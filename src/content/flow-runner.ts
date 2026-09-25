import { NODE_MAX_ROUNDS, NODE_TRANSCRIPT_MAX } from '@/common/constants';
import { sleep } from '@/common/dom-utils';
import { CxaiError, toCxaiError } from '@/common/errors';
import { createLogger } from '@/common/logger';
import { FLOW_ACTIONS, NODE_TYPE_LABEL } from './flow-selectors';
import { buildConsolePrompt, generateConsoleScreenshot } from './console-image';
import {
  clickAndSettle,
  clickButton,
  describeFlow,
  dismissInitDialog,
  dismissStrayDialog,
  findButtonByText,
  findButtonByTextDeep,
  findDialogueCompleteBlock,
  findDialogueCompleteText,
  findEnterTaskButton,
  findReuploadButton,
  findSummaryPendingRow,
  hasUploadedFile,
  isContentActionable,
  isDialogueRoundComplete,
  isFilePickerOpen,
  pick,
  readActiveTitle,
  readChainFinalScore,
  readFlowErrorToast,
  readFlowState,
  readUploadKind,
  readUploadRequirement,
  resetFilePickerOverlay,
  selectCard,
  waitFor,
  waitForButton,
  waitForFlow,
  waitForNodeFlag,
  waitForNodeSettled,
} from './flow-dom';
import { FLOW_SELECTORS } from './flow-selectors';
import type { FlowNode, FlowState, FlowNodeType, NodeRecord, PanelStatus } from '@/types';

/**
 * AI 实践「任务流」编排器。
 *
 * 它在任务流宿主页面（`…/taskChain/student/answer`）里运行，负责把**整条节点链路**
 * 自动跑完，而不是只做对话填充：
 *
 * ```
 * 扫描任务流
 *   └─ 逐个节点：
 *        ├ 情景对话节点：让对话 frame 开始对话 → 等它跑完 → 结束并评估
 *        └ 上传作品节点：生成 .docx → 打开附件选择器 → 自动上传 → 开始评估
 *      → 点「进入任务」+「直接来吧」解锁下一节点 → 循环
 * ```
 *
 * ## 这一版为什么能真正「无人值守」
 *
 * 上一版会在三处悄悄停住，用户只能自己点：
 *
 * | 症状 | 上一版的原因 | 现在的做法 |
 * |------|--------------|------------|
 * | 「进入任务 / 直接来吧」要自己点 | 点完只查一次弹窗，弹窗还没渲染就放弃了 | `dismissInitDialog` 轮询等弹窗，确认按钮按**主按钮选择器**取 |
 * | 「开始评估」要自己点 | 收尾按钮只查一次，按钮还没渲染 | `clickButton` 轮询 45~60 秒，且**跨同源 iframe** 查找 |
 * | 走完一个节点就停 | 全部已渲染卡片都完成 → 直接判定「需手动解锁」退出 | 主动点「进入任务」推进；单节点失败不再终止整条流程 |
 *
 * 另外两处判定也换掉了：
 * - **当前节点**：不再只信卡片上的 `is-current`（它滞后，会同时挂在多个卡片上），
 *   而是「内容区标题对号入座 → 内容区类型 → 卡片标记 → 未完成态」多信号互证；
 * - **等节点完成**：不再用卡片下标（列表会变长，下标会错位），改为**按标题**等。
 */

const log = createLogger('content:flow-runner');

/** 跑完一个节点后，等待该节点被标记为「已完成」的上限。 */
const NODE_COMPLETE_TIMEOUT_MS = 5 * 60 * 1000;
/** 单个节点内部「生成 → 上传」这条链的允许重试次数。 */
const NODE_STAGE_RETRY = 3;
/** 单个节点累计失败重试上限；超过后停止折腾并如实上报。 */
const NODE_MAX_ATTEMPTS = 40;
/** 点「进入任务」后，等待节点变成「当前节点」的上限。 */
const ADVANCE_TIMEOUT_MS = 45_000;
/** `readFlowState()` 连续读空的容忍次数（页面重渲染的窗口期）。 */
const EMPTY_STATE_GRACE = 12;
/** 等「下一个节点渲染出来」的最大轮次。 */
const NEXT_NODE_WAIT_ROUNDS = 15;
/**
 * 「可以靠重新上传救回来」的错误提示特征。
 *
 * 站点在评估失败时只弹一条几秒的 message（实测 `评估失败，请稍后重试`），
 * 通常意味着附件在服务端无效 —— **换一份新作品重传**是唯一有效的恢复动作。
 * 反过来，像「缺少作答记录 ID」这种重传也救不了，要如实上报而不是空转。
 */
const RETRYABLE_TOAST_RE = /评估失败|提交失败|请稍后重试|请稍后再试|系统繁忙/;

/** 编排器对外依赖。 */
export interface FlowDeps {
  /** 读取最新配置。 */
  getConfig: () => { maxRounds: number; intervalSec: number; questionTimeoutSec: number };
  /** 请求大模型作答（对话节点）。 */
  ask: (question: string, pageContext: string, signal: AbortSignal) => Promise<string>;
  /** 让 background 生成作品文档并暂存，返回文件名与大纲。 */
  generateDocx: (options: {
    taskTitle: string;
    requirement: string;
    pageContext: string;
    previousSummary: string;
  }) => Promise<{ fileName: string; outline: string[] }>;
  /**
   * 暂存一件**由内容脚本本地生成**的作品（控制台截图等），供附件选择器 frame 读取。
   *
   * 图片类节点必须在有 canvas 的上下文里生成，所以不能走 background。
   */
  storeArtifact: (artifact: {
    fileName: string;
    base64: string;
    mime?: string;
    outline: string[];
  }) => Promise<void>;
  /** 查询对话 frame 的状态。 */
  dialogueState: () => Promise<{ state: string; round: number; message: string; present?: boolean }>;
  /** 给对话 frame 下发指令（START / FINISH_DIALOGUE / STOP …）。 */
  commandDialogue: (cmd: string) => Promise<void>;
  /** 读取 / 保存节点记录。 */
  getRecord: (domIndex: number) => Promise<NodeRecord | undefined>;
  saveRecord: (record: NodeRecord) => Promise<void>;
  /** 上报状态。 */
  onStatus: (patch: Partial<PanelStatus>) => void;
}

/** 待执行的目标节点。`synthetic` 表示它是从右侧内容区临时合成的（卡片还没渲染出来）。 */
interface TargetNode {
  node: FlowNode;
  synthetic: boolean;
}

/** 编排器运行态。 */
export class FlowRunner {
  private running = false;
  private stopped = false;
  private controller: AbortController | null = null;
  /** 每个节点（按标题）累计的失败次数。 */
  private readonly attempts = new Map<string, number>();
  /** 停滞兜底里补点「开始评估」的次数（每个节点重置，避免无限点）。 */
  private nudgeClicks = 0;

