import type { PlatformAdapter } from '../adapters/base';
import type { ApplyMessage, ApplyResult } from '../shared/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const style = window.getComputedStyle(el as HTMLElement);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = (el as HTMLElement).getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function firstVisible(root: ParentNode, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    let nodes: Element[];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (isVisible(node)) return node as HTMLElement;
    }
  }
  return null;
}

function toast(text: string, tone: 'info' | 'warn' | 'ok' = 'info', timeoutMs = 6000): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'workget-toast';
  el.textContent = text;
  el.style.cssText = [
    'position:fixed',
    'right:20px',
    'bottom:24px',
    'z-index:2147483647',
    'max-width:360px',
    'padding:12px 16px',
    'border-radius:10px',
    'font-size:13px',
    'line-height:1.5',
    'color:#fff',
    'box-shadow:0 8px 24px rgba(0,0,0,.24)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
    `background:${tone === 'warn' ? '#c2410c' : tone === 'ok' ? '#0f766e' : '#1f2937'}`,
  ].join(';');
  document.body.appendChild(el);
  if (timeoutMs > 0) setTimeout(() => el.remove(), timeoutMs);
  return el;
}

function highlight(el: HTMLElement): void {
  el.style.outline = '3px solid #f59e0b';
  el.style.outlineOffset = '2px';
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => {
    el.style.outline = '';
    el.style.outlineOffset = '';
  }, 20_000);
}

/** 给 contenteditable / input 填值，React 受控组件也能收到事件。 */
function setFieldValue(el: HTMLElement, text: string): boolean {
  const isEditable = el.isContentEditable;
  if (isEditable) {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      el.textContent = text;
    }
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }),
    );
    return true;
  }
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, text);
  else input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function waitFor(
  getter: () => HTMLElement | null,
  timeoutMs: number,
  intervalMs = 300,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = getter();
    if (found) return found;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * 半自动投递。设计原则：每一步失败都退出并交还给人，绝不"猜着点"。
 * 真正的发送按钮默认交给用户按（autoSend=false），只有用户显式开启才自动点。
 */
export async function runApply(adapter: PlatformAdapter, msg: ApplyMessage): Promise<ApplyResult> {
  const risk = adapter.detectRiskSignal(document);
  if (risk) {
    toast(`检测到风控信号（${risk.evidence}），已停止操作，请手动处理`, 'warn', 12_000);
    return { ok: false, stage: 'blocked', reason: risk.evidence };
  }

  const config = adapter.config;
  const card =
    adapter.findCard(document, msg.platformJobId) ??
    null;

  if (card) {
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(400);
  }

  const scope: ParentNode = card ?? document;
  const applyButton =
    firstVisible(scope, config.apply.button) ?? (card ? firstVisible(document, config.apply.button) : null);

  if (!applyButton) {
    return {
      ok: false,
      stage: 'failed',
      reason: '没找到"沟通/投递"按钮（页面结构可能已改版，请在设置里用选择器自检更新）',
    };
  }

  applyButton.click();
  await sleep(600);

  const input = await waitFor(() => firstVisible(document, config.apply.input), 12_000);
  if (!input) {
    return { ok: false, stage: 'failed', reason: '已点击沟通按钮，但没等到聊天输入框；请手动粘贴话术发送' };
  }

  setFieldValue(input, msg.message);
  await sleep(300);

  const sendButton = firstVisible(document, config.apply.send);

  if (!msg.autoSend) {
    if (sendButton) highlight(sendButton);
    toast('话术已填好，请检查内容后手动点击发送。发送后回来点"已投递"记录。', 'ok', 15_000);
    return { ok: true, stage: 'filled' };
  }

  if (!sendButton) {
    return { ok: false, stage: 'failed', reason: '话术已填好，但没找到发送按钮；请手动发送' };
  }

  // 自动发送前再确认一次没有风控
  if (adapter.detectRiskSignal(document)) {
    return { ok: false, stage: 'blocked', reason: '发送前检测到风控信号，已中止' };
  }

  await sleep(1200 + Math.random() * 1800);
  sendButton.click();
  toast('已自动发送打招呼消息', 'ok');
  return { ok: true, stage: 'sent' };
}
