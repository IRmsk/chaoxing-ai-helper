import { FILL_MAX_RETRY, SEND_VERIFY_TIMEOUT_MS } from '@/common/constants';
import { CxaiError } from '@/common/errors';
import { isVisible, normalizeText, sleep, waitUntil } from '@/common/dom-utils';
import { createLogger } from '@/common/logger';
import type { ChatTargets } from '@/types';
import { findUnlockButton } from './detector';
import { getMessagesSignature } from './observer';

/**
 * 输入与发送注入器。
 *
 * 负责文档 4.3 / 4.4 的两件事：
 * 1. 把 DeepSeek 的回答「像真人一样」写进学习通的输入框 —— 学习通是 Vue 应用，
 *    直接赋 `el.value` 不会触发框架的 onChange，必须走原生 setter + 派发 input 事件；
 *    `contenteditable` 则走 `document.execCommand('insertText')`。
 * 2. 触发发送 —— 优先点击发送按钮，失败退化为 Enter 键，并校验发送结果。
 */

const log = createLogger('content:injector');

/* ------------------------------------------------------------------ */
/* 文本读写                                                            */
/* ------------------------------------------------------------------ */

// 说明：`normalizeText` 定义在 `@/common/dom-utils`，此处重新导出，
// 以保持 content 层调用方的导入路径稳定。
export { normalizeText };

/**
 * 读取输入框当前内容。
 *
 * @param el 输入框元素。
 */
export function readInputValue(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return (el.innerText ?? el.textContent ?? '').trim();
}

/* ------------------------------------------------------------------ */
/* 写入                                                               */
/* ------------------------------------------------------------------ */

/**
 * 通过原生 value setter 写值并派发事件（React/Vue 受控组件适配）。
 *
 * @param el textarea / input 元素。
 * @param value 目标文本。
 */
function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 清空 contenteditable 内容。 */
function clearContentEditable(el: HTMLElement): void {
  el.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const deleted = document.execCommand('delete', false);
    if (deleted && normalizeText(el.innerText ?? '') === '') return;
  } catch {
    /* 继续走兜底清空 */
  }
  el.innerHTML = '';
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
}

/**
 * 写入 contenteditable（按尝试次数升级策略）。
 *
 * @param el contenteditable 元素。
 * @param text 目标文本。
 * @param attempt 当前尝试次数（1 起）。
 */
async function writeContentEditable(el: HTMLElement, text: string, attempt: number): Promise<void> {
  clearContentEditable(el);
  el.focus();

  if (attempt >= 3) {
    // 第 3 次尝试：逐段插入，最接近真实输入节奏
    const chunks = text.match(/[\s\S]{1,12}/g) ?? [text];
    for (const chunk of chunks) {
      document.execCommand('insertText', false, chunk);
      await sleep(20);
    }
    return;
  }

  const ok = document.execCommand('insertText', false, text);
  if (!ok || normalizeText(readInputValue(el)) === '') {
    // 兜底：直接写 DOM + 手动派发 input（execCommand 已被现代浏览器标记为废弃）
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

/**
 * 把文本写入输入框（不校验，仅执行一次写入动作）。
 *
 * @param el 输入框元素。
 * @param text 目标文本。
 * @param attempt 尝试次数。
 */
async function applyText(el: HTMLElement, text: string, attempt: number): Promise<void> {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    setNativeValue(el, text);
    return;
  }
  await writeContentEditable(el, text, attempt);
}

/**
 * 写入并在写入后校验，最多重试 `FILL_MAX_RETRY` 次。
 *
 * @param el 输入框元素。
 * @param text 目标文本。
 * @param options.signal 中止信号。
 * @throws CxaiError('FILL_FAILED') 全部重试仍不一致时抛出。
 */
export async function fillInput(
  el: HTMLElement,
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const expected = normalizeText(text);

  for (let attempt = 1; attempt <= FILL_MAX_RETRY; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      await applyText(el, text, attempt);
    } catch (err) {
      log.warn(`第 ${attempt} 次写入抛出异常：${(err as Error)?.message ?? String(err)}`);
    }
    await sleep(150, options.signal);

    const actual = normalizeText(readInputValue(el));
    if (actual === expected) {
      log.info(`输入框写入并校验通过（第 ${attempt} 次尝试，${expected.length} 字）`);
      return;
    }
    log.warn(`第 ${attempt} 次写入校验不一致：期望 ${expected.length} 字 / 实际 ${actual.length} 字`);
  }

  throw new CxaiError(
    'FILL_FAILED',
    `连续 ${FILL_MAX_RETRY} 次写入均未通过校验，请用「选择器调试模式」重新指定输入框元素。`,
    false,
  );
}

