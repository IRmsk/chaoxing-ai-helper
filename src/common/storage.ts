import { createLogger } from './logger';
import { CONFIG_VERSION, DEFAULT_CONFIG, LEGACY_DEFAULTS, PENDING_DOCX_TTL_MS, STORAGE_KEYS } from './constants';
import type { Config, NodeRecord, PendingDocx, SelectorOverrides, ValidationIssue } from '@/types';

const log = createLogger('storage');

/**
 * chrome.storage.local 读写封装。
 *
 * 设计要点：
 * - API Key **只** 保存在 `chrome.storage.local`（`chrome.storage.local` 不参与
 *   跨设备同步），源码中不出现任何密钥，满足文档验收标准第 5 条；
 * - 所有写入前先做字段级校验，非法值直接抛出，避免脏配置导致运行时难以排查；
 * - 计数按课程 ID 分桶，页面刷新后不丢失（验收标准第 6 条）。
 */

/* ------------------------------------------------------------------ */
/* 配置校验                                                            */
/* ------------------------------------------------------------------ */

/** 判断字符串是否为合法的 http(s) URL。 */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * 字段级强制校验。
 *
 * @param config 待校验配置。
 * @param options.requireApiKey 是否强制要求 API Key（Popup 保存时必填；扩展初始化时允许为空）。
 * @returns 问题列表，空数组表示通过。
 */
export function validateConfig(config: Config, options: { requireApiKey?: boolean } = {}): ValidationIssue[] {
  const { requireApiKey = true } = options;
  const issues: ValidationIssue[] = [];
  const push = (field: keyof Config, message: string) => issues.push({ field, message });

  /* --- API Key --- */
  if (!config.apiKey?.trim()) {
    if (requireApiKey) push('apiKey', 'API Key 不能为空');
  } else if (/\s/.test(config.apiKey.trim())) {
    push('apiKey', 'API Key 中不能包含空白字符，请检查是否复制了多余空格');
  }

  /* --- Base URL --- */
  if (!config.baseUrl?.trim()) {
    push('baseUrl', 'Base URL 不能为空');
  } else if (!isValidHttpUrl(config.baseUrl.trim())) {
    push('baseUrl', 'Base URL 必须是合法的 http(s) 地址，例如 https://api.deepseek.com');
  }

  /* --- 模型 --- */
  if (!config.model?.trim()) push('model', '模型名称不能为空，可从「获取模型列表」中选择或手动填写');

  /* --- System Prompt --- */
  if (!config.systemPrompt?.trim()) push('systemPrompt', 'System Prompt 不能为空');

  /* --- 数值区间 --- */
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 500) {
    push('maxRounds', '最大轮数必须为 1 ~ 500 的整数');
  }
  if (!Number.isFinite(config.intervalSec) || config.intervalSec < 0 || config.intervalSec > 600) {
    push('intervalSec', '每轮间隔必须为 0 ~ 600 秒');
  }
  if (!Number.isFinite(config.replyTimeoutSec) || config.replyTimeoutSec < 5 || config.replyTimeoutSec > 1800) {
    push('replyTimeoutSec', '回复超时必须为 5 ~ 1800 秒');
  }
  if (!Number.isFinite(config.questionTimeoutSec) || config.questionTimeoutSec < 5 || config.questionTimeoutSec > 1800) {
    push('questionTimeoutSec', '等待提问超时必须为 5 ~ 1800 秒');
  }
  if (!Number.isFinite(config.requestTimeoutSec) || config.requestTimeoutSec < 5 || config.requestTimeoutSec > 600) {
    push('requestTimeoutSec', '单次请求超时必须为 5 ~ 600 秒');
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    push('temperature', '温度必须为 0 ~ 2 之间的数值');
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* 底层读写                                                            */
/* ------------------------------------------------------------------ */

async function readKey<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取配置（与默认值做浅合并，保证新增字段有默认值）。
 *
 * @returns 完整的配置对象。
 */
export async function getConfig(): Promise<Config> {
  const stored = (await readKey<Partial<Config>>(STORAGE_KEYS.config)) ?? {};
  const merged: Config = { ...DEFAULT_CONFIG, ...stored };

  // 迁移：把「仍停留在旧默认值」的字段升级到新默认值。
  // 只在值等于旧默认值时才改，避免覆盖用户的显式设置。
  const version = (await readKey<number>(STORAGE_KEYS.configVersion)) ?? 1;
  if (version < CONFIG_VERSION) {
    if (merged.maxRounds === LEGACY_DEFAULTS.maxRounds) merged.maxRounds = DEFAULT_CONFIG.maxRounds;
    if (merged.autoStart === LEGACY_DEFAULTS.autoStart) merged.autoStart = DEFAULT_CONFIG.autoStart;
    await writeKey(STORAGE_KEYS.configVersion, CONFIG_VERSION);
    await writeKey(STORAGE_KEYS.config, merged);
    log.info(`配置已从 v${version} 迁移到 v${CONFIG_VERSION}（maxRounds=${merged.maxRounds} autoStart=${merged.autoStart}）`);
  }

  // 数值字段兜底，防止手工改 storage 注入 NaN
  const numericKeys: (keyof Config)[] = [
    'maxRounds',
    'intervalSec',
    'replyTimeoutSec',
    'questionTimeoutSec',
    'requestTimeoutSec',
    'temperature',
  ];
  for (const key of numericKeys) {
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      (merged[key] as unknown) = DEFAULT_CONFIG[key];
    }
  }
  return merged;
}

