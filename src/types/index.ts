/**
 * 全局类型定义。
 *
 * 所有跨模块共享的契约（状态机状态、配置结构、消息协议、选择器覆盖）集中在此，
 * 保证 content / background / popup 三层对同一份协议理解一致。
 */

/* ------------------------------------------------------------------ */
/* 状态机                                                              */
/* ------------------------------------------------------------------ */

/**
 * 轮次状态机状态。
 *
 * ```
 * IDLE → DETECTING → WAITING_QUESTION → CALLING_DEEPSEEK
 *      → FILLING → SENDING → WAITING_REPLY → (轮次+1) → 循环 or DONE
 * ```
 * 任意环节异常 → ERROR；用户主动暂停 → PAUSED。
 */
export type StateName =
  | 'IDLE'
  | 'DETECTING'
  | 'WAITING_QUESTION'
  | 'CALLING_DEEPSEEK'
  | 'FILLING'
  | 'SENDING'
  | 'WAITING_REPLY'
  | 'PAUSED'
  | 'DONE'
  | 'ERROR';

/** 状态灯颜色语义（与文档 4.8 一致）。 */
export type StateTone = 'idle' | 'running' | 'waiting' | 'error';

/* ------------------------------------------------------------------ */
/* 任务流（AI 实践的「节点」链路）                                      */
/* ------------------------------------------------------------------ */

/**
 * 任务流节点类型。
 *
 * 学习通 AI 实践的任务流由若干「节点」串成，常见两类：
 * - `dialogue`：情景对话（节点类型文案「情景对话」）；
 * - `upload`：上传作品（节点类型文案「上传作品」，只接受 .docx）。
 *
 * 第一个节点不一定是对话 —— 也可能是上传作品，因此两条链路都必须能独立跑通。
 */
export type FlowNodeType = 'dialogue' | 'upload' | 'unknown';

/** 任务流中的一个节点。 */
export interface FlowNode {
  /** DOM 顺序下标（0 起）。 */
  domIndex: number;
  /** 页面显示的序号文案（如 "02"）。 */
  label: string;
  title: string;
  type: FlowNodeType;
  /** 原始类型文案（情景对话 / 上传作品 / …）。 */
  typeLabel: string;
  /** 节点说明（卡片正文）。 */
  description: string;
  /** 完成条件文案。 */
  completeCondition: string;
  completed: boolean;
  current: boolean;
  /**
   * 卡片被「选中高亮」（站点数据里的 `selectedTaskId === id`）。
   *
   * ⚠️ 语义注意：它跟着**用户点过哪张卡**走，用户点开一个已完成节点回顾时也会亮 ——
   * 所以**不能**当「当前该做哪题」用（那正是「显示上一个节点」的来源之一）。
   * 但反过来很有用：一个**未完成**的卡片带着这个标记，说明它确实已被选中、
   * 右侧内容区展示的就是它 —— 此时不需要再走一次「进入该节点」。
   */
  selected: boolean;
  upcoming: boolean;
  /** 页面显示的成绩（已完成节点）。 */
  score: string;
}

/** 右侧内容区当前展示什么。 */
export type FlowActiveContent = 'dialogue' | 'upload' | 'completed' | 'unknown';

/**
 * 上传节点要求提交的作品类型。
 *
 * 站点在作品卡片上写明「类型：文档 / 类型：图片」，两者的附件选择器入参不同
 * （`fileTypes=doc,docx` vs `fileTypes=png,jpg,jpeg`）——传错类型会被服务端拒绝
 * （选择器提示「上传失败：类型不支持」），导致该节点无法完成。
 */
export type UploadKind = 'image' | 'document';