/* ------------------------------------------------------------------ */
/* 输入框解锁                                                          */
/* ------------------------------------------------------------------ */

/**
 * 判断输入框是否处于「锁定 / 不可输入」状态。
 *
 * 学习通 AI 实践在轮到学生作答前，输入框是锁定的：
 * `textarea.messageInput.messageInputLock`，并且是 `disabled` 状态。
 *
 * @param el 输入框元素。
 */
export function isInputLocked(el: HTMLElement): boolean {
  const isFormControl = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  if (isFormControl) {
    const control = el as HTMLTextAreaElement;
    if (control.disabled || control.readOnly) return true;
  } else if (!el.isContentEditable) {
    return true;
  }
  return /lock|disabled|readonly/i.test(el.className?.toString?.() ?? '');
}

/**
 * 确保输入框可写：若处于锁定态，则点击「继续 / 开始作答」按钮解锁。
 *
 * 这是真实站点上必须的一步 —— 不点「继续」，输入框既无法输入，发送按钮也是锁的
 * （`span.sendBtn.optionBtnLock`），整个自动化会「看起来毫无效果」。
 *
 * @param input 输入框元素。
 * @param unlockBtn 「继续」按钮（可能不存在）。
 * @param options.signal 中止信号。
 * @param options.timeoutMs 等待解锁的超时毫秒数。
 */
export async function ensureInputReady(
  input: HTMLElement,
  unlockBtn: HTMLElement | null,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const { signal, timeoutMs = 6000 } = options;
  if (!isInputLocked(input)) return;

  // 缓存的按钮可能已被页面重渲染替换，这里做一次兜底查找
  let button = unlockBtn && unlockBtn.isConnected && isVisible(unlockBtn) ? unlockBtn : null;
  if (!button) button = findUnlockButton(input);

  if (!button) {
    log.warn('输入框处于锁定状态，但未找到「继续」按钮，将直接尝试写入');
    return;
  }

  log.info('输入框已锁定，点击「继续」解锁');
  clickElement(button);

  try {
    await waitUntil(() => !isInputLocked(input), { timeoutMs, intervalMs: 150, signal });
    log.info('输入框已解锁');
  } catch (err) {
    if (err instanceof DOMException) throw err;
    log.warn(`点击「继续」后输入框仍未解锁（${timeoutMs}ms 超时），将直接尝试写入`);
  }
  await sleep(150, signal);
}

/* ------------------------------------------------------------------ */
/* 发送                                                               */
/* ------------------------------------------------------------------ */

/**
 * 点击一个元素。
 *
 * ## 为什么要「指针序列 + 原生 click」两步走
 *
 * - **原生 `el.click()`** 是标准激活路径（会触发默认行为、派发真正的 click 事件），
 *   比手工 `new MouseEvent('click')` 更贴近真实用户点击，兼容性最好。
 * - **指针 / 鼠标按下抬起序列** 是为了照顾那些只监听 `pointerdown` / `mousedown`
 *   的自绘控件。
 *
 * 两者按真实用户的顺序组合，合计恰好一次 click：不会漏，也不会重复调用处理器。
 *
 * > 注：曾经怀疑「手工派发 click 打不动 Vue 的 @click」是某些按钮点不动的原因，
 * > 后来在真机上定位到**真正的原因是按文案找按钮时点到了包着按钮的容器**
 * > （见 `flow-dom.ts` 的 `findButtonByText`）。这条实现仍然保留 ——
 * > 它更接近真实点击，且已用回归钉死「一次点击只触发一次处理器」。
 *
 * @param el 目标元素。
 * @returns 是否派发成功。
 */
