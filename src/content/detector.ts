import { createLogger } from '@/common/logger';
import { isAiPracticeUrl } from '@/common/url-utils';
import { SELECTORS } from '@/common/selectors';
import {
  collectMessageItems,
  commonAncestorOf,
  findFirstMatch,
  getVisibleText,
  isPlausibleButton,
  isPlausibleContainer,
  isVisible,
} from '@/common/dom-utils';
import type { ChatTargets, SelectorKey, SelectorOverrides } from '@/types';

/**
 * 学习通 AI 实践对话窗口的 DOM 探测器。
 *
 * 三级探测策略（对应文档 4.2）：
 * 1. `override` —— 用户在「选择器调试模式」中手动点选并保存的选择器（最高优先级）；
 * 2. `selector` —— `@/common/selectors` 中的多级回退候选表；
 * 3. `heuristic` —— 当选择器全部失效时，基于「输入框 + 消息列表 + 发送按钮」的
 *    结构特征做启发式嗅探，尽量让扩展在页面改版后仍能工作。
 */

const log = createLogger('content:detector');

/** 聊天相关类名/属性关键字。 */
const CHAT_CLASS_RE = /(message|msg|chat|dialog|conversation|dialogue|record|history|talk|bubble)/i;
/** 输入框 placeholder 关键字。 */
const PLACEHOLDER_RE = /(输入|回答|说点什么|内容|请输入|answer|reply|message|ask|think|chat)/i;
/** 发送按钮关键字。 */
const SEND_RE = /(send|submit|发送|提交)/i;

/** 排除自身注入的 UI，避免「自问自答」。 */
function isOwnUI(el: Element): boolean {
  return Boolean(el.closest('[data-cxai-ui]'));
}

/** 元素是否可作为输入框。 */
function isEditable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return false; // 按文档约定只看 textarea / contenteditable
  return el.isContentEditable;
}

/** 在候选列表中查找，并过滤掉自身 UI。 */
function queryCandidate(list: string[], root: ParentNode): ReturnType<typeof findFirstMatch> {
  const hit = findFirstMatch(list, root);
  if (hit && isOwnUI(hit.el)) return null;
  return hit;
}