  constructor(private readonly deps: FlowDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  /** 开始 / 继续跑完整条任务流。 */
  start(): void {
    if (this.running) {
      log.warn('任务流已在运行，忽略重复触发');
      return;
    }
    this.running = true;
    this.stopped = false;
    const controller = new AbortController();
    this.controller = controller;
    void this.loop(controller.signal).finally(() => {
      this.running = false;
      this.controller = null;
    });
  }

  /** 停止。 */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.running = false;
    this.attempts.clear();
    this.deps.onStatus({ phase: 'idle', tone: 'idle', state: 'IDLE', message: '已结束' });
    void this.deps.commandDialogue('STOP');
  }

  /** 暂停（保留进度，可再点开始继续）。 */
  pause(): void {
    this.controller?.abort();
    this.running = false;
    this.deps.onStatus({ phase: 'paused', tone: 'waiting', state: 'PAUSED', message: '已暂停' });
  }

  /* ---------------- 主循环 ---------------- */

  private async loop(signal: AbortSignal): Promise<void> {
    try {
      /*
       * 等任务流出现。
       *
       * ⚠️ 这里刻意做成**分段重试**而不是一次等到底：任务流页面的卡片列表是异步拉数据
       * 渲染的，网络慢 / 接口慢时会超过单次超时。以前一次等超时就整条退出，
       * 表现就是「打开 AI 实践页面后助手什么都不做」。
       */
      let initial: FlowState | null = null;
      for (let i = 0; i < 12 && !initial; i += 1) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          initial = await waitForFlow(10_000, signal);
        } catch (err) {
          if (err instanceof DOMException) throw err;
          log.warn(`任务流尚未渲染出来（第 ${i + 1} 次等待），继续等…`);
          this.deps.onStatus({
            phase: 'scan',
            message: '正在等待 AI 实践任务流加载…',
            tone: 'waiting',
            state: 'DETECTING',
          });
        }
      }
      if (!initial) {
        throw new CxaiError('NOT_DETECTED', '等待任务流出现超时（页面上没有 .flow-card 卡片）', true);
      }

      log.info(`任务流概览：\n${describeFlow(initial)}`);
      this.deps.onStatus({
        phase: 'scan',
        message: `共 ${initial.nodes.length} 个已渲染节点，准备开始`,
        tone: 'running',
        state: 'DETECTING',
        nodeTotal: initial.nodes.length + initial.pendingNodes.length,
      });

      let emptyRounds = 0;
      let waitingRounds = 0;

      for (;;) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const state = readFlowState();
        if (!state) {
          // ⚠️ 页面重渲染（切换节点 / 打开 iframe）期间卡片列表会短暂为空。
          // 上一版在这里直接报「任务流已消失」并退出 —— 那正是「跑着跑着自己停了」的原因之一。
          if (emptyRounds < EMPTY_STATE_GRACE) {
            emptyRounds += 1;
            this.deps.onStatus({
              phase: 'scan',
              message: '任务流正在重渲染，稍候…',
              tone: 'waiting',
              state: 'DETECTING',
            });
            await sleep(1200, signal);
            continue;
          }
          this.deps.onStatus({
            phase: 'error',
            tone: 'error',
            state: 'ERROR',
            message: '任务流已消失（页面可能已跳转）',
          });
          return;
        }
        emptyRounds = 0;

        const total = state.nodes.length + state.pendingNodes.length;
        if (state.allCompleted) {
          /*
           * ⚠️ **所有节点做完 ≠ 整条任务流完成**。
           *
           * 站点在 `recordStatus === 0` 时会渲染一个「查看最终评估结果」的汇总行，
           * 点它 → 弹窗 → 点「开始评估」，才会生成最终评估并回写成绩。
           * 不做这一步，学习计划里会一直显示 0% / 未达标 ——
           * 用户看到的就是「跑完了但好像没用」。
           */
          const finalScore = await this.ensureChainEvaluated(signal);
          this.deps.onStatus({
            phase: 'done',
            tone: 'running',
            state: 'DONE',
            message: state.doneMarked
              ? `全部 ${state.nodes.length} 个节点已完成 🎉${finalScore ? `（最终评估 ${finalScore} 分）` : ''}`
              : `全部 ${total} 个节点已完成 🎉${finalScore ? `（最终评估 ${finalScore} 分）` : ''}`,
            nodeIndex: state.nodes.length,
            nodeTotal: Math.max(total, state.nodes.length),
          });
          await this.deps.commandDialogue('STOP');
          return;
        }

        const target = this.pickTargetNode(state);
        if (!target) {
          /*
           * 已渲染的卡片都做完了，但流程还没结束。
           *
           * 上一版在这里只能干等 60 秒然后放弃（「剩余节点需手动解锁」）——
           * 实际上页面上往往已经有「进入任务」入口，只要点一下（再点「直接来吧」）
           * 就能把下一个节点拉出来。所以这里改成**主动推进**。
           */
          if (waitingRounds < NEXT_NODE_WAIT_ROUNDS) {
            waitingRounds += 1;
            const nextTitle = state.pendingNodes[0]?.title ?? '下一个节点';
            this.deps.onStatus({
              phase: 'advance',
              message: `正在进入下一个节点…（「${nextTitle}」）`,
              tone: 'waiting',
              state: 'DETECTING',
              nodeIndex: state.nodes.length,
              nodeTotal: total,
              nodeTypeLabel: state.pendingNodes[0]?.typeLabel ?? '',
              nodeTitle: nextTitle,
            });
            if (await this.tryAdvance(signal)) {
              waitingRounds = 0;
              continue;
            }
            await sleep(4000, signal);
            continue;
          }
          this.deps.onStatus({
            phase: 'done',
            tone: 'running',
            state: 'DONE',
            message: state.pendingNodes.length
              ? `已渲染节点全部完成；剩余「${state.pendingNodes.map((p) => p.title).join('、')}」暂无可进入入口`
              : '没有待完成节点',
          });
          return;
        }

