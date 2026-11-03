import { describe, expect, it } from 'vitest';
import {
  GLOBAL_MIN_INTERVAL_MS,
  canApply,
  localDateKey,
  pickIntervalMs,
  quotaId,
  remainingQuota,
  shouldThrottle,
} from '../src/shared/quota';
import { RISK_LABEL, detectRiskSignal, shouldCircuitBreak } from '../src/shared/guard';
import type { RiskSignal } from '../src/shared/types';

const NOW = new Date(2026, 10, 3, 22, 40, 0).getTime();

describe('localDateKey', () => {
  it('输出本地时区 YYYY-MM-DD', () => {
    expect(localDateKey(NOW)).toBe('2026-11-03');
  });

  it('个位数月份日期补零', () => {
    expect(localDateKey(new Date(2026, 0, 5, 9, 0, 0).getTime())).toBe('2026-01-05');
  });

  it('配额 id 带平台', () => {
    expect(quotaId('boss', NOW)).toBe('2026-11-03|boss');
  });
});

describe('配额', () => {
  it('未达上限允许投递', () => {
    expect(canApply(0, 20)).toBe(true);
    expect(canApply(19, 20)).toBe(true);
  });

  it('达到上限即停止', () => {
    expect(canApply(20, 20)).toBe(false);
    expect(canApply(21, 20)).toBe(false);
  });

  it('剩余量不会为负', () => {
    expect(remainingQuota(20, 20)).toBe(0);
    expect(remainingQuota(25, 20)).toBe(0);
    expect(remainingQuota(5, 20)).toBe(15);
  });
});

describe('pickIntervalMs', () => {
  it('随机值落在区间内', () => {
    expect(pickIntervalMs([10_000, 30_000], () => 0)).toBe(10_000);
    expect(pickIntervalMs([10_000, 30_000], () => 1)).toBe(30_000);
    expect(pickIntervalMs([10_000, 30_000], () => 0.5)).toBe(20_000);
  });

  it('区间写反也能正常工作', () => {
    expect(pickIntervalMs([30_000, 10_000], () => 0)).toBe(10_000);
  });
});

describe('shouldThrottle', () => {
  it('从未投递过返回 0', () => {
    expect(shouldThrottle(undefined, NOW)).toBe(0);
  });

  it('间隔不足返回剩余等待时间', () => {
    expect(shouldThrottle(NOW - 3_000, NOW)).toBe(GLOBAL_MIN_INTERVAL_MS - 3_000);
  });

  it('间隔足够返回 0', () => {
    expect(shouldThrottle(NOW - GLOBAL_MIN_INTERVAL_MS, NOW)).toBe(0);
    expect(shouldThrottle(NOW - 60_000, NOW)).toBe(0);
  });
});

describe('detectRiskSignal', () => {
  it('识别安全验证', () => {
    expect(detectRiskSignal('请完成以下验证后继续', NOW)).toMatchObject({ kind: 'captcha', at: NOW });
  });

  it('识别操作频繁', () => {
    expect(detectRiskSignal('操作过于频繁，请稍后再试', NOW)?.kind).toBe('frequent');
  });

  it('识别登录失效', () => {
    expect(detectRiskSignal('登录已失效，请重新登录', NOW)?.kind).toBe('login');
  });

  it('正常文案不误报', () => {
    expect(detectRiskSignal('前端开发工程师 15-25K 杭州', NOW)).toBeNull();
    expect(detectRiskSignal('', NOW)).toBeNull();
  });

  it('证据取命中的原文片段', () => {
    expect(detectRiskSignal('系统检测：滑动验证', NOW)?.evidence).toContain('滑动验证');
  });

  it('每种风控都有中文标签', () => {
    for (const kind of ['captcha', 'frequent', 'login', 'unknown'] as const) {
      expect(RISK_LABEL[kind]).toBeTruthy();
    }
  });
});

describe('shouldCircuitBreak', () => {
  const signal = (at: number): RiskSignal => ({ kind: 'frequent', evidence: '操作频繁', at });

  it('窗口内达到阈值即熔断', () => {
    expect(shouldCircuitBreak([signal(NOW - 1_000), signal(NOW)], { now: NOW })).toBe(true);
  });

  it('只有一条信号不熔断', () => {
    expect(shouldCircuitBreak([signal(NOW - 1_000)], { now: NOW })).toBe(false);
  });

  it('窗口外的旧信号不计入', () => {
    const old = signal(NOW - 60 * 60_000);
    expect(shouldCircuitBreak([old, signal(NOW)], { now: NOW })).toBe(false);
  });

  it('无信号不熔断', () => {
    expect(shouldCircuitBreak([], { now: NOW })).toBe(false);
  });
});
