import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  buildFamilyKey,
  cleanText,
  decodeSalaryGlyphs,
  formatSalary,
  mergeJob,
  normalizeCompany,
  normalizeJob,
  normalizeTitle,
  parseActiveAt,
  parseEducation,
  parseExperience,
  parseSalary,
  splitCity,
} from '../src/shared/normalize';
import type { Job, RawJob } from '../src/shared/types';

const NOW = 1_760_000_000_000;

function raw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    platform: 'boss',
    platformJobId: 'abc123',
    url: 'https://www.zhipin.com/job_detail/abc123.html',
    title: '前端开发工程师',
    company: '某某科技有限公司',
    city: '杭州',
    salaryRaw: '15-25K·14薪',
    experienceRaw: '3-5年',
    educationRaw: '本科',
    tags: ['React', 'TypeScript'],
    ...overrides,
  };
}

describe('cleanText', () => {
  it('把全角字符转半角并压缩空白', () => {
    expect(cleanText('　ＲＥＡＣＴ　 开发　')).toBe('REACT 开发');
  });

  it('空值返回空串', () => {
    expect(cleanText(undefined)).toBe('');
    expect(cleanText(null)).toBe('');
  });
});

describe('parseSalary', () => {
  it('解析 K 区间与薪数', () => {
    expect(parseSalary('15-25K·14薪')).toMatchObject({ min: 15000, max: 25000, unit: 'month', months: 14 });
  });

  it('解析万的区间', () => {
    expect(parseSalary('1.5-2万')).toMatchObject({ min: 15000, max: 20000, unit: 'month' });
  });

  it('千与万混写', () => {
    expect(parseSalary('8千-1.2万')).toMatchObject({ min: 8000, max: 12000 });
  });

  it('日结按天', () => {
    expect(parseSalary('200-300元/天')).toMatchObject({ min: 200, max: 300, unit: 'day' });
  });

  it('年薪按年', () => {
    expect(parseSalary('年薪30-50万')).toMatchObject({ min: 300000, max: 500000, unit: 'year' });
  });

  it('纯数字按月薪的元', () => {
    expect(parseSalary('15000-20000')).toMatchObject({ min: 15000, max: 20000, unit: 'month' });
  });

  it('面议返回 undefined', () => {
    expect(parseSalary('面议')).toBeUndefined();
    expect(parseSalary('薪资面谈')).toBeUndefined();
  });

  it('倒序区间会被纠正', () => {
    expect(parseSalary('25-15K')).toMatchObject({ min: 15000, max: 25000 });
  });

  it('原文保留', () => {
    expect(parseSalary('15-25K')?.raw).toBe('15-25K');
  });
});

describe('decodeSalaryGlyphs（BOSS 私有区数字）', () => {
  const glyph = (...codes: number[]) => String.fromCharCode(...codes);

  it('按 U+E031 起算还原本地数字', () => {
    // BOSS 现网：9-12K 存成 E03A '-' E032 E033 'K'
    expect(decodeSalaryGlyphs(glyph(0xe03a, 0x2d, 0xe032, 0xe033, 0x4b))).toBe('9-12K');
    expect(decodeSalaryGlyphs(glyph(0xe031))).toBe('0');
  });

  it('保留普通数字与其它字符', () => {
    expect(decodeSalaryGlyphs('200-300元/天')).toBe('200-300元/天');
    expect(decodeSalaryGlyphs('')).toBe('');
    expect(decodeSalaryGlyphs(undefined)).toBe('');
  });

  it('解码后 parseSalary 拿到正确区间与薪数', () => {
    const decoded = parseSalary(glyph(0xe03a, 0x2d, 0xe032, 0xe033, 0x4b));
    expect(decoded).toMatchObject({ min: 9000, max: 12000, unit: 'month' });

    const withMonths = parseSalary(`15-25K·${glyph(0xe032, 0xe035)}薪`);
    expect(withMonths).toMatchObject({ min: 15000, max: 25000, months: 14 });
  });
});

describe('formatSalary', () => {
  it('月薪用 K/万表示', () => {
    expect(formatSalary({ min: 15000, max: 25000, unit: 'month', raw: '' })).toBe('1.5万-2.5万/月');
    expect(formatSalary({ min: 8000, max: 9000, unit: 'month', raw: '' })).toBe('8K-9K/月');
  });

  it('带 14 薪后缀', () => {
    expect(formatSalary({ min: 15000, max: 15000, unit: 'month', months: 14, raw: '' })).toContain('·14薪');
  });

  it('无薪资返回面议', () => {
    expect(formatSalary(undefined)).toBe('面议');
  });
});

