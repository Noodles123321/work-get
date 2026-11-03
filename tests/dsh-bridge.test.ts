import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, getJob, getSettings, saveDshBridge, upsertJobs } from '../src/db/repo';
import { normalizeJob } from '../src/shared/normalize';
import { DEFAULT_DSH_BRIDGE, type DshBridgeSettings, type Job, type RawJob } from '../src/shared/types';
import { buildPushPayload, describePushError, normalizeBaseUrl, pushJobs } from '../src/ui/dsh-bridge';

const NOW = 1_760_000_000_000;

function raw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    platform: 'boss',
    platformJobId: 'j1',
    url: 'https://www.zhipin.com/job_detail/j1.html',
    title: '高级前端开发工程师',
    company: '某某科技有限公司',
    city: '杭州',
    salaryRaw: '25-35K',
    tags: ['React'],
    ...overrides,
  };
}

function makeJob(overrides: Partial<RawJob> = {}): Job {
  return normalizeJob(raw(overrides), NOW);
}

function cfg(overrides: Partial<DshBridgeSettings> = {}): DshBridgeSettings {
  return { ...DEFAULT_DSH_BRIDGE, token: 'test-token', url: 'http://127.0.0.1:3610', ...overrides };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: () => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(async () => {
  await clearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeBaseUrl', () => {
  it('缺协议时补 http', () => {
    expect(normalizeBaseUrl('127.0.0.1:3610')).toBe('http://127.0.0.1:3610');
  });

  it('去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:3610///')).toBe('http://127.0.0.1:3610');
  });

  it('空值退回默认地址', () => {
    expect(normalizeBaseUrl('   ')).toBe('http://127.0.0.1:3610');
  });

  it('保留 https', () => {
    expect(normalizeBaseUrl('https://dsh.local:8443/')).toBe('https://dsh.local:8443');
  });
});

