import { addApplication, getActiveResume, getJob, getQuota, getSettings, incrementQuota, setJobStatus } from '../db/repo';
import { db } from '../db/schema';
import { canApply, shouldThrottle } from '../shared/quota';
import type { ApplyChannel, ApplyResult, Job } from '../shared/types';

const LAST_APPLY_KEY = 'last-apply-at';
const DAY = 86_400_000;

export interface ApplyOutcome extends ApplyResult {
  message: string;
}

async function findTabForUrl(url: string): Promise<chrome.tabs.Tab | undefined> {
  let origin = '';
  try {
    const u = new URL(url);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => {
    if (!t.url) return false;
    try {
      return new URL(t.url).origin === origin;
    } catch {
      return false;
    }
  });
}

async function pingUntilReady(tabId: number, attempts = 12): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, { type: 'WORKGET_PING' })) as { ok?: boolean } | undefined;
      if (res?.ok) return true;
    } catch {
      /* 内容脚本还没注入，等一下 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 打开（或复用）岗位页面 → 把话术填进输入框。
 * 返回 filled 时仍需用户自己点发送；返回 sent 说明 autoSend 已替你点了。
 */
export async function prepareApply(job: Job, message: string, autoSend: boolean): Promise<ApplyOutcome> {
  const settings = await getSettings();
  const limit = settings.prefs.dailyLimits[job.platform] ?? 0;
  const quota = await getQuota(job.platform);
  if (!canApply(quota.count, limit)) {
    return {
      ok: false,
      stage: 'blocked',
      message: `${job.platform} 今日主动沟通已用满 ${quota.count}/${limit}，明天再来（配额可自行调整）`,
    };
  }

  const lastRecord = await db.kv.get(LAST_APPLY_KEY);
  const wait = shouldThrottle(typeof lastRecord?.value === 'number' ? lastRecord.value : undefined);
  if (wait > 0) {
    return {
      ok: false,
      stage: 'blocked',
      message: `操作太快了，等 ${Math.ceil(wait / 1000)} 秒再投下一个（避免触发平台风控）`,
    };
  }

  const existing = await findTabForUrl(job.url);
  const tab = existing ?? (await chrome.tabs.create({ url: job.url, active: true }));
  const tabId = tab.id;
  if (tabId === undefined) {
    return { ok: false, stage: 'failed', message: '无法打开岗位页面，请手动打开' };
  }
  if (existing) await chrome.tabs.update(tabId, { active: true });

  const ready = await pingUntilReady(tabId);
  if (!ready) {
    return {
      ok: false,
      stage: 'failed',
      message: '岗位页面还没加载好（或刚安装插件还没刷新页面），刷新后重试',
    };
  }

  try {
    const result = (await chrome.tabs.sendMessage(tabId, {
      type: 'WORKGET_APPLY',
      platformJobId: job.platformJobId,
      message,
      autoSend,
    })) as ApplyResult | undefined;

    if (!result) return { ok: false, stage: 'failed', message: '页面没有响应，请手动完成' };

    if (result.stage === 'filled') {
      return { ...result, message: '话术已填进输入框，切到那个标签页检查一下，手动点发送即可' };
    }
    if (result.stage === 'sent') {
      return { ...result, message: '已自动发送打招呼消息' };
    }
    return {
      ...result,
      message: result.stage === 'blocked' ? `已中止：${result.reason ?? '风控'} ` : result.reason ?? '操作失败',
    };
  } catch (error) {
    return { ok: false, stage: 'failed', message: `页面通信失败：${String(error)}` };
  }
}

/** 用户确认发出后记账：投递记录 + 平台配额 + 岗位状态 + 全局节流时间戳。 */
export async function recordApplication(
  job: Job,
  message: string,
  channel: ApplyChannel = 'greet',
): Promise<void> {
  const settings = await getSettings();
  const now = Date.now();
  await addApplication({
    id: `a-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    jobId: job.id,
    platform: job.platform,
    jobTitle: job.title,
    company: job.company,
    at: now,
    channel,
    message,
    state: 'sent',
    updatedAt: now,
    followUpAt: now + settings.prefs.followUpDays * DAY,
  });
  await incrementQuota(job.platform, now);
  if ((await getJob(job.id))?.status !== 'applied') await setJobStatus(job.id, 'applied');
  await db.kv.put({ key: LAST_APPLY_KEY, value: now, updatedAt: now });
}

/** 在设置页里给当前标签页做一次选择器自检。 */
export async function selfCheckActiveTab(): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, message: '没有活动标签页' };
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'WORKGET_SELFTEST' });
  } catch {
    return { ok: false, message: '当前标签页不是招聘平台，或插件刚安装需要刷新页面' };
  }
}

/** 生成打招呼话术：优先 LLM，失败/未开启时退回模板。 */
export async function draftGreeting(job: Job): Promise<{ text: string; source: 'llm' | 'template' }> {
  const settings = await getSettings();
  const resume = await getActiveResume();
  const { templateGreeting, llmGreeting } = await import('../shared/llm');

  if (!resume) {
    return {
      text: templateGreeting({ ...job, tags: job.tags }, fallbackResume()),
      source: 'template',
    };
  }
  if (settings.llm.enabled && settings.llm.apiKey) {
    try {
      const text = await llmGreeting(settings.llm, job, resume);
      if (text) return { text, source: 'llm' };
    } catch {
      /* 网络/key 有问题就用模板，不阻塞投递 */
    }
  }
  return { text: templateGreeting(job, resume), source: 'template' };
}

function fallbackResume() {
  return {
    id: 'empty',
    name: '我',
    rawText: '',
    skills: [],
    years: 0,
    cities: [],
    createdAt: 0,
    updatedAt: 0,
    version: 'v0',
  };
}
