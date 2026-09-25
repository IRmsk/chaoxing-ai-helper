import { getVisibleText, isVisible, sleep } from '@/common/dom-utils';
import { createLogger } from '@/common/logger';
import { clickElement } from './injector';
import {
  FLOW_ACTIONS,
  FLOW_SELECTORS,
  FLOW_UPCOMING_TARGET,
  NODE_TYPE_LABEL,
  NOISE_CARD_CLASS_RE,
  classifyNodeType,
  inferNodeTypeFromText,
} from './flow-selectors';
import type { FlowActiveContent, FlowNode, FlowNodeType, FlowState, UploadKind } from '@/types';

/**
 * 任务流页面的 DOM 读取与操作。
 *
 * 设计原则：
 * 1. **读取用结构选择器**（`.flow-card` / `.task-type` …）—— 数量与层级是确定的；
 * 2. **操作用文案匹配** —— 按钮由不同组件渲染、类名不统一，但文案稳定；
 * 3. 所有等待都带超时，且「找不到按钮」不直接判定失败，而是交给上层决定重试或停。
 *
 * ## 一条硬经验：绝不信「单一信号」
 *
 * 这个页面有**三套互相不同步的真相**：
 *
 * | 信号 | 谁在维护 | 什么时候会骗你 |
 * |------|----------|----------------|
 * | `.is-current` / `.is-selected` 卡片标记 | 前端（切换动作完成后才更新） | 切换途中会**同时有多个卡片带标记** |
 * | `.right-content` 里渲染的内容 | 前端（跟随 activeContent） | 页面刚切换时会短暂为空 |
 * | `.task-type` 文案 | 后端数据 | 卡片未渲染完时读不到 |
 *
 * 只信其中一个，就会出现线上那两类故障：
 * - 「已经到上传 word 节点了，助手显示的还是上一个对话节点」→ 卡片标记滞后；
 * - 「第一个节点是上传 word，却被识别成对话节点」→ `.task-type` 读空后落到 `unknown`。
 *
 * 所以 `readFlowState()` 用**内容区优先、标记次之、未完成态兜底**的多信号互证来定节点，
 * 并且在 `.task-type` 缺失时用卡片文案 + 内容区反向校正节点类型。
 */

const log = createLogger('content:flow');

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按优先级取首个命中且可见的元素。
 *
 * @param selectors 候选选择器（高优先级在前）。
 * @param scope 查询范围。
 */
export function pick(selectors: readonly string[], scope: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    let nodes: Element[];
    try {
      nodes = Array.from(scope.querySelectorAll(selector));
    } catch {
      continue;
    }
    const hit = nodes.find((el): el is HTMLElement => el instanceof HTMLElement && isVisible(el));
    if (hit) return hit;
  }
  return null;
}

/** 取首个命中（不要求可见）—— 用于读取隐藏但存在的文本。 */
export function pickAny(selectors: readonly string[], scope: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    try {
      const hit = scope.querySelector(selector);
      if (hit instanceof HTMLElement) return hit;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 收集「可以搜按钮」的所有文档：本 frame + 所有**同源**子 iframe。
 *
 * 为什么要跨 frame 搜：收尾按钮（「开始评估」「完成对话」）在站点不同版本里
 * 有时渲染在对话 iframe 里、有时渲染在宿主页面上。只在自己这一层搜，
 * 就会漏掉一半情况 —— 表现就是「按钮明明在屏幕上，助手却说找不到」。
 *
 * 跨域 iframe 访问 `contentDocument` 会抛错，这里静默跳过。
 */
export function searchRoots(): ParentNode[] {
  const roots: ParentNode[] = [document];
  const walk = (doc: Document, depth: number): void => {
    if (depth > 3) return;
    let frames: Element[];
    try {
      frames = Array.from(doc.querySelectorAll('iframe, frame'));
    } catch {
      return;
    }
    for (const node of frames) {
      if (!(node instanceof HTMLIFrameElement)) continue;
      let inner: Document | null = null;
      try {
        inner = node.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner || roots.includes(inner)) continue;
      roots.push(inner);
      walk(inner, depth + 1);
    }
  };
  walk(document, 0);
  return roots;
}

/** 规整文本（压平空白、限长）。 */
function flat(el: Element | null, max = 300): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 按文案找按钮。
 *
 * 规则：在 `scope` 内找出所有「短文案的可点击元素」，取文案与候选完全相等者；
 * 没有完全相等则退化为「包含」匹配。刻意限制文案长度（≤14 字）以避免命中整块内容。
 *
 * @param texts 候选文案（按优先级）。
 * @param scope 查询范围。
 * @param extraTags 额外参与匹配的标签（默认已含 button/a/div/span）。
 */
export function findButtonByText(
  texts: readonly string[],
  scope: ParentNode = document,
  extraTags: string[] = [],
): HTMLElement | null {
  const tags = ['button', 'a', 'div', 'span', 'p', ...extraTags].join(',');
  const candidates: { el: HTMLElement; text: string }[] = [];
  let nodes: Element[] = [];
  try {
    nodes = Array.from(scope.querySelectorAll(tags));
  } catch {
    return null;
  }
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest('[data-cxai-ui]')) continue;
    const text = (node.textContent ?? '').replace(/\s+/g, '').trim();
    if (!text || text.length > 14) continue;
    if (!isVisible(node)) continue;
    // 只保留「最内层」的候选：子元素里有同样文案就跳过父级
    const childSame = Array.from(node.children).some(
      (c) => (c.textContent ?? '').replace(/\s+/g, '').trim() === text,
    );
    if (childSame) continue;
    candidates.push({ el: node, text });
  }

  for (const want of texts) {
    const exact = candidates.find((c) => c.text === want);
    if (exact) return exact.el;
  }

  /*
   * 包含匹配：**取最具体的那个**（文本最短 = 最内层），而不是「取第一个命中的」。
   *
   * 🚨 这条是线上「按钮明明在屏幕上，助手点了却毫无反应、还得自己点」的根因之一。
   *
   * 真机现场（最终评估弹窗）：
   * ```html
   * <div class="init-dialog__footer">
   *   <button class="init-dialog__btn--secondary">我再想想</button>
   *   <button class="init-dialog__btn--primary">开始评估</button>
   * </div>
   * ```
   * 父容器 `.init-dialog__footer` 的文本是「我再想想开始评估」，**也包含「开始」**，
   * 而且它在 DOM 里**排在两个按钮之前** —— 于是「取第一个」点到的是这个
   * **没有任何点击处理器的 footer**：Vue 的处理器一次都没被调用
   * （弹窗不关、接口不发），从用户视角就是「助手点了但没反应」。
   *
   * 取文本最短的那个，就自然落到真正的按钮上（「开始评估」4 字 < 父容器 8 字）。
   */
  for (const want of texts) {
    const loose = candidates
      .filter((c) => c.text.includes(want))
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (loose) return loose.el;
  }
  return null;
}

