import { addRiskSignal, getActiveResume, getSettings, upsertJobs } from '../db/repo';
import { db } from '../db/schema';
import { RISK_LABEL } from '../shared/guard';
import { PLATFORM_META, type Platform, type RawJob } from '../shared/types';

const FOLLOWUP_ALARM = 'workget-followup-check';

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);
    chrome.alarms.create(FOLLOWUP_ALARM, { periodInMinutes: 30, delayInMinutes: 5 });
  });

  chrome.alarms.create(FOLLOWUP_ALARM, { periodInMinutes: 30, delayInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FOLLOWUP_ALARM) void checkFollowUps();
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as { type?: string } & Record<string, unknown>;
    if (!msg?.type) return false;

    if (msg.type === 'WORKGET_CAPTURE') {
      void handleCapture(msg.jobs as RawJob[])
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (msg.type === 'WORKGET_RISK') {
      void handleRisk(msg.platform as string, msg.kind as string, msg.evidence as string)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (msg.type === 'WORKGET_CONFIG') {
      void loadOverrides()
        .then((overrides) => sendResponse({ ok: true, overrides }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    return false;
  });
});

async function loadOverrides(): Promise<unknown> {
  const record = await db.kv.get('selector-overrides');
  return record?.value ?? {};
}

async function handleCapture(jobs: RawJob[]): Promise<{ inserted: number; updated: number; dropped: number }> {
  if (!Array.isArray(jobs) || jobs.length === 0) return { inserted: 0, updated: 0, dropped: 0 };
  const settings = await getSettings();
  const resume = await getActiveResume();
  const result = await upsertJobs(jobs, { prefs: settings.prefs, resume });
  if (result.inserted > 0) await updateBadge();
  return result;
}

async function updateBadge(): Promise<void> {
  const total = await db.jobs.count();
  const newCount = await db.jobs.where('status').equals('new').count();
  const text = total === 0 ? '' : newCount > 99 ? '99+' : String(newCount);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
}

async function handleRisk(platformId: string, kind: string, evidence: string): Promise<void> {
  const platform = platformId as Platform;
  if (!(platform in PLATFORM_META)) return;
  await addRiskSignal(platform, {
    kind: (kind as 'captcha' | 'frequent' | 'login' | 'unknown') ?? 'unknown',
    evidence,
    at: Date.now(),
  });
  const label = RISK_LABEL[(kind as keyof typeof RISK_LABEL) ?? 'unknown'] ?? '风控';
  await notify(
    `Work GET：${PLATFORM_META[platform].label} 已暂停`,
    `${label}（${evidence}）。插件已停止该站点的自动操作，请手动处理后再继续。`,
  );
}

async function notify(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title,
      message,
    });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

async function checkFollowUps(): Promise<void> {
  const now = Date.now();
  const apps = await db.applications.where('state').equals('sent').toArray();
  const due = apps.filter((a) => a.followUpAt !== undefined && a.followUpAt <= now);
  if (due.length === 0) return;
  await notify(
    `有 ${due.length} 条投递该跟进了`,
    due
      .slice(0, 3)
      .map((a) => `${a.company} · ${a.jobTitle}`)
      .join('\n'),
  );
}
