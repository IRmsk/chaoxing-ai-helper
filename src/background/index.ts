import { DEFAULT_CONFIG, PORT_WORKER } from '@/common/constants';
import { setPendingDocx } from '@/common/storage';
import { buildDocx, buildDocumentPrompt, parseDocumentSpec } from './docx';
import { CxaiError, toCxaiError } from '@/common/errors';
import { clearLogBuffer, createLogger, formatLogs, getLogBuffer } from '@/common/logger';
import {
  MSG,
  PORT_MSG,
  failReply,
  okReply,
  type ApiProbePayload,
  type Command,
  type DetectInfo,
  type DialogueStateReply,
  type GenerateDocxPayload,
  type GenerateDocxResult,
  type LogsPayload,
  type RegisterPayload,
  type Reply,
  type TestConnectionResult,
} from '@/common/messages';
import { getConfig, resetCounter, subscribeChanges } from '@/common/storage';
import type { PanelStatus } from '@/types';
import { buildMessages, historyLength, pushTurn, resetHistory } from './context';
import { chatCompletion, normalizeBaseUrl, testConnection, listModels } from './llm-client';

/**
 * Background Service Worker：三层通信中枢。
 *
 * 职责：
 * 1. 维护每个标签页的 worker frame（对话窗口所在 frame）与面板 frame 的 Port；
 * 2. 把 Popup / 悬浮面板的控制指令精确转发到 worker frame；
 * 3. 代替 content script 发起跨域大模型请求（content script 受 CORS 限制，
 *    background 有 host_permissions 才能直连 API）；
 * 4. 维护对话上下文，保证多轮问答连贯；
 * 5. 汇总日志与运行状态，供 UI 展示与导出。
 */

const log = createLogger('background');

/* ------------------------------------------------------------------ */
/* 运行时状态表                                                        */
/* ------------------------------------------------------------------ */

interface PortMeta {
  port: chrome.runtime.Port;
  tabId: number;
  frameId: number;
}

interface TabEntry {
  worker?: PortMeta;
  panel?: PortMeta;
  /**
   * 任务流宿主 frame（`…/taskChain/student/answer`）。
   *
   * 它的存在会改变指令路由：页面处于「任务流模式」时，面板的「开始」应该交给
   * 任务流编排器（它负责逐节点推进），而不是直接丢给对话状态机。
   */
  flow?: PortMeta;
  /**
   * 面板展示用的「当前状态」。
   *
   * ⚠️ 它是全局一份，会被**同一个标签页里的多个 frame 交替覆盖**，
   * 所以**不能**拿它来判断「某个具体 frame 现在是什么状态」。
   */
  status: PanelStatus;
  /** 对话 frame（worker）上报的状态，独立一份。 */
  workerStatus?: PanelStatus;
  /** 任务流宿主（flow）上报的状态，独立一份。 */
  flowStatus?: PanelStatus;
  courseId: string;
  detect?: DetectInfo;
  contextLength: number;
}

const tabs = new Map<number, TabEntry>();

/** 每个课程最近一次请求时间戳，用于兜底限速（避免触发风控）。 */
const lastRequestAt = new Map<string, number>();

function defaultStatus(): PanelStatus {
  return {
    state: 'IDLE',
    tone: 'idle',
    round: 0,
    maxRounds: DEFAULT_CONFIG.maxRounds,
    courseId: '',
    message: '等待探测对话窗口',
    detected: false,
    confidence: 0,
    updatedAt: Date.now(),
  };
}

function getEntry(tabId: number): TabEntry {
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = { status: defaultStatus(), courseId: '', contextLength: 0 };
    tabs.set(tabId, entry);
  }
  return entry;
}

/** 把状态快照推送给该标签页的面板（若已上线）。 */
function pushStatus(tabId: number): void {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const payload = {
    t: PORT_MSG.STATUS_PUSH,
    status: entry.status,
    hasWorker: Boolean(entry.worker),
    detect: entry.detect ?? null,
    contextLength: entry.contextLength,
  };
  try {
    entry.panel?.port.postMessage(payload);
  } catch (err) {
    log.warn('推送状态到面板失败', err);
  }
}