/** 在本 frame + 所有同源子 iframe 里按文案找按钮。 */
export function findButtonByTextDeep(texts: readonly string[], extraTags: string[] = []): HTMLElement | null {
  for (const root of searchRoots()) {
    const hit = findButtonByText(texts, root, extraTags);
    if (hit) return hit;
  }
  return null;
}

/** 点击并按需等待一小会儿，让 Vue 完成重渲染。 */
export async function clickAndSettle(el: HTMLElement, settleMs = 400): Promise<void> {
  clickElement(el);
  await sleep(settleMs);
}

/** `clickButton` 的可选项。 */
export interface ClickButtonOptions {
  /** 总超时（毫秒）。 */
  timeoutMs?: number;
  /** 轮询间隔。 */
  intervalMs?: number;
  /** 中止信号。 */
  signal?: AbortSignal;
  /** 查询范围（默认整个文档）。 */
  scope?: ParentNode;
  /** 是否连同同源子 iframe 一起搜。 */
  deep?: boolean;
  /** 点击后等待重渲染的时长。 */
  settleMs?: number;
}

/**
 * **轮询式**点击按钮。
 *
 * 这是这次修复的关键之一：原来的实现都是「找一次 → 找不到就算了 / 报错」，
 * 但任务流页面的按钮全都是**异步渲染**的 —— 「开始评估」「直接来吧」
 * 「下一节点」都会在动作发生后 0.5~3 秒才出现。只查一次必然错过，
 * 于是表现为「按钮就在屏幕上，助手却当没看见，还得人手动点」。
 *
 * @param texts 候选文案（按优先级）。
 * @param options 轮询与点击参数。
 * @returns 点到按钮的文案；超时未找到返回 `null`。
 */
export async function clickButton(
  texts: readonly string[],
  options: ClickButtonOptions = {},
): Promise<string | null> {
  const {
    timeoutMs = 20_000,
    intervalMs = 600,
    signal,
    scope,
    deep = false,
    settleMs = 900,
  } = options;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const btn = deep
      ? findButtonByTextDeep(texts)
      : findButtonByText(texts, scope ?? document);
    if (btn) {
      const text = (btn.textContent ?? '').replace(/\s+/g, '').trim();
      log.info(`点击按钮：「${text}」`);
      await clickAndSettle(btn, settleMs);
      return text;
    }
    if (Date.now() > deadline) return null;
    await sleep(intervalMs, signal);
  }
}

/** 等待某个按钮出现（不点击）。 */
export async function waitForButton(
  texts: readonly string[],
  options: ClickButtonOptions = {},
): Promise<HTMLElement | null> {
  const { timeoutMs = 20_000, intervalMs = 600, signal, scope, deep = false } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const btn = deep ? findButtonByTextDeep(texts) : findButtonByText(texts, scope ?? document);
    if (btn) return btn;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs, signal);
  }
}

/* ------------------------------------------------------------------ */
/* 读取任务流                                                          */
/* ------------------------------------------------------------------ */

/**
 * 读取所有节点卡片。
 *
 * ⚠️ 必须把「不是节点的行」剔除掉。真机实测：任务全部完成后，列表末尾会多出一个
 * `article.flow-card.flow-card--done`（内容是「任务已完成 / 查看最终评估结果」），
 * 它**既没有 `.task-type` 也没有标题**。当成节点读的话会得到一个
 * 「类型 unknown、永远未完成」的幽灵节点 —— 编排器以为还有活要干，永远收不了尾。
 *
 * 判定条件：类名不是装饰行，且**至少有类型文案或标题**。
 */
export function readCards(): HTMLElement[] {
  const list = pick(FLOW_SELECTORS.cardList);
  if (!list) return [];
  const cardSelector = FLOW_SELECTORS.card.join(',');
  return Array.from(list.querySelectorAll(cardSelector)).filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    if (NOISE_CARD_CLASS_RE.test(classOf(el))) return false;
    const hasType = Boolean(pickAny(FLOW_SELECTORS.taskType, el));
    const hasTitle = Boolean(flat(pickAny(FLOW_SELECTORS.cardTitle, el), 80));
    return hasType || hasTitle;
  });
}

/** 页面是否已经打出「整条任务流完成」的标记。 */
export function isFlowDoneMarked(): boolean {
  return Boolean(pickAny(FLOW_SELECTORS.doneMarker));
}

/**
 * 找到「最终评估还没生成」的汇总行。
 *
 * 站点在 `recordStatus === 0` 时渲染 `.task-done-row--pending`（文案「查看最终评估结果」），
 * 点它会弹窗；确认后才会生成最终评估、回写成绩。
 *
 * @returns 需要点击的汇总行（不要求可见时返回 `null`）。
 */
export function findSummaryPendingRow(): HTMLElement | null {
  return pick(FLOW_SELECTORS.summaryPendingRow);
}

