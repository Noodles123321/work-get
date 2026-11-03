import { adapterForUrl, type SelectorOverrides } from '../adapters/registry';
import type { PlatformAdapter } from '../adapters/base';
import { detectRiskSignal } from '../shared/guard';
import type { ApplyMessage, ApplyResult, CaptureMessage, RawJob } from '../shared/types';
import { runApply } from '../content/apply';

const SWEEP_DEBOUNCE_MS = 900;
const RISK_COOLDOWN_MS = 5 * 60_000;

export default defineContentScript({
  matches: [
    '*://*.zhipin.com/*',
    '*://*.liepin.com/*',
    '*://*.zhaopin.com/*',
    '*://*.yupao.com/*',
  ],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    void bootstrap();
  },
});

async function fetchOverrides(): Promise<SelectorOverrides | undefined> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'WORKGET_CONFIG' })) as
      | { ok: boolean; overrides?: SelectorOverrides }
      | undefined;
    return res?.ok ? res.overrides : undefined;
  } catch {
    return undefined;
  }
}

function send(
  message:
    | CaptureMessage
    | { type: 'WORKGET_RISK'; platform: string; kind: string; evidence: string },
): void {
  try {
    void chrome.runtime.sendMessage(message);
  } catch {
    /* 扩展被重载时 runtime 会失效，忽略即可 */
  }
}

async function bootstrap(): Promise<void> {
  const overrides = await fetchOverrides();
  const adapter = adapterForUrl(location.href, overrides);
  if (!adapter) return;

  const captured = new Set<string>();
  let sweepTimer: number | undefined;
  let riskCooldownUntil = 0;
  let lastUrl = location.href;

  const reportRisk = (evidence: string, kind: string): void => {
    riskCooldownUntil = Date.now() + RISK_COOLDOWN_MS;
    send({ type: 'WORKGET_RISK', platform: adapter.id, kind, evidence });
    console.warn(`[Work GET] 检测到风控信号，暂停采集：${evidence}`);
  };

  const sweep = (): void => {
    if (Date.now() < riskCooldownUntil) return;
    const signal = detectRiskSignal(document.body?.innerText ?? '');
    if (signal) {
      reportRisk(signal.evidence, signal.kind);
      return;
    }

    const jobs: RawJob[] = [];
    const onList = adapter.isListPage(location.href);
    const onDetail = adapter.isDetailPage(location.href);

    if (onList || (!onDetail && adapter.matches(location.href))) {
      for (const job of adapter.extractList(document, { limit: 120 })) {
        const key = job.platformJobId;
        if (captured.has(key)) continue;
        captured.add(key);
        jobs.push(job);
      }
    }

    if (onDetail) {
      const detail = adapter.extractDetail(document, location.href);
      if (detail && !captured.has(detail.platformJobId)) {
        captured.add(detail.platformJobId);
        jobs.push(detail);
      }
    }

    if (jobs.length > 0) send({ type: 'WORKGET_CAPTURE', jobs });
  };

  const scheduleSweep = (delay = SWEEP_DEBOUNCE_MS): void => {
    window.clearTimeout(sweepTimer);
    sweepTimer = window.setTimeout(sweep, delay);
  };

  // SPA 换页：BOSS/猎聘 都是前端路由，pushState 不会触发 load
  const onUrlChange = (): void => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    captured.clear();
    scheduleSweep(1200);
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      window.setTimeout(onUrlChange, 0);
      return result;
    } as History[typeof method];
  }
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);

  const observer = new MutationObserver(() => scheduleSweep());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: unknown) => void) => {
      const msg = message as { type?: string };
      if (msg?.type === 'WORKGET_PING') {
        sendResponse({ ok: true });
        return false;
      }
      if (msg?.type === 'WORKGET_APPLY') {
        void runApply(adapter, message as ApplyMessage).then(sendResponse);
        return true;
      }
      if (msg?.type === 'WORKGET_SELFTEST') {
        sendResponse(selfTest(adapter));
        return false;
      }
      return false;
    },
  );

  // 首次 & 兜底轮询（部分页面懒加载不触发 mutation）
  scheduleSweep(800);
  window.setInterval(() => scheduleSweep(0), 15_000);
  console.info(`[Work GET] 已接入 ${adapter.label} 采集`);
}

