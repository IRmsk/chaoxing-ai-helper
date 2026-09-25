import { PAGE_CONTEXT_MAX_CHARS, REPLY_POLL_INTERVAL_MS, REPLY_STABLE_TIMES } from '@/common/constants';
import { CxaiError } from '@/common/errors';
import {
  classifySide,
  collectMessageItems,
  getVisibleText,
  isVisible,
  messageTextOf,
  normalizeText,
  sleep,
  type MessageItem,
  type MessageSide,
} from '@/common/dom-utils';
import { createLogger } from '@/common/logger';
import type { ChatTargets, SelectorOverrides } from '@/types';

/**
 * 对话状态观察器：负责「消息枚举 / 待答提问识别 / 回复完成检测」。
 *
 * ## 判定模型（v1.2 重构）
 *
 * 全部逻辑收敛到一句话：**取最后一条非空消息，看它是我方还是 AI。**
 *
 * - 最后一条是 **AI** ⇒ 这就是待作答的提问，读取它；
 * - 最后一条是 **我方** ⇒ 已经作答过，等 AI 回复，不做动作。
 *
 * 侧别由「命中哪一组选择器」直接决定（`.agent` ⇒ AI，`.userAnswer` ⇒ 我方），
 * 而不是靠猜；选择器全部失效时才退回 `classifySide` 的加权打分 + 几何兜底。
 *
 * ## 为什么不能用「被包含就去重」
 *
 * 学习通一轮问答的结构是 `.agent`（AI 提问）里**嵌着** `.userAnswer`（我方作答）。
 * 如果按「元素被其他候选包含就去重」处理，我方消息会被整片吞掉，
 * 而 `.agent` 的文本又是两边混在一起 —— 表现正好是
 * 「能探测到对话窗口，但读不对提问、也不会作答」。
 * 因此这里只剔除**同侧**嵌套，跨侧嵌套一律保留为两条独立消息。
 *
 * ## 我方消息排除
 *
 * 另外记录最近一次提交的文本，在挑选「AI 消息」时按归一化文本显式跳过，
 * 作为侧别判定失效时的第二道保险（否则会把自己的作答当成 AI 回复，陷入死循环）。
 */

const log = createLogger('content:observer');

/** 单条消息的视图对象。 */
export interface MessageView {
  el: HTMLElement;
  side: MessageSide;
  text: string;
  /** 轻量签名：元素下标 + 文本长度 + 文本前缀。 */
  signature: string;
}

/** 结束语特征：命中且不像提问时，判定实践已结束。 */
const ENDING_RE =
  /(已(经)?完成|本次[^。]{0,8}(结束|完成)|感谢[^。]{0,6}(参与|配合)|再见|祝[^。]{0,8}学习|实践[^。]{0,6}结束|没有[^。]{0,8}(其他|更多)[^。]{0,4}(问题|内容)|以上就是)/;
/** 提问特征。 */
const QUESTION_RE =
  /([?？]|请[^。]{0,6}(回答|说明|谈谈|说说|分析|列举)|你(认为|觉得|会|能)|如何|为什么|什么|是否|怎么|哪些|举例)/;

/** 判定「提问已输出完毕」所需的连续稳定采样次数。 */
const QUESTION_STABLE_TIMES = 2;
/** 提问轮询间隔。 */
const QUESTION_POLL_INTERVAL_MS = 600;

/* ------------------------------------------------------------------ */
/* 我方消息标记                                                        */
/* ------------------------------------------------------------------ */

/** 最近一次被我方提交到对话中的文本（归一化后）。 */
let ownSentText: string | null = null;

/**
 * 记录 / 清除「我方最近提交的文本」。
 *
 * @param text 提交的文本；传 `null` 清除。
 */
export function setOwnSentText(text: string | null): void {
  ownSentText = text ? normalizeText(text) : null;
}

/** 读取当前记录的我方文本。 */
export function getOwnSentText(): string | null {
  return ownSentText;
}

/** 判断某条消息是否就是我方刚提交的那条。 */
function isOwnMessage(text: string): boolean {
  if (!ownSentText) return false;
  return normalizeText(text) === ownSentText;
}