/**
 * 等待「这个节点已经翻篇」。
 *
 * 🚨 为什么不只等 `is-completed`（真机踩过）：
 *
 * `.is-completed` 是**后端结果回写之后**才加上去的，而页面往往更早就前进了
 * （出现「进入任务」入口、内容区换了题、打出「任务流已完成」标记）。
 * 只盯 `is-completed` 会傻等整整 5 分钟，期间**一个按钮都不会点** ——
 * 用户看到的就是「卡住了 / 这些按钮还得我自己点」。
 *
 * 这里的多路判据（任一成立就算翻篇）：
 * 1. 该标题的卡片已被标记为完成；
 * 2. 页面打出了「任务流已完成」标记；
 * 3. 页面上出现了新的「进入任务」入口（说明下一个节点已经可进入）；
 * 4. 内容区还停在这个类型上，但**已经没活可干了**（评估完成后按钮全部消失）。
 *
 * @param title 节点标题。
 * @param type 节点类型。
 * @param options 超时、轮询参数，以及「长时间没变化」时的兜底回调 `onStall`。
 * @returns 是否观察到「翻篇」（超时返回 `false`）。
 */
export async function waitForNodeSettled(
  title: string,
  type: FlowNodeType,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    signal?: AbortSignal;
    /**
     * 停滞兜底：每隔 `stallMs` 没有观察到变化就调用一次。
     *
     * 这是「按钮还得自己点」的**最后一道保险** —— 万一前面的链路漏了某个动作
     * （某个版本多了一个确认弹窗、某个按钮文案变了），这里还有机会主动推一把。
     */
    onStall?: () => void | Promise<void>;
    /** 停滞判定的间隔。 */
    stallMs?: number;
  },
): Promise<boolean> {
  const { timeoutMs, intervalMs = 1200, signal, onStall, stallMs = 20_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastNudge = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (isNodeSettled(readFlowState(), title, type)) return true;
    if (onStall && Date.now() - lastNudge >= stallMs) {
      lastNudge = Date.now();
      try {
        await onStall();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        log.warn(`停滞兜底执行失败（忽略，继续等）：${(err as Error)?.message ?? String(err)}`);
      }
    }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs, signal);
  }
}

/**
 * 「这个节点已经翻篇」的判定（`waitForNodeSettled` 的纯函数版本）。
 *
 * @param state 当前任务流状态（可能为 `null`）。
 * @param title 节点标题。
 * @param type 节点类型。
 */
