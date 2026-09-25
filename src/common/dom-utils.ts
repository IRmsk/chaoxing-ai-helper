import { AI_HINTS, CONTENT_SELECTORS, META_SELECTOR, SELECTORS, SKIP_BUTTON_SELECTOR, SKIP_TAGS, USER_HINTS } from './selectors';
import type { SelectorOverrides } from '@/types';

/**
 * DOM 通用工具集。
 *
 * 这里集中了「选择器查找、可见性判断、消息侧别判定、稳定选择器生成、等待原语」
 * 等被 content 层反复使用的底层能力。
 */

/** 消息归属侧别。 */
export type MessageSide = 'ai' | 'user' | 'unknown';

/** 命中结果：元素 + 命中的选择器字符串（便于诊断/回写）。 */
export interface MatchResult {
  el: HTMLElement;
  selector: string;
}

/**
 * 一条消息条目：元素 + 侧别。
 *
 * 侧别在这里就确定，而不是等到提取文本时再猜 —— 因为「哪一组选择器命中的」
 * 本身就是最可靠的侧别证据。
 */
export interface MessageItem {
  el: HTMLElement;
  side: MessageSide;
}

/** 异步休眠。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 按优先级依次尝试候选选择器，返回首个命中元素。
 *
 * @param selectorList 候选选择器数组（高优先级在前）。
 * @param root 查找根节点，默认 `document`。
 * @returns 命中的元素或 `null`。
 */
export function findFirst(selectorList: string[], root: ParentNode = document): HTMLElement | null {
  return findFirstMatch(selectorList, root)?.el ?? null;
}

/**
 * 按优先级依次尝试候选选择器，返回首个命中元素及其选择器。
 *
 * @param selectorList 候选选择器数组。
 * @param root 查找根节点。
 * @returns 命中结果或 `null`。
 */
export function findFirstMatch(selectorList: string[], root: ParentNode = document): MatchResult | null {
  for (const selector of selectorList) {
    let el: Element | null = null;
    try {
      el = root.querySelector(selector);
    } catch {
      // 非法选择器（例如用户手写的语法错误）直接跳过
      continue;
    }
    if (el instanceof HTMLElement && isVisible(el)) return { el, selector };
  }
  return null;
}

/**
 * 收集所有命中候选的元素（用于消息列表遍历）。
 *
 * @param selectorList 候选选择器数组；命中第一个可用者即返回其全部匹配。
 * @param root 查找根节点。
 */
export function findAll(selectorList: string[], root: ParentNode = document): HTMLElement[] {
  for (const selector of selectorList) {
    let nodes: Element[];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch {
      continue;
    }
    const visible = nodes.filter((n): n is HTMLElement => n instanceof HTMLElement && isVisible(n));
    if (visible.length > 0) return visible;
  }
  return [];
}

/**
 * 判断元素是否可见（占位面积 > 0 且未被 CSS 隐藏）。
 *
 * @param el 目标元素。
 */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (Number.parseFloat(style.opacity || '1') === 0) return false;
  return true;
}

/**
 * 提取元素的可读文本（去噪版）。
 *
 * 会剔除脚本、样式、以及**按钮类元素**的文本节点，避免把「继续 / 发送」按钮文案
 * 混进消息正文 —— 学习通的这两个按钮都是 `span`，且可能嵌在消息块内部。
 *
 * @param el 目标元素。
 * @param exclude 需要整段排除的子树（用于「AI 条目里嵌着用户条目」的结构：
 *                提取 AI 正文时要跳过内部的用户作答，否则两条消息的文本会粘连）。
 * @param skipMeta 是否连同**头像 / 昵称 / 时间戳**一起跳过。
 *                仅提取「消息正文」时开启；嗅探按钮文案时必须关闭，
 *                否则按钮自身的文字也会被当成 meta 而读成空串。
 * @returns 规整后的文本。
 */