/** 更新状态快照并广播。 */
function patchStatus(tabId: number, patch: Partial<PanelStatus>): void {
  const entry = getEntry(tabId);
  entry.status = { ...entry.status, ...patch, updatedAt: Date.now() };
  pushStatus(tabId);
}

/* ------------------------------------------------------------------ */
/* 权限与限速                                                          */
/* ------------------------------------------------------------------ */

/**
 * 校验扩展是否已获得目标 Base URL 的访问权限。
 *
 * 用户使用第三方 / 自建端点时，`host_permissions` 里只有 DeepSeek 官方，
 * 必须通过 `optional_host_permissions` 动态授权 —— 授权动作在 Popup 中完成
 * （浏览器要求权限申请必须来自用户手势）。
 *
 * @param baseUrl 用户配置的根地址。
 * @throws CxaiError('PERMISSION_DENIED') 未授权时抛出。
 */
async function ensureHostPermission(baseUrl: string): Promise<void> {
  let origin: string;
  try {
    origin = new URL(normalizeBaseUrl(baseUrl)).origin + '/*';
  } catch {
    throw new CxaiError('API_CONFIG_MISSING', `Base URL 不是合法地址：${baseUrl}`, false);
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    throw new CxaiError(
      'PERMISSION_DENIED',
      `扩展尚未获得 ${origin} 的访问权限。请打开扩展弹窗重新点击「保存配置」以授权该域名。`,
      false,
    );
  }
}

/**
 * 兜底限速：同一课程两次请求之间至少间隔 `intervalSec` 秒。
 *
 * @param courseId 课程 ID。
 * @param intervalSec 间隔秒数。
 * @param signal 中止信号。
 */
async function ensureMinInterval(courseId: string, intervalSec: number, signal?: AbortSignal): Promise<void> {
  if (intervalSec <= 0) return;
  const last = lastRequestAt.get(courseId) ?? 0;
  const wait = last + intervalSec * 1000 - Date.now();
  if (wait > 0) {
    log.debug(`限速等待 ${Math.ceil(wait / 1000)}s`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  lastRequestAt.set(courseId, Date.now());
}

/* ------------------------------------------------------------------ */
/* 指令转发                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把控制指令转发给指定标签页的 worker frame。
 *
 * @param tabId 标签页 ID。
 * @param cmd 指令。
 * @throws CxaiError 未探测到对话窗口时抛出。
 */
function forwardCommand(tabId: number, cmd: Command, target: 'worker' | 'flow' = 'worker'): void {
  const entry = tabs.get(tabId);
  const meta = target === 'flow' ? entry?.flow : entry?.worker;
  if (!meta) {
    throw new CxaiError(
      'NOT_DETECTED',
      target === 'flow'
        ? '页面未探测到 AI 实践任务流。请确认页面已打开任务，并刷新页面后重试。'
        : '页面未探测到 AI 实践对话窗口。请确认页面已打开对话，并刷新页面后重试。',
      false,
    );
  }
  meta.port.postMessage({ t: PORT_MSG.COMMAND, cmd });
  log.info(`指令已转发 → ${cmd}（tab=${tabId} frame=${meta.frameId} target=${target}）`);
}

/**
 * 面板指令的路由策略。
 *
 * 任务流页面由「编排器」统管整条节点链路，所以指令优先给 flow frame；
 * 普通对话页（没有任务流）才直接给对话 frame。
 *
 * @param tabId 标签页 ID。
 * @param cmd 指令。
 */
function routePanelCommand(tabId: number, cmd: Command): void {
  const entry = tabs.get(tabId);
  forwardCommand(tabId, cmd, entry?.flow ? 'flow' : 'worker');
}

/* ------------------------------------------------------------------ */
/* Port 连接处理                                                       */
/* ------------------------------------------------------------------ */

/**
 * 把内容脚本补注入到「已经打开」的学习通标签页。
 *
 * 扩展刚加载 / 更新时，浏览器不会往已存在的标签页注入内容脚本，
 * 用户必须手动刷新页面（F5）才会生效 —— 这既反直觉又容易让人以为「坏了」。
 * 这里主动补一次，配合内容脚本里的重复注入护栏，做到「打开页面即可自动开始」。
 */
async function injectIntoOpenTabs(): Promise<void> {
  const entries = (chrome.runtime.getManifest().content_scripts ?? []).filter(
    (entry) => (entry.js?.length ?? 0) > 0,
  );
  if (entries.length === 0) return;

  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: ['*://*.chaoxing.com/*'] });
  } catch (err) {
    log.warn('查询已打开的学习通标签页失败', err);
    return;
  }
  if (tabs.length === 0) return;

  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    for (const entry of entries) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: entry.js as string[],
        });
        if (entry.css?.length) {
          await chrome.scripting
            .insertCSS({ target: { tabId: tab.id, allFrames: true }, files: entry.css })
            .catch(() => undefined);
        }
        log.info(`已补注入内容脚本 → tab=${tab.id}`);
      } catch (err) {
        log.warn(`补注入失败（tab=${tab.id}，可能页面未加载完）`, err);
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenTabs();
});
/**
 * 允许**内容脚本**访问 `chrome.storage.session`。
 *
 * ⚠️ 默认 `accessLevel` 是 `TRUSTED_CONTEXTS`，内容脚本读写会直接抛
 * `Access to storage is not allowed from this context` —— 而且是**静默失效**：
 * 附件选择器 frame 读不到「待上传的 Word 文档」，任务流 frame 读不到节点记录，
 * 表现就是「上传弹窗打开了，但文件永远传不上去」。
 *
 * 这段必须在 Service Worker 每次启动时都跑（SW 会被回收后重启），
 * 因此放在模块顶层而不是 onInstalled 里。
 */