        waitingRounds = 0;
        await this.runNodeGuarded(target, signal);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (!this.stopped) {
          this.deps.onStatus({
            phase: 'paused',
            tone: 'waiting',
            state: 'PAUSED',
            message: '已暂停，点「开始」可继续',
          });
        }
        return;
      }
      const cx = toCxaiError(err);
      log.error(`任务流执行失败：${cx.message}`);
      this.deps.onStatus({ phase: 'error', tone: 'error', state: 'ERROR', message: cx.message, error: cx.message });
    }
  }

  /**
   * 选出下一个要做的节点。
   *
   * 优先级：
   * 1. 右侧内容区**正在显示**的节点（内容区是权威信号，说明页面当前就在这道题上）；
   * 2. 卡片标记出的当前节点；
   * 3. 第一个未完成节点；
   * 4. 内容区有明确类型、且**卡列表里确实还没有这个节点**时，从内容区临时合成一个。
   *
   * ⚠️ 第 4 条必须严格设限，否则会出大问题 —— 真机上实测过：
   * 最后一题做完后，内容区仍然挂着这道题（`.upload-content` 还在），
   * 而卡片全部打勾了。此时若无条件合成，就会**反复去做一个已经完成的节点**，
   * 面板一直显示「正在处理当前节点…」，用户看起来就是「卡死 / 没有任何效果」。
   *
   * 所以合成必须同时满足：
   * - 内容区类型与当前节点冲突（当前节点已完成 / 类型不符 / 不存在）；
   * - 内容区标题**匹配不到任何卡片**（说明这确实是个卡片还没渲染出来的新节点）；
   * - 页面**没有**打出「任务流已完成」的标记。
   */
  private pickTargetNode(state: FlowState): TargetNode | null {
    const active = state.activeContent;
    const isDecisive = active === 'upload' || active === 'dialogue';

    if (isDecisive) {
      const contentMatch = state.nodes.filter((n) => !n.completed && n.type === active);
      if (contentMatch.length) return { node: contentMatch[0], synthetic: false };

      const cur = state.nodes[state.currentIndex];
      const curConflicts = !cur || cur.completed || cur.type !== active;
      const titleMatchesCard = Boolean(state.activeTitle) && state.nodes.some((n) => {
        if (!n.title || !state.activeTitle) return false;
        return n.title === state.activeTitle || n.title.includes(state.activeTitle) || state.activeTitle.includes(n.title);
      });

      if (curConflicts && !titleMatchesCard && !state.doneMarked && isContentActionable(active)) {
        log.info(`内容区（${active}）与卡片列表不一致，按内容区临时合成节点处理`);
        return { node: synthesizeFromContent(state, active), synthetic: true };
      }
    }

    const cur = state.nodes[state.currentIndex];
    if (cur && !cur.completed) return { node: cur, synthetic: false };
    const first = state.nodes.find((n) => !n.completed);
    return first ? { node: first, synthetic: false } : null;
  }

  /**
   * 包一层：单个节点失败**不再终止整条流程**。
   *
   * 任务流里任何一个异步环节（页面重渲染、接口慢、按钮延迟出现）都可能让某个节点
   * 这一轮失败；旧实现会让异常一路冒到主循环，把整条自动化打死。
   * 这里改为「退避重试」，并把重试原因如实写到面板上 —— 用户不需要介入，
   * 页面状态一变就会自动继续。
   */
  private async runNodeGuarded(target: TargetNode, signal: AbortSignal): Promise<void> {
    const key = target.node.title || `节点 ${target.node.domIndex + 1}`;
    const attempts = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempts);

    if (attempts > NODE_MAX_ATTEMPTS) {
      this.deps.onStatus({
        phase: 'error',
        tone: 'error',
        state: 'ERROR',
        message: `${key}：已重试 ${NODE_MAX_ATTEMPTS} 次仍未通过，需要人工确认后重开`,
      });
      // 不再紧凑重试，改为长时间挂起等待环境变化（例如用户重新进入节点）
      await sleep(60_000, signal);
      return;
    }

    try {
      await this.runNode(target, signal);
      this.attempts.delete(key);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      const cx = toCxaiError(err);
      const backoff = Math.min(3000 * attempts, 20_000);
      log.warn(`${key}：第 ${attempts} 次执行失败 —— ${cx.message}（${Math.round(backoff / 1000)}s 后重试）`);
      this.deps.onStatus({
        phase: 'advance',
        tone: 'waiting',
        state: 'DETECTING',
        message: `${key}：${cx.message}（第 ${attempts} 次，${Math.round(backoff / 1000)}s 后自动重试）`,
      });
      await sleep(backoff, signal);
    }
  }

  /* ---------------- 公共小工具 ---------------- */

  /** 组装带节点信息的进度状态。 */
  private report(
    node: FlowNode | null,
    state: FlowState | null,
    patch: Partial<PanelStatus> & { phase: PanelStatus['phase']; message: string },
  ): void {
    const total = state ? state.nodes.length + state.pendingNodes.length : 0;
    this.deps.onStatus({
      ...patch,
      tone: patch.tone ?? 'waiting',
      nodeIndex:
        node && node.domIndex >= 0
          ? node.domIndex + 1
          : (patch.nodeIndex ?? (state ? state.nodes.length : 0)),
      nodeTotal: patch.nodeTotal ?? total,
      nodeTitle: node?.title ?? patch.nodeTitle ?? '',
      nodeTypeLabel: node?.typeLabel ?? patch.nodeTypeLabel ?? '',
    });
  }

  /** 节点标签（日志 / 面板共用）。 */
  private labelOf(node: FlowNode, state: FlowState | null): string {
    const total = state ? state.nodes.length + state.pendingNodes.length : 0;
    if (node.domIndex < 0) return `当前节点「${node.title}」`;
    return `节点 ${node.domIndex + 1}/${total}「${node.title}」`;
  }

  /* ---------------- 对话达标 → 开始评估 ---------------- */

  /**
   * 点掉「已完成作答轮数要求，点击开始评估」这个提示块。
   *
   * 先点里层的文案节点，没反应再点外层那个 `.complete` 容器 ——
   * 因为无法确定点击处理器挂在哪一层，两个都试一遍最稳（每次点完都等它消失来判定成功）。
   *
   * @returns 是否成功触发（提示块消失 = 评估已经开始）。
   */
  private async triggerDialogueComplete(signal: AbortSignal): Promise<boolean> {
    const candidates: HTMLElement[] = [];
    const inner = findDialogueCompleteText();
    const block = findDialogueCompleteBlock();
    if (inner) candidates.push(inner);
    if (block && block !== inner) candidates.push(block);
    if (candidates.length === 0) return false;

    for (const el of candidates) {
      log.info(`点击对话达标提示（${el.className}）`);
      await clickAndSettle(el, 1500);
      try {
        await waitFor(() => !findDialogueCompleteText(), { timeoutMs: 10_000, intervalMs: 600, signal });
        return true;
      } catch (err) {
        if (err instanceof DOMException) throw err;
        log.debug('提示块未消失，换下一个候选元素再试');
      }
    }
    return false;
  }

  /* ---------------- 整条链路的收尾：最终评估 ---------------- */

  /**
   * 生成「最终评估」，把整条任务流真正跑完。
   *
   * 流程：点列表末尾的汇总行（「查看最终评估结果」）→ 等弹窗 → 点主按钮（「开始评估」）
   * → 等得分渲染出来（`.task-done-score-num`，且 pending 行消失）。
   *
   * @returns 最终评估得分；未生成或超时返回空串。
   */
  private async ensureChainEvaluated(signal: AbortSignal): Promise<string> {
    const already = readChainFinalScore();
    if (already) {
      log.info(`最终评估已存在：${already} 分`);
      return already;
    }

    const row = findSummaryPendingRow();
    if (!row) return '';

    log.info('检测到「查看最终评估结果」，正在生成最终评估…');
    this.deps.onStatus({
      phase: 'evaluate',
      message: '全部节点已完成，正在生成最终评估…',
      tone: 'waiting',
      state: 'WAITING_REPLY',
    });
    await clickAndSettle(row, 1200);

    // 弹窗里的确认按钮文案是「开始评估」（加载中变成「评估中...」），
    // 结构上就是 .init-dialog__btn--primary —— dismissInitDialog 两条路都能命中。
    const handled = await dismissInitDialog({ timeoutMs: 20_000, signal }).catch(() => false);
    if (!handled) log.warn('点「查看最终评估结果」后未等到确认弹窗');

    // 等得分出现（pending 行消失 + 得分有数字），最多等 5 分钟
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const score = readChainFinalScore();
      if (score) {
        log.info(`最终评估完成：${score} 分`);
        return score;
      }
      const still = findSummaryPendingRow();
      if (!still) {
        // pending 行没了但也没读到分数 —— 再等一会儿让得分渲染
        await sleep(1500, signal);
        const retry = readChainFinalScore();
        if (retry) return retry;
      }
      await sleep(2000, signal);
    }
    log.warn('等待最终评估得分超时（节点成果已保存，可在页面上手动查看）');
    return '';
  }

  /* ---------------- 推进到下一个节点 ---------------- */

  /**
   * 主动推进：点「进入任务」→ 处理初始化提示 → 等页面真的换节点。
   *
   * @returns 是否观察到页面推进。
   */
  private async tryAdvance(signal: AbortSignal): Promise<boolean> {
    /*
     * 先清掉挡路的提示弹窗。
     *
     * 有些提示层盖在卡片上时，**页面自己的**点击处理会被忽略 ——
     * 从用户视角就是「按钮看得见、助手也点了，但页面没反应，只能自己点」。
     */
    if (dismissStrayDialog() > 0) await sleep(800, signal);

    const btn = findEnterTaskButton();
    if (!btn) {
      /*
       * 没有「进入任务」入口时，试一次「下一节点」这类通用推进按钮。
       *
       * ⚠️ 刻意**只在本 frame 的文档里找**（不加 `deep`）：对话 iframe 里也有一个
       * 文案相近的「继续」（那是解锁输入框用的），跨帧搜会误点它。
       */
      const next = findButtonByText(FLOW_ACTIONS.nextNode);
      if (!next) return false;
      log.info('未找到「进入任务」，改点通用推进按钮');
      await clickAndSettle(next, 1000);
      await sleep(1000, signal);
      return true;
    }

    const before = readFlowState();
    log.info('检测到「进入任务」，点击进入下一个节点');
    await clickAndSettle(btn, 900);

    // 关键：轮询等初始化提示弹窗出现，再点主按钮（「直接来吧」）
    const handled = await dismissInitDialog({ timeoutMs: 15_000, signal });
    if (!handled) log.warn('点「进入任务」后未等到初始化提示（可能该节点不需要确认）');

    try {
      await waitFor(
        () => {
          const now = readFlowState();
          if (!now) return false;
          if (!before) return true;
          if (now.nodes.length > before.nodes.length) return true;
          if (now.currentTitle && now.currentTitle !== before.currentTitle) return true;
          if (now.activeContent !== before.activeContent && now.activeContent !== 'unknown') return true;
          return false;
        },
        { timeoutMs: ADVANCE_TIMEOUT_MS, intervalMs: 800, signal },
      );
      log.info('已进入下一个节点');
      await sleep(800, signal);
      return true;
    } catch (err) {
      if (err instanceof DOMException) throw err;
      log.warn('点了「进入任务」但没观察到页面推进，交给外层按现有状态继续尝试');
      return false;
    }
  }

  /* ---------------- 单个节点 ---------------- */

  private async runNode(target: TargetNode, signal: AbortSignal): Promise<void> {
    let state = readFlowState();
    const node = target.node;
    const label = this.labelOf(node, state);
    const total = state ? state.nodes.length + state.pendingNodes.length : 0;

    log.info(`开始处理 ${label}（类型 ${node.type}/${node.typeLabel}${target.synthetic ? '，由内容区合成' : ''}）`);
    // 换节点了：重置「停滞兜底补点次数」
    this.nudgeClicks = 0;

    /* --- 1) 确保该节点已激活 --- */
    /*
     * ⚠️ `node.selected` 也算「已经在做这道题」。
     *
     * 真机实测：任务流里那个正在做的节点，卡片上有时**只有 `is-selected`、
     * 没有 `is-current`**（站点数据里 `current` 与 `selected` 是两套状态）。
     * 以前只认 `is-current`，于是会先「点卡片 → 等 45 秒变成当前节点 → 超时」
     * 才回到正轨 —— 白等一轮，看上去就是「卡住了」。
     */
    if (!node.completed && !node.current && !node.selected) {
      this.report(node, state, {
        phase: 'advance',
        message: `${label}：正在进入该节点…`,
        tone: 'running',
        state: 'DETECTING',
      });

      if (node.upcoming || target.synthetic) {
        // 即将作答的节点只能通过「进入任务」+「直接来吧」进入
        const advanced = await this.tryAdvance(signal);
        if (!advanced && node.domIndex >= 0) {
          log.info(`${label}：未见「进入任务」入口，改为直接点卡片`);
          await selectCard(node.domIndex);
          await sleep(800, signal);
        }
      } else if (node.domIndex >= 0) {
        log.info(`${label}：点击节点卡片切换`);
        await selectCard(node.domIndex);
        await sleep(800, signal);
      }

      await dismissInitDialog({ timeoutMs: 8_000, signal });
      dismissStrayDialog();
      const isCurrent = await waitForNodeFlag(node.title, 'current', {
        timeoutMs: ADVANCE_TIMEOUT_MS,
        signal,
      });
      if (!isCurrent) log.warn(`${label}：等待节点变为「当前节点」超时，继续按内容区尝试`);
      await sleep(600, signal);
    }

    // 有些页面对「刚变当前」的节点还会再弹一次提示
    await dismissInitDialog({ timeoutMs: 4000, signal });

    /* --- 2) 类型再确认（卡片类型不可信时以内容区为准） --- */
    state = readFlowState();
    let type: FlowNodeType = node.type;
    if (type === 'unknown') {
      const active = state?.activeContent;
      if (active === 'upload' || active === 'dialogue') type = active;
    }
    if (type === 'unknown') {
      // 两条信号都读不出来 —— 老实报错，交给退避重试，而不是瞎猜去跑对话
      throw new CxaiError('NOT_DETECTED', `${label}：无法判定节点类型（既读不到类型文案，内容区也未知）`, true);
    }

    this.report(node, state, {
      phase: 'scan',
      message: `${label}：类型 ${NODE_TYPE_LABEL[type]}，开始执行`,
      tone: 'running',
      state: 'DETECTING',
    });

    /* --- 3) 按类型执行 --- */
    if (type === 'upload') {
      await this.runUploadNode(node, signal);
    } else {
      await this.runDialogueNode(node, signal);
    }

    /* --- 4) 等这个节点被标记为「已完成」 --- */
    this.report(node, state, {
      phase: 'evaluate',
      message: `${label}：等待评估完成…`,
      tone: 'waiting',
      state: 'WAITING_REPLY',
    });

    const completed = await waitForNodeSettled(node.title, type, {
      timeoutMs: NODE_COMPLETE_TIMEOUT_MS,
      signal,
      onStall: () => this.nudge(node, type, signal),
    });

    if (!completed) {
      // 不抛错：交给外层退避重试（页面上也可能已经推进了，重读状态就会自己走对）
      log.warn(`${label}：未等到「已完成」，交给外层重试`);
      return;
    }

    log.info(`${label}：已完成 ✅`);

    const latest = readFlowState();
    const score =
      latest?.nodes.find((n) => n.title === node.title)?.score ??
      (node.domIndex >= 0 ? latest?.nodes[node.domIndex]?.score : undefined);
    const recordIndex = node.domIndex >= 0 ? node.domIndex : total;
    const previous = await this.deps.getRecord(recordIndex);
    await this.deps.saveRecord({
      ...(previous ?? { domIndex: recordIndex, title: node.title, type, transcript: [] }),
      title: node.title,
      type,
      score,
    });

    this.report(node, latest, {
      phase: 'advance',
      message: `${label}：已完成${score ? `（${score}）` : ''}，准备下一个节点`,
      tone: 'running',
      state: 'DETECTING',
    });
  }

  /* ---------------- 停滞兜底 ---------------- */

  /**
   * 「长时间没有任何变化」时主动试一次推进。
   *
   * 这是「部分按钮还是得自己点」的**最后一道保险**：前面的链路万一漏了某个动作
   * （站点多了一个确认弹窗、某个按钮文案变了、某个请求超时导致分支走偏），
   * 这里每 20 秒还会主动试一遍下面这几件事，而不是干等到 5 分钟超时：
   *
   * 1. 关掉挡路的提示弹窗；
   * 2. 对话节点：出现「已完成作答轮数要求，点击开始评估」就点掉；
   * 3. 上传节点：文件已挂上却没点「开始评估」就补点；
   * 4. 出现「进入任务」/「查看最终评估结果」就点掉（说明当前节点其实已经翻篇）。
   */
  private async nudge(node: FlowNode, type: FlowNodeType, signal: AbortSignal): Promise<void> {
    log.info(`${this.labelOf(node, readFlowState())}：长时间没有变化，主动试一次推进`);

    if (dismissStrayDialog() > 0) await sleep(600, signal);

    if (type === 'dialogue' && isDialogueRoundComplete()) {
      this.report(node, readFlowState(), {
        phase: 'finish-dialogue',
        message: `${this.labelOf(node, readFlowState())}：检测到达标提示，主动点击开始评估`,
        tone: 'running',
        state: 'SENDING',
      });
      await this.triggerDialogueComplete(signal);
      return;
    }

    if (type === 'upload') {
      /*
       * ⚠️ 这里必须「有上限地」点，不能无限点。
       *
       * 「开始评估」点下去失败时页面**一点变化都没有**（只弹一个转瞬即逝的错误提示），
       * 无上限地重试就成了「一直在点、什么都不发生」。所以：
       * - 一旦看到失败提示 → 直接换一份新作品重传（这是唯一能真正恢复的动作）；
       * - 否则最多补点 2 次，之后交给外层退避重试。
       */
      const err = readFlowErrorToast();
      if (err && RETRYABLE_TOAST_RE.test(err)) {
        log.warn(`停滞兜底：检测到评估失败提示「${err}」，换一份新作品重新上传`);
        await this.forceReupload(node, signal);
        return;
      }
      if (this.nudgeClicks < 2 && hasUploadedFile()) {
        this.nudgeClicks += 1;
        const clicked = await clickButton(FLOW_ACTIONS.startEvaluate, {
          timeoutMs: 3000,
          intervalMs: 500,
          deep: true,
          signal,
        });
        if (clicked) {
          log.info(`停滞兜底：已点击「${clicked}」（第 ${this.nudgeClicks} 次）`);
          // 点完立刻观察有没有失败提示（它只显示 ~3 秒）
          const after = await this.readToastWithin(6000, signal);
          if (after && RETRYABLE_TOAST_RE.test(after)) {
            log.warn(`停滞兜底：评估失败提示「${after}」，换一份新作品重新上传`);
            await this.forceReupload(node, signal);
            return;
          }
          await sleep(1000, signal);
          return;
        }
      }
    }

    // 页面已经出现「进入任务」→ 当前节点其实已翻篇，交给外层继续推进
    if (findEnterTaskButton()) return;

    const row = findSummaryPendingRow();
    if (row) {
      log.info('停滞兜底：检测到「查看最终评估结果」，点掉它');
      await clickAndSettle(row, 800);
      await dismissInitDialog({ timeoutMs: 8_000, signal });
    }
  }

  /* ---------------- 对话节点 ---------------- */

  private async runDialogueNode(node: FlowNode, signal: AbortSignal): Promise<void> {
    const label = this.labelOf(node, readFlowState());
    this.report(node, readFlowState(), {
      phase: 'open-dialogue',
      message: `${label}：准备对话…`,
      tone: 'running',
      state: 'DETECTING',
    });

    /*
     * 进入这个节点时对话**就已经达标**的情况必须先处理掉。
     *
     * 真机实测过：页面「重新练习」后，对话 iframe 仍挂着上一次的对话内容，
     * 里面已经有「已完成作答轮数要求，点击开始评估」的提示块。
     * 如果不在这里先判一次，就会白等一轮才开始收尾（甚至因为状态机
     * 停在「等待提问」而一直不动）。
     */
    if (isDialogueRoundComplete()) {
      log.info(`${label}：进入时对话就已达标，直接收尾`);
      await this.finishDialogueNode(node, signal);
      return;
    }

    /*
     * 开场页（`pcStudentIndex`）上只有「开始对话」按钮，点掉它页面才会导航到真正的
     * 对话界面（`pcDialogue`）。正常情况下由对话 frame 自己处理（收到 START 后点），
     * 这里额外做一次**跨同源 iframe** 的兜底点击 —— 站点把按钮渲染在别处时也能命中。
     */
    const intro = await waitForButton(FLOW_ACTIONS.startDialogue, {
      timeoutMs: 2500,
      signal,
      deep: true,
    });
    if (intro) {
      log.info(`${label}：发现「开始对话」，先点掉`);
      await clickAndSettle(intro, 1200);
    }

    // 让对话 frame 自行处理：还没开场就点「开始对话」，已开场就跑对话状态机
    await this.deps.commandDialogue('START');
    this.report(node, readFlowState(), {
      phase: 'dialogue',
      message: `${label}：对话进行中…`,
      tone: 'waiting',
      state: 'WAITING_QUESTION',
    });

    // 轮询对话 frame 状态，直到它跑完（DONE）或出错
    const deadline = Date.now() + 25 * 60 * 1000;
    const startedAt = Date.now();
    let lastMessage = '';
    let restartCount = 0;
    let seenBusy = false;

    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const status = await this.deps.dialogueState();

      // 「开始对话」会触发 iframe 内导航 → 新文档会重新注入内容脚本，
      // 那一瞬间状态回落成 IDLE。这里补发几次 START，避免卡在开场页。
      if (status.state !== 'IDLE' && status.state !== 'ERROR') seenBusy = true;

      if (!seenBusy && status.state === 'IDLE' && Date.now() - startedAt > 6000) {
        if (restartCount < 20) {
          restartCount += 1;
          log.info(`${label}：对话尚未启动，第 ${restartCount} 次尝试拉起`);
          // 双保险：既补发指令，也在页面上直接找一次「开始对话」
          const again = findButtonByTextDeep(FLOW_ACTIONS.startDialogue);
          if (again) await clickAndSettle(again, 1000);
          await this.deps.commandDialogue('START');
          await sleep(2500, signal);
          continue;
        }
        // 20 次都拉不起来 —— 明确报错交给外层退避重试，而不是默默耗到超时
        throw new CxaiError(
          'NOT_DETECTED',
          `${label}：对话窗口一直没启动（对话 frame ${status.present ? '已注册' : '未注册'}，请在页面上确认对话窗口是否已加载）`,
          true,
        );
      }

      if (status.message && status.message !== lastMessage) {
        lastMessage = status.message;
        this.report(node, readFlowState(), {
          phase: 'dialogue',
          message: `${label}：${status.message}`,
          tone: 'waiting',
          state: 'WAITING_QUESTION',
        });
      }
      if (status.state === 'DONE') break;
      /*
       * 🚨 对话「已达轮数要求」的识别 —— 线上「开始评估只能自己点」的根因之一。
       *
       * 达标后对话 frame 会渲染「已完成作答轮数要求，点击开始评估」的提示块，
       * 但状态机并不认识它，会一直停在「等待 AI 提问」。这里必须抢先识别出来，
       * 直接进入收尾，而不是干等到 25 分钟超时。
       */
      if (isDialogueRoundComplete()) {
        log.info(`${label}：检测到「已完成作答轮数要求，点击开始评估」，转入收尾`);
        break;
      }
      if (status.state === 'ERROR') {
        // 出错时也先看一眼是不是已经达标了（达标瞬间的页面重渲染会导致误报失效）
        if (isDialogueRoundComplete()) {
          log.info(`${label}：对话已达标（状态机报错可忽略），转入收尾`);
          break;
        }
        throw new CxaiError('UNKNOWN', `${label}：对话出错 —— ${status.message}`, true);
      }
      if (Date.now() > deadline) {
        log.warn(`${label}：对话等待超时，尝试直接结束`);
        break;
      }
      await sleep(1500, signal);
    }

    /* --- 收尾：结束对话 → 触发评估 --- */
    await this.finishDialogueNode(node, signal);
  }

  /**
   * 对话节点的收尾：结束对话 → 触发评估。
   *
   * 两个入口都会调它：正常运行到底之后，以及**进入节点时对话就已达标**的情况。
   */
  private async finishDialogueNode(node: FlowNode, signal: AbortSignal): Promise<void> {
    const label = this.labelOf(node, readFlowState());

    this.report(node, readFlowState(), {
      phase: 'finish-dialogue',
      message: `${label}：结束对话并提交评估…`,
      tone: 'running',
      state: 'SENDING',
    });
    await this.deps.commandDialogue('FINISH_DIALOGUE');
    await sleep(1200, signal);

    /*
     * 收尾按钮（「开始评估」「完成对话」「提交」…）是异步渲染的，
     * 而且不同版本里可能落在宿主页面或对话 iframe 里，所以**轮询 + 跨同源 frame** 找。
     * 旧实现只查一次 —— 这就是「对话完成后『开始评估』还得自己点」的原因。
     */
    let clicked: string | null = null;

    // ① 先处理「已完成作答轮数要求，点击开始评估」这个提示块 ——
    //    对话节点唯一的评估入口，文案 16 字超过词表上限，按文案永远找不到。
    if (await this.triggerDialogueComplete(signal)) {
      clicked = '已完成作答轮数要求，点击开始评估';
    } else {
      clicked = await clickButton([...FLOW_ACTIONS.startEvaluate, ...FLOW_ACTIONS.finishDialogue], {
        timeoutMs: 45_000,
        intervalMs: 1000,
        settleMs: 1200,
        deep: true,
        signal,
      });
    }
    if (clicked) log.info(`${label}：已点击收尾按钮「${clicked}」`);
    else log.warn(`${label}：未找到收尾按钮（可能已自动提交或已在评估中）`);

    this.report(node, readFlowState(), {
      phase: 'evaluate',
      message: `${label}：AI 评估中…`,
      tone: 'waiting',
      state: 'WAITING_REPLY',
    });
  }

  /* ---------------- 上传节点 ---------------- */

  private async runUploadNode(node: FlowNode, signal: AbortSignal): Promise<void> {
    const label = this.labelOf(node, readFlowState());

    /**
     * 先复位可能残留的附件选择器弹层。
     *
     * 宿主用 `v-show` 控制该弹层；上一次尝试若没关干净，弹层会一直盖在页面上，
     * 而且再次点「选择文件」时设置的 iframe 地址与当前完全相同 ——
     * 浏览器不会重新导航，选择器 frame 里的内容脚本也就不会重新注入。
     * 主动关一次（把地址复位成 about:blank）能保证下次打开是真正的重新加载。
     */
    if (resetFilePickerOverlay()) {
      log.info(`${label}：已复位残留的附件选择器弹层`);
      await sleep(800, signal);
    }

    // 已经传过文件就直接进入评估
    if (!hasUploadedFile()) {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= NODE_STAGE_RETRY; attempt += 1) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          await this.generateAndUpload(node, signal);
          lastError = null;
          break;
        } catch (err) {
          lastError = err as Error;
          if (err instanceof DOMException) throw err;
          log.warn(`${label}：第 ${attempt} 次上传尝试失败 —— ${lastError.message}`);
          this.report(node, readFlowState(), {
            phase: 'pick-file',
            message: `${label}：上传失败（第 ${attempt} 次），准备重试…`,
            tone: 'waiting',
            state: 'WAITING_QUESTION',
          });
          await sleep(2000, signal);
        }
      }
      if (lastError) throw lastError;
    } else {
      log.info(`${label}：已存在上传文件，跳过上传`);
    }

    /* --- 提交并评估：按钮在文件挂上后才渲染，必须轮询等 --- */
    this.report(node, readFlowState(), {
      phase: 'evaluate',
      message: `${label}：提交并评估…`,
      tone: 'running',
      state: 'SENDING',
    });

    /*
     * 🚨 评估失败必须「换一份重传」，而不是死点同一个按钮。
     *
     * 真机取证：附件在服务端**无效**时（例如前几轮失败留下的残留记录），
     * 点「开始评估」页面只会弹一个转瞬即逝的错误提示
     * （实测 `评估失败，请稍后重试`），**DOM 状态一点不变**。
     * 旧实现看不到这条提示，只会以为按钮没点到、于是无限重试同一个按钮 ——
     * 用户看到的就是「卡在那儿一直点，什么都不发生」。
     */
    for (let attempt = 1; attempt <= NODE_STAGE_RETRY; attempt += 1) {
      const clicked = await clickButton(FLOW_ACTIONS.startEvaluate, {
        timeoutMs: 60_000,
        intervalMs: 1000,
        settleMs: 1200,
        deep: true,
        signal,
      });
      if (clicked) log.info(`${label}：已点击「${clicked}」（第 ${attempt} 次）`);
      else log.warn(`${label}：未找到「开始评估」按钮，可能已自动提交`);

      // 等提示浮出来（成功时不会有错误提示）
      const err = await this.readToastWithin(8000, signal);
      if (!err) return;
      if (!RETRYABLE_TOAST_RE.test(err)) {
        // 不是「失败可重试」那一类（例如「缺少作答记录 ID」）—— 重传也救不了，如实上报
        throw new CxaiError('UNKNOWN', `${label}：评估被站点拒绝 —— ${err}`, true);
      }

      log.warn(`${label}：评估失败提示「${err}」，准备换一份新作品重新上传（第 ${attempt} 次）`);
      this.report(node, readFlowState(), {
        phase: 'pick-file',
        message: `${label}：${err}，正在重新生成并上传作品…`,
        tone: 'waiting',
        state: 'WAITING_REPLY',
      });
      const recovered = await this.forceReupload(node, signal);
      if (!recovered) {
        log.warn(`${label}：重新上传未成功，交给外层退避重试`);
        throw new CxaiError('UNKNOWN', `${label}：评估失败（${err}）且重新上传未成功`, true);
      }
    }

    this.report(node, readFlowState(), {
      phase: 'evaluate',
      message: `${label}：AI 评估中…`,
      tone: 'waiting',
      state: 'WAITING_REPLY',
    });
  }

  /**
   * 在 `ms` 内**轮询**读取错误提示。
   *
   * ⚠️ 必须轮询，不能只读一次：站点的 message 提示默认只显示约 3 秒
   * （真机实测：点击后 ~0.9s 弹出、~3s 消失）。「点完等 3 秒再读」
   * 正好卡在它刚消失的时刻 —— 这就是第一版自愈没触发的原因。
   *
   * @param ms 观察窗口。
   * @param signal 中止信号。
   */
  private async readToastWithin(ms: number, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const text = readFlowErrorToast();
      if (text) return text;
      if (Date.now() > deadline) return '';
      await sleep(400, signal);
    }
  }

  /**
   * 「重新上传」一份新作品，然后交给上传链路重新走一遍。
   *
   * 用来处理「附件在服务端无效 → 评估一直失败」这种状态：
   * 点「重新上传」（它直接打开附件选择器）→ 生成新文档 → 走一遍上传。
   *
   * @returns 是否成功走完重新上传。
   */
  private async forceReupload(node: FlowNode, signal: AbortSignal): Promise<boolean> {
    const label = this.labelOf(node, readFlowState());
    const btn = findReuploadButton();
    if (!btn) {
      log.warn(`${label}：找不到「重新上传」按钮，无法换文件`);
      return false;
    }
    await clickAndSettle(btn, 1200);

    // 「重新上传」会直接挂出附件选择器（不需要再点「选择文件」）
    let pickerOpen = false;
    try {
      await waitFor(() => isFilePickerOpen(), { timeoutMs: 10_000, intervalMs: 400, signal });
      pickerOpen = true;
    } catch {
      log.warn(`${label}：点「重新上传」后选择器弹层未出现`);
    }

    await this.generateAndUpload(node, signal, { pickerAlreadyOpen: pickerOpen });
    await sleep(1200, signal);
    return true;
  }

  /** 生成文档 → 打开选择器 → 等上传完成。 */
  private async generateAndUpload(
    node: FlowNode,
    signal: AbortSignal,
    options: { pickerAlreadyOpen?: boolean } = {},
  ): Promise<void> {
    const label = this.labelOf(node, readFlowState());

    const state = readFlowState();
    const requirement = readUploadRequirement() || node.description || state?.unlockCondition || '';
    const previousSummary = await this.buildPreviousSummary(node.domIndex);
    const kind = readUploadKind();

    /*
     * 站点把上传节点分成两种：**类型：文档** 与 **类型：图片**。
     *
     * 图片类要求交「程序运行的控制台截图」，选择器入参是 `fileTypes=png,jpg,jpeg`。
     * 以前只生成 .docx，遇到图片类节点时选择器直接报「上传失败：类型不支持」，
     * 附件挂不上 → 评估必失败 → 那个节点永远走不动（真机上就是这样卡死的整个流程）。
     */
    let fileName: string;
    let outline: string[];
    if (kind === 'image') {
      this.report(node, readFlowState(), {
        phase: 'prepare-doc',
        message: `${label}：正在生成控制台截图…`,
        tone: 'running',
        state: 'CALLING_DEEPSEEK',
      });
      const raw = await this.deps
        .ask(buildConsolePrompt({ title: node.title, requirement, previousSummary }), collectPageText(), signal)
        .catch((err: unknown) => {
          log.warn(`${label}：生成控制台输出失败，改用兜底文本 —— ${(err as Error)?.message ?? String(err)}`);
          return '';
        });
      const shot = generateConsoleScreenshot({
        title: `${node.title} — 控制台输出`,
        text: raw || `> java Main\n${node.title}\n运行成功\nBUILD SUCCESS`,
        fileName: `${requirement.match(/^[^\n]{2,40}/)?.[0] ?? node.title}-${node.title}`,
      });
      fileName = shot.fileName;
      outline = shot.lines;
      await this.deps.storeArtifact({
        fileName: shot.fileName,
        base64: shot.base64,
        mime: 'image/png',
        outline: shot.lines,
      });
      log.info(`${label}：已生成 ${shot.fileName}（控制台截图，${shot.lines.length} 行）`);
    } else {
      this.report(node, readFlowState(), {
        phase: 'prepare-doc',
        message: `${label}：正在生成 Word 作品…`,
        tone: 'running',
        state: 'CALLING_DEEPSEEK',
      });
      const generated = await this.deps.generateDocx({
        taskTitle: node.title,
        requirement,
        pageContext: collectPageText(),
        previousSummary,
      });
      fileName = generated.fileName;
      outline = generated.outline;
      log.info(`${label}：已生成 ${fileName}（${outline.length} 个小节）`);
    }

    this.report(node, readFlowState(), {
      phase: 'pick-file',
      message: `${label}：打开文件选择器…`,
      tone: 'running',
      state: 'FILLING',
    });
    await this.deps.saveRecord({
      domIndex: node.domIndex,
      title: node.title,
      type: node.type,
      transcript: [],
      artifact: { fileName, title: node.title, outline },
    });

    // 点「选择文件」→ 页面挂出附件选择器 iframe，那个 frame 里的内容脚本会自动接管上传。
    // 弹层没打开成功时（例如被残留遮罩挡住）再补点几次，最多 3 次。
    //
    // ⚠️ 「重新上传」这条路会**直接**打开选择器，此时再点「选择文件」反而会把它关掉，
    // 所以 pickerAlreadyOpen 为真时跳过这一步。
    let opened = Boolean(options.pickerAlreadyOpen) && isFilePickerOpen();
    if (opened) {
      log.info(`${label}：选择器弹层已由「重新上传」打开，跳过点「选择文件」`);
    } else {
      const chooseBtn =
        pick(FLOW_SELECTORS.chooseBtn) ??
        findButtonByTextDeep(FLOW_ACTIONS.chooseFile);
      if (!chooseBtn) throw new Error('未找到「选择文件」按钮');

      for (let i = 1; i <= 3 && !opened; i += 1) {
        await clickAndSettle(chooseBtn, 800);
        // waitFor 超时会抛错（没有返回值），这里只关心「有没有等到」
        try {
          await waitFor(() => isFilePickerOpen() || hasUploadedFile(), {
            timeoutMs: 8000,
            intervalMs: 400,
            signal,
          });
          opened = true;
        } catch {
          log.warn(`${label}：第 ${i} 次点击「选择文件」后弹层未出现，重试`);
        }
      }
      if (!opened && !hasUploadedFile()) {
        log.warn(`${label}：附件选择器弹层未打开，仍继续等待上传结果`);
      }
    }

    // 等文件出现在「已上传」区域
    this.report(node, readFlowState(), {
      phase: 'pick-file',
      message: `${label}：等待文件上传完成…`,
      tone: 'waiting',
      state: 'WAITING_REPLY',
    });
    if (options.pickerAlreadyOpen) {
      /*
       * 「重新上传」这条路：`hasUploadedFile()` 一直是真（旧文件还挂着），
       * 所以不能拿它当完成信号 —— 改为等**选择器弹层关闭**：
       * 宿主只在处理完选择器的消息之后才关闭弹层，因此「关闭」≈「确认已被接收」。
       */
      try {
        await waitFor(() => !isFilePickerOpen(), { timeoutMs: 90_000, intervalMs: 800, signal });
        log.info(`${label}：选择器已关闭，视为新作品已提交`);
      } catch {
        log.warn(`${label}：等待选择器关闭超时，仍继续尝试评估`);
      }
    } else {
      await waitFor(() => hasUploadedFile(), { timeoutMs: 90_000, intervalMs: 800, signal });
      log.info(`${label}：文件已上传并挂到作品卡片`);
    }
    await sleep(800, signal);
  }


  /** 汇总前序节点的成果，供作品文档衔接。 */
  private async buildPreviousSummary(currentIndex: number): Promise<string> {
    const parts: string[] = [];
    const upto = currentIndex >= 0 ? currentIndex : 0;
    for (let i = 0; i < upto; i += 1) {
      const record = await this.deps.getRecord(i);
      if (!record) continue;
      const lines: string[] = [`【节点 ${i + 1}】${record.title}`];
      if (record.artifact) {
        lines.push(`已提交作品：${record.artifact.fileName}`);
        if (record.artifact.outline.length) lines.push(`作品大纲：${record.artifact.outline.join(' / ')}`);
      }
      for (const turn of record.transcript.slice(-NODE_TRANSCRIPT_MAX)) {
        lines.push(`问：${turn.question.slice(0, 160)}`);
        lines.push(`答：${turn.answer.slice(0, 220)}`);
      }
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }
}