export function getVisibleText(el: HTMLElement, exclude: Element[] = [], skipMeta = false): string {
  const parts: string[] = [];
  const skipTrees = exclude.filter((node) => node !== el);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (skipTrees.some((tree) => tree.contains(parent))) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-cxai-ui]')) return NodeFilter.FILTER_REJECT;
      // 头像 / 昵称 / 时间戳：只算「消息里可有可无的元信息」，不是正文
      if (skipMeta) {
        const meta = parent.closest(META_SELECTOR);
        if (meta && meta !== el) return NodeFilter.FILTER_REJECT;
      }
      // 跳过按钮文案；但若「当前元素本身就是那个按钮」，则要保留它自己的文本，
      // 否则启发式识别发送/继续按钮时会读到空字符串。
      const buttonHost = parent.closest(SKIP_BUTTON_SELECTOR);
      if (buttonHost && buttonHost !== el) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue ?? '';
      if (!text.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    parts.push((node.nodeValue ?? '').trim());
    node = walker.nextNode();
  }
  return parts.join('\n').replace(/\n{2,}/g, '\n').trim();
}

/**
 * 求一组元素的最近公共祖先。
 *
 * 用于「已知消息条目选择器时，直接推断出消息列表容器」这条高置信度路径。
 *
 * @param elements 元素数组（至少 1 个）。
 * @returns 公共祖先；数组为空时返回 `null`。
 */
export function commonAncestorOf(elements: HTMLElement[]): HTMLElement | null {
  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0].parentElement;
  let ancestor: HTMLElement | null = elements[0];
  for (let i = 1; i < elements.length && ancestor; i += 1) {
    while (ancestor && !ancestor.contains(elements[i])) ancestor = ancestor.parentElement;
  }
  return ancestor;
}

/**
 * 按「AI 条目 + 用户条目 + 通用条目」三组候选，收集当前对话中的所有消息条目。
 *
 * 相比只用一个 `messageItem` 候选数组，这样做的价值是：
 * - 真实站点上 AI / 用户的类名完全不同（`.agent` / `.userAnswer`），需要合并两组；
 * - 合并后再按**文档顺序**排序，保证「最后一条消息」判断正确；
 * - 只剔除**同侧嵌套**的重复元素。
 *
 * > ⚠️ 关键点：**不同侧之间的嵌套必须保留**。
 * > 有些站点的结构是「一轮 = 外层条目里同时含对方提问与我方作答」，
 * > 即我方条目是对方条目的**后代**。如果按「被包含就去重」处理，
 * > 所有我方消息都会被整片吞掉，外层条目的文本又混着两边的文字，
 * > 结果就是「能探测到窗口，但读不对提问、也不作答」。
 *
 * @param scope 查找范围。
 * @returns 按文档顺序排列的消息条目（含初步侧别判定）。
 */