export function isNodeSettled(state: FlowState | null, title: string, type: FlowNodeType): boolean {
  if (!state) return false;
  if (state.doneMarked) return true;
  const card = state.nodes.find((n) => n.title === title);
  if (card?.completed) return true;
  if (findEnterTaskButton()) return true;
  if (
    (type === 'upload' || type === 'dialogue') &&
    state.activeContent === type &&
    !isContentActionable(type)
  ) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 意外弹窗                                                            */
/* ------------------------------------------------------------------ */

/**
 * 关掉「挡路的提示弹窗」。
 *
 * 任务流里除了初始化弹窗，还可能出现别的提示层（例如某个节点评估完成后弹出的
 * 结果提示）。它们盖在卡片上会让**页面自己**忽略后续点击 ——
 * 从用户视角就是「按钮看得见、助手也点了，但页面没反应」。
 *
 * ⚠️ 白名单必须收紧：**只点「确认 / 知道了 / 关闭」这类收尾词**，
 * 绝不去点「取消」「我再想想」这种会撤销动作的按钮，也不点任何业务提交按钮。
 *
 * @returns 关掉了几个弹窗。
 */
export function dismissStrayDialog(): number {
  let closed = 0;
  for (const root of searchRoots()) {
    let dialogs: Element[] = [];
    try {
      dialogs = Array.from(
        root.querySelectorAll('.init-dialog, .el-message-box, .el-dialog__wrapper, [class*="dialog__wrapper"]'),
      );
    } catch {
      continue;
    }
    for (const dialog of dialogs) {
      if (!(dialog instanceof HTMLElement) || !isVisible(dialog)) continue;
      if (dialog.closest('[data-cxai-ui]')) continue;
      const btn =
        pick(FLOW_SELECTORS.initDialogBtn, dialog) ??
        findButtonByText(['我知道了', '知道了', '关闭', '确定', '确定并关闭'], dialog);
      if (!btn) continue;
      const text = (btn.textContent ?? '').replace(/\s+/g, '').trim();
      if (!['直接来吧', '我知道了', '知道了', '关闭', '确定', '确定并关闭'].includes(text)) continue;
      log.info(`关闭挡路的提示弹窗（点了「${text}」）`);
      clickElement(btn);
      closed += 1;
    }
  }
  return closed;
}

/* ------------------------------------------------------------------ */
/* 「最终评估」读取                                                    */
/* ------------------------------------------------------------------ */

/**
 * 上传节点要求提交的**作品类型**。
 *
 * 真机实测：站点在作品卡片上写明「类型：文档」或「类型：图片」，
 * 两者的附件选择器入参完全不同（`fileTypes=doc,docx` vs `fileTypes=png,jpg,jpeg`）。
 * 传错类型时选择器会直接提示 **「上传失败：类型不支持」**，
 * 附件挂不上 → 点「开始评估」只会弹「评估失败，请稍后重试」→ 那个节点永远走不动。
 *
 * @returns `'image'`（图片/截图）或 `'document'`（文档）。
 */
export function readUploadKind(): UploadKind {
  const meta = flat(pickAny(FLOW_SELECTORS.workMeta), 120);
  // `.work-meta` 里的「类型：xxx」是权威信号
  const declared = /类型\s*[:：]\s*([^\s数量]+)/.exec(meta)?.[1] ?? '';
  if (/图片|截图|照片|image/i.test(declared)) return 'image';
  if (/文档|文件|doc/i.test(declared)) return 'document';

  // 兜底：从要求文案里判断
  const hint = `${meta} ${flat(pickAny(FLOW_SELECTORS.workRequirement), 300)}`;
  if (/截图|图片|照片|\bpng\b|\bjpe?g\b/i.test(hint)) return 'image';
  return 'document';
}

/** 读取最终评估得分（还没生成时为空串）。 */
export function readChainFinalScore(): string {
  if (pickAny(FLOW_SELECTORS.summaryPendingRow)) return '';
  return flat(pickAny(FLOW_SELECTORS.summaryScore), 12).replace(/[^\d.]/g, '');
}

/**
 * 读取页面上正在显示的**错误提示**（Element-UI 的 `.el-message--error`）。
 *
 * 为什么需要它：站点在「开始评估」失败时**不会改变任何 DOM 状态**，
 * 只弹一个几秒就消失的 message（真机实测：`评估失败，请稍后重试`）。
 * 不看它的话，助手会以为「按钮没点到」而**无限重试点同一个按钮** ——
 * 用户看到的就是「卡在那里，一直在点，什么都不发生」。
 *
 * 拿到这条提示，就能换成正确动作（重新上传一份新作品再评估）。
 *
 * @returns 错误提示文案；没有时为空串。
 */
export function readFlowErrorToast(): string {
  for (const root of searchRoots()) {
    let hits: Element[] = [];
    try {
      hits = Array.from(root.querySelectorAll('.el-message--error, [class*="el-message--error"]'));
    } catch {
      continue;
    }
    for (const el of hits) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return '';
}

/** 「重新上传」按钮（文件已挂上、想换一份时点它），找不到返回 `null`。 */
export function findReuploadButton(): HTMLElement | null {
  return pick(FLOW_SELECTORS.reuploadBtn) ?? findButtonByText(['重新上传', '重新选择', '更换文件']);
}

/**
 * 对话节点是否已经「作答达轮数要求、等待开始评估」。
 *
 * 真机实测：达标后对话 frame 里会渲染
 * `<div class="complete newChapeter wrap1000"><div class="taskChainCompleteText">
 * 已完成作答轮数要求，点击开始评估</div></div>`。
 *
 * 这一段必须被识别，否则对话明明早就结束了，状态机还在等「下一个提问」，
 * 于是「开始评估」只能用户自己点 —— 正是线上反馈的现象之一。
 *
 * 在**本 frame + 所有同源子 iframe**里找（该提示出现在对话 iframe 内）。
 */
export function findDialogueCompleteText(): HTMLElement | null {
  for (const root of searchRoots()) {
    const hit = pick(FLOW_SELECTORS.dialogueCompleteText, root);
    if (hit) return hit;
  }
  return null;
}

/** 对话达标提示的**可点容器**（那个 `.complete` 块）。 */
export function findDialogueCompleteBlock(): HTMLElement | null {
  for (const root of searchRoots()) {
    const hit = pick(FLOW_SELECTORS.dialogueCompleteBlock, root);
    if (hit) return hit;
  }
  return null;
}

/** 对话节点是否已达标待评估。 */
export function isDialogueRoundComplete(): boolean {
  return Boolean(findDialogueCompleteText());
}

/** 卡片上的 class 文本。 */
function classOf(el: HTMLElement): string {
  return el.className?.toString?.() ?? '';
}

/**
 * 读取节点类型文案。
 *
 * 真实 DOM 是 `<div class="task-type"><span class="task-index">02</span><span>情景对话</span></div>`，
 * 直接取外层文本会得到「02情景对话」，既难看也会影响类型判定，所以要剔除序号那一节。
 */
function readTypeLabel(card: HTMLElement): string {
  const el = pickAny(FLOW_SELECTORS.taskType, card);
  if (!el) return '';
  const spans = Array.from(el.querySelectorAll('span')).filter(
    (s) => !s.classList.contains('task-index'),
  );
  const raw = spans.length > 0 ? (spans[spans.length - 1].textContent ?? '') : (el.textContent ?? '');
  return raw.replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

/**
 * 读取「尚未渲染成卡片」的后续节点。
 *
 * 它们出现在「解锁下一节点条件」里：每个 `.unlock-target` 是一个
 * `<p>类型</p><h4>标题</h4>`。注意其中会有一条是「未通过 → 重做当前节点」，
 * 需要按标题排除掉。
 *
 * @param currentTitle 当前节点标题（用于排除「重做当前节点」那条规则）。
 */
export function readUpcomingNodes(currentTitle: string): { title: string; typeLabel: string }[] {
  const result: { title: string; typeLabel: string }[] = [];
  const seen = new Set<string>();
  let nodes: Element[] = [];
  try {
    nodes = Array.from(document.querySelectorAll(FLOW_UPCOMING_TARGET));
  } catch {
    return result;
  }
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const typeLabel = flat(node.querySelector('p'), 20);
    /*
     * ⚠️ 只认「有 h4 标题」的 target。
     *
     * 真机实测：条件列表的最后一条是 `<p>结束</p><h4></h4>` —— 它是**终止标记**，
     * 不是节点。以前用「h4 为空就退回整段文本」的写法，会凭空多出一个叫「结束」的
     * 待解锁节点，于是 (a) 进度永远显示 X/Y 差一个，(b) `allCompleted` 永远不成立，
     * 流程收不了尾。
     */
    const h4 = flat(node.querySelector('h4'), 40);
    if (!h4) continue;
    const title = h4;
    if (title === currentTitle || seen.has(title)) continue;
    seen.add(title);
    result.push({ title, typeLabel });
  }
  return result;
}

/** 把一个卡片解析成节点信息。 */
function parseCard(card: HTMLElement, domIndex: number): FlowNode {
  const typeLabel = readTypeLabel(card);
  const title = flat(pickAny(FLOW_SELECTORS.cardTitle, card), 80);
  const description = flat(pickAny(FLOW_SELECTORS.cardDesc, card), 300);
  const completeCondition = flat(pickAny(FLOW_SELECTORS.completeCondition, card), 300);
  const classes = classOf(card);

  // 类型判定：先看权威的类型文案，读不到再用卡片文案推断。
  // ⚠️ 绝不能停在 unknown —— 编排器以前把「非 upload」一律当对话节点跑，
  // 于是「第一个节点是上传作品」时会被拿去跑对话，文件永远传不上去。
  let type: FlowNodeType = classifyNodeType(typeLabel);
  if (type === 'unknown') {
    type = inferNodeTypeFromText(
      [title, description, completeCondition, flat(card, 400)].join(' '),
    );
    if (type !== 'unknown') {
      log.debug(`节点「${title}」的 .task-type 为空，已按卡片文案推断为 ${type}`);
    }
  }

  return {
    domIndex,
    label: flat(pickAny(FLOW_SELECTORS.taskIndex, card), 8),
    title,
    type,
    typeLabel: typeLabel || NODE_TYPE_LABEL[type],
    description,
    completeCondition,
    completed: /is-completed/.test(classes),
    /*
     * 「当前节点」判定。
     *
     * 站点源码里这三个 class 的语义是（已从 `6727.*.js` 确认）：
     * ```
     * class: { "is-current": i.current, "is-completed": i.completed,
     *          "is-upcoming": i.upcoming, "is-selected": selectedTaskId === i.id }
     * ```
     * - `is-current` 绑的是数据里的 `i.current` —— **可信**；
     * - `is-selected` 只是「列表里被高亮选中的那一张」（用户点过哪张就是哪张），
     *   **和「当前该做哪题」无关**：用户点开一个已完成节点回顾时，它也会被选中。
     *
     * 旧实现把两者合并（`/is-current|is-selected/`），于是「用户点过的那张卡」
     * 会被误判成当前节点 —— 这正是线上「已经到上传节点了，助手却显示上一个
     * 对话节点」的来源之一。所以这里**只认 `is-current`**，
     * 并额外接受 `.task-status:not(--upcoming)`（站点只在 `i.current` 为真时才渲染它）
     * 作为兜底。
     */
    current:
      /is-current/.test(classes) || Boolean(pickAny(FLOW_SELECTORS.taskStatusCurrent, card)),
    selected: /is-selected/.test(classes),
    upcoming: /is-upcoming/.test(classes),
    score: flat(pickAny(FLOW_SELECTORS.taskScore, card), 12),
  };
}

/**
 * 读取右侧内容区当前展示什么。
 *
 * 限定在 `.right-content` 里查：整页范围内可能存在其它同名/相似容器
 * （隐藏的旧节点内容、弹层模板……），不限定范围会把判断带偏。
 */
export function readActiveContent(): FlowActiveContent {
  const scope = (pickAny(FLOW_SELECTORS.rightContent) as HTMLElement | null) ?? document;

  const dialogue = Boolean(pick(FLOW_SELECTORS.dialogueFrame, scope));
  const upload = Boolean(pick(FLOW_SELECTORS.uploadContent, scope));
  const completed = Boolean(pick(FLOW_SELECTORS.completedView, scope));

  if (dialogue && !upload) return 'dialogue';
  if (upload && !dialogue) return 'upload';
  if (upload && dialogue) return 'upload';
  if (completed) return 'completed';
  return 'unknown';
}

/**
 * 读取右侧内容区当前展示的**节点标题**。
 *
 * 上传节点的内容区里会带上题目标题（`.task-detail h3` / `.upload-card h3`），
 * 与左侧卡片上的 `h3` 是同一份数据 —— 这是**最强的关联信号**：
 * 直接拿它去卡片列表里对号入座，比任何 class 标记都可靠。
 *
 * 对话节点的内容区是个 iframe，读不到标题，返回空串（走类型互证那条路）。
 */
export function readActiveTitle(): string {
  const scope = (pickAny(FLOW_SELECTORS.rightContent) as HTMLElement | null) ?? document;
  const candidates = [
    ...FLOW_SELECTORS.uploadTitle,
    ...FLOW_SELECTORS.workTitle,
    '.right-content h3',
    '.right-content h2',
  ];
  for (const selector of candidates) {
    let hit: Element | null = null;
    try {
      hit = scope.querySelector(selector);
    } catch {
      continue;
    }
    const title = flat(hit, 80);
    if (title) return title;
  }
  return '';
}

/**
 * 解出「当前节点」在卡片列表中的下标。
 *
 * 四路信号按可靠性排序：
 *
 * 0. **内容区标题与卡片标题对号入座** ——
 *    上传节点的内容区带着同一份标题数据，直接匹配即可；即使页面上有多张卡片
 *    同时挂着 `is-current`、或 `.task-type` 完全读不到，这一步也不会被骗。
 * 1. **右侧内容区类型**（对话 iframe / 上传组件）配合节点类型锁定候选。
 * 2. **卡片标记**（`is-current` / `is-selected`）——
 *    前端是**动作完成后**才更新标记的，切换途中会有多个卡片同时带标记，
 *    所以取**最后一个**（靠后的才是新选中的）。
 * 3. **未完成态** —— 前面都不可用时的兜底。
 *
 * @param nodes 卡片解析结果。
 * @param active 内容区类型判定。
 * @param activeTitle 内容区标题。
 */
function resolveCurrentIndex(
  nodes: FlowNode[],
  active: FlowActiveContent,
  activeTitle: string,
): number {
  if (nodes.length === 0) return -1;
  const indexes = nodes.map((_, i) => i);

  // ⓪ 内容区标题 ⇄ 卡片标题 精确匹配
  if (activeTitle) {
    const hit = indexes.filter((i) => nodes[i].title && nodes[i].title === activeTitle);
    if (hit.length) return hit[hit.length - 1];
    // 标题可能被截断/加前缀，退一步做包含匹配（取最长的那个，避免误配短标题）
    const loose = indexes
      .filter(
        (i) =>
          nodes[i].title &&
          (nodes[i].title.includes(activeTitle) || activeTitle.includes(nodes[i].title)),
      )
      .sort((a, b) => nodes[b].title.length - nodes[a].title.length);
    if (loose.length) return loose[0];
  }

  if (active === 'upload' || active === 'dialogue') {
    // ①a 内容区类型 + 卡片标记 双重命中 —— 最可信
    const markedMatch = indexes.filter((i) => nodes[i].current && nodes[i].type === active);
    if (markedMatch.length) return markedMatch[markedMatch.length - 1];
    // ①b 内容区类型 + 未完成
    const unfinishedMatch = indexes.filter((i) => !nodes[i].completed && nodes[i].type === active);
    if (unfinishedMatch.length) return unfinishedMatch[0];
    // ①c 内容区类型（该节点可能刚评估完，标记还没更新）
    const anyMatch = indexes.filter((i) => nodes[i].type === active);
    if (anyMatch.length) return anyMatch[anyMatch.length - 1];
  }

  const marked = indexes.filter((i) => nodes[i].current);
  if (marked.length) return marked[marked.length - 1];

  const unfinished = indexes.filter((i) => !nodes[i].completed);
  if (unfinished.length) return unfinished[0];

  return nodes.length - 1;
}

/**
 * 读取当前任务流状态。
 *
 * @returns 页面不是任务流页面时返回 `null`。
 */
export function readFlowState(): FlowState | null {
  const cards = readCards();
  if (cards.length === 0) return null;

  const nodes = cards.map(parseCard);
  const activeContent = readActiveContent();
  const activeTitle = readActiveTitle();
  const currentIndex = resolveCurrentIndex(nodes, activeContent, activeTitle);
  const current = currentIndex >= 0 ? nodes[currentIndex] : null;

  // 内容区反向校正：`.task-type` 读空时，用「右侧正在显示什么」把类型补齐。
  // 这是「上传节点被识别成对话节点」的最后一道保险。
  if (
    current &&
    current.type === 'unknown' &&
    (activeContent === 'upload' || activeContent === 'dialogue')
  ) {
    current.type = activeContent;
    current.typeLabel = NODE_TYPE_LABEL[activeContent];
    log.debug(`节点「${current.title}」类型未知，已按内容区校正为 ${activeContent}`);
  }

  // 已渲染卡片之外的后续节点（页面只渲染到当前节点）
  const renderedTitles = new Set(nodes.map((n) => n.title));
  const pendingNodes = readUpcomingNodes(current?.title ?? '')
    .filter((u) => !renderedTitles.has(u.title))
    .map((u) => ({ ...u, type: classifyNodeType(u.typeLabel) }));

  // 「页面上还有可以进入的节点」—— 这是判断「是否真的全做完」的关键补充信号：
  // 只看卡片，会在「当前节点已完成、下一节点刚从解锁区冒出来」的窗口期误判为全部完成。
  const hasNext = Boolean(findEnterTaskButton());

  /*
   * 「全部完成」的判定。
   *
   * 优先采信**页面自己给出的完成标记**（`.flow-card--done` / `.task-done-row`）——
   * 这是最直接、最不会误判的信号。推断式判定只作为补充。
   *
   * 为什么不能只靠推断：真机上「当前节点刚完成、内容区还挂着最后一题」时，
   * 推断式判定仍然认为内容区是「上传节点」，编排器会反复去啃一个已经做完的节点。
   */
  const doneMarked = isFlowDoneMarked();
  const allCompleted =
    doneMarked || (nodes.length > 0 && nodes.every((n) => n.completed) && !hasNext && pendingNodes.length === 0);

  return {
    nodes,
    currentIndex,
    currentType: current?.type ?? 'unknown',
    currentTitle: current?.title ?? '',
    activeContent,
    activeTitle,
    allCompleted,
    doneMarked,
    unlockCondition: flat(pickAny(FLOW_SELECTORS.unlockCondition), 300),
    pendingNodes,
    requirement: readUploadRequirement(),
  };
}

/** 读取上传节点的「作品要求」（含卡片说明与提交要求）。 */
export function readUploadRequirement(): string {
  const parts = [
    flat(pickAny(FLOW_SELECTORS.uploadTitle), 120),
    flat(pickAny(FLOW_SELECTORS.uploadRequirement), 500),
    flat(pickAny(FLOW_SELECTORS.workTitle), 120),
    flat(pickAny(FLOW_SELECTORS.workMeta), 80),
    flat(pickAny(FLOW_SELECTORS.workRequirement), 500),
  ].filter(Boolean);
  return parts.join('\n');
}

/** 已上传文件是否已出现（至少一个）。 */
export function hasUploadedFile(): boolean {
  return Boolean(pick(FLOW_SELECTORS.uploadedFiles));
}

/** 「开始评估」按钮是否已出现（文件挂上后才会渲染）。 */
export function hasEvaluateButton(): boolean {
  return Boolean(pick(FLOW_SELECTORS.evaluateBtn));
}

/**
 * 附件选择器弹层当前是否可见。
 *
 * 宿主组件用 `v-show` 控制显隐，且**只在弹层可见时才处理「确定」消息**；
 * 残留的弹层还会挡住后续点击，所以打开新弹层前要先把它复位。
 */
export function isFilePickerOpen(): boolean {
  const overlay = pick(FLOW_SELECTORS.filePickerOverlay) as HTMLElement | null;
  if (!overlay) return false;
  const cs = getComputedStyle(overlay);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

/**
 * 关闭残留的附件选择器弹层。
 *
 * 宿主组件的 `handleFilePickerMessage` 监听 window 上的 `message`：
 * 收到 `attachmentCloseWin` 就会把 `filePickerIframeUrl` 置回 `about:blank` 并隐藏弹层。
 * 我们先主动复位，好处是**下次打开时 iframe 的 src 会真正变化从而重新加载** ——
 * 否则若上次弹层没关干净，再次打开设置的是同一个 URL，浏览器不会重新导航，
 * 选择器 frame 里的内容脚本也不会重新注入。
 *
 * @returns 是否执行了复位（弹层当时是打开的）。
 */
export function resetFilePickerOverlay(): boolean {
  if (!isFilePickerOpen()) return false;
  try {
    window.postMessage({ type: 'attachmentCloseWin' }, '*');
    return true;
  } catch {
    return false;
  }
}

/**
 * 右侧内容区现在**还有没有活可干**。
 *
 * 这是「临时合成节点」和「判断内容区是否已翻篇」的安全阀门。
 * 站点源码（`6907.*.js`）里的渲染条件是：
 * ```
 * uploadInfo.taskCompleted || isEvaluating || evaluateResultState === 'done'
 *   ? 什么都不渲染
 *   : [ hasUploadedFiles ? <div.upload-actions>（重新上传 / 开始评估）
 *                        : <button.choose-btn>（选择文件）]
 * ```
 * 也就是说：**评估完成后 `.choose-btn` / `.evaluate-btn` 都会消失**。
 * 所以「这两个按钮都不在」= 这道题已经没活可干了。
 *
 * 为什么必须有这个判断：最后一题做完后，`.right-content` 仍然挂着这道题
 * （`.upload-content` 还在），只按「内容区是上传节点」就去临时合成节点的话，
 * 会**反复去啃一个已经做完的节点**，面板一直显示「正在处理…」，
 * 用户看到的就是「卡住 / 没有任何效果」。
 *
 * @param type 内容区类型。
 */
export function isContentActionable(type: 'dialogue' | 'upload'): boolean {
  if (type === 'upload') {
    return Boolean(pick(FLOW_SELECTORS.chooseBtn)) || Boolean(pick(FLOW_SELECTORS.evaluateBtn));
  }
  // 对话节点：要么停在开场页（有「开始对话」），要么对话界面里有可写的输入框
  if (findButtonByTextDeep(FLOW_ACTIONS.startDialogue)) return true;
  for (const root of searchRoots()) {
    let hit: Element | null = null;
    try {
      hit = root.querySelector('textarea.messageInput, textarea, [contenteditable="true"]');
    } catch {
      hit = null;
    }
    if (hit && isVisible(hit as HTMLElement)) return true;
  }
  return false;
}

/** 对话 iframe 是否已挂载。 */
export function getDialogueFrame(): HTMLIFrameElement | null {
  const el = pick(FLOW_SELECTORS.dialogueFrame);
  return el instanceof HTMLIFrameElement ? el : null;
}

/**
 * 任务流上**是否还有需要助手去做的活**。
 *
 * 这是**编排器监督者**的判据 —— 决定「编排器停了之后要不要自动拉起来」。
 * 编排器的主循环在几条路径上会直接 `return`（读不到任务流、没有可推进的节点…），
 * 之后若没有外部事件它就再也不会醒来 —— 用户看到的就是「过一会儿就不动了、
 * 剩下的按钮还得自己点」。监督者靠这个函数把「还有活」和「真的做完了」区分开。
 *
 * ⚠️ 必须写得保守：只有在确实还有未完成的东西时才返回 `true`，
 * 否则会在真正做完之后反复重启，把它自己变成死循环。
 *
 * @param state 当前任务流状态。
 */
export function flowNeedsWork(state: FlowState | null): boolean {
  if (!state) return false;
  // 页面已打出「任务流完成」标记，且最终评估也生成了 —— 真做完了
  if (state.doneMarked && readChainFinalScore()) return false;
  // 完成标记在、也没有待生成的最终评估 —— 真做完了
  if (state.doneMarked && !findSummaryPendingRow()) return false;
  // 还有未完成的节点
  if (state.nodes.some((n) => !n.completed)) return true;
  // 还有没解锁出来的后续节点
  if (state.pendingNodes.length > 0) return true;
  // 节点都打勾了，但「最终评估」还没生成
  if (findSummaryPendingRow()) return true;
  return false;
}

/**
 * 从表格行里挑出「刚上传成功的那一行」。
 *
 * 🚨 这是附件选择器上传失败的真凶所在（真机取证 2026-09）。
 *
 * 现场事实：
 * - 选择器页面的列表里**本来就有历史行**（云盘文件），每行都带
 *   `.el-checkbox__original`，但它们的勾选框全部是 `is-disabled`；
 * - 写入文件后页面会**新增一行**（`作品.docx 69.00 B 上传成功`），
 *   它是**唯一一行没有被 `is-disabled` 的**。
 *
 * 旧实现的两个错误叠加：等待条件写成「页面上有勾选框」（上传前就为真 → 误报成功），
 * 勾选又取「第一个勾选框」（落在禁用的历史行上，点了等于没点）——
 * 结果是点确定时提交**空列表**，宿主实测收到
 * `{"type":"attachmentConfirm","data":"[]"}`，文件永远挂不上作品卡片。
 *
 * @param rows 表格行。
 * @param fileName 期望的文件名。
 * @returns 可勾选的那一行；还没上传成功时返回 `null`。
 */
export function pickUsableRow(rows: Element[], fileName: string): HTMLElement | null {
  const usable = rows.filter(
    (tr): tr is HTMLElement =>
      tr instanceof HTMLElement &&
      !tr.querySelector('.el-checkbox.is-disabled') &&
      // 明确写着上传失败的行（例如「上传失败：类型不支持」）绝不能用
      !/上传失败|类型不支持|超过|不允许|非法/.test(tr.textContent ?? ''),
  );
  if (usable.length === 0) return null;
  const base = fileName.replace(/\.(docx?|pdf|png|jpe?g|zip)$/i, '');
  const byName = usable.find((tr) => {
    const text = tr.textContent ?? '';
    return text.includes(fileName) || (base.length > 4 && text.includes(base));
  });
  if (byName) return byName;
  // 名字被截断 / 显示不一致时的兜底：只有一行可用且明确写着「上传成功」
  const done = usable.filter((tr) => /上传成功|上传完成|已上传/.test(tr.textContent ?? ''));
  return done.length === 1 ? done[0] : null;
}

/** 在**当前文档**里找「刚上传成功的那一行」（选择器页面用）。 */
export function findUploadedRow(fileName: string): HTMLElement | null {
  let rows: Element[] = [];
  try {
    rows = Array.from(document.querySelectorAll('.el-table__body tr'));
  } catch {
    return null;
  }
  return pickUsableRow(rows, fileName);
}

/* ------------------------------------------------------------------ */
/* 操作                                                                */
/* ------------------------------------------------------------------ */

/**
 * 找到「进入任务」按钮。
 *
 * 优先取「即将作答」卡片上的按钮（那才是真正需要进入的节点）；
 * 找不到时退化为页面上任意位置的「进入任务」（文案/类名两种路径都试）。
 *
 * @param scope 查询范围。
 */
export function findEnterTaskButton(scope: ParentNode = document): HTMLElement | null {
  for (const card of readCards()) {
    if (!/is-upcoming/.test(classOf(card))) continue;
    const btn =
      pick(FLOW_SELECTORS.enterTaskBtn, card) ?? findButtonByText(FLOW_ACTIONS.enterTask, card);
    if (btn) return btn;
  }
  return (
    pick(FLOW_SELECTORS.enterTaskBtn, scope) ??
    findButtonByText(FLOW_ACTIONS.enterTask, scope)
  );
}

/** 页面上是否还有「进入任务」入口（= 还有下一个节点可做）。 */
export function hasNextNodeEntry(): boolean {
  return Boolean(findEnterTaskButton());
}

/**
 * 点击指定下标的节点卡片（切换右侧内容区）。
 *
 * @param domIndex 卡片下标。
 */
export async function selectCard(domIndex: number): Promise<boolean> {
  const cards = readCards();
  const card = cards[domIndex];
  if (!card) return false;
  // 卡片本体绑定了 click，直接点卡片（或它的 body）
  const target = pickAny(FLOW_SELECTORS.cardDesc, card)?.parentElement ?? card;
  await clickAndSettle(target, 600);
  return true;
}

/**
 * 关闭「初始化提示」弹窗（首次进入节点时可能出现）。
 *
 * ⚠️ 两个关键点，都是线上踩出来的：
 *
 * 1. **必须轮询等它出现**。点「进入任务」后要先调接口，弹窗 0.5~3 秒才渲染；
 *    只查一次会直接返回 false —— 表现就是「按钮就在屏幕上，助手却当没看见」。
 *    这是「进入任务 / 直接来吧 还得自己点」的根因。
 * 2. **确认按钮按选择器取，不靠猜文案**。这个弹窗的确认就是主按钮
 *    （`.init-dialog__btn--primary`，文案「直接来吧」）。文案对不上时
 *    **绝不能**退而去点「次要按钮」—— 那是「我再想想」= 取消，
 *    会把刚发起的进入动作取消掉。
 *
 * @param options.timeoutMs 等待弹窗出现的上限。
 * @returns 是否处理了弹窗。
 */
export async function dismissInitDialog(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  const { timeoutMs = 15_000, signal } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const dialog = pick(FLOW_SELECTORS.initDialog);
    if (dialog) {
      // 1) 先按文案找确认按钮
      const byText = findButtonByText(FLOW_ACTIONS.initDialogOk, dialog);
      // 2) 文案对不上就按结构取主按钮（确认按钮就是主按钮）
      const primary = pick(FLOW_SELECTORS.initDialogBtn, dialog);
      const confirm = byText ?? primary;
      if (confirm) {
        log.info('确认初始化提示弹窗');
        await clickAndSettle(confirm, 800);
        return true;
      }
      // 3) 只有连主按钮都没有时，才退回「次要按钮」做兜底关闭
      const secondary = pick(FLOW_SELECTORS.initDialogCancel, dialog);
      if (secondary) {
        log.warn('初始化提示弹窗里找不到主按钮，退回次要按钮关闭');
        await clickAndSettle(secondary, 500);
        return true;
      }
      return false;
    }
    if (Date.now() > deadline) return false;
    await sleep(500, signal);
  }
}

/**
 * 进入一个「即将作答」的节点。
 *
 * 页面把后续节点渲染成 `is-upcoming`，其 `selectTask()` 对 upcoming 直接 return，
 * 所以点卡片无效；必须点卡片上的「进入任务」，再在弹出的初始化提示里点「直接来吧」。
 *
 * @param domIndex 卡片下标；传 `-1`/省略表示「页面上任意一个进入任务入口」。
 * @returns 是否成功点到「进入任务」。
 */
export async function enterUpcomingNode(domIndex = -1): Promise<boolean> {
  const card = domIndex >= 0 ? readCards()[domIndex] : undefined;
  const btn =
    (card
      ? (pick(FLOW_SELECTORS.enterTaskBtn, card) ??
        findButtonByText(FLOW_ACTIONS.enterTask, card))
      : null) ?? findEnterTaskButton();

  if (!btn) return false;
  await clickAndSettle(btn, 800);
  return true;
}

/** 当前节点类型（供上层快速判定）。 */
export function currentNodeType(): FlowNodeType {
  return readFlowState()?.currentType ?? 'unknown';
}

/** 等待任务流出现（页面加载完成）。 */
export async function waitForFlow(timeoutMs: number, signal?: AbortSignal): Promise<FlowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const state = readFlowState();
    if (state) return state;
    if (Date.now() > deadline) throw new Error('等待任务流出现超时');
    await sleep(500, signal);
  }
}

