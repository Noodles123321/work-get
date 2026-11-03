import type { RiskSignal } from './types';

interface Pattern {
  re: RegExp;
  kind: RiskSignal['kind'];
}

/**
 * 风控信号识别。宁可误报也不要漏报：一旦命中就停用该平台，让用户人工处理。
 * 只匹配页面可见文案，不探测任何隐藏机制。
 */
const PATTERNS: Pattern[] = [
  { re: /(安全验证|请完成(以下)?验证|人机验证|滑动验证|拖动滑块|点击完成验证|验证码)/, kind: 'captcha' },
  { re: /(操作(过于)?频繁|访问(过于)?频繁|请求(过于)?频繁|请稍后再试|稍后再试|操作太快|休息一下)/, kind: 'frequent' },
  { re: /(登录已?失效|请先登录|重新登录|账号(异常|存在风险)|异常登录)/, kind: 'login' },
];

export function detectRiskSignal(text: string | null | undefined, now: number = Date.now()): RiskSignal | null {
  const content = (text ?? '').replace(/\s+/g, ' ');
  if (!content) return null;
  for (const { re, kind } of PATTERNS) {
    const m = content.match(re);
    if (m) {
      return { kind, evidence: m[0], at: now };
    }
  }
  return null;
}

/** 同一平台窗口期内出现 N 次信号即熔断。 */
export function shouldCircuitBreak(
  signals: RiskSignal[],
  options: { windowMs?: number; threshold?: number; now?: number } = {},
): boolean {
  const windowMs = options.windowMs ?? 10 * 60_000;
  const threshold = options.threshold ?? 2;
  const now = options.now ?? Date.now();
  const recent = signals.filter((s) => now - s.at <= windowMs);
  return recent.length >= threshold;
}

export const RISK_LABEL: Record<RiskSignal['kind'], string> = {
  captcha: '需要人机验证',
  frequent: '操作频率被限制',
  login: '登录态失效',
  unknown: '未知风控',
};
