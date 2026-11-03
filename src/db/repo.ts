import { db } from './schema';
import type { QuotaRecord } from '../shared/quota';
import { localDateKey, quotaId } from '../shared/quota';
import { mergeJob, normalizeJob } from '../shared/normalize';
import { hardFilter, ruleScore } from '../shared/matcher';
import type { RiskSignal } from '../shared/types';
import {
  DEFAULT_DSH_BRIDGE,
  DEFAULT_LLM,
  DEFAULT_PREFS,
  type Application,
  type ApplicationState,
  type DshBridgeSettings,
  type Job,
  type JobStatus,
  type LlmSettings,
  type MatchRecord,
  type Preferences,
  type RawJob,
  type Resume,
  type Settings,
} from '../shared/types';

/* ------------------------------- 设置 ------------------------------- */

const SETTINGS_KEY = 'settings';

function mergeSettings(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>;
  return {
    prefs: { ...DEFAULT_PREFS, ...(value.prefs ?? {}) },
    llm: { ...DEFAULT_LLM, ...(value.llm ?? {}) },
    dshBridge: { ...DEFAULT_DSH_BRIDGE, ...(value.dshBridge ?? {}) },
    activeResumeId: value.activeResumeId,
  };
}

export async function getSettings(): Promise<Settings> {
  const record = await db.kv.get(SETTINGS_KEY);
  return mergeSettings(record?.value);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    prefs: { ...current.prefs, ...(patch.prefs ?? {}) },
    llm: { ...current.llm, ...(patch.llm ?? {}) },
    dshBridge: { ...current.dshBridge, ...(patch.dshBridge ?? {}) },
    activeResumeId: patch.activeResumeId ?? current.activeResumeId,
  };
  await db.kv.put({ key: SETTINGS_KEY, value: next, updatedAt: Date.now() });
  return next;
}

export async function saveDshBridge(patch: Partial<DshBridgeSettings>): Promise<DshBridgeSettings> {
  const settings = await getSettings();
  return (await saveSettings({ dshBridge: { ...settings.dshBridge, ...patch } })).dshBridge;
}

export async function savePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const settings = await getSettings();
  return (await saveSettings({ prefs: { ...settings.prefs, ...patch } })).prefs;
}

export async function saveLlm(patch: Partial<LlmSettings>): Promise<LlmSettings> {
  const settings = await getSettings();
  return (await saveSettings({ llm: { ...settings.llm, ...patch } })).llm;
}

/* ------------------------------- 岗位 ------------------------------- */

export interface UpsertResult {
  inserted: number;
  updated: number;
  dropped: number;
}

/**
 * 采集入库。同 dedupeKey 视为同一岗位：保留 firstSeenAt、刷新 lastSeenAt。
 * 传了 resume/prefs 时顺带算规则分（纯本地，零成本）。
 */
export async function upsertJobs(
  rawJobs: RawJob[],
  ctx?: { prefs: Preferences; resume?: Resume },
): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: 0, updated: 0, dropped: 0 };
  if (rawJobs.length === 0) return result;

  const now = Date.now();
  const normalized = rawJobs
    .filter((raw) => raw.platformJobId && raw.title)
    .map((raw) => normalizeJob(raw, now));

  // 批内先按 dedupeKey 合并，避免同一次滚动重复插入
  const batch = new Map<string, Job>();
  for (const job of normalized) {
    const key = `${job.id}`;
    const hit = batch.get(key);
    batch.set(key, hit ? mergeJob(hit, job) : job);
  }

  await db.transaction('rw', db.jobs, async () => {
    for (const job of batch.values()) {
      if (ctx?.resume) {
        const filter = hardFilter(job, ctx.prefs, ctx.resume);
        if (!filter.pass) {
          result.dropped++;
          continue;
        }
        job.ruleScore = ruleScore(job, ctx.resume, ctx.prefs).score;
      }
      const existing = await db.jobs.get(job.id);
      if (existing) {
        const merged = mergeJob(existing, job);
        await db.jobs.put(merged);
        result.updated++;
      } else {
        await db.jobs.put(job);
        result.inserted++;
      }
    }
  });

  return result;
}