/**
 * 等待条件成立。
 *
 * @param predicate 判定函数。
 * @param options.timeoutMs 超时。
 * @param options.intervalMs 轮询间隔。
 * @param options.signal 中止信号。
 */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<void> {
  const { timeoutMs, intervalMs = 500, signal } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('TIMEOUT');
    await sleep(intervalMs, signal);
  }
}

/**
 * 等待某个节点进入指定状态（**按标题匹配**，不按下标）。
 *
 * 为什么不按下标：任务流的卡片列表会随节点解锁而**变长**，
 * 之前用 `nodes[index]` 去等状态，列表一变就等错了对象 ——
 * 症状是「节点明明早就完成了，助手还在傻等，最后靠超时跳过」。
 *
 * 另外：卡片列表重渲染到一半时 `readFlowState()` 会短暂返回 `null`，
 * 这里把它当成「还没满足」继续轮询，而不是抛错。
 *
 * @param title 节点标题。
 * @param flag 要等待的状态。
 * @param options 超时与轮询参数。
 * @returns 是否等到（超时返回 `false`，由调用方决定后续动作）。
 */
export async function waitForNodeFlag(
  title: string,
  flag: 'current' | 'completed',
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  const { timeoutMs, intervalMs = 700, signal } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const state = readFlowState();
    const node = state?.nodes.find((n) => n.title === title);
    if (node && (flag === 'completed' ? node.completed : node.current)) return true;
    if (Date.now() > deadline) return false;
    await sleep(intervalMs, signal);
  }
}

/** 面板展示用的节点摘要。 */
export function describeFlow(state: FlowState): string {
  const lines = state.nodes.map(
    (n, i) =>
      `  ${i + 1}. [${n.completed ? '✓' : n.current ? '▶' : '·'}] ${n.typeLabel} ${n.title}` +
      `${n.score ? ` (${n.score})` : ''}`,
  );
  return lines.join('\n');
}

/** 可读文本（供上层收集节点上下文）。 */
export function readElementText(el: HTMLElement | null, max = 800): string {
  if (!el) return '';
  return getVisibleText(el).replace(/\n{2,}/g, '\n').trim().slice(0, max);
}