/**
 * 保存配置（部分字段合并后写入）。
 *
 * @param patch 需要更新的字段。
 * @param options.validate 是否执行强制校验（默认 true）。
 * @throws 校验失败时抛出 Error，message 为汇总后的中文提示。
 */
export async function saveConfig(patch: Partial<Config>, options: { validate?: boolean } = {}): Promise<Config> {
  const { validate = true } = options;
  const current = await getConfig();
  const next: Config = { ...current, ...patch };

  if (validate) {
    const issues = validateConfig(next, { requireApiKey: true });
    if (issues.length > 0) {
      throw new Error(issues.map((i) => i.message).join('；'));
    }
  }

  await writeKey(STORAGE_KEYS.config, next);
  return next;
}

/* ------------------------------------------------------------------ */
/* 轮次计数（按课程 ID 分桶）                                          */
/* ------------------------------------------------------------------ */

type Counters = Record<string, number>;

/**
 * 读取某课程的已完成轮数。
 *
 * @param courseId 课程 ID（从 URL query 中解析）。
 */
export async function getCounter(courseId: string): Promise<number> {
  const counters = (await readKey<Counters>(STORAGE_KEYS.counters)) ?? {};
  return counters[courseId] ?? 0;
}

/**
 * 写入某课程的已完成轮数。
 *
 * @param courseId 课程 ID。
 * @param value 新的轮数。
 */
export async function setCounter(courseId: string, value: number): Promise<void> {
  const counters = (await readKey<Counters>(STORAGE_KEYS.counters)) ?? {};
  counters[courseId] = Math.max(0, Math.floor(value));
  await writeKey(STORAGE_KEYS.counters, counters);
}

/**
 * 清空计数。
 *
 * @param courseId 指定课程则只清该课程；省略则清空全部。
 */
export async function resetCounter(courseId?: string): Promise<void> {
  if (!courseId) {
    await writeKey(STORAGE_KEYS.counters, {});
    return;
  }
  const counters = (await readKey<Counters>(STORAGE_KEYS.counters)) ?? {};
  delete counters[courseId];
  await writeKey(STORAGE_KEYS.counters, counters);
}

/* ------------------------------------------------------------------ */
/* 选择器覆盖                                                          */
/* ------------------------------------------------------------------ */

/** 读取用户自定义选择器覆盖。 */
export async function getOverrides(): Promise<SelectorOverrides> {
  return (await readKey<SelectorOverrides>(STORAGE_KEYS.overrides)) ?? {};
}

/**
 * 写入（合并）选择器覆盖。
 *
 * @param patch 需要覆盖的键值；值为 `undefined` 表示删除该覆盖。
 */
export async function setOverrides(patch: SelectorOverrides): Promise<SelectorOverrides> {
  const current = await getOverrides();
  const next: SelectorOverrides = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!value) delete next[key as keyof SelectorOverrides];
    else next[key as keyof SelectorOverrides] = value;
  }
  await writeKey(STORAGE_KEYS.overrides, next);
  return next;
}

/** 清空全部选择器覆盖（恢复默认候选表）。 */
export async function clearOverrides(): Promise<void> {
  await writeKey(STORAGE_KEYS.overrides, {});
}