describe('normalizeTitle / normalizeCompany', () => {
  it('去掉括号补充与分隔符', () => {
    expect(normalizeTitle('前端开发工程师（杭州）')).toBe('前端开发工程师');
  });

  it('去掉"急招/双休"这类营销词', () => {
    expect(normalizeTitle('急招 高级 React 工程师 双休')).toBe('高级react工程师');
  });

  it('公司去掉有限公司后缀与城市前缀', () => {
    expect(normalizeCompany('北京某某科技有限公司')).toBe('某某科技');
  });
});

describe('splitCity', () => {
  it('拆分城市与区域', () => {
    expect(splitCity('杭州·西湖区')).toEqual({ city: '杭州', district: '西湖' });
  });

  it('单城市去掉"市"', () => {
    expect(splitCity('深圳市')).toEqual({ city: '深圳' });
  });

  it('空值兜底未知', () => {
    expect(splitCity('')).toEqual({ city: '未知' });
  });
});

describe('parseExperience / parseEducation / parseActiveAt', () => {
  it('经验区间', () => {
    expect(parseExperience('3-5年')).toEqual({ min: 3, max: 5 });
    expect(parseExperience('1年以内')).toEqual({ min: 0, max: 1 });
    expect(parseExperience('5年以上')).toEqual({ min: 5 });
    expect(parseExperience('经验不限')).toEqual({});
  });

  it('学历取最高命中', () => {
    expect(parseEducation('本科及以上')).toBe('本科');
    expect(parseEducation('学历不限')).toBe('不限');
    expect(parseEducation('')).toBeUndefined();
  });

  it('活跃时间换算相对时间', () => {
    expect(parseActiveAt('刚刚', NOW)).toBe(NOW);
    expect(parseActiveAt('2小时前', NOW)).toBe(NOW - 2 * 3_600_000);
    expect(parseActiveAt('3天前', NOW)).toBe(NOW - 3 * 86_400_000);
  });
});

describe('dedupeKey', () => {
  it('同一岗位不同薪资写法落到同一个 key', () => {
    const base = { city: '杭州', companyNorm: '某某科技', titleNorm: '前端开发工程师' };
    const a = buildDedupeKey({ ...base, salary: parseSalary('15-25K') });
    const b = buildDedupeKey({ ...base, salary: parseSalary('15000-25000元/月') });
    expect(a).toBe(b);
  });

  it('城市"市"后缀不影响', () => {
    const parts = { companyNorm: 'c', titleNorm: 't' };
    expect(buildDedupeKey({ ...parts, city: '杭州' })).toBe(buildDedupeKey({ ...parts, city: '杭州市' }));
  });

  it('familyKey 不含薪资', () => {
    expect(buildFamilyKey({ city: '杭州', companyNorm: 'c', titleNorm: 't' })).toBe('杭州|c|t');
  });
});

describe('normalizeJob', () => {
  it('生成 platform:id 形式的 id', () => {
    const job = normalizeJob(raw(), NOW);
    expect(job.id).toBe('boss:abc123');
    expect(job.status).toBe('new');
    expect(job.lastSeenAt).toBe(NOW);
  });

  it('缺失标题公司有兜底', () => {
    const job = normalizeJob(raw({ title: '  ', company: undefined }), NOW);
    expect(job.title).toBe('未命名岗位');
    expect(job.company).toBe('未知公司');
  });

  it('拼接城市与区域', () => {
    const job = normalizeJob(raw({ city: '杭州', district: '西湖区' }), NOW);
    expect(job.city).toBe('杭州');
    expect(job.district).toBe('西湖');
  });

  it('标签去空白并裁剪', () => {
    const job = normalizeJob(raw({ tags: [' React ', '', 'TS'] }), NOW);
    expect(job.tags).toEqual(['React', 'TS']);
  });
});

describe('mergeJob', () => {
  const existing = normalizeJob(raw({ capturedAt: NOW - 10_000 }), NOW - 5_000);
  const incoming: Job = normalizeJob(raw({ capturedAt: NOW }), NOW) as Job;

  it('保留最早的 firstSeenAt 与最新的 lastSeenAt', () => {
    const merged = mergeJob(existing, incoming);
    expect(merged.firstSeenAt).toBe(NOW - 10_000);
    expect(merged.lastSeenAt).toBe(NOW);
  });

  it('保留已有 note 与 ruleScore', () => {
    const merged = mergeJob({ ...existing, note: '已联系', ruleScore: 88 }, incoming);
    expect(merged.note).toBe('已联系');
    expect(merged.ruleScore).toBe(88);
  });
});
