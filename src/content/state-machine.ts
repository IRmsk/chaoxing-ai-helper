import { QUESTION_RETRY_MAX } from '@/common/constants';
import { sleep } from '@/common/dom-utils';
import { CxaiError, toCxaiError } from '@/common/errors';
import { createLogger } from '@/common/logger';
import type { ChatTargets, Config, PanelStatus, StateName, StateTone } from '@/types';
import { ensureInputReady, fillInput, isInputLocked, sendMessage } from './injector';
import {
  describeMessages,
  getMessagesSignature,
  getPageContext,
  looksLikeEnding,
  setOwnSentText,
  waitForNewQuestion,
  waitForStableReply,
  type MessageView,
} from './observer';

/**
 * 轮次状态机。
 *
 * ```
 * IDLE → DETECTING → WAITING_QUESTION → CALLING_DEEPSEEK
 *      → FILLING → SENDING → WAITING_REPLY → (轮次+1) → 循环 or DONE
 * ```
 * - 达到 `maxRounds` → DONE，并停止产生新轮次；
 * - 任意环节异常 → ERROR，面板提供「重试 / 跳过本轮」；
 * - 用户暂停 → PAUSED，可继续。
 */

const log = createLogger('content:state');

/** 状态 → 指示灯语义。 */
const TONE_MAP: Record<StateName, StateTone> = {
  IDLE: 'idle',
  DETECTING: 'waiting',
  WAITING_QUESTION: 'waiting',
  CALLING_DEEPSEEK: 'running',
  FILLING: 'running',
  SENDING: 'running',
  WAITING_REPLY: 'waiting',
  PAUSED: 'waiting',
  DONE: 'running',
  ERROR: 'error',
};

/** 状态机对外依赖。 */
export interface RunnerDeps {
  /** 读取最新配置（每轮开始前都会重新读取，保证改配置即时生效）。 */
  getConfig: () => Config;
  /** 获取当前对话窗口关键节点（失效时应返回 null）。 */
  getTargets: () => ChatTargets | null;
  /** 请求大模型作答（`pageContext` 是对话之外的整页背景资料）。 */
  ask: (question: string, pageContext: string, signal: AbortSignal) => Promise<string>;
  /** 上报状态片段。 */
  onStatus: (patch: Partial<PanelStatus>) => void;
  /** 轮次变化回调（用于持久化计数）。 */
  onRound: (round: number) => void;
}

