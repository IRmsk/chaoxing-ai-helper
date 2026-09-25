import { PORT_WORKER } from '@/common/constants';
import { CxaiError } from '@/common/errors';
import { createLogger } from '@/common/logger';
import { PORT_MSG, type Command, type DetectInfo, type RegisterPayload } from '@/common/messages';
import type { PanelStatus } from '@/types';

/**
 * content script ↔ background 的长连接桥。
 *
 * 使用长连接（Port）而不是一次性消息的原因：
 * 1. 面板需要**被动接收** background 推送的状态与指令，一次性消息做不到；
 * 2. MV3 Service Worker 会被回收，长连接上的消息往来能持续刷新其存活计时器，
 *    再叠加 20s 心跳，避免调用大模型期间 SW 被回收导致请求中断。
 */

const log = createLogger('content:bridge');

type AskResult = { ok: true; content: string } | { ok: false; error: string; code?: string };

interface PendingAsk {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 心跳间隔（毫秒）。 */
const HEARTBEAT_MS = 20_000;

export class BackgroundBridge {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, PendingAsk>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  /**
   * 待补发的注册消息。
   *
   * ⚠️ 这是个容易踩的时序坑：内容脚本是**同步**做探测与注册的，而
   * `bridge.connect()` 往往在 `reloadSettings()` 这类异步流程之后才执行。
   * 于是注册消息会打在「端口还不存在」的时刻 —— `post()` 里 `this.port?.postMessage`
   * 静默变成空操作，而调用方（`registerWorker`）已经把 `amWorker` 置为 true，
   * **再也不会重试**。表现就是：探测一切正常（置信度 0.85、发送按钮命中），
   * 但 background 始终认为「没有对话 frame」，编排器下发的 START 全部落空。
   *
   * 因此把注册消息缓存下来，在**每次连接建立后补发一次**，
   * 顺带也解决了 Service Worker 被回收后重连需要重新注册的问题。
   */
  private hello: Record<string, unknown> | null = null;

  /** background 在端口建立时回执的标签页 ID（比 tabs.query 可靠）。 */
  private tabId: number | null = null;

  private commandHandlers = new Set<(cmd: Command) => void>();
  private configHandlers = new Set<() => void>();
  private statusHandlers = new Set<(status: PanelStatus | null, hasWorker: boolean, detect: DetectInfo | null) => void>();

