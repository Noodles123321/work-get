/**
 * 侧边栏 → DSH 桥（dsh-workget-bridge 插件）的客户端。
 *
 * 契约见 docs/dsh-bridge.md：
 *   GET  /health  → { ok, name, version, pushes, ... }
 *   POST /push    → { jobs: [...] } → { ok, sessionId, count, duplicate }
 *
 * 这里只负责三件事：裁剪出要推的岗位、发请求并把错误翻译成人话、成功后回写 dshPushedAt。
 */

import { markJobsPushed } from '../db/repo';
import type { DshBridgeSettings, Job, Platform } from '../shared/types';

/** 与插件端 sanitizeJob 对齐的最小子集（多传无害，插件会再清洗一遍） */
export interface PushJob {
  id: string;
  platform: Platform;
  platformJobId: string;
  title: string;
  company: string;
  city: string;
  salary?: { min?: number; max?: number; unit: string; months?: number; raw: string };
  experienceMin?: number;
  experienceMax?: number;
  education?: string;
  tags: string[];
  url: string;
  ruleScore?: number;
  description?: string;
  hrActiveText?: string;
}

export type PushErrorCode =
  | 'disabled'
  | 'no_token'
  | 'unreachable'
  | 'unauthorized'
  | 'too_many_jobs'
  | 'empty_jobs'
  | 'deliver_failed'
  | 'bad_response';

export interface PushResponse {
  ok: boolean;
  sessionId?: string;
  count: number;
  duplicate?: boolean;
  platforms?: Platform[];
  error?: PushErrorCode;
  message?: string;
}

export interface PushAttempt {
  /** 实际送出的条数 */
  count: number;
  /** 因为超过 maxJobs 被丢掉的条数 */
  skipped: number;
  response: PushResponse;
}

const DEFAULT_TIMEOUT_MS = 8000;

export function normalizeBaseUrl(raw: string): string {
  const text = (raw || '').trim() || 'http://127.0.0.1:3610';
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  return withScheme.replace(/\/+$/, '');
}

/** 从数据库的 Job 里裁出要推的字段；只保留有标题和链接的。 */
export function buildPushPayload(jobs: Job[], maxJobs: number): { jobs: PushJob[]; skipped: number } {
  const limit = Number.isFinite(maxJobs) && maxJobs > 0 ? Math.floor(maxJobs) : 20;
  const seen = new Set<string>();
  const picked: PushJob[] = [];

  for (const job of jobs) {
    if (!job.title || !job.url) continue;
    const key = job.id || `${job.platform}:${job.platformJobId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (picked.length >= limit) continue;
    picked.push({
      id: job.id,
      platform: job.platform,
      platformJobId: job.platformJobId,
      title: job.title,
      company: job.company,
      city: job.city,
      salary: job.salary
        ? { min: job.salary.min, max: job.salary.max, unit: job.salary.unit, months: job.salary.months, raw: job.salary.raw }
        : undefined,
      experienceMin: job.experienceMin,
      experienceMax: job.experienceMax,
      education: job.education,
      tags: job.tags,
      url: job.url,
      ruleScore: job.ruleScore,
      description: job.description,
    });
  }

  return { jobs: picked, skipped: Math.max(0, jobs.length - picked.length) };
}

export function describePushError(code: PushErrorCode | undefined, message?: string): string {
  switch (code) {
    case 'disabled':
      return '推送已关闭：到「设置 → DSH 侧」打开开关';
    case 'no_token':
      return '还没填 token：打开 DSH 工作区下 .dsh-bridge/token.txt，复制整行到「设置 → DSH 侧」';
    case 'unreachable':
      return '连不上 DSH 桥：确认 DSH 已重启、插件已启用（端口 3610），或检查「设置 → DSH 侧」的地址';
    case 'unauthorized':
      return 'token 不匹配：重新复制 .dsh-bridge/token.txt 的内容（重启插件不会改 token）';
    case 'too_many_jobs':
      return message || '一次推太多条了，减少选择或调小「单次最多推送」';
    case 'empty_jobs':
      return '没有可推送的岗位：请先勾选或筛选出岗位';
    case 'deliver_failed':
      return `DSH 侧建会话失败：${message || '看 .dsh-bridge/bridge.log'}`;
    case 'bad_response':
      return `DSH 桥返回了看不懂的响应：${message || '检查插件版本是否匹配'}`;
    default:
      return message || '推送失败';
  }
}

function headersFor(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

export async function bridgeHealth(
  cfg: DshBridgeSettings,
  timeoutMs = 4000,
): Promise<{ ok: boolean; info?: Record<string, unknown>; message?: string }> {
  try {
    const res = await fetch(`${normalizeBaseUrl(cfg.url)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const info = (await res.json()) as Record<string, unknown>;
    if (info.name !== 'dsh-workget-bridge') return { ok: false, message: `服务名不对：${String(info.name)}`, info };
    return { ok: true, info };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function mapFailure(res: Response): Promise<PushResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 非 JSON 响应
  }
  const error = String(body.error || '');
  const message = typeof body.message === 'string' ? body.message : undefined;
  const code: PushErrorCode =
    res.status === 401
      ? 'unauthorized'
      : error === 'too_many_jobs'
        ? 'too_many_jobs'
        : error === 'empty_jobs'
          ? 'empty_jobs'
          : error === 'deliver_failed'
            ? 'deliver_failed'
            : 'bad_response';
  return { ok: false, count: 0, error: code, message };
}

/**
 * 推一批岗位到 DSH。成功后把 dshPushedAt 写回本地（失败不动）。
 * 返回值永远是结构化结果，不抛异常（UI 直接展示 response.message）。
 */
export async function pushJobs(
  jobs: Job[],
  cfg: DshBridgeSettings,
  opts: { timeoutMs?: number } = {},
): Promise<PushAttempt> {
  const { jobs: payload, skipped } = buildPushPayload(jobs, cfg.maxJobs);

  if (!cfg.enabled) return { count: 0, skipped, response: { ok: false, count: 0, error: 'disabled' } };
  if (!cfg.token.trim()) return { count: 0, skipped, response: { ok: false, count: 0, error: 'no_token' } };
  if (payload.length === 0) return { count: 0, skipped, response: { ok: false, count: 0, error: 'empty_jobs' } };

  const url = `${normalizeBaseUrl(cfg.url)}/push`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headersFor(cfg.token.trim()),
      body: JSON.stringify({ jobs: payload }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { count: 0, skipped, response: { ok: false, count: 0, error: 'unreachable', message } };
  }

  if (!res.ok) {
    const response = await mapFailure(res);
    return { count: 0, skipped, response };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { count: 0, skipped, response: { ok: false, count: 0, error: 'bad_response', message } };
  }

  if (body.ok !== true || typeof body.sessionId !== 'string') {
    return { count: 0, skipped, response: { ok: false, count: 0, error: 'bad_response', message: 'ok/sessionId 缺失' } };
  }

  const ids = payload.map((job) => job.id);
  await markJobsPushed(ids);

  return {
    count: payload.length,
    skipped,
    response: {
      ok: true,
      count: Number(body.count) || payload.length,
      sessionId: body.sessionId,
      duplicate: body.duplicate === true,
      platforms: Array.isArray(body.platforms) ? (body.platforms as Platform[]) : undefined,
    },
  };
}