/** 任务流状态快照。 */
export interface FlowState {
  nodes: FlowNode[];
  /** 当前节点在 `nodes` 中的下标；找不到为 -1。 */
  currentIndex: number;
  currentType: FlowNodeType;
  currentTitle: string;
  activeContent: FlowActiveContent;
  /**
   * 右侧内容区当前展示的节点标题。
   *
   * 上传节点的内容区带着与卡片同一份题目标题 —— 这是「内容区 ⇄ 卡片」对号入座
   * 的最强信号（卡片上的 `is-current` 标记会滞后，不能只看它）。
   * 对话节点的内容区是 iframe，读不到标题，此时为空串。
   */
  activeTitle: string;
  /** 所有节点都已完成。 */
  allCompleted: boolean;
  /**
   * 页面已打出「整条任务流完成」的标记（`.flow-card--done` / `.task-done-row`）。
   *
   * 这是比推断更可靠的完成信号：真机上最后一题做完后，内容区仍会挂着该节点，
   * 只靠「卡片是否都打勾」推断容易被残留内容骗到。
   */
  doneMarked: boolean;
  /** 解锁下一节点的条件文案。 */
  unlockCondition: string;
  /**
   * 尚未渲染成卡片的后续节点。
   *
   * 真实页面的 `.flow-card-list` **只渲染到当前节点**：后面的节点以
   * 「解锁下一节点条件」里的 `.unlock-target`（`<p>类型</p><h4>标题</h4>`）形式预告。
   * 不把它们算进来，就无法判断「整条任务流是否真的做完了」。
   */
  pendingNodes: { title: string; typeLabel: string; type: FlowNodeType }[];
  /** 当前上传节点的作品要求（仅 upload 节点有）。 */
  requirement: string;
}

/** 单个节点的执行记录（供后续节点引用）。 */
export interface NodeRecord {
  domIndex: number;
  title: string;
  type: FlowNodeType;
  /** 对话节点的问答摘录（截断保存）。 */
  transcript: { question: string; answer: string }[];
  /** 上传节点生成的文件信息。 */
  artifact?: { fileName: string; title: string; outline: string[] };
  score?: string;
}

/** 待上传的 Word 文档（由 background 生成，供文件选择器 frame 读取）。 */
export interface PendingDocx {
  courseId: string;
  fileName: string;
  /** base64 编码的作品字节（.docx 或图片）。 */
  base64: string;
  /**
   * MIME 类型。
   *
   * 上传节点分「文档 / 图片」两种，选择器据此校验：
   * - 文档 → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
   * - 图片 → `image/png`
   * 传错会被服务端拒绝（选择器显示「上传失败：类型不支持」）。不填时按 .docx 处理。
   */
  mime?: string;
  /** 生成时间戳（毫秒）—— 超过有效期视为过期，避免误上传旧文件。 */
  createdAt: number;
  /** 作品大纲 / 控制台正文，便于 UI 展示与记录。 */
  outline: string[];
}

/** 任务流当前的执行阶段（面板展示用）。 */
export type FlowPhase =
  | 'idle'
  | 'scan'
  | 'open-dialogue'
  | 'dialogue'
  | 'finish-dialogue'
  | 'prepare-doc'
  | 'pick-file'
  | 'evaluate'
  | 'advance'
  | 'paused'
  | 'done'
  | 'error';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** 用户可配置项。除 `apiKey` / `baseUrl` / `model` 外均有安全默认值。 */
export interface Config {
  /** DeepSeek（或兼容 OpenAI 协议端点）的 API Key，仅存于本地 chrome.storage。 */
  apiKey: string;
  /** 接口根地址，例如 `https://api.deepseek.com`（不含 /chat/completions）。 */
  baseUrl: string;
  /** 模型名，例如 `deepseek-chat`。 */
  model: string;
  /** 系统提示词，决定 AI 作答风格。 */
  systemPrompt: string;
  /** 最大轮数（达到后自动停止）。 */
  maxRounds: number;
  /** 每轮之间的最小间隔（秒），避免触发风控。 */
  intervalSec: number;
  /** 等待 AI 回复完成的超时（秒）。 */
  replyTimeoutSec: number;
  /** 等待 AI 抛出下一个问题的超时（秒）。 */
  questionTimeoutSec: number;
  /** 单次接口请求超时（秒）。 */
  requestTimeoutSec: number;
  /** 采样温度。 */
  temperature: number;
  /** 页面加载后自动开始（默认关闭，避免用户未配置 API Key 时空转）。 */
  autoStart: boolean;
}