/* ------------------------------------------------------------------ */
/* 调试模式                                                            */
/* ------------------------------------------------------------------ */

/** 读取「选择器调试模式」开关。 */
export async function getDebugMode(): Promise<boolean> {
  return (await readKey<boolean>(STORAGE_KEYS.debug)) ?? false;
}

/** 写入「选择器调试模式」开关。 */
export async function setDebugMode(value: boolean): Promise<void> {
  await writeKey(STORAGE_KEYS.debug, value);
}

/* ------------------------------------------------------------------ */
/* 悬浮面板偏好                                                        */
/* ------------------------------------------------------------------ */

/** 悬浮面板的 UI 偏好。 */
export interface PanelPrefs {
  /** 右下角偏移（px）。 */
  x: number;
  y: number;
  /** 是否折叠为悬浮球。 */
  collapsed: boolean;
}

const DEFAULT_PANEL_PREFS: PanelPrefs = { x: 24, y: 96, collapsed: true };

/** 读取悬浮面板偏好。 */
export async function getPanelPrefs(): Promise<PanelPrefs> {
  const stored = await readKey<Partial<PanelPrefs>>(STORAGE_KEYS.panelPrefs);
  return { ...DEFAULT_PANEL_PREFS, ...(stored ?? {}) };
}

/** 写入悬浮面板偏好。 */
export async function setPanelPrefs(patch: Partial<PanelPrefs>): Promise<void> {
  const current = await getPanelPrefs();
  await writeKey(STORAGE_KEYS.panelPrefs, { ...current, ...patch });
}

/* ------------------------------------------------------------------ */
/* 变更订阅                                                            */
/* ------------------------------------------------------------------ */

/**
 * 订阅配置/覆盖/调试开关变更（content script 用它热更新，无需刷新页面）。
 *
 * @param handler 变更回调。
 * @returns 取消订阅函数。
 */
export function subscribeChanges(handler: () => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return;
    if (
      STORAGE_KEYS.config in changes ||
      STORAGE_KEYS.overrides in changes ||
      STORAGE_KEYS.debug in changes
    ) {
      handler();
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}


/* ------------------------------------------------------------------ */
/* 会话级存储适配层                                                    */
/* ------------------------------------------------------------------ */

/**
 * 「会话级」存储的读写适配。
 *
 * 默认走 `chrome.storage.session`（不落盘、浏览器关闭即清空，语义最贴合
 * 「本次任务流执行过程」）。但内容脚本访问它有硬门槛：
 * `accessLevel` 默认是 `TRUSTED_CONTEXTS`，未放开时内容脚本读写会抛
 * `Access to storage is not allowed from this context`。
 *
 * background 启动时已经调用 `setAccessLevel({ TRUSTED_AND_UNTRUSTED_CONTEXTS })`，
 * 但为了不让整套任务流因为一个 API 的可用性而**静默失效**，这里再做一层兜底：
 * session 读/写失败时自动退回 `chrome.storage.local`（加 `sess:` 前缀区分）。
 *
 * 之所以要双层：这次线上故障就是「上传弹窗打开了，文件却永远传不上去」——
 * 根源正是附件选择器 frame 读 `session` 抛错后被 catch 吞掉，静默返回 null。
 */

/** 回退到 local 时使用的前缀，避免与持久化配置混淆。 */
const SESSION_FALLBACK_PREFIX = 'cxai:sess:';

/** session 是否已确认不可用（避免每次都抛一遍错）。 */
let sessionUsable = true;

/** 从会话级存储读一批键。失败时回退到 local。 */
async function sessionGet<T = unknown>(keys: string | string[] | null): Promise<Record<string, T>> {
  if (sessionUsable) {
    try {
      const result = await chrome.storage.session.get(keys as string);
      return result as Record<string, T>;
    } catch (err) {
      sessionUsable = false;
      log.warn(`storage.session 不可用，改用 local 兜底：${(err as Error)?.message ?? String(err)}`);
    }
  }
  const list = keys === null ? null : Array.isArray(keys) ? keys : [keys];
  const local = await chrome.storage.local.get(null);
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(local)) {
    if (!key.startsWith(SESSION_FALLBACK_PREFIX)) continue;
    const bare = key.slice(SESSION_FALLBACK_PREFIX.length);
    if (list === null || list.includes(bare)) out[bare] = value as T;
  }
  return out;
}