/** 某个祖先链上是否存在「聊天容器」特征。 */
function hasChatAncestor(el: HTMLElement, maxDepth = 8): boolean {
  let node: HTMLElement | null = el.parentElement;
  for (let i = 0; node && i < maxDepth; i += 1) {
    if (CHAT_CLASS_RE.test(node.className?.toString?.() ?? '')) return true;
    node = node.parentElement;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 输入框                                                              */
/* ------------------------------------------------------------------ */

/** 输入框命中结果。 */
interface InputHit {
  el: HTMLElement;
  selector: string;
  source: ChatTargets['source'];
}

/**
 * 探测输入框。
 *
 * 优先精确候选；全部失败时对所有 textarea / contenteditable 打分选优，
 * 以此避开学习通顶栏的搜索框等无关输入控件。
 */
function detectInput(overrides: SelectorOverrides, root: ParentNode): InputHit | null {
  const custom = overrides.input;
  if (custom) {
    const hit = queryCandidate([custom], root);
    if (hit && isEditable(hit.el)) return { el: hit.el, selector: custom, source: 'override' };
    log.warn(`用户自定义输入框选择器未命中：${custom}`);
  }

  // 候选表（末位 `div[contenteditable="true"]` 过于宽泛，单独走打分逻辑）
  const precise = SELECTORS.input.filter((s) => s !== 'div[contenteditable="true"]');
  const hit = queryCandidate(precise, root);
  if (hit && isEditable(hit.el)) return { el: hit.el, selector: hit.selector, source: 'selector' };

  // 启发式：对所有可编辑元素打分
  const all = Array.from(root.querySelectorAll('textarea, [contenteditable="true"]')).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && isEditable(el) && isVisible(el) && !isOwnUI(el),
  );
  if (all.length === 0) return null;

  let best: { el: HTMLElement; score: number } | null = null;
  for (const el of all) {
    const score = scoreInput(el);
    if (!best || score > best.score) best = { el, score };
  }
  if (!best || best.score < 6) {
    log.warn(`启发式输入框打分不足（best=${best?.score ?? 0}），判定为未探测到对话窗口`);
    return null;
  }
  log.info(`启发式命中输入框（score=${best.score}）`);
  return { el: best.el, selector: 'div[contenteditable="true"]', source: 'heuristic' };
}

/** 输入框打分。 */
function scoreInput(el: HTMLElement): number {
  let score = 0;
  const placeholder = el.getAttribute('placeholder') ?? '';
  if (PLACEHOLDER_RE.test(placeholder)) score += 8;
  if (el instanceof HTMLTextAreaElement) score += 3; // textarea 歧义更小
  if (hasChatAncestor(el)) score += 6;

  // 祖辈里存在「发送」按钮
  let scope: HTMLElement | null = el.parentElement;
  for (let i = 0; scope && i < 4; i += 1) {
    if (scope.querySelector('[class*="send" i], [class*="submit" i], button')) score += 4;
    scope = scope.parentElement;
  }

  // 祖辈里存在消息列表特征
  if (el.parentElement && hasMessageSibling(el, 6)) score += 10;

  // 出现在表单里且无聊天上下文 → 大概率是登录/搜索表单
  if (el.closest('form') && !hasChatAncestor(el)) score -= 10;
  return score;
}

/** 从输入框向上找，判断是否与一个「消息列表」容器同级。 */
function hasMessageSibling(el: HTMLElement, maxDepth: number): boolean {
  let node: HTMLElement | null = el.parentElement;
  for (let i = 0; node && i < maxDepth; i += 1) {
    for (const sibling of Array.from(node.children)) {
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling.contains(el)) continue;
      if (scoreList(sibling, el, sibling.parentElement === node ? 12 : 0) >= LIST_MIN_SCORE) return true;
    }
    node = node.parentElement;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 消息列表                                                            */
/* ------------------------------------------------------------------ */

/** 启发式接受消息列表的最低分。 */
const LIST_MIN_SCORE = 18;

/**
 * 消息列表打分。
 *
 * 性能考量：本函数在探测循环里每 1.5 秒会对多个候选容器求值一次，
 * 因此先用廉价的 `textContent` / `children` 判断做剪枝，最后才做会触发
 * 重排的 `isVisible` / `getBoundingClientRect`。
 *
 * @param el 候选容器。
 * @param inputEl 输入框（用于排除「包含输入框的容器」）。
 * @param sameLevelBonus 与输入框「同层」时的加分（同层是消息列表的强特征）。
 */
function scoreList(el: HTMLElement, inputEl: HTMLElement, sameLevelBonus = 0): number {
  if (el === inputEl || el.contains(inputEl)) return -1;
  if (isOwnUI(el)) return -1;

  const kids = Array.from(el.children) as HTMLElement[];
  if (kids.length < 1) return -1;

  // 消息列表的子元素应该是「消息」，而不是一排按钮/图标（排除工具栏、操作条）
  const interactive = kids.filter((k) =>
    k.matches('button, a, input, textarea, [role="button"], svg, i, img'),
  ).length;
  if (interactive > kids.length * 0.5) return -1;

  const withText = kids.filter((k) => (k.textContent ?? '').trim().length > 0);
  if (withText.length === 0) return -1;

  // 消息正文通常有一定长度，纯标签/按钮容器会被这一步过滤掉
  const totalText = withText.reduce((sum, k) => sum + (k.textContent ?? '').trim().length, 0);
  if (totalText < 12) return -1;

  // 消息列表内不应包含输入控件
  if (el.querySelector('input, textarea, [contenteditable="true"]')) return -1;

  let score = Math.min(withText.length, 12) * 6;
  score += sameLevelBonus; // 与输入框同层
  if (CHAT_CLASS_RE.test(el.className?.toString?.() ?? '')) score += 20;
  if (kids.length === withText.length && withText.length >= 2) score += 10; // 子元素都是消息 → 结构干净
  if (el.querySelectorAll('a').length > 6) score -= 15; // 导航/目录区

  // 代价较高的可见性与尺寸判断放在最后（统一在此处一次性取 rect，避免重复重排）
  if (!isVisible(el)) return -1;
  const rect = el.getBoundingClientRect();
  if (rect.height < 40) score -= 25;
  if (rect.width < 120) score -= 20;

  // 「一条消息」= 头像 + 气泡（+ 时间戳），其中头像/时间戳明显更小。
  // 出现这种「大小不一的文本子节点」时，当前候选更像一条消息而不是消息列表，需要压分。
  if (withText.length >= 2) {
    const substantial = withText.filter((k) => {
      const r = k.getBoundingClientRect();
      return r.width >= 48 && r.height >= 18;
    });
    if (substantial.length < withText.length) score -= 20;
  }

  return score;
}

/** 列出候选容器（限定深度与数量，避免全文档遍历）。 */
function collectContainers(scope: HTMLElement, inputEl: HTMLElement, maxDepth = 2, limit = 200): HTMLElement[] {
  const out: HTMLElement[] = [];
  const queue: { node: HTMLElement; depth: number }[] = [{ node: scope, depth: 0 }];
  while (queue.length && out.length < limit) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const child of Array.from(current.node.children)) {
      if (!(child instanceof HTMLElement)) continue;
      out.push(child);
      // 子树里若包含输入框，仍需下探（输入框可能包在 footer 里，其兄弟才是消息列表）
      queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return out.filter((el) => el !== inputEl);
}

/** 消息列表命中结果。 */
interface ListHit {
  el: HTMLElement;
  selector?: string;
  source: ChatTargets['source'];
}

/**
 * 探测消息列表容器。
 *
 * 启发式采用「**就近原则**」：从输入框的父级开始逐层向上扫描，一旦在某一层
 * 找到足够像消息列表的容器就立即采用，不再考虑更高层的候选。
 *
 * 这样做能有效避免「页面右侧恰好有个结构相似的侧栏/面板」被误判为消息列表。
 */
function detectList(overrides: SelectorOverrides, inputEl: HTMLElement, root: ParentNode): ListHit | null {
  const custom = overrides.messageList;
  if (custom) {
    const hit = queryCandidate([custom], root);
    if (hit && isPlausibleContainer(hit.el)) {
      return { el: hit.el, selector: custom, source: 'override' };
    }
    if (hit) {
      log.warn(
        `自定义消息列表选择器命中了 <${hit.el.tagName.toLowerCase()}>，但它不像消息容器` +
          `（多半是点到了正文段落），已忽略：${custom}`,
      );
    } else {
      log.warn(`用户自定义消息列表选择器未命中：${custom}`);
    }
  }

  const hit = queryCandidate(SELECTORS.messageList, root);
  if (hit && !hit.el.contains(inputEl)) return { el: hit.el, selector: hit.selector, source: 'selector' };

  // 结构化推断（高置信度）：已知消息条目选择器时，直接取其共同父级作为列表容器。
  // 真实站点上 AI / 用户条目类名完全不同（.agent / .userAnswer），这条路径比
  // 纯启发式打分可靠得多。
  const items = collectMessageItems(root);
  if (items.length >= 1) {
    const parent = commonAncestorOf(items.map((item) => item.el));
    if (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      parent !== inputEl &&
      !parent.contains(inputEl)
    ) {
      log.info(`按消息条目推断出列表容器（已识别 ${items.length} 条消息）`);
      return { el: parent, source: 'selector' };
    }
  }

  // 启发式：逐层向上，取最近一层中得分最高的容器
  let node: HTMLElement | null = inputEl.parentElement;
  for (let depth = 0; node && depth < 8; depth += 1) {
    if (node === document.body || node === document.documentElement) break;

    let best: { el: HTMLElement; score: number } | null = null;
    for (const container of collectContainers(node, inputEl, 2, 200)) {
      // 与输入框「同层」（同为 node 的直接子级）时给强加分
      const bonus = container.parentElement === node ? 12 : 0;
      const score = scoreList(container, inputEl, bonus);
      if (score > (best?.score ?? 0)) best = { el: container, score };
    }

    if (best && best.score >= LIST_MIN_SCORE) {
      log.info(`启发式命中消息列表（depth=${depth} score=${best.score}）`);
      return { el: best.el, source: 'heuristic' };
    }
    node = node.parentElement;
  }

  log.warn('启发式未能定位消息列表');
  return null;
}

/* ------------------------------------------------------------------ */
/* 根容器 & 发送按钮                                                    */
/* ------------------------------------------------------------------ */

/** 求两个元素的最近公共祖先。 */
function commonAncestor(a: HTMLElement, b: HTMLElement): HTMLElement {
  let node: HTMLElement | null = a;
  while (node) {
    if (node.contains(b)) return node;
    node = node.parentElement;
  }
  return document.body;
}

/** 命中结果通用结构（元素 + 命中方式）。 */
interface Hit<T extends HTMLElement | null> {
  el: T;
  selector?: string;
  source: ChatTargets['source'];
}

/** 探测对话根容器。 */
function detectRoot(
  overrides: SelectorOverrides,
  listEl: HTMLElement | null,
  inputEl: HTMLElement,
): Hit<HTMLElement> {
  const custom = overrides.chatRoot;
  if (custom) {
    const hit = queryCandidate([custom], document);
    // 根容器必须**真正包含**输入框；用 el.contains(el) 恒为真的特性套进来的
    // 伪根（例如把消息列表填成同一个元素）会被这里挡掉
    if (hit && hit.el !== inputEl && hit.el.contains(inputEl)) {
      return { el: hit.el, selector: custom, source: 'override' };
    }
    if (hit) log.warn(`用户自定义根容器未包含输入框：${custom}`);
  }

  const hit = queryCandidate(SELECTORS.chatRoot, document);
  if (hit && hit.el.contains(inputEl)) return { el: hit.el, selector: hit.selector, source: 'selector' };

  void listEl;
  const base = listEl ? commonAncestor(listEl, inputEl) : inputEl.parentElement;
  let el: HTMLElement = base && base !== document.documentElement ? base : document.body;
  // 若公共祖先就是 body，说明结构异常，退化为输入框的两层父级
  if (el === document.body) {
    el = inputEl.parentElement?.parentElement ?? inputEl.parentElement ?? document.body;
  }
  return { el, source: 'heuristic' };
}

/* ------------------------------------------------------------------ */
/* 按钮（发送 / 继续）                                                  */
/* ------------------------------------------------------------------ */

/** 「继续 / 开始作答」按钮的文案特征。 */
const UNLOCK_RE = /^(继续|点击继续|开始|开始作答|去作答|继续作答|下一步|开始练习)$/;

/** 收集某选择器下所有「可见且非本扩展 UI」的元素。 */
function queryAll(selector: string, root: ParentNode): HTMLElement[] {
  try {
    return Array.from(root.querySelectorAll(selector)).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && isVisible(el) && !isOwnUI(el),
    );
  } catch {
    return [];
  }
}

/** 元素是否处于「锁定 / 禁用」状态。 */
function isLocked(el: HTMLElement): boolean {
  return (
    el.matches('[disabled], [aria-disabled="true"]') ||
    /lock|disabled|forbid/i.test(el.className?.toString?.() ?? '')
  );
}

/**
 * 从一组候选按钮里挑最合适的那个。
 *
 * 真实站点上发送按钮在锁定时会追加 `optionBtnLock`、`span.sendBtn` 在两种状态下
 * 都能命中，因此**不能简单取第一个**：优先选未锁定的，其次选离输入框最近的。
 *
 * @param candidates 候选按钮。
 * @param inputEl 输入框（用作距离基准）。
 */
function pickBestButton(candidates: HTMLElement[], inputEl: HTMLElement): HTMLElement | null {
  if (candidates.length === 0) return null;
  const inputRect = inputEl.getBoundingClientRect();
  const scored = candidates.map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      el,
      locked: isLocked(el),
      dist: Math.abs(rect.left - inputRect.right) + Math.abs(rect.top - inputRect.top),
    };
  });
  scored.sort((a, b) => (a.locked === b.locked ? a.dist - b.dist : a.locked ? 1 : -1));
  return scored[0].el;
}

