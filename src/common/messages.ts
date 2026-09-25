import type { Config, LogEntry, PanelStatus } from '@/types';

/**
 * 三层通信协议（popup ↔ background ↔ content）。
 *
 * 拓扑说明：
 * ```
 *  popup ──sendMessage──► background ──Port──► content(worker frame) ──► 学习通 DOM
 *  panel(top frame) ──Port──► background ──Port──► content(worker frame)
 * ```
 * 由于 AI 实践对话可能位于子 iframe，background 充当「中枢」：
 * 记录每个 tab 的 worker frameId，把面板/弹窗的指令精确转发到对应 frame。
 */

/**
 * 可由 UI 触发的控制指令。
 *
 * - `START` / `RESUME` / `PAUSE` / `STOP` / `STEP` / `SKIP`：控制状态机；
 * - `DEBUG`：在对话窗口所在 frame 打开选择器调试器；
 * - `DIAGNOSE`：在对话窗口所在 frame 输出一份完整诊断到控制台（排查读不到消息时用）；
 * - `RESET`：清空当前课程的轮次计数与对话上下文（由 worker 执行并回写存储）。
 */
export type Command =
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'STOP'
  | 'STEP'
  | 'SKIP'
  | 'DEBUG'
  | 'DIAGNOSE'
  | 'RESET'
  /**
   * 结束当前对话节点：在对话 frame 内寻找「完成对话 / 开始评估」并点击。
   * 由任务流编排器下发（用户无需手动操作）。
   */
  | 'FINISH_DIALOGUE';

/** 一次性消息类型（sendMessage）。 */
export const MSG = {
  /** popup → background：获取指定标签页的运行状态。 */
  GET_STATUS: 'cxai:get-status',
  /** popup → background：测试接口连通性。 */
  TEST_CONNECTION: 'cxai:test-connection',
  /** popup → background：拉取模型列表。 */
  FETCH_MODELS: 'cxai:fetch-models',
  /** popup → background：清空轮次计数。 */
  RESET_COUNTER: 'cxai:reset-counter',
  /** popup → background：导出日志。 */
  GET_LOGS: 'cxai:get-logs',
  /** popup → background：清理日志。 */
  CLEAR_LOGS: 'cxai:clear-logs',
  /** popup/panel → background：转发控制指令给 worker frame。 */
  FORWARD_COMMAND: 'cxai:forward-command',
  /** background → content：广播「配置已变更」。 */
  CONFIG_CHANGED: 'cxai:config-changed',
  /** 任意层 → background：确认 background 存活（用于诊断）。 */
  PING: 'cxai:ping',
  /** 任务流 frame → background：生成「上传作品」节点的 Word 文档并暂存。 */
  GENERATE_DOCX: 'cxai:generate-docx',
  /** 任务流 frame → background：查询对话 frame 当前状态。 */
  GET_DIALOGUE_STATE: 'cxai:get-dialogue-state',
  /** 任务流 frame → background：把指令转发给对话 frame。 */
  COMMAND_DIALOGUE: 'cxai:command-dialogue',
} as const;

/** Port 消息类型。 */
export const PORT_MSG = {
  /* --- worker → background --- */
  /** content 注册自己为当前标签页的 worker（对话窗口所在 frame）。 */
  REGISTER: 'register',
  /** content 上报状态快照。 */
  STATUS: 'status',
  /** content 请求 background 调用大模型（带 requestId 便于关联响应）。 */
  ASK: 'ask',
  /** content 上报页面探测结果（用于 Popup 诊断）。 */
  DETECT_INFO: 'detect-info',

  /* --- background → worker --- */
  /**
   * background 在端口建立时回执本 frame 所属的标签页 ID。
   *
   * 内容脚本自己拿不到可靠的 tabId（`chrome.tabs.query` 在多个 chaoxing 标签页
   * 同时打开时可能返回**别的**标签页），而任务流编排器必须用正确的 tabId
   * 才能把指令/状态查询路由到本标签页的对话 frame。
   */
  WELCOME: 'welcome',
  /** background 下发控制指令。 */
  COMMAND: 'command',
  /** background 通知配置变更。 */
  CONFIG_CHANGED: 'config-changed',
  /** background 回复 ASK 请求。 */
  ASK_RESULT: 'ask-result',

  /* --- flow → background / background → flow --- */
  /** 任务流 frame 注册自己（宿主页面）。 */
  FLOW_REGISTER: 'flow-register',

  /* --- panel → background --- */
  /** 面板上线。 */
  PANEL_HELLO: 'panel-hello',
  /** 面板请求当前状态。 */
  PANEL_SYNC: 'panel-sync',
  /** 面板请求 background 把控制指令转发给本标签页的 worker frame。 */
  PANEL_COMMAND: 'panel-command',

  /* --- background → panel --- */
  /** background 推送状态快照。 */
  STATUS_PUSH: 'status-push',
} as const;