  /** 建立连接（幂等）。 */
  connect(): void {
    if (this.port) return;
    try {
      this.port = chrome.runtime.connect({ name: PORT_WORKER });
    } catch (err) {
      log.warn(`连接 background 失败：${(err as Error)?.message ?? String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.port.onMessage.addListener((raw: unknown) => this.handleMessage(raw as Record<string, unknown>));
    this.port.onDisconnect.addListener(() => {
      this.port = null;
      this.stopHeartbeat();
      log.warn('与 background 的连接已断开（Service Worker 可能被回收），将自动重连');
      this.rejectAllPending('与后台服务的连接中断，请重试');
      this.scheduleReconnect();
    });

    this.startHeartbeat();
    log.info('已连接 background');

    // 端口就绪（或断线重连）后补发注册消息，保证 background 一定认得本 frame
    if (this.hello) {
      try {
        this.port.postMessage(this.hello);
      } catch (err) {
        log.warn(`补发注册消息失败：${(err as Error)?.message ?? String(err)}`);
      }
    }
  }

  /** 断线重连（指数温和退避，最长 5s）。 */
  private scheduleReconnect(attempt = 0): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(500 * 2 ** attempt, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.port) this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        this.port?.postMessage({ t: 'ping', at: Date.now() });
      } catch {
        /* 连接已断开，等待 onDisconnect 处理 */
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.t) {
      case PORT_MSG.ASK_RESULT: {
        const requestId = msg.requestId as string;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        const result = msg as unknown as AskResult;
        if (result.ok) pending.resolve(result.content);
        else pending.reject(new CxaiError((msg.code as never) ?? 'UNKNOWN', result.error, Boolean(msg.retryable)));
        break;
      }
      case PORT_MSG.WELCOME:
        this.tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
        log.debug(`background 回执 tabId=${this.tabId}`);
        break;
      case PORT_MSG.COMMAND:
        this.commandHandlers.forEach((h) => h(msg.cmd as Command));
        break;
      case PORT_MSG.CONFIG_CHANGED:
        this.configHandlers.forEach((h) => h());
        break;
      case PORT_MSG.STATUS_PUSH:
        this.statusHandlers.forEach((h) =>
          h((msg.status as PanelStatus) ?? null, Boolean(msg.hasWorker), (msg.detect as DetectInfo) ?? null),
        );
        break;
      default:
        break;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CxaiError('API_NETWORK', reason, true));
    }
    this.pending.clear();
  }

  /* ---------------- 发送 ---------------- */

  private post(message: Record<string, unknown>): void {
    if (!this.port) this.connect();
    try {
      this.port?.postMessage(message);
    } catch (err) {
      log.warn(`发送消息失败：${(err as Error)?.message ?? String(err)}`);
      this.port = null;
      this.scheduleReconnect();
    }
  }

  /**
   * 取本 frame 所属的标签页 ID。
   *
   * 优先用 background 在端口建立时回执的值；拿不到时才 `null`，
   * 由调用方回退到 `chrome.tabs.query`。
   */
  getTabId(): number | null {
    return this.tabId;
  }

  /** 注册为当前标签页的 worker。 */
  register(payload: RegisterPayload): void {
    this.hello = { t: PORT_MSG.REGISTER, payload } as Record<string, unknown>;
    this.post(this.hello);
  }

  /**
   * 注册为「任务流宿主 frame」。
   *
   * 与 `register`（对话 worker）分开：任务流页面同时存在宿主与对话 iframe，
   * background 需要区分两者才能把指令发给正确的一方。
   *
   * @param payload 注册信息。
   */
  registerFlow(payload: RegisterPayload): void {
    this.hello = { t: PORT_MSG.FLOW_REGISTER, payload } as Record<string, unknown>;
    this.post(this.hello);
  }

  /** 上报运行状态。 */
  reportStatus(status: PanelStatus): void {
    this.post({ t: PORT_MSG.STATUS, status });
  }

  /** 上报探测诊断信息。 */
  reportDetect(info: DetectInfo): void {
    this.post({ t: PORT_MSG.DETECT_INFO, payload: info });
  }

  /** 声明确认自己承载悬浮面板。 */
  announcePanel(): void {
    this.post({ t: PORT_MSG.PANEL_HELLO });
  }

  /** 面板请求一次状态同步。 */
  requestPanelSync(): void {
    this.post({ t: PORT_MSG.PANEL_SYNC });
  }

  /** 面板下发控制指令（由 background 转发给 worker frame，可能是另一个 frame）。 */
  sendCommand(cmd: Command): void {
    this.post({ t: PORT_MSG.PANEL_COMMAND, cmd });
  }

  /**
   * 请求 background 调用大模型。
   *
   * @param question 本轮提问文本。
   * @param courseId 课程 ID（上下文分桶键）。
   * @param timeoutMs 超时毫秒数（略大于接口超时，避免无限等待）。
   * @param signal 中止信号。
   * @returns 大模型回答文本。
   */
  ask(
    question: string,
    pageContext: string,
    courseId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    this.connect();
    const requestId = `ask-${Date.now()}-${this.seq++}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CxaiError('API_NETWORK', '等待后台返回超时，请重试', true));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(requestId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        timer,
      });

      this.post({ t: PORT_MSG.ASK, payload: { requestId, courseId, question, pageContext } });
    });
  }

  /* ---------------- 订阅 ---------------- */

  onCommand(handler: (cmd: Command) => void): () => void {
    this.commandHandlers.add(handler);
    return () => this.commandHandlers.delete(handler);
  }

  onConfigChanged(handler: () => void): () => void {
    this.configHandlers.add(handler);
    return () => this.configHandlers.delete(handler);
  }

  onStatus(handler: (status: PanelStatus | null, hasWorker: boolean, detect: DetectInfo | null) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
}