void (async () => {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
    log.info('storage.session 已开放给内容脚本');
  } catch (err) {
    log.warn(`开放 storage.session 失败：${(err as Error)?.message ?? String(err)}`);
  }
})();

chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenTabs();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_WORKER) return;
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId ?? 0;
  if (typeof tabId !== 'number') return;

  log.debug(`content 端口已连接（tab=${tabId} frame=${frameId}）`);

  // 把 tabId 告诉内容脚本：它自己 query 出来的 tabId 在「同时开着多个学习通标签页」
  // 时可能指向别的标签页，导致指令被路由到错误的标签页。
  try {
    port.postMessage({ t: PORT_MSG.WELCOME, tabId });
  } catch {
    /* 端口可能立刻断开，忽略 */
  }

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as { t?: string; [k: string]: unknown };
    if (!msg?.t) return;
    const entry = getEntry(tabId);

    switch (msg.t) {
      /* ---------------- 注册为 worker ---------------- */
      case PORT_MSG.REGISTER: {
        const payload = msg.payload as RegisterPayload;
        entry.worker = { port, tabId, frameId };
        entry.courseId = payload.courseId;
        entry.status = {
          ...entry.status,
          courseId: payload.courseId,
          detected: true,
          confidence: payload.confidence,
          message: '已探测到 AI 实践对话窗口，等待开始',
        };
        entry.workerStatus = entry.status;
        log.info(`worker 注册成功（tab=${tabId} frame=${frameId} course=${payload.courseId}）`);
        pushStatus(tabId);
        break;
      }

      /* ---------------- 注册为任务流宿主 ---------------- */
      case PORT_MSG.FLOW_REGISTER: {
        const payload = msg.payload as RegisterPayload;
        entry.flow = { port, tabId, frameId };
        entry.courseId = payload.courseId;
        entry.status = {
          ...entry.status,
          courseId: payload.courseId,
          detected: true,
          confidence: payload.confidence,
          message: '已识别到 AI 实践任务流，等待开始',
        };
        entry.flowStatus = entry.status;
        log.info(`flow 注册成功（tab=${tabId} frame=${frameId} course=${payload.courseId}）`);
        pushStatus(tabId);
        break;
      }

      /* ---------------- 面板上线 ---------------- */
      case PORT_MSG.PANEL_HELLO: {
        entry.panel = { port, tabId, frameId };
        log.debug(`面板已上线（tab=${tabId} frame=${frameId}）`);
        pushStatus(tabId);
        break;
      }

      case PORT_MSG.PANEL_SYNC: {
        pushStatus(tabId);
        break;
      }

      /* ---------------- 面板下发指令 ---------------- */
      case PORT_MSG.PANEL_COMMAND: {
        const cmd = msg.cmd as Command;
        try {
          routePanelCommand(tabId, cmd);
        } catch (err) {
          const cx = toCxaiError(err);
          patchStatus(tabId, { state: 'ERROR', tone: 'error', message: cx.message, error: cx.message });
        }
        break;
      }

      /* ---------------- 状态上报 ---------------- */
      case PORT_MSG.STATUS: {
        const status = msg.status as PanelStatus;
        const next: PanelStatus = { ...status, updatedAt: Date.now() };
        entry.status = next;
        // 按「谁上报的」分别记到独立槽位 —— 同一个标签页里 flow 与 worker
        // 会各自上报，混在一个槽位里会让「查询对话状态」读到另一个 frame 的状态。
        if (entry.worker?.port === port) entry.workerStatus = next;
        if (entry.flow?.port === port) entry.flowStatus = next;
        if (status.courseId) entry.courseId = status.courseId;
        pushStatus(tabId);
        break;
      }

      /* ---------------- 探测诊断信息 ---------------- */
      case PORT_MSG.DETECT_INFO: {
        entry.detect = msg.payload as DetectInfo;
        pushStatus(tabId);
        break;
      }

      /* ---------------- 大模型调用（核心） ---------------- */
      case PORT_MSG.ASK: {
        const { requestId, courseId, question, pageContext } = msg.payload as {
          requestId: string;
          courseId: string;
          question: string;
          pageContext?: string;
        };
        void handleAsk(tabId, port, requestId, courseId, question, pageContext ?? '');
        break;
      }

      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    const entry = tabs.get(tabId);
    if (!entry) return;
    if (entry.flow?.port === port) {
      entry.flow = undefined;
      log.info(`flow 断开（tab=${tabId}）`);
    }
    if (entry.worker?.port === port) {
      entry.worker = undefined;
      // ⚠️ 这里**只**清 worker。以前误把 entry.flow 也清掉了，后果是：
      // 对话 iframe 一跳转（pcStudentIndex → pcDialogue 会重建文档），
      // 旧 worker 端口断开时把**任务流宿主**的注册也一并删掉，
      // 于是编排器再也发不出指令、面板指令也被路由错对象。
      entry.status = {
        ...entry.status,
        detected: false,
        message: '对话窗口已断开（页面可能已刷新）',
      };
      log.info(`worker 断开（tab=${tabId}）`);
    }
    if (entry.panel?.port === port) entry.panel = undefined;
    pushStatus(tabId);
  });
});