/* ------------------------------------------------------------------ */
/* 消息枚举                                                            */
/* ------------------------------------------------------------------ */

/** 可见且有文本的直接子元素。 */
function textChildren(el: HTMLElement): HTMLElement[] {
  return (Array.from(el.children) as HTMLElement[]).filter((c) => isVisible(c) && getVisibleText(c).length > 0);
}

/**
 * 最深一层的文本块（选择器与直接子元素都失效时的兜底）。
 *
 * 逐层向下，取第一个「有 ≥2 个带文本子节点」的层级，避免把整段列表当成一条消息。
 *
 * @param list 消息列表容器。
 * @param maxDepth 最大下探层数。
 */
function leafBlocks(list: HTMLElement, maxDepth = 3): HTMLElement[] {
  let level: HTMLElement[] = [list];
  let best: HTMLElement[] = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: HTMLElement[] = [];
    for (const node of level) {
      const kids = textChildren(node).filter((el) => {
        const rect = el.getBoundingClientRect();
        // 头像 / 图标等碎片节点按尺寸排除，避免「头像 + 气泡」被当成两条消息
        return rect.width >= 48 && rect.height >= 18;
      });
      next.push(...kids);
    }
    if (next.length === 0) break;
    best = next;
    if (next.length >= 2) break;
    level = next;
  }
  return best;
}

/**
 * 解析当前对话的全部消息（按文档顺序）。
 *
 * @param list 消息列表容器。
 */
export function getMessages(list: HTMLElement): MessageView[] {
  let items: MessageItem[] = collectMessageItems(list);

  // 选择器全部失效 → 退化为「列表内的文本块 + 加权/几何判定」
  if (items.length === 0) {
    const direct = textChildren(list);
    const blocks = direct.length >= 2 ? direct : leafBlocks(list);
    items = blocks.map((el) => ({ el, side: 'unknown' as MessageSide }));
    if (items.length > 0) log.info(`消息条目选择器未命中，退化为文本块解析（${items.length} 块）`);
  }

  return items.map((item, index) => {
    const text = messageTextOf(item, items);
    const side: MessageSide = item.side === 'unknown' ? classifySide(item.el, list) : item.side;
    return {
      el: item.el,
      side,
      text,
      signature: `${index}|${text.length}|${text.slice(0, 32)}`,
    };
  });
}

/** 过滤掉空消息（页面会预先渲染空的作答占位块）。 */
function nonEmpty(messages: MessageView[]): MessageView[] {
  return messages.filter((m) => m.text.trim().length > 0);
}

/** 统计当前消息条数。 */
export function countMessages(list: HTMLElement): number {
  return getMessages(list).length;
}

/** 取最后一条**非空**消息。 */
export function getLastMessage(list: HTMLElement): MessageView | null {
  const messages = nonEmpty(getMessages(list));
  return messages.length ? messages[messages.length - 1] : null;
}

/**
 * 消息列表的轻量签名（数量 + 末条文本摘要）。
 *
 * 用于「发送是否成功」的校验：发送后签名应发生变化。
 *
 * @param list 消息列表容器。
 */
export function getMessagesSignature(list: HTMLElement): string {
  const messages = getMessages(list);
  const last = nonEmpty(messages).at(-1);
  return `${messages.length}#${last ? `${last.text.length}:${last.text.slice(0, 40)}` : 'empty'}`;
}

/* ------------------------------------------------------------------ */
/* 待答提问识别（核心）                                                */
/* ------------------------------------------------------------------ */

/**
 * 取「待作答的 AI 提问」。
 *
 * 判定规则（就是需求里那句「看最后一条消息是谁发的」）：
 * - 最后一条**非空**消息是 **AI** ⇒ 返回它，这就是要回答的问题；
 * - 最后一条是 **我方** ⇒ 返回 `null`（说明还在等 AI 回复，不该再发一次）；
 * - 没有任何消息 ⇒ 返回 `null`。
 *
 * @param list 消息列表容器。
 * @returns 待答问题；没有则 `null`。
 */