/** 写会话级存储。失败时回退到 local。 */
async function sessionSet(items: Record<string, unknown>): Promise<void> {
  if (sessionUsable) {
    try {
      await chrome.storage.session.set(items);
      return;
    } catch (err) {
      sessionUsable = false;
      log.warn(`storage.session 写入失败，改用 local 兜底：${(err as Error)?.message ?? String(err)}`);
    }
  }
  const prefixed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(items)) prefixed[SESSION_FALLBACK_PREFIX + key] = value;
  await chrome.storage.local.set(prefixed);
}

/** 删除会话级存储中的键。失败时回退到 local。 */
async function sessionRemove(key: string): Promise<void> {
  if (sessionUsable) {
    try {
      await chrome.storage.session.remove(key);
      return;
    } catch {
      sessionUsable = false;
    }
  }
  await chrome.storage.local.remove(SESSION_FALLBACK_PREFIX + key);
}

/* ------------------------------------------------------------------ */
/* 任务流：节点记录                                                    */
/* ------------------------------------------------------------------ */

/**
 * 读取某课程的节点执行记录。
 *
 * 用途：后续节点（尤其是「上传作品」）需要引用前序节点的成果 ——
 * 例如第一个节点是对话、第二个节点要写作品，作品内容就得衔接前面的结论。
 * 页面本身只保留完成条件摘要，因此这里由扩展自己记录。
 *
 * @param courseId 课程 ID。
 */
export async function getFlowRecords(courseId: string): Promise<Record<string, NodeRecord>> {
  const result = await sessionGet<Record<string, Record<string, NodeRecord>>>(STORAGE_KEYS.flowRecords);
  const all = result[STORAGE_KEYS.flowRecords] ?? {};
  return all[courseId] ?? {};
}

/**
 * 写入单个节点的执行记录。
 *
 * @param courseId 课程 ID。
 * @param record 节点记录。
 */
export async function saveFlowRecord(courseId: string, record: NodeRecord): Promise<void> {
  const result = await sessionGet<Record<string, Record<string, NodeRecord>>>(STORAGE_KEYS.flowRecords);
  const all = result[STORAGE_KEYS.flowRecords] ?? {};
  all[courseId] = { ...(all[courseId] ?? {}), [String(record.domIndex)]: record };
  await sessionSet({ [STORAGE_KEYS.flowRecords]: all });
}

/** 清空某课程的节点记录。 */
export async function clearFlowRecords(courseId: string): Promise<void> {
  const result = await sessionGet<Record<string, Record<string, NodeRecord>>>(STORAGE_KEYS.flowRecords);
  const all = result[STORAGE_KEYS.flowRecords] ?? {};
  delete all[courseId];
  await sessionSet({ [STORAGE_KEYS.flowRecords]: all });
}

/* ------------------------------------------------------------------ */
/* 任务流：待上传的 Word 文档                                          */
/* ------------------------------------------------------------------ */

/**
 * 暂存待上传的 .docx（供文件选择器 frame 读取）。
 *
 * 为什么走 storage 而不是直接跨 frame 传值：文件选择器是**另一个 frame**，
 * 且由页面自己创建；两边唯一天然共享的通道就是扩展的 storage。
 *
 * @param pending 待上传文档。
 */
export async function setPendingDocx(pending: PendingDocx): Promise<void> {
  await sessionSet({ [`${STORAGE_KEYS.pendingDocx}:${pending.courseId}`]: pending });
}

/**
 * 读取某课程的待上传文档；超过有效期视为不存在。
 *
 * @param courseId 课程 ID。
 */
export async function getPendingDocx(courseId: string): Promise<PendingDocx | null> {
  const key = `${STORAGE_KEYS.pendingDocx}:${courseId}`;
  const result = await sessionGet<PendingDocx>(key);
  const value = result[key];
  if (!value?.base64) return null;
  if (Date.now() - value.createdAt > PENDING_DOCX_TTL_MS) return null;
  return value;
}

/** 清理待上传文档（上传完成后调用）。 */
export async function clearPendingDocx(courseId: string): Promise<void> {
  await sessionRemove(`${STORAGE_KEYS.pendingDocx}:${courseId}`);
}