/**
 * 处理一次大模型问答请求。
 *
 * @param tabId 标签页 ID（用于状态回写）。
 * @param port worker 的 Port（用于回传结果）。
 * @param requestId 请求关联 ID。
 * @param courseId 课程 ID。
 * @param question 本轮提问文本。
 */
async function handleAsk(
  tabId: number,
  port: chrome.runtime.Port,
  requestId: string,
  courseId: string,
  question: string,
  pageContext: string,
): Promise<void> {
  const respond = (payload: Record<string, unknown>) => {
    try {
      port.postMessage({ t: PORT_MSG.ASK_RESULT, requestId, ...payload });
    } catch (err) {
      log.warn('回传 ASK 结果失败（面板可能已关闭）', err);
    }
  };

  try {
    const config = await getConfig();
    if (!config.apiKey.trim()) {
      throw new CxaiError('API_CONFIG_MISSING', '未配置 API Key，请打开扩展弹窗填写', false);
    }

    await ensureHostPermission(config.baseUrl);
    await ensureMinInterval(courseId, config.intervalSec);

    const messages = await buildMessages(courseId, config.systemPrompt, question, pageContext);
    log.info(
      `调用大模型（model=${config.model} 上下文=${messages.length} 条 背景资料=${pageContext.length} 字）`,
    );

    const answer = await chatCompletion({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      messages,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutSec * 1000,
    });

    await pushTurn(courseId, question, answer);
    const entry = tabs.get(tabId);
    if (entry) entry.contextLength = await historyLength(courseId);

    log.info(`大模型返回 ${answer.length} 字`);
    respond({ ok: true, content: answer });
  } catch (err) {
    const cx = toCxaiError(err);
    log.error(`大模型调用失败（${cx.code}）：${cx.message}`);
    respond({ ok: false, error: cx.message, code: cx.code, retryable: cx.retryable });
  }
}

