import { beforeEach, describe, expect, it } from 'vitest';
import {
  addApplication,
  applicationsForJob,
  clearAll,
  countJobs,
  dueFollowUps,
  getQuota,
  getSettings,
  hasApplied,
  incrementQuota,
  listApplications,
  purgeIncompleteJobs,
  queryJobs,
  savePreferences,
  setApplicationState,
  setJobStatus,
  stats,
  upsertJobs,
} from '../src/db/repo';
import { DEFAULT_PREFS, type Application, type RawJob } from '../src/shared/types';

const NOW = Date.now();

function raw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    platform: 'boss',
    platformJobId: 'j1',
    url: 'https://www.zhipin.com/job_detail/j1.html',
    title: '前端开发工程师',
    company: '某某科技有限公司',
    city: '杭州',
    salaryRaw: '20-30K',
    tags: ['React'],
    ...overrides,
  };
}

function app(overrides: Partial<Application> = {}): Application {
  return {
    id: 'a1',
    jobId: 'boss:j1',
    platform: 'boss',
    jobTitle: '前端开发工程师',
    company: '某某科技',
    at: NOW,
    channel: 'greet',
    state: 'sent',
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAll();
});

describe('设置', () => {
  it('默认设置带默认偏好与 LLM 配置', async () => {
    const settings = await getSettings();
    expect(settings.prefs.dailyLimits.boss).toBe(20);
    expect(settings.prefs.autoSend).toBe(false);
    expect(settings.llm.enabled).toBe(false);
  });

  it('保存偏好只覆盖指定字段', async () => {
    await savePreferences({ autoSend: true, cities: ['杭州'] });
    const settings = await getSettings();
    expect(settings.prefs.autoSend).toBe(true);
    expect(settings.prefs.cities).toEqual(['杭州']);
    expect(settings.prefs.dailyLimits).toEqual(DEFAULT_PREFS.dailyLimits);
  });
});

describe('upsertJobs', () => {
  it('首次采集全部插入', async () => {
    const result = await upsertJobs([raw(), raw({ platformJobId: 'j2', title: '后端开发工程师' })]);
    expect(result).toEqual({ inserted: 2, updated: 0, dropped: 0 });
    expect(await countJobs()).toBe(2);
  });

  it('重复采集只更新不新增', async () => {
    await upsertJobs([raw()]);
    const first = (await queryJobs())[0]!;
    const result = await upsertJobs([raw({ tags: ['React', 'TypeScript'] })]);
    expect(result).toEqual({ inserted: 0, updated: 1, dropped: 0 });
    const again = (await queryJobs())[0]!;
    expect(again.firstSeenAt).toBe(first.firstSeenAt);
    expect(again.tags).toContain('TypeScript');
  });

  it('同批次内重复只算一条', async () => {
    const result = await upsertJobs([raw(), raw()]);
    expect(result.inserted).toBe(1);
    expect(await countJobs()).toBe(1);
  });

  it('缺平台 ID 或标题的数据被忽略', async () => {
    const result = await upsertJobs([raw({ platformJobId: '' }), raw({ title: '' }), raw()]);
    expect(result.inserted).toBe(1);
  });

  it('传入简历与偏好时做硬过滤并打分', async () => {
    const result = await upsertJobs(
      [raw({ tags: ['外包'] }), raw({ platformJobId: 'j2', title: '后端开发工程师' })],
      {
        prefs: DEFAULT_PREFS,
        resume: {
          id: 'r1',
          name: '张三',
          rawText: 'React 5 年',
          skills: ['React'],
          years: 5,
          cities: ['杭州'],
          createdAt: NOW,
          updatedAt: NOW,
          version: 'v1',
        },
      },
    );
    expect(result.dropped).toBe(1);
    expect(result.inserted).toBe(1);
    const [job] = await queryJobs();
    expect(job!.ruleScore).toBeGreaterThan(0);
  });
});