export function collectMessageItems(scope: ParentNode): MessageItem[] {
  const ov = activeOverrides;
  const prefixed = (custom: string | undefined, base: string[]): string[] =>
    custom && isPlausibleItemSelector(custom, scope) ? [custom, ...base] : base;

  const aiList = prefixed(ov.messageItemAI, SELECTORS.messageItemAI);
  const userList = prefixed(ov.messageItemUser, SELECTORS.messageItemUser);
  const itemList = prefixed(ov.messageItem, SELECTORS.messageItem);

  const aiHits = findAll(aiList, scope).filter((el) => !SKIP_TAGS.has(el.tagName));
  const userHits = findAll(userList, scope).filter((el) => !SKIP_TAGS.has(el.tagName));

  let items: MessageItem[];
  if (aiHits.length > 0 || userHits.length > 0) {
    items = [
      ...aiHits.map((el) => ({ el, side: 'ai' as MessageSide })),
      ...userHits.map((el) => ({ el, side: 'user' as MessageSide })),
    ];
  } else {
    items = findAll(itemList, scope).map((el) => ({ el, side: 'unknown' as MessageSide }));
  }

  // 仅剔除同侧嵌套（父与子都被同侧候选命中）；跨侧嵌套是合法结构，必须保留
  const kept = items.filter(
    (item) =>
      !items.some((other) => other !== item && other.side === item.side && other.el.contains(item.el)),
  );

  return kept.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

/* ------------------------------------------------------------------ */
/* 自定义选择器的「合理性体检」                                         */
/* ------------------------------------------------------------------ */

/**
 * 明显**不可能是容器**的标签。
 *
 * 用户在用可视化调试器点选时，很容易点到最内层的正文段落
 * （例如 `div.agent > … > .answer_content > p`）。这种选择器一旦被当成
 * 「消息列表」保存，永远解析出 0 条消息 —— 表现就是
 * 「探测成功了，但读不到任何提问、也不作答」。所以自定义选择器先过一遍体检。
 */
const NON_CONTAINER_TAGS = new Set([
  'P', 'SPAN', 'A', 'I', 'EM', 'STRONG', 'B', 'IMG', 'SVG',
  'LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** 当前生效的自定义选择器（由 content 层在探测后写入，供消息收集复用）。 */
let activeOverrides: SelectorOverrides = {};

/**
 * 设置当前生效的自定义选择器。
 *
 * 之所以用模块级变量而不是层层传参：消息收集被 observer / state-machine
 * 间接调用很多次，而「AI 消息 / 用户消息」这两个自定义选择器必须对它们全部生效。
 *
 * @param overrides 自定义选择器（传 `{}` 清除）。
 */
export function setActiveOverrides(overrides: SelectorOverrides): void {
  activeOverrides = overrides ?? {};
}

/** 自定义「列表 / 根容器」是否像个容器。 */
export function isPlausibleContainer(el: HTMLElement): boolean {
  if (NON_CONTAINER_TAGS.has(el.tagName)) return false;
  if (el.children.length >= 1) return true;
  return collectMessageItems(el).length >= 1;
}

/** 自定义「消息条目」是否说得通（不能是纯文本段落 / 行内元素）。 */
export function isPlausibleItem(el: HTMLElement): boolean {
  if (el.tagName === 'P' || el.tagName === 'SPAN' || el.tagName === 'A') return false;
  return getVisibleText(el).length > 0;
}

/** 选择器最后一段是否是「叶子文本标签」（p / span / a / img …）。 */
const LEAF_SEGMENT_RE = /^(p|span|a|i|em|strong|b|img|h[1-6])$/i;

/** 取选择器最后一段的标签名（去掉 `:nth-of-type(n)` 等伪类）。 */
function tailTagOf(selector: string): string {
  const tail = selector.split('>').pop() ?? '';
  return tail.split(':')[0].trim().toLowerCase();
}

/**
 * 候选选择器是否值得用。
 *
 * 双保险：
 * 1. 先按**字符串**判掉「以正文段落结尾」的写法（`… > p`）—— 能挡住元素还没渲染出来的情况；
 * 2. 再实际查一次并做结构体检 —— 能挡住「标签是 div、实际却是正文容器」的情况。
 *
 * @param selector 用户自定义选择器。
 * @param scope 查询范围。
 */
function isPlausibleItemSelector(selector: string, scope: ParentNode): boolean {
  if (LEAF_SEGMENT_RE.test(tailTagOf(selector))) return false;
  try {
    const hit = scope.querySelector(selector);
    return hit instanceof HTMLElement ? isPlausibleItem(hit) : false;
  } catch {
    return false;
  }
}

/** 自定义「按钮」是否像个按钮（文案要短，且不能是整块消息）。 */
export function isPlausibleButton(el: HTMLElement): boolean {
  if (getVisibleText(el).length > 20) return false; // 按钮文案不会这么长
  if (el.querySelector('p, textarea, [contenteditable="true"]')) return false;
  return true;
}

/**
 * 在条目内挑选「正文容器」。
 *
 * 真实条目里除了正文还有头像与发言人名（`.agentName` = 「测评专家」），
 * 直接取整条文本会把发言人名一起送给大模型。优先按 `CONTENT_SELECTORS` 精准取正文；
 * 都命中不到时返回 `null`，由调用方退回「取整个条目 + 跳过 meta 节点」。
 *
 * @param item 消息条目。
 * @param side 侧别。
 */
function pickContentEl(item: HTMLElement, side: MessageSide): HTMLElement | null {
  if (side !== 'ai' && side !== 'user') return null;
  for (const selector of CONTENT_SELECTORS[side]) {
    try {
      if (item.matches(selector)) return item;
      const found = item.querySelector(selector);
      if (found instanceof HTMLElement && getVisibleText(found).length > 0) return found;
    } catch {
      /* 非法选择器（用户手写语法错误）→ 试下一个 */
    }
  }
  return null;
}

/**
 * 提取某个消息条目的正文。
 *
 * 两级策略：
 * 1. 优先取**正文容器**（`CONTENT_SELECTORS`）—— 天然排除头像与发言人名；
 * 2. 否则取整个条目，但排除内部的**对侧消息子树**与**头像/昵称/时间戳**。
 *
 * @param item 目标条目。
 * @param all 当前所有条目（用于找出嵌在内部的对侧条目）。
 */
export function messageTextOf(item: MessageItem, all: MessageItem[]): string {
  const contentEl = pickContentEl(item.el, item.side);
  const base = contentEl ?? item.el;
  const nestedOpposite = all
    .filter((other) => other !== item && other.side !== item.side && base.contains(other.el))
    .map((other) => other.el);
  return getVisibleText(base, nestedOpposite, contentEl === null);
}

/**
 * 判断两个元素的包含关系（用于去重）。
 *
 * @param a 元素 A。
 * @param b 元素 B。
 * @returns 若 a 包含 b，返回 true。
 */
export function contains(a: Element, b: Element): boolean {
  return a !== b && a.contains(b);
}

/* ------------------------------------------------------------------ */
/* 消息侧别判定                                                        */
/* ------------------------------------------------------------------ */

/** 把一个字符串拆成可用于匹配的 token 集合（类名 / 属性值）。 */
function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[\s,._[\]{}()"'=:|/\\]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 单侧打分：命中越强分越高。 */
function scoreHints(tokens: string[], hints: string[]): number {
  let score = 0;
  for (const token of tokens) {
    for (const hint of hints) {
      if (token === hint) {
        score += 3; // 完全相等的 token 是最强信号（如 class="left"）
      } else if (hint.length >= 5 && token.includes(hint)) {
        score += 2; // 长关键字允许子串匹配（如 "message-ai-content"）
      } else if (hint.length >= 2 && new RegExp(`(^|[-_])${hint}([-_]|$)`).test(token)) {
        score += 2; // 短关键字要求词边界，避免 "email" 命中 "ai"、"task" 命中 "ask"
      }
    }
  }
  return score;
}

/**
 * 汇总元素上所有可用于判定的字符串（class、data-*、aria-*、id）。
 *
 * @param el 目标元素。
 */
function collectSignals(el: HTMLElement): string[] {
  const raw: string[] = [el.className?.toString?.() ?? '', el.id ?? ''];
  for (const attr of Array.from(el.attributes)) {
    if (/^(data-|aria-|role)/.test(attr.name)) raw.push(`${attr.name} ${attr.value}`);
  }
  return tokenize(raw.join(' '));
}

/**
 * 判定一条消息属于 AI（左侧/提问方）还是用户（右侧/作答方）。
 *
 * 判定优先级：
 * 1. 类名 / 数据属性关键字**加权**打分：
 *    - 元素自身的类名权重最高（`depthWeight[0] = 3`）；
 *    - 向上冒泡的祖先权重递减 —— 因为祖先容器往往是双方共用的
 *      （例如 `.answerList` / `.answerBox`），让它们主导判定会把 AI 消息错判成用户消息；
 * 2. 几何位置兜底：以消息列表容器的水平中心为界，左 ⇢ AI，右 ⇢ 用户。
 *
 * @param el 单条消息元素。
 * @param list 消息列表容器（用于几何判定）。
 * @returns 侧别。
 */
export function classifySide(el: HTMLElement, list: HTMLElement | null): MessageSide {
  /** 各层的权重：自身 > 父级 > 祖父级。 */
  const DEPTH_WEIGHT = [3, 1, 0.3];

  let node: HTMLElement | null = el;
  let aiScore = 0;
  let userScore = 0;
  for (let depth = 0; node && depth < 3; depth += 1) {
    const signals = collectSignals(node);
    const weight = DEPTH_WEIGHT[depth] ?? 0.2;
    aiScore += scoreHints(signals, AI_HINTS) * weight;
    userScore += scoreHints(signals, USER_HINTS) * weight;
    node = node.parentElement;
  }

  if (aiScore > userScore) return 'ai';
  if (userScore > aiScore) return 'user';

  // 2) 几何兜底
  if (list) {
    const listRect = list.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && listRect.width > 0) {
      const delta = rect.left + rect.width / 2 - (listRect.left + listRect.width / 2);
      if (Math.abs(delta) > 4) return delta < 0 ? 'ai' : 'user';
    }
    // 3) 结构调整：列表首个子元素通常是 AI 的开场提问
    const children = Array.from(list.children) as HTMLElement[];
    const index = children.indexOf(el);
    if (index === 0) return 'ai';
  }

  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* 选择器生成（选择器调试模式用）                                       */
/* ------------------------------------------------------------------ */

const HASHED_CLASS = /^[a-z]+[-_]?[0-9a-f]{5,}$/i;

/** 判断类名是否是构建产物哈希（如 `chat-3f2a1b`），这类类名不稳定，生成选择器时应剔除。 */
function isHashedClass(cls: string): boolean {
  if (HASHED_CLASS.test(cls)) return true;
  // 纯数字或过长的随机串
  if (/^[0-9]+$/.test(cls)) return true;
  if (cls.length > 30) return true;
  return false;
}

/** 生成单个元素的选择器片段。 */
function segmentFor(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).filter((c) => !isHashedClass(c) && !c.startsWith('cxai'));
  const classPart = classes.length ? '.' + classes.map((c) => CSS.escape(c)).join('.') : '';
  return `${tag}${classPart}`;
}

/**
 * 为元素生成一个稳定、尽量唯一的 CSS 选择器。
 *
 * 策略：
 * - 优先使用 `#id`；
 * - 否则由最近的稳定祖先拼 `>` 路径，逐级校验唯一性；
 * - 仍然不唯一时追加 `:nth-of-type(n)`。
 *
 * @param el 目标元素。
 * @param root 停止上溯的根节点（默认 `document.body`）。
 * @returns 可被 `document.querySelector` 命中的选择器。
 */
export function buildCssPath(el: HTMLElement, root: HTMLElement | null = document.body): string {
  if (el.id && !/^\d/.test(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`;
  }

  const segments: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== root && node.parentElement) {
    let segment = segmentFor(node);
    // 同级同类元素多于 1 个时，补 nth-of-type
    const parent = node.parentElement;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    if (sameTag.length > 1) {
      const idx = sameTag.indexOf(node) + 1;
      segment += `:nth-of-type(${idx})`;
    }
    segments.unshift(segment);

    const candidate = segments.join(' > ');
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch {
      /* 用户站点上理论上不会出现非法选择器，忽略 */
    }
    node = node.parentElement;
  }

  const full = segments.join(' > ');
  return full || segmentFor(el);
}

/**
 * 归一化文本用于比对：统一换行、压缩连续空白、去首尾空白。
 *
 * 学习通编辑器可能把 `\n` 转成 `<br>` 或 `<p>`，读回来时形态不同，
 * 因此校验时只比对「内容等价」而非「字节相等」。
 *
 * @param text 原始文本。
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 等待原语                                                            */
/* ------------------------------------------------------------------ */

/** 轮询等待条件成立。 */
export interface WaitOptions {
  /** 超时毫秒数。 */
  timeoutMs: number;
  /** 轮询间隔毫秒数。 */
  intervalMs?: number;
  /** 中止信号。 */
  signal?: AbortSignal;
}

/**
 * 轮询等待 `predicate` 返回真值。
 *
 * @param predicate 判定函数，返回真值即结束等待并返回该值。
 * @param options 超时 / 间隔 / 中止信号。
 * @returns 判定函数返回的真值。
 * @throws 超时抛出 `Error('TIMEOUT')`；中止抛出 AbortError。
 */
export async function waitUntil<T>(predicate: () => T | null | undefined | false, options: WaitOptions): Promise<T> {
  const { timeoutMs, intervalMs = 200, signal } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const value = predicate();
    if (value) return value as T;
    if (Date.now() >= deadline) throw new Error('TIMEOUT');
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/** 滚动元素使其进入视口（不触发页面滚动条抖动）。 */
export function scrollIntoViewSoft(el: HTMLElement): void {
  try {
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
  } catch {
    el.scrollIntoView(false);
  }
}