/* ------------------------------------------------------------------ */
/* 一次性消息处理                                                      */
/* ------------------------------------------------------------------ */

/**
 * 生成「上传作品」节点要用的 .docx。
 *
 * 放在 background 做的两个原因：
 * 1. `docx` 体积不小，而内容脚本会注入到页面每个 frame，摊在每个 frame 是浪费；
 * 2. 生成需要调大模型，background 已经持有 API Key 与会话逻辑。
 *
 * 生成后直接暂存到 `chrome.storage.session`，文件选择器 frame 会自行读取 ——
 * 这样不必把几十 KB 的 base64 在消息通道里来回搬。
 *
 * @param tabId 发起请求的标签页。
 * @param payload 任务信息。
 */
async function handleGenerateDocx(
  tabId: number,
  payload: GenerateDocxPayload,
): Promise<GenerateDocxResult> {
  const config = await getConfig();
  if (!config.apiKey.trim()) {
    throw new CxaiError('API_CONFIG_MISSING', '未配置 API Key，请打开扩展弹窗填写', false);
  }
  await ensureHostPermission(config.baseUrl);
  await ensureMinInterval(payload.courseId, config.intervalSec);

  const prompt = buildDocumentPrompt({
    taskTitle: payload.taskTitle,
    requirement: payload.requirement,
    pageContext: payload.pageContext,
    previousSummary: payload.previousSummary,
  });

  log.info(`生成作品文档：${payload.taskTitle}`);
  const raw = await chatCompletion({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          '你是学习通 AI 实践课的助教，负责把学生的任务成果整理成结构化的 Word 作品文档。只输出要求的 JSON，不要任何多余说明。',
      },
      { role: 'user', content: prompt },
    ],
    temperature: config.temperature,
    timeoutMs: config.requestTimeoutSec * 1000,
  });

  const spec = parseDocumentSpec(raw, payload.taskTitle || '实践作品');
  const docx = await buildDocx(spec, spec.title || payload.taskTitle);
  await setPendingDocx({
    courseId: payload.courseId,
    fileName: docx.fileName,
    base64: docx.base64,
    createdAt: Date.now(),
    outline: docx.outline,
  });

  const sizeText = `${Math.max(1, Math.round((docx.base64.length * 0.75) / 1024))} KB`;
  log.info(`作品文档已生成：${docx.fileName}（${sizeText}，${docx.outline.length} 个小节）`);
  const entry = tabs.get(tabId);
  if (entry) entry.contextLength = await historyLength(payload.courseId);
  return { fileName: docx.fileName, outline: docx.outline, sizeText };
}

chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender, sendResponse: (r: Reply<unknown>) => void): boolean | undefined => {
    const msg = raw as { type?: string; [k: string]: unknown };
    if (!msg?.type || !String(msg.type).startsWith('cxai:')) return undefined;

    void (async () => {
      try {
        switch (msg.type) {
          case MSG.PING:
            sendResponse(okReply({ pong: true, at: Date.now() }));
            return;

          case MSG.GET_STATUS: {
            const tabId = msg.tabId as number;
            const entry = tabs.get(tabId);
            sendResponse(
              okReply({
                status: entry?.status ?? null,
                hasWorker: Boolean(entry?.worker),
                detect: entry?.detect ?? null,
                contextLength: entry?.contextLength ?? 0,
              }),
            );
            return;
          }

          /* -------- 任务流：生成 Word 文档 -------- */
          case MSG.GENERATE_DOCX: {
            const result = await handleGenerateDocx(
              msg.tabId as number,
              msg as unknown as GenerateDocxPayload,
            );
            sendResponse(okReply(result));
            return;
          }

          /* -------- 任务流：查询对话 frame 状态 -------- */
          case MSG.GET_DIALOGUE_STATE: {
            const tabId = msg.tabId as number;
            const entry = tabs.get(tabId);
            // 必须读**对话 frame 自己的**状态槽位，不能用共享的 entry.status：
            // 任务流宿主也会上报状态，混在一起时编排器会把「自己的状态」
            // 误当成对话状态（例如把宿主的状态当成 IDLE → 反复重发 START）。
            const workerStatus = entry?.workerStatus;
            const replyData: DialogueStateReply = {
              present: Boolean(entry?.worker),
              state: workerStatus?.state ?? 'IDLE',
              round: workerStatus?.round ?? 0,
              message: workerStatus?.message ?? '',
            };
            sendResponse(okReply(replyData));
            return;
          }

          /* -------- 任务流：把指令转发给对话 frame -------- */
          case MSG.COMMAND_DIALOGUE: {
            const tabId = msg.tabId as number;
            const cmd = msg.cmd as Command;
            try {
              forwardCommand(tabId, cmd, 'worker');
              sendResponse(okReply({ forwarded: true }));
            } catch (err) {
              sendResponse(failReply(toCxaiError(err).message));
            }
            return;
          }

          case MSG.FORWARD_COMMAND: {
            forwardCommand(msg.tabId as number, msg.cmd as Command);
            sendResponse(okReply(true));
            return;
          }

          case MSG.TEST_CONNECTION: {
            const payload = msg.payload as ApiProbePayload;
            await ensureHostPermission(payload.baseUrl);
            const result: TestConnectionResult = await testConnection(payload);
            sendResponse(okReply(result));
            return;
          }

          case MSG.FETCH_MODELS: {
            const payload = msg.payload as ApiProbePayload;
            await ensureHostPermission(payload.baseUrl);
            const models = await listModels({ apiKey: payload.apiKey, baseUrl: payload.baseUrl });
            sendResponse(okReply(models));
            return;
          }

          case MSG.RESET_COUNTER: {
            const courseId = msg.courseId as string | undefined;
            // fromWorker=true 表示本次清空由 content script 自己发起，
            // 此时不能再把 RESET 指令转发回 worker，否则会形成回环。
            const fromWorker = Boolean(msg.fromWorker);
            await resetCounter(courseId || undefined);
            if (courseId) await resetHistory(courseId);

            for (const [tabId, entry] of tabs) {
              if (courseId && entry.courseId !== courseId) continue;
              patchStatus(tabId, { round: 0, message: '轮次计数已清空' });
              if (!fromWorker) {
                try {
                  forwardCommand(tabId, 'RESET');
                } catch {
                  /* 该标签页没有 worker，忽略 */
                }
              }
            }
            sendResponse(okReply(true));
            return;
          }

          case MSG.GET_LOGS: {
            const payload: LogsPayload = { entries: getLogBuffer(), text: formatLogs() };
            sendResponse(okReply(payload));
            return;
          }

          case MSG.CLEAR_LOGS: {
            clearLogBuffer();
            sendResponse(okReply(true));
            return;
          }

          default:
            sendResponse(failReply(`未知消息类型：${msg.type}`));
        }
      } catch (err) {
        const cx = toCxaiError(err);
        sendResponse(failReply(cx.message, cx.code));
      }
    })();

    // 异步响应，保持通道打开
    return true;
  },
);

/* ------------------------------------------------------------------ */
/* 生命周期清理                                                        */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const entry = tabs.get(tabId);
  if (!entry) return;
  // 页面开始导航：旧 worker 一定失效，先清掉避免把指令发到已卸载的 frame
  entry.worker = undefined;
  entry.detect = undefined;
  entry.status = { ...defaultStatus(), courseId: entry.courseId, message: '页面加载中…' };
  pushStatus(tabId);
});

// 配置变更时，通知所有 worker 热更新（无需刷新页面）
subscribeChanges(() => {
  log.debug('配置已变更，广播给全部 worker');
  for (const entry of tabs.values()) {
    try {
      entry.worker?.port.postMessage({ t: PORT_MSG.CONFIG_CHANGED });
    } catch {
      /* 忽略：端口可能已断开 */
    }
  }
});

log.info('Service Worker 已启动');
