import type { Platform } from './types';

export interface QuotaRecord {
  /** `${date}|${platform}` */
  id: string;
  date: string;
  platform: Platform;
  count: number;
  updatedAt: number;
}

/** 本地时区的 YYYY-MM-DD，跨天自然重置配额。 */
export function localDateKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function quotaId(platform: Platform, now: number = Date.now()): string {
  return `${localDateKey(now)}|${platform}`;
}

export function remainingQuota(count: number, limit: number): number {
  return Math.max(0, limit - count);
}

export function canApply(count: number, limit: number): boolean {
  return count < limit;
}

/** [min,max] 内随机间隔，给平台侧呈现人类节奏。 */
export function pickIntervalMs(range: [number, number], rng: () => number = Math.random): number {
  const [min, max] = range[0] <= range[1] ? range : [range[1], range[0]];
  const lo = Math.max(0, min);
  const hi = Math.max(lo, max);
  return Math.round(lo + rng() * (hi - lo));
}

/** 全局节流：两次投递之间的最小间隔（毫秒），避免批量确认时过快。 */
export const GLOBAL_MIN_INTERVAL_MS = 8_000;

export function shouldThrottle(lastApplyAt: number | undefined, now: number = Date.now()): number {
  if (!lastApplyAt) return 0;
  const elapsed = now - lastApplyAt;
  return elapsed >= GLOBAL_MIN_INTERVAL_MS ? 0 : GLOBAL_MIN_INTERVAL_MS - elapsed;
}