/** 配置字段级校验结果。 */
export interface ValidationIssue {
  field: keyof Config;
  message: string;
}

/* ------------------------------------------------------------------ */
/* 选择器                                                              */
/* ------------------------------------------------------------------ */

/** 可被用户自定义覆盖的关键选择器键。 */
export type SelectorKey =
  | 'chatRoot'
  | 'messageList'
  | 'messageItem'
  | 'messageItemAI'
  | 'messageItemUser'
  | 'input'
  | 'sendBtn'
  /**
   * 「继续 / 开始作答」按钮。
   *
   * 学习通 AI 实践的输入框默认是**锁定**的（`textarea.messageInput.messageInputLock`），
   * 必须点击该按钮解锁后才能输入。扩展在每轮填写前会自动点它。
   */
  | 'unlockBtn';

/** 用户通过「选择器调试模式」保存的自定义选择器（部分覆盖默认候选）。 */
export type SelectorOverrides = Partial<Record<SelectorKey, string>>;

/* ------------------------------------------------------------------ */
/* 运行状态                                                            */
/* ------------------------------------------------------------------ */

/** content script 上报、并在悬浮面板 / Popup 中展示的运行时状态快照。 */
export interface PanelStatus {
  state: StateName;
  tone: StateTone;
  /** 已完成轮数。 */
  round: number;
  maxRounds: number;
  /** 当前课程 ID（用于按课程分别计数）。 */
  courseId: string;
  /** 人类可读的状态描述。 */
  message: string;
  /** 任务流进度：当前节点序号（1 起，0 表示未知）。 */
  nodeIndex?: number;
  /** 任务流总节点数。 */
  nodeTotal?: number;
  /** 当前节点标题。 */
  nodeTitle?: string;
  /** 当前节点类型文案（情景对话 / 上传作品）。 */
  nodeTypeLabel?: string;
  /** 任务流阶段。 */
  phase?: FlowPhase;
  /** 最近一次错误信息。 */
  error?: string;
  /** 最近一次抓取到的 AI 提问（截断展示）。 */
  lastQuestion?: string;
  /** 最近一次提交的答案（截断展示）。 */
  lastAnswer?: string;
  /** 是否探测到对话窗口。 */
  detected: boolean;
  /** 探测置信度 0~1，便于排查选择器失效。 */
  confidence: number;
  updatedAt: number;
}

/** 日志条目。 */
export interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  text: string;
}

/* ------------------------------------------------------------------ */
/* 探测结果                                                            */
/* ------------------------------------------------------------------ */

/** DOM 探测得到的对话窗口各关键节点。 */
export interface ChatTargets {
  /** A 对话根容器。 */
  root: HTMLElement;
  /** B 消息列表容器（可能等于 root）。 */
  list: HTMLElement;
  /** C 输入框（textarea 或 contenteditable）。 */
  input: HTMLElement;
  /** D 发送按钮（可能不存在，此时退化为 Enter 发送）。 */
  sendBtn: HTMLElement | null;
  /** E 「继续 / 开始作答」按钮（输入框锁定时用于解锁，可能不存在）。 */
  unlockBtn: HTMLElement | null;
  /** 实际命中的选择器（用于诊断与回写）。 */
  matched: Partial<Record<SelectorKey, string>>;
  /** 探测置信度 0~1。 */
  confidence: number;
  /** 探测方式：override（用户自定义）/ selector（默认候选）/ heuristic（启发式嗅探）。 */
  source: 'override' | 'selector' | 'heuristic';
}