/** 选择器自检：把每条规则的命中数报给设置页，方便平台改版时定位。 */
function domHint(adapter: PlatformAdapter): unknown {
  const cfg = adapter.config;
  let card: Element | null = null;
  for (const selector of cfg.listItem) {
    let found: Element[] = [];
    try {
      found = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (found.length === 0) continue;
    const titleSelectors = toSelectors(cfg.fields.title);
    const withTitle = found.find((el) =>
      titleSelectors.some((s) => {
        try {
          return el.querySelector(s) !== null;
        } catch {
          return false;
        }
      }),
    );
    card = withTitle ?? found[0] ?? null;
    break;
  }
  if (!card) return null;
  const descendants = Array.from(card.querySelectorAll('*'))
    .slice(0, 60)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') ?? '').slice(0, 80),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }));
  // 薪资数字有时被站点用伪元素/属性渲染，textContent 只剩 "-K"；这里把能读到的都摊开。
  const salaryEl = card.querySelector('.job-salary');
  const salaryProbe = salaryEl
    ? (() => {
        const text = salaryEl.textContent ?? '';
        const style = getComputedStyle(salaryEl);
        return {
          html: salaryEl.outerHTML.slice(0, 600),
          text,
          length: text.length,
          codepoints: Array.from(text).map((ch) => ch.codePointAt(0)?.toString(16)),
          attrs: Array.from(salaryEl.attributes).map((a) => `${a.name}=${a.value}`),
          before: getComputedStyle(salaryEl, '::before').content,
          after: getComputedStyle(salaryEl, '::after').content,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          color: style.color,
          childNodes: Array.from(salaryEl.childNodes).map((n) => `${n.nodeType}:${n.nodeName}`),
          parentHtml: (salaryEl.parentElement?.outerHTML ?? '').slice(0, 900),
        };
      })()
    : null;
  return {
    tag: card.tagName.toLowerCase(),
    className: card.getAttribute('class') ?? '',
    descendants,
    salaryProbe,
    html: card.outerHTML.replace(/\s+/g, ' ').slice(0, 3500),
  };
}

function selfTest(adapter: PlatformAdapter): unknown {
  const cfg = adapter.config;
  const count = (selector: string): number => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1; // -1 = 选择器本身写错了（非法语法）
    }
  };
  const report = (selectors: string[]) => selectors.map((selector) => ({ selector, count: count(selector) }));

  const fields: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(cfg.fields)) {
    fields[key] = report(toSelectors(rule));
  }

  return {
    ok: true,
    platform: adapter.id,
    label: adapter.label,
    url: location.href,
    isListPage: adapter.isListPage(location.href),
    isDetailPage: adapter.isDetailPage(location.href),
    loginState: adapter.detectLoginState(document),
    risk: adapter.detectRiskSignal(document),
    listItem: report(cfg.listItem),
    fields,
    apply: {
      button: report(cfg.apply.button),
      input: report(cfg.apply.input),
      send: report(cfg.apply.send),
    },
    sample: adapter.extractList(document, { limit: 2 }),
    domHint: domHint(adapter),
  };
}

function toSelectors(rule: unknown): string[] {
  if (typeof rule === 'string') return [rule];
  if (Array.isArray(rule)) return rule.filter((s): s is string => typeof s === 'string');
  if (rule && typeof rule === 'object' && 'selector' in rule) {
    const selector = (rule as { selector?: string | string[] }).selector;
    if (typeof selector === 'string') return [selector];
    if (Array.isArray(selector)) return selector;
  }
  return [];
}