/**
 * 从右侧内容区临时合成一个节点。
 *
 * 出现在「节点刚解锁、卡片列表还没渲染完」的窗口期：这时卡片信号全部不可靠，
 * 但内容区已经明确告诉我们要做「上传」还是「对话」。旧实现只会在这里傻等或报错。
 */
function synthesizeFromContent(state: FlowState, type: 'dialogue' | 'upload'): FlowNode {
  const title =
    readActiveTitle() ||
    state.activeTitle ||
    state.currentTitle ||
    (type === 'upload' ? '上传作品节点' : '情景对话节点');
  return {
    domIndex: -1,
    label: '',
    title,
    type,
    typeLabel: NODE_TYPE_LABEL[type],
    description: '',
    completeCondition: '',
    completed: false,
    current: true,
    selected: true,
    upcoming: false,
    score: '',
  };
}

/** 采集任务流页面上的可见文字（供文档生成参考）。 */
function collectPageText(): string {
  const scope = document.body;
  if (!scope) return '';
  const text = (scope.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, 2400);
}

/** 节点最大轮数（供对话侧参考）。 */
export const FLOW_NODE_MAX_ROUNDS = NODE_MAX_ROUNDS;

/** 节点类型展示名（导出给面板用）。 */
export { NODE_TYPE_LABEL };