/** 探测发送按钮。 */
function detectSendBtn(
  overrides: SelectorOverrides,
  root: HTMLElement,
  inputEl: HTMLElement,
): Hit<HTMLElement | null> {
  const custom = overrides.sendBtn;
  if (custom) {
    const best = pickBestButton(queryAll(custom, root).filter(isPlausibleButton), inputEl);
    if (best) return { el: best, selector: custom, source: 'override' };
    log.warn(`用户自定义发送按钮选择器未命中或不像按钮：${custom}`);
  }

  for (const selector of SELECTORS.sendBtn) {
    const best = pickBestButton(queryAll(selector, root), inputEl);
    if (best) return { el: best, selector, source: 'selector' };
  }

  // 启发式：输入框附近 4 层内，文本含「发送/提交」或类名含 send 的可点击元素
  let scope: HTMLElement | null = inputEl.parentElement;
  for (let i = 0; scope && i < 4; i += 1) {
    const candidates = queryAll('button, [role="button"], div, span, a', scope).filter((el) => {
      const text = getVisibleText(el);
      if (text.length > 6) return false; // 按钮文案通常很短
      return SEND_RE.test(text) || SEND_RE.test(el.className?.toString?.() ?? '');
    });
    const best = pickBestButton(candidates, inputEl);
    if (best) return { el: best, source: 'heuristic' };
    scope = scope.parentElement;
  }
  return { el: null, source: 'heuristic' };
}