export interface JobQuery {
  keyword?: string;
  platforms?: Job['platform'][];
  statuses?: JobStatus[];
  city?: string;
  minScore?: number;
  limit?: number;
  orderBy?: 'lastSeenAt' | 'firstSeenAt' | 'ruleScore';
}

export async function queryJobs(query: JobQuery = {}): Promise<Job[]> {
  let collection = db.jobs.toCollection();
  const all = await collection.toArray();
  const keyword = query.keyword?.trim().toLowerCase();

  let rows = all;
  if (query.platforms?.length) rows = rows.filter((j) => query.platforms!.includes(j.platform));
  if (query.statuses?.length) rows = rows.filter((j) => query.statuses!.includes(j.status));
  if (query.city) rows = rows.filter((j) => j.city.includes(query.city!));
  if (query.minScore !== undefined) rows = rows.filter((j) => (j.ruleScore ?? 0) >= query.minScore!);
  if (keyword) {
    rows = rows.filter((j) =>
      `${j.title} ${j.company} ${j.tags.join(' ')} ${j.city}`.toLowerCase().includes(keyword),
    );
  }

  const orderBy = query.orderBy ?? 'lastSeenAt';
  rows.sort((a, b) => {
    if (orderBy === 'ruleScore') return (b.ruleScore ?? 0) - (a.ruleScore ?? 0) || b.lastSeenAt - a.lastSeenAt;
    return (b[orderBy] ?? 0) - (a[orderBy] ?? 0);
  });

  return query.limit ? rows.slice(0, query.limit) : rows;
}

export async function getJob(id: string): Promise<Job | undefined> {
  return db.jobs.get(id);
}

export async function setJobStatus(id: string, status: JobStatus): Promise<void> {
  await db.jobs.update(id, { status });
}

export async function deleteJob(id: string): Promise<void> {
  await db.jobs.delete(id);
}

export async function countJobs(): Promise<number> {
  return db.jobs.count();
}

/** 记录一批岗位已推送到 DSH（只写时间戳，不改状态） */
export async function markJobsPushed(ids: string[], at = Date.now()): Promise<number> {
  if (ids.length === 0) return 0;
  const unique = [...new Set(ids)];
  let touched = 0;
  await db.transaction('rw', db.jobs, async () => {
    for (const id of unique) {
      touched += await db.jobs.update(id, { dshPushedAt: at });
    }
  });
  return touched;
}

/* ------------------------------- 投递 ------------------------------- */

export async function addApplication(app: Application): Promise<void> {
  await db.applications.put(app);
}

export async function updateApplication(id: string, patch: Partial<Application>): Promise<void> {
  await db.applications.update(id, { ...patch, updatedAt: Date.now() });
}

export async function listApplications(limit = 500): Promise<Application[]> {
  const rows = await db.applications.orderBy('at').reverse().toArray();
  return rows.slice(0, limit);
}

export async function applicationsForJob(jobId: string): Promise<Application[]> {
  return db.applications.where('jobId').equals(jobId).toArray();
}

export async function dueFollowUps(now = Date.now()): Promise<Application[]> {
  const rows = await db.applications.toArray();
  return rows.filter((a) => a.followUpAt !== undefined && a.followUpAt <= now && a.state === 'sent');
}

export async function hasApplied(jobId: string): Promise<boolean> {
  const rows = await db.applications.where('jobId').equals(jobId).toArray();
  return rows.length > 0;
}

export async function setApplicationState(id: string, state: ApplicationState): Promise<void> {
  await updateApplication(id, { state });
}

/* ------------------------------- 简历 ------------------------------- */

export async function saveResume(resume: Resume): Promise<void> {
  await db.resumes.put(resume);
  const settings = await getSettings();
  if (!settings.activeResumeId) await saveSettings({ activeResumeId: resume.id });
}

export async function listResumes(): Promise<Resume[]> {
  return db.resumes.orderBy('updatedAt').reverse().toArray();
}

export async function getResume(id: string): Promise<Resume | undefined> {
  return db.resumes.get(id);
}

export async function getActiveResume(): Promise<Resume | undefined> {
  const settings = await getSettings();
  if (settings.activeResumeId) {
    const resume = await db.resumes.get(settings.activeResumeId);
    if (resume) return resume;
  }
  const all = await listResumes();
  return all[0];
}