describe('buildPushPayload', () => {
  it('按 maxJobs 截断并报告跳过数', () => {
    const jobs = [makeJob({ platformJobId: 'a' }), makeJob({ platformJobId: 'b' }), makeJob({ platformJobId: 'c' })];
    const { jobs: picked, skipped } = buildPushPayload(jobs, 2);
    expect(picked).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('同一 id 只推一次', () => {
    const job = makeJob({ platformJobId: 'dup' });
    const { jobs: picked } = buildPushPayload([job, { ...job }], 10);
    expect(picked).toHaveLength(1);
  });

  it('缺标题或缺链接的岗位被丢弃', () => {
    const noUrl = { ...makeJob({ platformJobId: 'x' }), url: '' };
    const { jobs: picked, skipped } = buildPushPayload([noUrl], 10);
    expect(picked).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('携带薪资、分数与平台字段', () => {
    const { jobs: picked } = buildPushPayload([{ ...makeJob(), ruleScore: 81 }], 10);
    expect(picked[0]?.platform).toBe('boss');
    expect(picked[0]?.ruleScore).toBe(81);
    expect(picked[0]?.salary?.raw).toBe('25-35K');
    expect(picked[0]?.salary?.min).toBe(25000);
  });

  it('maxJobs 非法时退回 20', () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob({ platformJobId: `n${i}` }));
    expect(buildPushPayload(jobs, 0).jobs).toHaveLength(20);
  });
});

describe('describePushError', () => {
  it('每种错误都有中文提示', () => {
    const codes = [
      'disabled',
      'no_token',
      'unreachable',
      'unauthorized',
      'too_many_jobs',
      'empty_jobs',
      'deliver_failed',
      'bad_response',
    ] as const;
    for (const code of codes) {
      const text = describePushError(code);
      expect(text.length).toBeGreaterThan(6);
      expect(text).not.toContain('undefined');
    }
  });

  it('服务端 message 优先', () => {
    expect(describePushError('too_many_jobs', '一次最多 20 条')).toBe('一次最多 20 条');
  });

  it('未知错误退回 message / 兜底文案', () => {
    expect(describePushError(undefined, '自定义')).toBe('自定义');
    expect(describePushError(undefined)).toBe('推送失败');
  });
});

describe('pushJobs 前置检查', () => {
  it('关闭时不发请求', async () => {
    const spy = stubFetch(async () => fakeResponse(200, {}));
    const attempt = await pushJobs([makeJob()], cfg({ enabled: false }));
    expect(attempt.response.error).toBe('disabled');
    expect(spy).not.toHaveBeenCalled();
  });

  it('缺 token 时不发请求', async () => {
    const spy = stubFetch(async () => fakeResponse(200, {}));
    const attempt = await pushJobs([makeJob()], cfg({ token: '   ' }));
    expect(attempt.response.error).toBe('no_token');
    expect(spy).not.toHaveBeenCalled();
  });

  it('没有可推岗位时直接返回 empty_jobs', async () => {
    const spy = stubFetch(async () => fakeResponse(200, {}));
    const attempt = await pushJobs([], cfg());
    expect(attempt.response.error).toBe('empty_jobs');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pushJobs 网络与响应', () => {
  it('网络异常映射为 unreachable', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const attempt = await pushJobs([makeJob()], cfg());
    expect(attempt.response.error).toBe('unreachable');
    expect(attempt.response.message).toContain('Failed to fetch');
  });

  it('401 映射为 unauthorized', async () => {
    stubFetch(async () => fakeResponse(401, { ok: false, error: 'unauthorized' }));
    const attempt = await pushJobs([makeJob()], cfg());
    expect(attempt.response.error).toBe('unauthorized');
  });

  it('413/400 透传服务端 message', async () => {
    stubFetch(async () => fakeResponse(400, { ok: false, error: 'too_many_jobs', message: '一次最多 20 条，当前 21 条' }));
    const attempt = await pushJobs([makeJob()], cfg());
    expect(attempt.response.error).toBe('too_many_jobs');
    expect(attempt.response.message).toContain('一次最多 20 条');
  });

  it('502 映射为 deliver_failed', async () => {
    stubFetch(async () => fakeResponse(502, { ok: false, error: 'deliver_failed', message: '[create] boom' }));
    const attempt = await pushJobs([makeJob()], cfg());
    expect(attempt.response.error).toBe('deliver_failed');
  });

  it('缺 sessionId 视为 bad_response 且不写回时间戳', async () => {
    await upsertJobs([raw()]);
    stubFetch(async () => fakeResponse(200, { ok: true, count: 1 }));
    const jobs = [{ ...makeJob(), dshPushedAt: undefined }];
    const attempt = await pushJobs(jobs, cfg());
    expect(attempt.response.error).toBe('bad_response');
    const stored = await getJob('boss:j1');
    expect(stored?.dshPushedAt).toBeUndefined();
  });

  it('请求体带 token 与岗位数组', async () => {
    const spy = stubFetch(async () => fakeResponse(200, { ok: true, sessionId: 'session-1', count: 1 }));
    await pushJobs([makeJob()], cfg());
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
    const body = JSON.parse(String(init.body)) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(1);
  });
});

describe('pushJobs 成功路径', () => {
  it('成功后回写 dshPushedAt', async () => {
    await upsertJobs([raw({ platformJobId: 'j1' }), raw({ platformJobId: 'j2' })]);
    stubFetch(async () => fakeResponse(200, { ok: true, sessionId: 'session-abc', count: 2, platforms: ['boss'] }));
    const attempt = await pushJobs([makeJob({ platformJobId: 'j1' }), makeJob({ platformJobId: 'j2' })], cfg());
    expect(attempt.response.ok).toBe(true);
    expect(attempt.response.sessionId).toBe('session-abc');
    expect(attempt.count).toBe(2);
    expect((await getJob('boss:j1'))?.dshPushedAt).toBeGreaterThan(0);
    expect((await getJob('boss:j2'))?.dshPushedAt).toBeGreaterThan(0);
  });

  it('重复推送（duplicate=true）也算成功并回写', async () => {
    await upsertJobs([raw()]);
    stubFetch(async () => fakeResponse(200, { ok: true, sessionId: 'session-old', count: 1, duplicate: true }));
    const attempt = await pushJobs([makeJob()], cfg());
    expect(attempt.response.ok).toBe(true);
    expect(attempt.response.duplicate).toBe(true);
    expect((await getJob('boss:j1'))?.dshPushedAt).toBeGreaterThan(0);
  });
});

describe('DSH 设置持久化', () => {
  it('默认开启、地址指向 3610', async () => {
    const settings = await getSettings();
    expect(settings.dshBridge.enabled).toBe(true);
    expect(settings.dshBridge.url).toBe('http://127.0.0.1:3610');
    expect(settings.dshBridge.token).toBe('');
  });

  it('保存 token 不影响偏好设置', async () => {
    await saveDshBridge({ token: 'abc123', maxJobs: 8 });
    const settings = await getSettings();
    expect(settings.dshBridge.token).toBe('abc123');
    expect(settings.dshBridge.maxJobs).toBe(8);
    expect(settings.prefs.dailyLimits.boss).toBe(20);
  });
});