/**
 * 探测「继续 / 开始作答」按钮。
 *
 * 学习通 AI 实践的输入框默认锁定（`messageInputLock`），必须先点这个按钮才能输入。
 */
function detectUnlockBtn(
  overrides: SelectorOverrides,
  root: HTMLElement,
  inputEl: HTMLElement,
): Hit<HTMLElement | null> {
  const custom = overrides.unlockBtn;
  if (custom) {
    const all = queryAll(custom, root).filter(isPlausibleButton);
    if (all.length > 0) return { el: all[0], selector: custom, source: 'override' };
    log.warn(`用户自定义解锁按钮选择器未命中或不像按钮：${custom}`);
  }

  for (const selector of SELECTORS.unlockBtn) {
    const all = queryAll(selector, root);
    if (all.length > 0) return { el: all[0], selector, source: 'selector' };
  }

  // 启发式：输入框附近文本恰为「继续 / 开始作答」之类的短文案元素
  let scope: HTMLElement | null = inputEl.parentElement;
  for (let i = 0; scope && i < 4; i += 1) {
    const found = queryAll('button, [role="button"], span, div, a', scope).find((el) => {
      const text = getVisibleText(el);
      return text.length > 0 && text.length <= 8 && UNLOCK_RE.test(text);
    });
    if (found) return { el: found, source: 'heuristic' };
    scope = scope.parentElement;
  }
  return { el: null, source: 'heuristic' };
}