export function getPendingQuestion(list: HTMLElement): MessageView | null {
  const messages = nonEmpty(getMessages(list));
  const last = messages.at(-1);
  if (!last) return null;
  if (last.side === 'user') return null;
  // 侧别判定失效时的第二道保险：内容与我方刚发的一模一样 → 视为我方消息
  if (isOwnMessage(last.text)) return null;
  return last;
}

/**
 * 找本轮 AI 回复：**我方刚提交的那条消息之后的第一个 AI 消息**。
 *
 * 以「我方消息在列表中的位置」为锚点，而不是用发送前的消息条数作下标 ——
 * 页面在发送瞬间可能同时插入「我方气泡（空）+ AI 占位块」，
 * 用下标会错位；用位置关系则天然稳定。
 *
 * @param list 消息列表容器。
 * @param sentText 我方刚提交的文本；省略时退化为「最后一条非我方消息」。
 */
export function findReplyMessage(list: HTMLElement, sentText?: string | null): MessageView | null {
  const messages = nonEmpty(getMessages(list));
  if (messages.length === 0) return null;

  const sent = sentText ? normalizeText(sentText) : null;
  const ownIndex = sent ? messages.map((m) => normalizeText(m.text)).lastIndexOf(sent) : -1;

  if (ownIndex >= 0) {
    for (let i = ownIndex + 1; i < messages.length; i += 1) {
      const candidate = messages[i];
      if (candidate.side !== 'user' && !isOwnMessage(candidate.text)) return candidate;
    }
    return null; // 我方消息之后还没出现 AI 回复
  }

  // 找不到我方消息（渲染差异）→ 退化为「最后一条非我方消息」
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.side !== 'user' && !isOwnMessage(candidate.text)) return candidate;
  }
  return null;
}

/**
 * 等待「新的 AI 提问」出现，并要求它已输出稳定（避免把流式中间态当完整问题）。
 *
 * @param list 消息列表容器。
 * @param previousSignature 上一个已作答问题的签名；签名相同视为同一问题。
 * @param options.timeoutMs 超时毫秒数。
 * @param options.signal 中止信号。
 * @throws CxaiError('QUESTION_TIMEOUT') 超时。
 */
export async function waitForNewQuestion(
  list: HTMLElement,
  previousSignature: string | null,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    /** 每次采样回调，参数为「最后一条非空消息」的侧别与摘要（用于 UI 展示识别过程）。 */
    onTick?: (info: { side: MessageSide | 'none'; text: string }) => void;
  },
): Promise<MessageView> {
  const { timeoutMs, signal, onTick } = options;
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stable = 0;

  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const pending = getPendingQuestion(list);
    if (onTick) {
      const tail = nonEmpty(getMessages(list)).at(-1);
      onTick(tail ? { side: tail.side, text: tail.text } : { side: 'none', text: '' });
    }
    if (pending && pending.signature !== previousSignature) {
      if (pending.text === lastText) {
        stable += 1;
        if (stable >= QUESTION_STABLE_TIMES) return pending;
      } else {
        lastText = pending.text;
        stable = 0;
      }
    } else {
      lastText = '';
      stable = 0;
    }

    if (Date.now() >= deadline) {
      throw new CxaiError(
        'QUESTION_TIMEOUT',
        `等待 AI 提问超时（${Math.round(timeoutMs / 1000)} 秒），已停止本轮。`,
        true,
      );
    }
    await sleep(Math.min(QUESTION_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
  }
}

/* ------------------------------------------------------------------ */
/* 回复完成检测                                                        */
/* ------------------------------------------------------------------ */

/**
 * 等待 AI 回复流式输出结束。
 *
 * @param list 消息列表容器。
 * @param options.timeoutMs 超时毫秒数。
 * @param options.signal 中止信号。
 * @param options.sentText 我方刚提交的文本，用于定位本轮回复。
 * @param options.onTick 每次采样回调（用于 UI 显示「接收中…」）。
 * @returns 稳定后的完整回复文本。
 * @throws CxaiError('REPLY_TIMEOUT') 超时。
 */
export async function waitForStableReply(
  list: HTMLElement,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    sentText?: string | null;
    onTick?: (text: string) => void;
    stableTimes?: number;
    intervalMs?: number;
  },
): Promise<string> {
  const {
    timeoutMs,
    signal,
    sentText,
    onTick,
    stableTimes = REPLY_STABLE_TIMES,
    intervalMs = REPLY_POLL_INTERVAL_MS,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastLen = -1;
  let stable = 0;

  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() > deadline) {
      throw new CxaiError(
        'REPLY_TIMEOUT',
        `等待 AI 回复超时（${Math.round(timeoutMs / 1000)} 秒），可在弹窗中调大「回复超时」。`,
        true,
      );
    }

    const candidate = findReplyMessage(list, sentText);
    if (candidate) {
      onTick?.(candidate.text);
      if (candidate.text.length === lastLen) {
        stable += 1;
        if (stable >= stableTimes) {
          log.info(`回复完成检测命中（长度 ${lastLen}，稳定 ${stableTimes} 次）`);
          return candidate.text;
        }
      } else {
        stable = 0;
        lastLen = candidate.text.length;
      }
    }

    await sleep(intervalMs, signal);
  }
}