export function clickElement(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', base));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
  } catch (err) {
    // 某些环境不支持 PointerEvent 构造函数 —— 不影响后面的原生 click
    log.debug(`派发指针事件失败（忽略）：${(err as Error)?.message ?? String(err)}`);
  }

  try {
    // ⭐ 关键：用原生 click()，不要手工 new MouseEvent('click') 派发
    el.click();
    return true;
  } catch (err) {
    log.warn(`原生 click() 失败，退回手工派发 click：${(err as Error)?.message ?? String(err)}`);
    try {
      el.dispatchEvent(new MouseEvent('click', base));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 派发 Enter 键事件。
 *
 * 注意：`KeyboardEvent` 构造出的对象 `keyCode` 恒为 0，而 Vue/React 组件常以
 * `e.keyCode === 13` 判定回车 —— 因此这里用 `Object.defineProperty` 覆写该属性。
 *
 * @param el 目标元素（通常是输入框）。
 */
function dispatchEnter(el: HTMLElement): void {
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    const event = new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(event, 'keyCode', { get: () => 13 });
    Object.defineProperty(event, 'which', { get: () => 13 });
    el.dispatchEvent(event);
  }
}

/**
 * 校验「是否发送成功」。
 *
 * 判据（满足其一即视为成功）：
 * 1. 消息列表签名发生变化（新增了我方消息）；
 * 2. 输入框内容已不再等于刚写入的文本（被清空或被框架接管）。
 *
 * @param targets 探测结果。
 * @param beforeSignature 发送前的签名。
 * @param sentText 刚写入的文本。
 * @param timeoutMs 校验等待上限。
 * @param signal 中止信号。
 */
async function verifySent(
  targets: ChatTargets,
  beforeSignature: string,
  sentText: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expected = normalizeText(sentText);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const signature = getMessagesSignature(targets.list);
    if (signature !== beforeSignature) {
      log.info('发送成功：消息列表已新增一条记录');
      return true;
    }
    const value = normalizeText(readInputValue(targets.input));
    if (expected && value !== expected) {
      log.info('发送成功：输入框已被清空/接管');
      return true;
    }
    await sleep(200, signal);
  }
  return false;
}

/**
 * 触发发送（按钮优先，Enter 兜底），并校验发送结果。
 *
 * @param targets 探测结果。
 * @param options.beforeSignature 发送前消息列表签名。
 * @param options.sentText 刚写入的文本。
 * @param options.signal 中止信号。
 * @throws CxaiError('SEND_FAILED') 未检测到发送成功时抛出。
 */
export async function sendMessage(
  targets: ChatTargets,
  options: { beforeSignature: string; sentText: string; signal?: AbortSignal },
): Promise<void> {
  const { beforeSignature, sentText, signal } = options;

  // 方案 1：点击发送按钮
  if (targets.sendBtn?.isConnected) {
    log.info('尝试点击发送按钮');
    clickElement(targets.sendBtn);
    if (await verifySent(targets, beforeSignature, sentText, 1500, signal)) return;
    log.warn('点击发送按钮后未检测到新消息，尝试 Enter 兜底');
  } else {
    log.info('未命中发送按钮，直接使用 Enter 发送');
  }

  // 方案 2：Enter 键
  dispatchEnter(targets.input);
  if (await verifySent(targets, beforeSignature, sentText, SEND_VERIFY_TIMEOUT_MS, signal)) return;

  // 方案 3：再次点击（部分组件需要先 blur 才提交）
  if (targets.sendBtn?.isConnected) {
    targets.input.blur();
    await sleep(120, signal);
    clickElement(targets.sendBtn);
    if (await verifySent(targets, beforeSignature, sentText, 2500, signal)) return;
  }

  throw new CxaiError(
    'SEND_FAILED',
    '已尝试点击发送按钮与回车键，但未检测到新消息。请确认发送按钮可用（未置灰/未限流），或用「选择器调试模式」重新指定发送按钮。',
    true,
  );
}