/**
 * 兜底查找「继续」按钮（不重新做完整探测）。
 *
 * 使用场景：解锁按钮在页面重渲染后元素被替换，导致状态机里缓存的引用失效。
 *
 * @param inputEl 输入框元素。
 * @returns 命中的按钮；没有则 `null`。
 */
export function findUnlockButton(inputEl: HTMLElement): HTMLElement | null {
  const root = (inputEl.ownerDocument?.body ?? document.body) as HTMLElement;
  return detectUnlockBtn({}, root, inputEl).el;
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测当前 frame 中的 AI 实践对话窗口。
 *
 * @param overrides 用户自定义选择器。
 * @param root 查找根节点，默认 `document`。
 * @param options.ignoreOverrides 忽略 `overrides`，只用候选表 + 启发式。
 *        用于「自定义选择器把消息解析搞成 0 条」时的自愈重探（见 `content/index.tsx`）。
 * @returns 探测结果；未探测到时返回 `null`。
 */
export function detectChat(
  overrides: SelectorOverrides = {},
  root: ParentNode = document,
  options: { ignoreOverrides?: boolean } = {},
): ChatTargets | null {
  const ov: SelectorOverrides = options.ignoreOverrides ? {} : overrides;

  // 快速剪枝：整页没有任何 textarea / contenteditable 时直接判定「无对话窗口」，
  // 避免在无关 frame 上反复做昂贵的祖先遍历（探测循环每 1.5s 执行一次）。
  let hasEditable = false;
  try {
    hasEditable = Boolean(root.querySelector('textarea, [contenteditable="true"]'));
  } catch {
    return null;
  }
  // 命中 AI 实践路由时不做剪枝：页面刚打开、输入框还没渲染出来的那一两秒
  // 也要能探测成功，否则「打开页面自动开始」会错过时机。
  if (!hasEditable && !isAiPracticeUrl()) return null;

  const inputHit = detectInput(ov, root);
  if (!inputHit) return null;

  const listHit = detectList(ov, inputHit.el, root);
  const rootHit = detectRoot(ov, listHit?.el ?? null, inputHit.el);
  const sendHit = detectSendBtn(ov, rootHit.el, inputHit.el);
  const unlockHit = detectUnlockBtn(ov, rootHit.el, inputHit.el);

  // 置信度：三个关键节点各自加权
  let confidence = 0.4;
  if (inputHit.source === 'override') confidence += 0.2;
  if (listHit) confidence += listHit.source === 'heuristic' ? 0.15 : 0.3;
  if (sendHit.el) confidence += 0.1;
  if (rootHit.source !== 'heuristic') confidence += 0.1;
  // URL 本身就是 AI 实践对话路由 → 结构信号之外的强佐证
  const urlHint = isAiPracticeUrl();
  if (urlHint) confidence += 0.05;

  const matched: Partial<Record<SelectorKey, string>> = {
    input: inputHit.selector,
    ...(listHit?.selector ? { messageList: listHit.selector } : {}),
    ...(rootHit.selector ? { chatRoot: rootHit.selector } : {}),
    ...(sendHit.selector ? { sendBtn: sendHit.selector } : {}),
    ...(unlockHit.selector ? { unlockBtn: unlockHit.selector } : {}),
  };

  const targets: ChatTargets = {
    root: rootHit.el,
    list: listHit?.el ?? rootHit.el,
    input: inputHit.el,
    sendBtn: sendHit.el,
    unlockBtn: unlockHit.el,
    matched,
    confidence: Math.min(1, Number(confidence.toFixed(2))),
    source: inputHit.source,
  };

  log.info(
    `探测完成 source=${targets.source} confidence=${targets.confidence} urlHint=${urlHint}` +
      ` 发送按钮=${sendHit.el ? '命中' : '未命中（走 Enter）'}` +
      ` 继续按钮=${unlockHit.el ? '命中' : '未命中'}`,
  );
  return targets;
}

/**
 * 提取单条消息的文本（供 observer 使用）。
 *
 * @param el 消息元素。
 */
export function messageText(el: HTMLElement): string {
  return getVisibleText(el);
}