describe('queryJobs', () => {
  it('按关键词过滤', async () => {
    await upsertJobs([raw(), raw({ platformJobId: 'j2', title: '后端开发工程师' })]);
    const rows = await queryJobs({ keyword: '前端' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('前端开发工程师');
  });

  it('按平台过滤', async () => {
    await upsertJobs([raw(), raw({ platform: 'liepin', platformJobId: 'l1' })]);
    expect(await queryJobs({ platforms: ['liepin'] })).toHaveLength(1);
  });

  it('按状态过滤并支持改状态', async () => {
    await upsertJobs([raw()]);
    await setJobStatus('boss:j1', 'starred');
    expect(await queryJobs({ statuses: ['starred'] })).toHaveLength(1);
    expect(await queryJobs({ statuses: ['new'] })).toHaveLength(0);
  });

  it('limit 生效', async () => {
    await upsertJobs([
      raw(),
      raw({ platformJobId: 'j2', title: '后端开发工程师' }),
      raw({ platformJobId: 'j3', title: '测试工程师' }),
    ]);
    expect(await queryJobs({ limit: 2 })).toHaveLength(2);
  });
});

describe('配额', () => {
  it('初始为 0，累加后可用上限判断', async () => {
    const before = await getQuota('boss');
    expect(before.count).toBe(0);
    const after = await incrementQuota('boss');
    expect(after.count).toBe(1);
    expect((await getQuota('boss')).count).toBe(1);
  });

  it('不同平台互不影响', async () => {
    await incrementQuota('boss');
    expect((await getQuota('boss')).count).toBe(1);
    expect((await getQuota('liepin')).count).toBe(0);
  });
});

describe('投递记录', () => {
  it('新增后能查到，且 hasApplied 为 true', async () => {
    await addApplication(app());
    expect(await hasApplied('boss:j1')).toBe(true);
    expect(await applicationsForJob('boss:j1')).toHaveLength(1);
    expect(await listApplications()).toHaveLength(1);
  });

  it('未投递的岗位 hasApplied 为 false', async () => {
    expect(await hasApplied('boss:j2')).toBe(false);
  });

  it('跟进到期只返回已投递状态', async () => {
    await addApplication(app({ followUpAt: NOW - 1000 }));
    await addApplication(app({ id: 'a2', jobId: 'boss:j2', followUpAt: NOW - 1000, state: 'replied' }));
    const due = await dueFollowUps(NOW);
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe('a1');
  });

  it('更新状态', async () => {
    await addApplication(app());
    await setApplicationState('a1', 'interview');
    expect((await listApplications())[0]!.state).toBe('interview');
  });
});

describe('stats', () => {  it('统计岗位与投递', async () => {
    await upsertJobs([raw(), raw({ platformJobId: 'j2', title: '后端开发工程师' })]);
    await setJobStatus('boss:j2', 'starred');
    await addApplication(app());
    await addApplication(app({ id: 'a2', jobId: 'boss:j2', state: 'interview' }));
    const s = await stats();
    expect(s.jobs).toBe(2);
    expect(s.starred).toBe(1);
    expect(s.applied).toBe(2);
    expect(s.byPlatform.boss).toBe(2);
    expect(s.replies).toBe(1);
    expect(s.interviews).toBe(1);
  });
});

describe('purgeIncompleteJobs', () => {
  it('只删公司/城市都缺的记录', async () => {
    await upsertJobs([
      raw(),
      raw({ platformJobId: 'j2', title: '缺字段岗位', company: undefined, city: undefined }),
    ]);
    expect(await countJobs()).toBe(2);
    expect(await purgeIncompleteJobs()).toBe(1);
    expect(await countJobs()).toBe(1);
    const left = await queryJobs({});
    expect(left[0]!.company).toBe('某某科技有限公司');
  });

  it('没有残缺记录时返回 0', async () => {
    await upsertJobs([raw()]);
    expect(await purgeIncompleteJobs()).toBe(0);
    expect(await countJobs()).toBe(1);
  });
});