export async function deleteResume(id: string): Promise<void> {
  await db.resumes.delete(id);
  const settings = await getSettings();
  if (settings.activeResumeId === id) {
    const rest = await listResumes();
    await saveSettings({ activeResumeId: rest[0]?.id });
  }
}

/* ------------------------------- 匹配 ------------------------------- */

export function matchId(resumeId: string, jobId: string): string {
  return `${resumeId}::${jobId}`;
}

export async function getMatch(resumeId: string, jobId: string): Promise<MatchRecord | undefined> {
  return db.matches.get(matchId(resumeId, jobId));
}

export async function putMatch(record: MatchRecord): Promise<void> {
  await db.matches.put(record);
}

export async function matchesForJob(jobId: string): Promise<MatchRecord[]> {
  return db.matches.where('jobId').equals(jobId).toArray();
}

/* ------------------------------- 配额 ------------------------------- */

export async function getQuota(platform: Job['platform'], now = Date.now()): Promise<QuotaRecord> {
  const id = quotaId(platform, now);
  const record = await db.quotas.get(id);
  return record ?? { id, date: localDateKey(now), platform, count: 0, updatedAt: now };
}

export async function incrementQuota(platform: Job['platform'], now = Date.now()): Promise<QuotaRecord> {
  const record = await getQuota(platform, now);
  const next: QuotaRecord = { ...record, count: record.count + 1, updatedAt: now };
  await db.quotas.put(next);
  return next;
}

/* ----------------------------- 风控信号 ----------------------------- */

function riskKey(platform: Job['platform']): string {
  return `risk:${platform}`;
}

export async function addRiskSignal(platform: Job['platform'], signal: RiskSignal): Promise<RiskSignal[]> {
  const record = await db.kv.get(riskKey(platform));
  const list = Array.isArray(record?.value) ? (record.value as RiskSignal[]) : [];
  const cutoff = Date.now() - 24 * 3_600_000;
  const next = [...list.filter((s) => s.at >= cutoff), signal].slice(-20);
  await db.kv.put({ key: riskKey(platform), value: next, updatedAt: Date.now() });
  return next;
}

export async function getRiskSignals(platform: Job['platform']): Promise<RiskSignal[]> {
  const record = await db.kv.get(riskKey(platform));
  return Array.isArray(record?.value) ? (record.value as RiskSignal[]) : [];
}

export async function clearRiskSignals(platform: Job['platform']): Promise<void> {
  await db.kv.delete(riskKey(platform));
}

/* ------------------------------- 统计 ------------------------------- */

export interface Stats {
  jobs: number;
  starred: number;
  applied: number;
  byPlatform: Record<string, number>;
  byStatus: Record<string, number>;
  replies: number;
  interviews: number;
}

export async function stats(): Promise<Stats> {
  const [jobs, apps] = await Promise.all([db.jobs.toArray(), db.applications.toArray()]);
  const byPlatform: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const job of jobs) {
    byPlatform[job.platform] = (byPlatform[job.platform] ?? 0) + 1;
    byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  }
  return {
    jobs: jobs.length,
    starred: byStatus.starred ?? 0,
    applied: apps.length,
    byPlatform,
    byStatus,
    replies: apps.filter((a) => a.state === 'replied' || a.state === 'interview').length,
    interviews: apps.filter((a) => a.state === 'interview').length,
  };
}

/* ------------------------------ 导出 ------------------------------ */

export async function exportJobs(): Promise<Job[]> {
  return queryJobs({ orderBy: 'lastSeenAt' });
}

export async function clearAll(): Promise<void> {
  await db.transaction('rw', [db.jobs, db.applications, db.matches, db.quotas, db.kv], async () => {
    await Promise.all([db.jobs.clear(), db.applications.clear(), db.matches.clear(), db.quotas.clear(), db.kv.clear()]);
  });
}

/**
 * 清理字段残缺的记录：公司/城市都没采到的岗位（通常是选择器没命中时留下的），
 * 它们还会污染去重键，重采前清掉最省事。
 */
export async function purgeIncompleteJobs(): Promise<number> {
  const ids: string[] = [];
  await db.jobs.each((job) => {
    if (job.company === '未知公司' || job.city === '未知') ids.push(job.id);
  });
  if (ids.length === 0) return 0;
  await db.jobs.bulkDelete(ids);
  return ids.length;
}