/* ------------------------------------------------------------------ */
/* 页面背景资料                                                        */
/* ------------------------------------------------------------------ */

/**
 * 采集「对话之外的整页文字」，作为提示词的背景资料。
 *
 * 为什么需要：AI 实践的评分依据往往写在对话之外 —— 任务介绍、出场角色说明、
 * 任务完成条件、任务流/章节名等。只把「最后一条提问」丢给大模型，
 * 回答容易偏离任务要求。
 *
 * 做法：取整个 frame 的可见文本，**排除消息列表子树**（避免与「提问 + 历史」
 * 重复占用 token），按行去重后截断。
 *
 * @param targets 探测结果。
 * @returns 压平后的背景文字；没有可用内容时返回空串。
 */
export function getPageContext(targets: ChatTargets): string {
  const scope = (document.body ?? document.documentElement) as HTMLElement | null;
  if (!scope) return '';

  const exclude: Element[] = [];
  if (targets.list?.isConnected) exclude.push(targets.list);

  // skipMeta=false：背景资料要「所有文字」，不做头像/昵称过滤
  const raw = getVisibleText(scope, exclude, false);

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }

  const merged = lines.join('\n');
  return merged.length > PAGE_CONTEXT_MAX_CHARS
    ? `${merged.slice(0, PAGE_CONTEXT_MAX_CHARS)}…`
    : merged;
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

/**
 * 生成当前对话的可读快照（用于排查「读不到消息 / 侧别判错」）。
 *
 * @param list 消息列表容器。
 */
export function describeMessages(list: HTMLElement): string {
  const messages = getMessages(list);
  if (messages.length === 0) return '未解析到任何消息条目';
  const lines = messages.map((m, i) => {
    const flat = m.text.replace(/\s+/g, ' ').trim();
    return `  #${i} [${m.side}] len=${m.text.length} ${flat.slice(0, 50)}`;
  });
  const pending = getPendingQuestion(list);
  return [
    `消息总数 ${messages.length}（AI ${messages.filter((m) => m.side === 'ai').length} / 我方 ${
      messages.filter((m) => m.side === 'user').length
    } / 未知 ${messages.filter((m) => m.side === 'unknown').length}）`,
    `最后一条非空消息侧别：${pending ? 'AI（待作答）' : '我方或空（等待中）'}`,
    ...lines,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 语义判断                                                            */
/* ------------------------------------------------------------------ */

/**
 * 判断文本是否「像一个提问」。
 *
 * @param text 待判定文本。
 */
export function looksLikeQuestion(text: string): boolean {
  return QUESTION_RE.test(text);
}

/**
 * 判断文本是否是收尾语（用于在 AI 明确结束时自动收工）。
 *
 * @param text 待判定文本。
 */
export function looksLikeEnding(text: string): boolean {
  return ENDING_RE.test(text) && !looksLikeQuestion(text);
}

/**
 * 便捷封装：给定探测结果，取当前待答问题。
 *
 * @param targets 探测结果。
 * @param _overrides 预留参数（保持签名稳定）。
 */
export function currentQuestion(targets: ChatTargets, _overrides?: SelectorOverrides): MessageView | null {
  void _overrides;
  return getPendingQuestion(targets.list);
}