/** 截断长文本用于 UI 展示。 */
function truncate(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export class AutomationRunner {
  private state: StateName = 'IDLE';
  private controller: AbortController | null = null;
  private busy = false;

  private round = 0;

  /** 已成功作答的问题签名，避免重复作答同一问题。 */
  private lastAnsweredSignature: string | null = null;
  /** 本轮正在处理、尚未成功提交的问题（供「跳过本轮」使用）。 */
  private pendingQuestion: MessageView | null = null;

  private stopped = false;
  /** 第 0 轮「等不到提问」的连续重试次数。 */
  private questionRetries = 0;

  constructor(private readonly deps: RunnerDeps) {}

  /* ---------------- 只读状态 ---------------- */

  getState(): StateName {
    return this.state;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * 状态机当前是否在跑（`busy` 为 true，或状态已离开 IDLE）。
   *
   * 与 `isBusy()` 的区别：`busy` 只覆盖「正在执行某个步骤」，
   * 而「等待 AI 提问」这类驻留状态同样算「在跑」—— 编排器判断
   * 「要不要把它拉起来」时用这个更准。
   */
  isRunning(): boolean {
    return this.busy || this.state !== 'IDLE';
  }

  getRound(): number {
    return this.round;
  }

  /** 页面刷新后恢复持久化的轮次。 */
  restoreRound(value: number): void {
    this.round = Math.max(0, Math.floor(value));
    this.deps.onStatus({ round: this.round });
  }

  /** 清空轮次（对应 Popup 的「清空当前课程计数」）。 */
  clearRound(): void {
    this.round = 0;
    this.lastAnsweredSignature = null;
    this.pendingQuestion = null;
    setOwnSentText(null);
    this.deps.onRound(0);
    this.deps.onStatus({ round: 0, message: '轮次计数已清空' });
  }

  /* ---------------- 控制入口 ---------------- */

  /** 从当前进度开始连续作答，直到达到上限或用户停止。 */
  start(): void {
    this.launch(Number.POSITIVE_INFINITY);
  }

  /** 继续（暂停 / 出错后）。 */
  resume(): void {
    this.launch(Number.POSITIVE_INFINITY);
  }

  /** 手动触发一次：只跑一轮。 */
  step(): void {
    this.launch(1);
  }

  /** 出错后重试：重新执行本轮（沿用同一个问题）。 */
  retry(): void {
    this.lastAnsweredSignature = null;
    this.pendingQuestion = null;
    this.launch(Number.POSITIVE_INFINITY);
  }

  /** 跳过本轮：把当前问题标记为已作答后继续。 */
  skip(): void {
    if (this.pendingQuestion) {
      this.lastAnsweredSignature = this.pendingQuestion.signature;
      this.pendingQuestion = null;
      log.info('已跳过当前问题');
    }
    this.launch(Number.POSITIVE_INFINITY);
  }

  /** 暂停：中断当前等待，保留轮次进度。 */
  pause(): void {
    if (!this.busy) return;
    log.info('用户暂停');
    this.controller?.abort();
  }

  /** 停止：中断并回到空闲。 */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.setState('IDLE', '已停止');
  }

  /* ---------------- 内部实现 ---------------- */

  private setState(state: StateName, message: string, error?: string): void {
    this.state = state;
    log.state(state, message);
    this.deps.onStatus({ state, tone: TONE_MAP[state], message, ...(error ? { error } : {}) });
  }

  /**
   * 启动执行循环。
   *
   * @param additionalRounds 本轮会话额外允许执行的轮数（`Infinity` 表示直到上限）。
   */
  private launch(additionalRounds: number): void {
    if (this.busy) {
      log.warn('任务正在运行中，忽略重复触发');
      return;
    }
    this.busy = true;
    this.stopped = false;

    const controller = new AbortController();
    this.controller = controller;

    const quota =
      additionalRounds === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : this.round + Math.max(1, additionalRounds);

    void this.loop(controller.signal, quota).finally(() => {
      this.busy = false;
      this.controller = null;
    });
  }

  /** 主循环。 */
  private async loop(signal: AbortSignal, quota: number): Promise<void> {
    try {
      for (;;) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const config = this.deps.getConfig();

        if (this.round >= config.maxRounds) {
          this.setState('DONE', `已完成 ${this.round} 轮，达到上限 ${config.maxRounds}，任务结束`);
          return;
        }
        if (this.round >= quota) {
          this.setState('IDLE', `本次触发完成，当前累计 ${this.round}/${config.maxRounds} 轮`);
          return;
        }

        const finished = await this.runRound(signal);
        if (finished) return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (this.stopped) {
          this.setState('IDLE', '已手动停止');
          return;
        }
        this.setState('PAUSED', `已暂停（当前 ${this.round} 轮，点「继续」可恢复）`);
        return;
      }
      const cx = toCxaiError(err);
      log.error(`执行失败：${cx.message}`);
      this.setState('ERROR', cx.message, cx.message);
    }
  }

  /**
   * 执行一轮完整问答。
   *
   * @param signal 中止信号。
   * @returns `true` 表示实践已结束，应退出主循环。
   */
  private async runRound(signal: AbortSignal): Promise<boolean> {
    const config = this.deps.getConfig();

    /* ---------- 1. 等待 AI 提问 ---------- */
    let targets = this.requireTargets();
    this.setState('WAITING_QUESTION', `等待 AI 提问（第 ${this.round + 1}/${config.maxRounds} 轮）…`);

    // 进入等待前先落一份消息快照，排查「读不到提问 / 侧别判错」时能一眼看出原因
    log.info(`当前对话快照：\n${describeMessages(targets.list)}`);

    let question: MessageView;
    try {
      question = await waitForNewQuestion(targets.list, this.lastAnsweredSignature, {
        timeoutMs: config.questionTimeoutSec * 1000,
        signal,
        onTick: ({ side, text }) => {
          // 实时把「最后一条消息是谁发的」显示出来，用户一眼就能确认识别是否正常
          const who = side === 'ai' ? 'AI' : side === 'user' ? '我方' : side === 'none' ? '无消息' : '未知';
          const head = text.replace(/\s+/g, ' ').slice(0, 32);
          this.deps.onStatus({
            message: `第 ${this.round + 1} 轮｜最后一条消息：${who}${head ? `「${head}…」` : ''}`,
          });
        },
      });
    } catch (err) {
      const cx = toCxaiError(err);
      if (cx.code === 'QUESTION_TIMEOUT') {
        log.warn(`等待提问超时，对话快照：\n${describeMessages(targets.list)}`);

        // 一轮都没跑过 → 大概率只是页面还在加载、提问还没渲染出来，
        // 不该直接判错（需求是「一打开 AI 实践页面就能自动开始」）。
        // 持续重等到上限才报错。
        if (this.round === 0 && this.questionRetries < QUESTION_RETRY_MAX) {
          this.questionRetries += 1;
          this.setState(
            'WAITING_QUESTION',
            `暂未检测到 AI 提问，继续等待…（第 ${this.questionRetries}/${QUESTION_RETRY_MAX} 次）`,
          );
          await sleep(2000, signal);
          return false; // 回到主循环，再等一轮
        }

        // 已经完成过至少一轮，且迟迟等不到新问题 → 大概率是 AI 已收尾，按完成处理
        if (this.round > 0) {
          this.setState('DONE', `未再检测到新的 AI 提问，判定实践已结束（共完成 ${this.round} 轮）`);
          return true;
        }
      }
      throw err;
    }

    // AI 明确收尾时自动结束
    if (this.round > 0 && looksLikeEnding(question.text)) {
      this.setState('DONE', `AI 已给出收尾回复，判定实践结束（共完成 ${this.round} 轮）`);
      return true;
    }

    this.questionRetries = 0;
    this.pendingQuestion = question;
    log.info(`第 ${this.round + 1} 轮提问：${truncate(question.text, 60)}`);

    /* ---------- 2. 请求大模型 ---------- */
    this.setState('CALLING_DEEPSEEK', `正在向 ${config.model} 请求答案…`);
    // 带上「对话之外的整页文字」（任务介绍 / 出场角色 / 完成条件 / 任务流），
    // 让模型按任务要求作答，而不是只盯着最后一句提问
    const pageContext = getPageContext(targets);
    log.info(`页面背景资料 ${pageContext.length} 字`);
    const answer = await this.deps.ask(question.text, pageContext, signal);

    /* ---------- 3. 解锁输入框并写入 ---------- */
    targets = this.requireTargets();
    // 真实站点上输入框默认锁定（messageInputLock），必须先点「继续」解锁，
    // 否则写入被忽略、发送按钮也是锁的 —— 表现为「跑了但没有任何效果」。
    if (isInputLocked(targets.input)) {
      this.setState('FILLING', '输入框已锁定，正在点击「继续」解锁…');
    }
    await ensureInputReady(targets.input, targets.unlockBtn, { signal });

    this.setState('FILLING', `正在写入输入框（${answer.length} 字）…`);
    await fillInput(targets.input, answer, { signal });

    /* ---------- 4. 发送 ---------- */
    targets = this.requireTargets();
    this.setState('SENDING', '正在发送…');
    const beforeSignature = getMessagesSignature(targets.list);
    await sendMessage(targets, { beforeSignature, sentText: answer, signal });
    // 标记我方消息：后续挑选 AI 回复时会显式跳过它，
    // 避免「侧别判定失效时把自己的作答当成 AI 回复」而死循环
    setOwnSentText(answer);

    /* ---------- 5. 等待 AI 回复完成 ---------- */
    // 以「我方刚发出的这条消息」为锚点找回复，不再依赖发送前的消息下标
    this.setState('WAITING_REPLY', '正在等待 AI 回复…');
    const reply = await waitForStableReply(targets.list, {
      timeoutMs: config.replyTimeoutSec * 1000,
      signal,
      sentText: answer,
      onTick: (text) => this.deps.onStatus({ message: `AI 正在回复…（已输出 ${text.length} 字）` }),
    });

    /* ---------- 6. 轮次结算 ---------- */
    this.round += 1;
    this.lastAnsweredSignature = question.signature;
    this.pendingQuestion = null;
    this.deps.onRound(this.round);
    this.deps.onStatus({
      round: this.round,
      lastQuestion: truncate(question.text),
      lastAnswer: truncate(answer),
      message: `第 ${this.round} 轮完成`,
    });
    log.state('WAITING_REPLY', `第 ${this.round} 轮完成（AI 回复 ${reply.length} 字）`);

    /* ---------- 7. 轮次间间隔 ---------- */
    if (config.intervalSec > 0 && this.round < config.maxRounds) {
      await sleep(config.intervalSec * 1000, signal);
    }
    return false;
  }

  /** 获取有效的对话窗口节点，失效则抛错进入 ERROR。 */
  private requireTargets(): ChatTargets {
    const targets = this.deps.getTargets();
    if (!targets) {
      throw new CxaiError(
        'NOT_DETECTED',
        '对话窗口已失效（页面可能发生重渲染或跳转）。请刷新页面后重试。',
        true,
      );
    }
    return targets;
  }
}