/* ------------------------------------------------------------------ */
/* 消息负载                                                            */
/* ------------------------------------------------------------------ */

/** worker 注册信息。 */
export interface RegisterPayload {
  courseId: string;
  url: string;
  frameId: number;
  confidence: number;
}

/** 探测诊断信息。 */
export interface DetectInfo {
  matched: Record<string, string | undefined>;
  source: 'override' | 'selector' | 'heuristic';
  confidence: number;
  inputKind: 'textarea' | 'contenteditable' | 'unknown';
  messageCount: number;
  aiMessageCount: number;
  userMessageCount: number;
  /** 消息列表首条文本摘要，便于用户确认是否找对了 DOM。 */
  sample: string;
}

/** 模型拉取 / 连接测试的请求参数。 */
export interface ApiProbePayload {
  apiKey: string;
  baseUrl: string;
  model?: string;
}

/** 连接测试结果。 */
export interface TestConnectionResult {
  ok: boolean;
  /** 人类可读结果描述。 */
  message: string;
  /** 延迟毫秒。 */
  latencyMs?: number;
  /** 探测到的模型列表（顺带返回，减少一次请求）。 */
  models?: string[];
}

/** 统一的响应包装。 */
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** background 保存的每个 tab 的运行态。 */
export interface TabRuntime {
  tabId: number;
  frameId: number;
  status: PanelStatus;
  lastSeen: number;
}

/** 传递给 content 的完整上下文（配置 + 覆盖 + 调试开关）。 */
export interface ContentBootstrap {
  config: Config;
  overrides: Record<string, string>;
  debug: boolean;
}

/* ------------------------------------------------------------------ */
/* 发送助手                                                            */
/* ------------------------------------------------------------------ */

/**
 * 向 background 发送一次性消息并等待响应。
 *
 * @param message 消息体（必须包含 `type`）。
 * @returns background 的响应。
 */
export async function sendToBackground<T = unknown>(message: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

/**
 * 从消息监听器返回统一成功响应。
 *
 * @param data 业务数据。
 */
export function okReply<T>(data: T): Reply<T> {
  return { ok: true, data };
}

/**
 * 从消息监听器返回统一失败响应。
 *
 * @param error 中文错误描述。
 * @param code 错误码（可选）。
 */
export function failReply(error: string, code?: string): Reply<never> {
  return { ok: false, error, code };
}

/** 导出日志用的返回结构。 */
export interface LogsPayload {
  entries: LogEntry[];
  text: string;
}


/* ------------------------------------------------------------------ */
/* 任务流相关负载                                                      */
/* ------------------------------------------------------------------ */

/** 生成 Word 文档的请求。 */
export interface GenerateDocxPayload {
  courseId: string;
  taskTitle: string;
  requirement: string;
  pageContext: string;
  previousSummary: string;
}

/** 生成 Word 文档的结果。 */
export interface GenerateDocxResult {
  fileName: string;
  outline: string[];
  /** 文档字节数的可读大小（用于面板展示）。 */
  sizeText: string;
}

/** 对话 frame 的状态摘要（任务流编排器据此判断对话是否跑完）。 */
export interface DialogueStateReply {
  /** 是否已有对话 frame 注册。 */
  present: boolean;
  state: string;
  round: number;
  message: string;
}
