import { describe, expect, it } from 'vitest';
import { blendScore, hardFilter, ruleScore } from '../src/shared/matcher';
import { DEFAULT_PREFS, type Job, type Preferences, type Resume } from '../src/shared/types';
import { hashString, parseJsonLoose, redact, templateGreeting } from '../src/shared/llm';
import { normalizeJob } from '../src/shared/normalize';

const NOW = 1_760_000_000_000;

const RESUME: Resume = {
  id: 'r1',
  name: '张三',
  rawText: '5 年前端经验，熟悉 React、TypeScript、Node.js',
  skills: ['React', 'TypeScript', 'Node.js'],
  years: 5,
  cities: ['杭州'],
  expectedSalary: { min: 20000, max: 30000, unit: 'month', raw: '20-30K' },
  education: '本科',
  createdAt: NOW,
  updatedAt: NOW,
  version: 'v1',
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    ...normalizeJob(
      {
        platform: 'boss',
        platformJobId: 'j1',
        url: 'https://www.zhipin.com/job_detail/j1.html',
        title: '高级前端开发工程师',
        company: '某某科技有限公司',
        city: '杭州',
        salaryRaw: '25-35K',
        experienceRaw: '3-5年',
        educationRaw: '本科',
        tags: ['React', 'TypeScript'],
        description: '负责 React 前端架构，需要 TypeScript 与 Node.js 经验',
      },
      NOW,
    ),
    ...overrides,
  };
}

function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return { ...DEFAULT_PREFS, ...overrides };
}

describe('hardFilter', () => {
  it('屏蔽词命中即排除', () => {
    const result = hardFilter(job({ tags: ['外包'] }), prefs());
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('外包');
  });

  it('屏蔽公司命中即排除', () => {
    const result = hardFilter(job(), prefs({ blockedCompanies: ['某某科技'] }));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('屏蔽公司');
  });

  it('城市不在意向范围排除', () => {
    const result = hardFilter(job({ city: '北京' }), prefs({ cities: ['杭州'] }));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('城市');
  });

  it('城市未知时不做城市过滤', () => {
    expect(hardFilter(job({ city: '未知' }), prefs({ cities: ['杭州'] })).pass).toBe(true);
  });

  it('薪资上限低于期望下限排除', () => {
    const low = job({ salary: { min: 8000, max: 12000, unit: 'month', raw: '8-12K' } });
    const result = hardFilter(low, prefs({ salaryMin: 15000 }));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('薪资');
  });

  it('经验要求超过上限排除', () => {
    const senior = job({ experienceMin: 8 });
    expect(hardFilter(senior, prefs({ experienceMax: 5 })).pass).toBe(false);
  });

  it('正常岗位通过', () => {
    expect(hardFilter(job(), prefs({ cities: ['杭州'], salaryMin: 20000 }), RESUME).pass).toBe(true);
  });
});

describe('ruleScore', () => {
  it('技能命中的岗位分数更高', () => {
    const hit = ruleScore(job(), RESUME);
    const miss = ruleScore(job({ description: '负责线下门店销售', tags: ['销售'] }), RESUME);
    expect(hit.score).toBeGreaterThan(miss.score);
  });

  it('分数始终在 0-100 之间', () => {
    for (const j of [job(), job({ description: '', tags: [], city: '未知' })]) {
      const score = ruleScore(j, RESUME).score;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('给出可解释的理由', () => {
    const result = ruleScore(job(), RESUME);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.matchedSkills).toContain('React');
  });

  it('城市不符会扣分并记录 gap', () => {
    const result = ruleScore(job({ city: '北京' }), RESUME, prefs({ cities: ['杭州'] }));
    expect(result.gaps.join(' ')).toContain('城市');
  });

  it('无薪资时提示需要沟通', () => {
    const result = ruleScore(job({ salary: undefined }), RESUME);
    expect(result.gaps.join(' ')).toContain('薪资');
  });

  it('白领方向给鱼泡降 8 分', () => {
    // 用低分岗位，避免 100 分上限把差值吃掉
    const weak = { title: '行政专员', description: '', tags: [] as string[], salary: undefined };
    const white = ruleScore(job({ ...weak, platform: 'yupao' }), { ...RESUME, skills: [] }, prefs({ direction: 'white-collar' }));
    const both = ruleScore(job({ ...weak, platform: 'yupao' }), { ...RESUME, skills: [] }, prefs({ direction: 'both' }));
    expect(both.score - white.score).toBe(8);
    expect(white.gaps.join(' ')).toContain('白领');
  });

  it('蓝领方向给非鱼泡降 4 分', () => {
    const weak = { title: '行政专员', description: '', tags: [] as string[], salary: undefined };
    const blue = ruleScore(job({ ...weak, platform: 'boss' }), { ...RESUME, skills: [] }, prefs({ direction: 'blue-collar' }));
    const both = ruleScore(job({ ...weak, platform: 'boss' }), { ...RESUME, skills: [] }, prefs({ direction: 'both' }));
    expect(both.score - blue.score).toBe(4);
  });

  it('不限方向不因平台降权', () => {
    const yupao = ruleScore(job({ platform: 'yupao' }), RESUME, prefs({ direction: 'both' }));
    const boss = ruleScore(job({ platform: 'boss' }), RESUME, prefs({ direction: 'both' }));
    expect(yupao.score).toBe(boss.score);
  });
});

describe('blendScore', () => {
  it('没有 LLM 分时等于规则分', () => {
    expect(blendScore(72)).toBe(72);
  });

  it('按 65/35 加权', () => {
    expect(blendScore(50, 100)).toBe(83);
    expect(blendScore(100, 0)).toBe(35);
  });

  it('结果裁剪到 0-100', () => {
    expect(blendScore(100, 100)).toBe(100);
    expect(blendScore(0, 0)).toBe(0);
  });
});

describe('redact', () => {
  it('手机号替换为占位符', () => {
    expect(redact('联系电话 13800138000')).toBe('联系电话 [手机号]');
  });

  it('邮箱替换为占位符', () => {
    expect(redact('邮箱 zhangsan@example.com')).toContain('[邮箱]');
  });

  it('普通文本不变', () => {
    expect(redact('5 年 React 经验')).toBe('5 年 React 经验');
  });
});

describe('parseJsonLoose', () => {
  it('解析带代码块的 JSON', () => {
    expect(parseJsonLoose<{ score: number }>('```json\n{"score":80}\n```')).toEqual({ score: 80 });
  });

  it('从夹杂文字中抠出 JSON', () => {
    expect(parseJsonLoose<{ score: number }>('好的，结果如下：{"score":70} 以上')).toEqual({ score: 70 });
  });

  it('无法解析返回 null', () => {
    expect(parseJsonLoose('完全没有 JSON')).toBeNull();
  });
});

describe('hashString', () => {
  it('同输入稳定同输出', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('输出 8 位十六进制', () => {
    expect(hashString('resume-v1::job-1')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('templateGreeting', () => {
  it('包含岗位名称且长度可控', () => {
    const text = templateGreeting(job(), RESUME);
    expect(text).toContain('高级前端开发工程师');
    expect(text.length).toBeLessThanOrEqual(110);
  });

  it('不会出现连续逗号', () => {
    const text = templateGreeting(job({ tags: [] }), RESUME);
    expect(text).not.toContain('，，');
  });

  it('没有技能时也有兜底文案', () => {
    const text = templateGreeting(job(), { ...RESUME, skills: [], years: 0 });
    expect(text.length).toBeGreaterThan(10);
  });
});
