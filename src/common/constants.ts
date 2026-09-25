import type { Config } from '@/types';

/** 日志统一前缀，方便用户 `Ctrl+F` 过滤。 */
export const LOG_PREFIX = '[CX-AI]';

/** chrome.storage.local 的键名。统一加 `cxai:` 前缀避免与其他扩展冲突。 */
export const STORAGE_KEYS = {
  /** 全局配置。 */
  config: 'cxai:config',
  /** 按课程 ID 分别记录的轮次计数。 */
  counters: 'cxai:counters',
  /** 用户自定义选择器覆盖。 */
  overrides: 'cxai:selectorOverrides',
  /** 选择器调试模式开关。 */
  debug: 'cxai:debugMode',
  /** 悬浮面板的位置与折叠状态。 */
  panelPrefs: 'cxai:panelPrefs',
  /** 配置结构版本（用于把老版本的默认值升级到新默认值）。 */
  configVersion: 'cxai:configVersion',
  /** 任务流按课程记录的节点执行记录（session 存储）。 */
  flowRecords: 'cxai:flowRecords',
  /** 待上传的 Word 文档（session 存储，由 background 生成、选择器 frame 读取）。 */
  pendingDocx: 'cxai:pendingDocx',
} as const;

/** Port 名称：content script（worker）↔ background 的长连接。 */
export const PORT_WORKER = 'cxai:port:worker';
/** Port 名称：悬浮面板（top frame）↔ background 的长连接。 */
export const PORT_PANEL = 'cxai:port:panel';

/** 默认配置。 */
export const DEFAULT_CONFIG: Config = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  systemPrompt:
    '你是学习通 AI 实践课的对话助手。请用简洁、口语化、符合学生身份的中文回答，控制在 100-200 字，不要使用 Markdown 列表。',
  maxRounds: 30,
  intervalSec: 3,
  replyTimeoutSec: 90,
  questionTimeoutSec: 120,
  requestTimeoutSec: 60,
  temperature: 1.0,
  autoStart: true,
};

/**
 * 配置结构版本。
 *
 * 改默认值的语义时**必须同时 +1**，并在 `storage.getConfig` 里补一段迁移：
 * 否则老用户浏览器里那份已经落盘的旧默认值会一直生效（改代码不生效，很容易误判成 bug）。
 */
export const CONFIG_VERSION = 2;

/** 迁移前的旧默认值（仅当用户仍停留在旧默认值时才升级，避免覆盖用户的显式设置）。 */
export const LEGACY_DEFAULTS = {
  maxRounds: 10,
  autoStart: false,
} as const;

/** 常用模型候选（用户仍可自定义）。 */
export const PRESET_MODELS = [
  { value: 'deepseek-chat', label: 'deepseek-chat（DeepSeek 对话模型）' },
  { value: 'deepseek-reasoner', label: 'deepseek-reasoner（DeepSeek 推理模型）' },
] as const;

/** 常用 Base URL 候选。 */
export const PRESET_BASE_URLS = [
  { value: 'https://api.deepseek.com', label: 'DeepSeek 官方' },
] as const;

/** 上下文数组最大长度（超出后丢弃最早的对话，保留 system）。 */
export const MAX_CONTEXT_MESSAGES = 20;

/** 重试策略：指数退避延迟（毫秒）。 */
export const RETRY_DELAYS_MS = [1000, 3000] as const;

/** 回复完成检测：连续稳定次数。 */
export const REPLY_STABLE_TIMES = 3;
/** 回复完成检测：采样间隔（毫秒）。 */
export const REPLY_POLL_INTERVAL_MS = 800;

/**
 * 附件选择器 frame 等待「待上传文档」的最长时间（毫秒）。
 *
 * 之所以要等这么久：选择器 iframe 不会每次打开都重新加载（宿主用 `v-show`），
 * 内容脚本可能只跑一次；而文档是在任务流跑到上传节点时才生成的，
 * 两者之间可能有分钟级的时间差。
 */
export const PICKER_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/** 待上传文档的有效期（毫秒）：超过则视为过期，避免误上传上一次生成的文件。 */
export const PENDING_DOCX_TTL_MS = 5 * 60 * 1000;

/** 单个节点最多保留的问答条数（用于后续节点引用上下文）。 */
export const NODE_TRANSCRIPT_MAX = 12;

/** 每个节点最多允许的对话轮数上限（防止在某个节点里打转）。 */
export const NODE_MAX_ROUNDS = 40;

/** 注入提示词的「页面背景资料」最大字符数（控制 token 消耗）。 */
export const PAGE_CONTEXT_MAX_CHARS = 1600;

/** 第 0 轮等不到提问时的最大连续重试次数（超过才报错，避免页面还在加载就判失败）。 */
export const QUESTION_RETRY_MAX = 20;

/** DOM 探测轮询间隔（毫秒）。 */
export const DETECT_POLL_INTERVAL_MS = 1500;

/** 输入框写入校验重试次数。 */
export const FILL_MAX_RETRY = 3;

/** 发送成功校验的等待上限（毫秒）。 */
export const SEND_VERIFY_TIMEOUT_MS = 5000;

/** 日志环形缓冲区容量。 */
export const LOG_BUFFER_SIZE = 400;
