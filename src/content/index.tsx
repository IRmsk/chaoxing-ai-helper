import { createRoot, type Root } from 'react-dom/client';
import { DETECT_POLL_INTERVAL_MS, DEFAULT_CONFIG, PICKER_WAIT_TIMEOUT_MS } from '@/common/constants';
import { createLogger } from '@/common/logger';
import { MSG, sendToBackground, type Command, type DetectInfo } from '@/common/messages';
import {
  clearFlowRecords,
  clearOverrides,
  clearPendingDocx,
  getConfig,
  getCounter,
  getDebugMode,
  getFlowRecords,
  getOverrides,
  getPendingDocx,
  saveFlowRecord,
  setPendingDocx,
  setCounter,
  setOverrides,
  subscribeChanges,
} from '@/common/storage';
import { resolveCourseKey, safeUrl } from '@/common/url-utils';
import {
  classifyPageRole,
  watchRouteChanges,
  type PageRole,
  type RolePatterns,
} from '@/common/route-watch';
import { buildCssPath, setActiveOverrides } from '@/common/dom-utils';
import type { ChatTargets, Config, NodeRecord, PanelStatus, SelectorOverrides } from '@/types';
import { BackgroundBridge } from './bridge';
import { detectChat } from './detector';
import { describeMessages, getMessages } from './observer';
import { isInputLocked } from './injector';
import { openPicker } from './picker';
import { DIALOGUE_URL_RE, FILE_PICKER_URL_RE, FLOW_ACTIONS, FLOW_URL_RE } from './flow-selectors';
import {
  clickAndSettle,
  clickButton,
  findButtonByText,
  flowNeedsWork,
  hasNextNodeEntry,
  readActiveTitle,
  readChainFinalScore,
  readFlowState,
  readUploadRequirement,
} from './flow-dom';
import { FlowRunner } from './flow-runner';
import {
  isPickerFrame,
  isPickerOverlayVisible,
  runPickerUpload,
  ensureFileInput,
} from './file-picker-frame';
import { AutomationRunner } from './state-machine';
import { Panel, panelStyles } from './panel/Panel';

/**
 * Content Script 入口。
 *
 * 由于 `all_frames: true`，本脚本会注入到页面的每一个 frame。为避免多个 frame
 * 同时驱动状态机造成混乱，这里做「角色划分」：
 *
 * | 角色     | 判定                                   | 职责                       |
 * |----------|----------------------------------------|----------------------------|
 * | worker   | 该 frame 内探测到 AI 实践对话窗口       | 驱动状态机、操作 DOM       |
 * | panel    | `window.top === window.self`（顶层）    | 渲染悬浮面板、转发指令     |
 *
 * 顶层 frame 也可能同时是 worker（对话就在主文档里），此时两个角色合一。
 */

const log = createLogger('content');

/** 是否顶层 frame。跨域时访问 window.top 会抛错，需 try/catch。 */
const IS_TOP_FRAME = (() => {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
})();

/** 本 frame 的职责角色。 */
type FrameRole = PageRole;

/**
 * 角色判定用的 URL 特征。
 *
 * 页面结构决定了三种角色可能同时存在：
 *
 * | 角色      | 判定                                   | 职责                         |
 * |-----------|----------------------------------------|------------------------------|
 * | `picker`  | URL 是 `/attCommon/s`（附件选择器）     | 自动上传生成的 Word 作品     |
 * | `flow`    | URL 是 `taskChain/student/answer`       | 编排整条任务流（逐节点推进）  |
 * | `chat`    | 其余（含 pcDialogue / 普通页面）        | 对话填充 + 悬浮面板           |
 *
 * 三者互斥，先判 `picker`（它是被宿主页面动态创建的 iframe，位置最深）。
 */
const ROLE_PATTERNS: RolePatterns = { picker: FILE_PICKER_URL_RE, flow: FLOW_URL_RE };

/**
 * 🚨 本 frame 的角色必须是**可变的**，不能是加载时的常量。
 *
 * 这是「页面不刷新就不工作、刷新之后才正常」的**唯一根因**：
 * 内容脚本只在文档加载时注入一次，而站点大量使用**同文档路由**（SPA）——
 * 从课程页 / 任务列表跳到 `taskChain/student/answer` 时脚本**不会重新注入**。
 * 以前角色是 `const`，于是：
 *
 * - 进来时 URL 还不是任务流 → 角色永远是 `chat` → **编排器从不启动**，
 *   → 面板按钮点了没反应（background 找不到 flow frame，还会提示「请刷新页面后重试」）；
 * - 只有手动 F5（脚本在正确的 URL 上重新注入）才会变成 `flow`。
 *
 * 现在改成「变量 + 路由轮询」，任何时刻 URL 一变就重新判定并补齐对应角色的初始化。
 * 判定与监听逻辑抽到 `@/common/route-watch`，便于回归覆盖。
 */
let role: FrameRole = classifyPageRole(location.href, ROLE_PATTERNS, isPickerFrame());

/** 各角色的一次性初始化标记（幂等，可被路由变化反复调用）。 */
const roleReady = { picker: false, flow: false, chat: false, panel: false };

/* ------------------------------------------------------------------ */
/* 运行时状态                                                          */
/* ------------------------------------------------------------------ */

let config: Config = { ...DEFAULT_CONFIG };
let overrides: SelectorOverrides = {};
let debugMode = false;

let targets: ChatTargets | null = null;
/** 是否已把本 frame 注册为 worker。 */
let amWorker = false;
let autoStarted = false;

const bridge = new BackgroundBridge();
const courseKey = resolveCourseKey(location.href);

let status: PanelStatus = {
  state: 'IDLE',
  tone: 'idle',
  round: 0,
  maxRounds: DEFAULT_CONFIG.maxRounds,
  courseId: courseKey,
  message: '正在探测对话窗口…',
  detected: false,
  confidence: 0,
  updatedAt: Date.now(),
};

const runner = new AutomationRunner({
  getConfig: () => config,
  getTargets: () => (targets && targets.input.isConnected ? targets : null),
  ask: (question, pageContext, signal) =>
    bridge.ask(question, pageContext, courseKey, config.requestTimeoutSec * 1000 + 15_000, signal),
  onStatus: (patch) => patchStatus(patch),
  onRound: (round) => {
    void setCounter(courseKey, round);
  },
});

/**
 * 任务流编排器（仅 `flow` 角色使用）。
 *
 * 它负责把整条节点链路跑完：对话节点交给子 iframe 的状态机，
 * 上传节点则自己生成 Word 作品并驱动附件选择器上传。
 */
const flowRunner = new FlowRunner({
  getConfig: () => ({
    maxRounds: config.maxRounds,
    intervalSec: config.intervalSec,
    questionTimeoutSec: config.questionTimeoutSec,
  }),
  ask: (question, pageContext, signal) =>
    bridge.ask(question, pageContext, courseKey, config.requestTimeoutSec * 1000 + 15_000, signal),
  generateDocx: async (options) => {
    const reply = await sendToBackground<{ ok: boolean; data?: { fileName: string; outline: string[] }; error?: string }>({
      type: MSG.GENERATE_DOCX,
      tabId: await currentTabId(),
      courseId: courseKey,
      ...options,
    });
    if (!reply?.ok || !reply.data) throw new Error(reply?.error ?? '生成作品文档失败');
    return reply.data;
  },
  /**
   * 暂存「由内容脚本本地生成」的作品（控制台截图）。
   *
   * 图片类上传节点必须用 canvas 画，而 canvas 只在有 DOM 的上下文可用 ——
   * background 的 Service Worker 没有 DOM，所以这一步只能在内容脚本里做。
   * 生成结果写进同一个待上传槽位，附件选择器 frame 照常读取。
   */
  storeArtifact: async (artifact) => {
    await setPendingDocx({
      courseId: courseKey,
      fileName: artifact.fileName,
      base64: artifact.base64,
      mime: artifact.mime,
      createdAt: Date.now(),
      outline: artifact.outline,
    });
  },
  dialogueState: async () => {
    const reply = await sendToBackground<{
      ok: boolean;
      data?: { present: boolean; state: string; round: number; message: string };
    }>({ type: MSG.GET_DIALOGUE_STATE, tabId: await currentTabId() });
    return reply?.data ?? { state: 'IDLE', round: 0, message: '', present: false };
  },
  commandDialogue: async (cmd) => {
    const reply = await sendToBackground<{ ok: boolean; error?: string }>({
      type: MSG.COMMAND_DIALOGUE,
      tabId: await currentTabId(),
      cmd,
    });
    // 不要把失败咽掉：之前「找不到对话 frame」时错误被忽略，
    // 表现成「对话节点进去了但永远不开始」，极难定位。
    // 但 STOP 是收尾时的尽力而为（全部节点做完后本来就没有对话 frame），
    // 这种情况不该刷 warning 吓人。
    if (!reply?.ok) {
      const text = `向对话 frame 下发 ${cmd} 失败：${reply?.error ?? '未知原因'}`;
      if (cmd === 'STOP') log.debug(text);
      else log.warn(text);
    }
  },
  getRecord: async (domIndex) => (await getFlowRecords(courseKey))[String(domIndex)],
  saveRecord: (record: NodeRecord) => saveFlowRecord(courseKey, record),
  onStatus: (patch) => patchStatus(patch),
});

/**
 * 取当前标签页 ID（任务流编排器需要它来查询/转发对话 frame 指令）。
 *
 * ⚠️ 优先用 background 通过端口回执的 tabId。
 * 以前这里靠 `chrome.tabs.query` 猜：同时开着「个人空间 / 课程页 / AI 实践」等多个
 * chaoxing 标签页时，`{ url: ['*://*.chaoxing.com/*'] }[0]` 很可能返回**别的**标签页
 * （顺序不保证），于是指令被路由到错误的标签页 —— 症状是
 * 「任务流里对话节点明明进去了，编排器却一直说找不到对话 frame」。
 */
let cachedTabId: number | null = null;
async function currentTabId(): Promise<number> {
  // 1) 端口回执（最可靠）
  const fromBridge = bridge.getTabId();
  if (typeof fromBridge === 'number' && fromBridge > 0) return fromBridge;
  if (cachedTabId !== null && cachedTabId > 0) return cachedTabId;

  // 2) 兜底：优先当前激活标签页，其次是「当前窗口里 URL 含 taskChain/attCommon 的那个」
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id) {
      cachedTabId = active.id;
      return cachedTabId;
    }
    const all = await chrome.tabs.query({ url: ['*://*.chaoxing.com/*'] });
    const best = all.find((t) => /taskChain|taskDialogue|attCommon/.test(t.url ?? '')) ?? all[0];
    cachedTabId = best?.id ?? -1;
  } catch {
    cachedTabId = -1;
  }
  return cachedTabId;
}

/* ------------------------------------------------------------------ */
/* 状态上报                                                            */
/* ------------------------------------------------------------------ */

/**
 * 更新本地状态快照并按需广播。
 *
 * @param patch 需要变更的字段。
 */
function patchStatus(patch: Partial<PanelStatus>): void {
  status = { ...status, ...patch, updatedAt: Date.now() };
  if (amWorker) bridge.reportStatus(status);
  if (IS_TOP_FRAME && amWorker) renderPanel();
}

/** 组装探测诊断信息（供 Popup 排查选择器失效问题）。 */
function buildDetectInfo(found: ChatTargets | null): DetectInfo {
  if (!found) {
    return {
      matched: {},
      source: 'heuristic',
      confidence: 0,
      inputKind: 'unknown',
      messageCount: 0,
      aiMessageCount: 0,
      userMessageCount: 0,
      sample: '',
    };
  }
  const messages = getMessages(found.list);
  return {
    matched: found.matched as Record<string, string | undefined>,
    source: found.source,
    confidence: found.confidence,
    inputKind: found.input instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable',
    messageCount: messages.length,
    aiMessageCount: messages.filter((m) => m.side === 'ai').length,
    userMessageCount: messages.filter((m) => m.side === 'user').length,
    sample: messages
      .slice(-3)
      .map((m) => `[${m.side}] ${m.text.replace(/\s+/g, ' ').slice(0, 48)}`)
      .join(' ｜ '),
  };
}

/* ------------------------------------------------------------------ */
/* 探测循环                                                            */
/* ------------------------------------------------------------------ */

/**
 * 本文档是否已经**被动**拉起过状态机。
 *
 * 为什么要它：内容脚本会在「页面每次重建文档」后重新注入（例如开场页
 * `pcStudentIndex` 真正导航到 `pcDialogue`），此时编排器那条 `START` 很可能
 * 打在了旧文档上。只依赖指令就会漏掉，因此这里做一次「探测到对话窗口且已要求
 * 自动开始 → 自己拉起状态机」的兜底。按文档只做一次，避免反复 start。
 */
let passiveStarted = false;

/** 用户是否显式点过「结束」（点了就不再自动拉起）。 */
let userStopped = false;

/**
 * 对话节点的「开场页」是否已经点过「开始对话」。
 *
 * 开场页会一直停在原地，重复点击可能触发多次进入；用一个标记去重。
 */
let introClicked = false;

/**
 * 把本 frame 登记为「对话 worker」。
 *
 * 两种情况都需要登记：
 * 1. 探测到了对话窗口（正常流程）；
 * 2. 停在对话节点的**开场页**（`pcStudentIndex`）—— 那里没有输入框，
 *    `detectChat` 会返回 `null`，但它依然是编排器要找的那个对话 frame。
 *
 * 不登记第 2 种的后果很隐蔽：编排器下发 `START` 时背景脚本找不到 worker，
 * 直接抛「未探测到对话窗口」并静默失败（编排器只轮询状态、不看这个错误），
 * 表现就是**「对话节点已经进去了，但永远不开始」**。
 *
 * @param found 探测结果；开场页传 `null`。
 * @param confidence 置信度。
 */
function registerWorker(found: ChatTargets | null, confidence = 0.5): void {
  if (amWorker) return;
  amWorker = true;
  bridge.register({
    courseId: courseKey,
    url: safeUrl(location.href),
    frameId: 0,
    confidence: found?.confidence ?? confidence,
  });
  bridge.reportDetect(buildDetectInfo(found));
  log.info(`本 frame 已成为 worker（confidence=${found?.confidence ?? confidence}）`);
}

/**
 * 处理「对话开场页」。
 *
 * 该页面上只有一个「开始对话」按钮，点掉之后同 frame 会导航到真正的对话界面
 * （`pcDialogue`），由随后的探测接管。
 *
 * @param allowClick 是否允许点击（未开启自动开始时不点，避免打扰用户）。
 */
async function handleDialogueIntroPage(allowClick: boolean): Promise<void> {
  // 即使不点按钮，也要先把自己登记成 worker —— 否则编排器的 START 无处可去
  if (DIALOGUE_URL_RE.test(location.href)) {
    registerWorker(null, 0.6);
    patchStatus({
      detected: true,
      confidence: 0.6,
      message: '已进入对话节点，等待开始…',
    });
  }

  if (!allowClick || introClicked) return;
  const introBtn = findButtonByText(FLOW_ACTIONS.startDialogue);
  if (!introBtn) return;

  introClicked = true;
  log.info('对话开场页：点击「开始对话」');
  patchStatus({ tone: 'running', state: 'DETECTING', message: '正在开始对话…' });
  await clickAndSettle(introBtn, 1200);
}

/** 执行一次探测，并在状态变化时注册 / 上报。 */
function runDetection(): void {
  // 让「AI 消息 / 用户消息」这类自定义选择器对消息收集也生效
  // （消息收集被 observer / state-machine 间接调用，用模块级变量传递最省改动）
  setActiveOverrides(overrides);

  const found = detectChat(overrides);

  if (found) {
    // 自愈：探测到了窗口，却解析出 0 条消息 —— 几乎一定是保存的自定义选择器
    // 指向了错误节点（例如把正文段落 `p` 当成了消息列表）。
    // 此时自动忽略自定义选择器重探一次；若能解析出消息，就清掉这份失效配置并告警。
    let effective = found;
    if (getMessages(found.list).length === 0) {
      const retry = detectChat(overrides, document, { ignoreOverrides: true });
      const retryCount = retry ? getMessages(retry.list).length : 0;
      if (retry && retryCount > 0) {
        log.warn(
          `自定义选择器解析出 0 条消息（已失效或点错元素），已自动忽略并重新探测（解析到 ${retryCount} 条）。` +
            `建议在弹窗里点「清除自定义选择器」。`,
        );
        effective = retry;
        overrides = {};
        void clearOverrides();
        patchStatus({ message: '自定义选择器已失效，已自动重置并重新探测' });
      } else {
        log.warn('消息解析结果为 0 条，且忽略自定义选择器后仍为 0 —— 请点面板「诊断」查看结构');
      }
    }

    targets = effective;
    if (!amWorker) {
      registerWorker(effective);

      patchStatus({
        detected: true,
        confidence: effective.confidence,
        message: `已探测到对话窗口（置信度 ${(effective.confidence * 100).toFixed(0)}%），点击「开始」运行`,
      });

      // 恢复持久化的轮次计数
      void getCounter(courseKey).then((round) => {
        if (round > 0) {
          runner.restoreRound(round);
          patchStatus({ round, message: `已恢复进度：${round} 轮` });
        }
      });

      if (config.autoStart && !autoStarted) {
        autoStarted = true;
        log.info('autoStart 已开启，自动开始');
        runner.start();
      }

      if (debugMode) {
        log.info('调试模式已开启，自动弹出选择器调试器');
        openPickerHere();
      }
    } else {
      bridge.reportDetect(buildDetectInfo(effective));
    }

    /*
     * 被动自动开始。
     *
     * 对话节点从「开场页」切到真正的对话界面时会**重建文档**、内容脚本重新注入，
     * 而编排器那条 START 往往已经打在旧文档上了。只靠指令会漏，所以这里兜底：
     * 只要「探测到对话窗口」且「已经要求自动开始」，就把状态机拉起来。
     * 按文档只做一次，用户点过「结束」也不再自动拉起。
     */
    if (!passiveStarted && !userStopped && !runner.isRunning() && (autoStarted || config.autoStart)) {
      passiveStarted = true;
      log.info('对话窗口已就绪，自动启动对话状态机');
      runner.start();
    }
    return;
  }

  if (amWorker) {
    // 对话窗口消失（页面重渲染 / 切换题目）
    targets = null;
    patchStatus({
      detected: false,
      confidence: 0,
      message: '对话窗口已消失，等待重新探测…',
    });
  }

  // 没有对话窗口时，检查是否停在「对话开场页」
  // （`autoStarted` 表示编排器/用户已经要求开始；config.autoStart 表示自动开始）
  void handleDialogueIntroPage(autoStarted || config.autoStart);
}

/* ------------------------------------------------------------------ */
/* 悬浮面板                                                            */
/* ------------------------------------------------------------------ */

let reactRoot: Root | null = null;
let panelHost: HTMLElement | null = null;
/** 来自 background 的槽位状态（当本 frame 不是 worker 时使用）。 */
let pushedStatus: PanelStatus | null = null;
let pushedHasWorker = false;

/** 渲染 / 更新悬浮面板。 */
function renderPanel(): void {
  if (!IS_TOP_FRAME || !reactRoot) return;
  const effective = amWorker ? status : pushedStatus ?? {
    ...status,
    message: '正在其他框架中探测对话窗口…',
  };
  reactRoot.render(
    <Panel
      status={effective}
      hasWorker={amWorker || pushedHasWorker}
      onCommand={handleCommandFromUI}
      onOpenDebug={handleOpenDebug}
    />,
  );
}

/** 在顶层 frame 挂载面板（Shadow DOM 隔离，避免样式互相污染）。 */
function mountPanel(): void {
  if (!IS_TOP_FRAME || panelHost) return;
  panelHost = document.createElement('div');
  panelHost.setAttribute('data-cxai-ui', 'panel-host');
  const shadow = panelHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelStyles;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.body.appendChild(panelHost);
  reactRoot = createRoot(container);
  renderPanel();
  log.info('悬浮面板已挂载');
}

/* ------------------------------------------------------------------ */
/* 角色初始化（可被路由变化反复调用，幂等）                             */
/* ------------------------------------------------------------------ */

/** 用户是否显式点过「结束」（点了就不再被监督者自动拉起）。 */
let userStoppedFlow = false;

/** 顶层 frame 挂载面板 + 向 background 报到（只需一次）。 */
function setupTopPanel(): void {
  if (!IS_TOP_FRAME || roleReady.panel) return;
  roleReady.panel = true;
  bridge.announcePanel();
  if (document.body) mountPanel();
  else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
  bridge.requestPanelSync();
}

/** 监督者的定时器句柄（只需启动一次）。 */
let flowSupervisorTimer: number | null = null;

/**
 * 编排器监督者 —— **「跑着跑着自己停了」的兜底**。
 *
 * 编排器的主循环在若干条路径上会 `return`（读不到任务流、没有可推进的节点…），
 * 之后如果没有外部事件，它就再也不会醒来。表现就是用户说的
 * 「有些按钮还是得自己点」「过一会儿就不动了」。
 *
 * 这里每 2.5 秒看一眼：只要**页面确实还有活**（`flowNeedsWork`）、而编排器没在跑，
 * 就把它拉起来。页面一变（节点解锁、出现「进入任务」、出现「开始评估」）就会自动继续，
 * 全程不需要刷新页面。
 */
function startFlowSupervisor(): void {
  if (flowSupervisorTimer !== null) return;
  flowSupervisorTimer = window.setInterval(() => {
    if (role !== 'flow' || userStoppedFlow) return;
    if (flowRunner.isRunning()) return;
    const state = readFlowState();
    if (!flowNeedsWork(state)) return;
    log.info('监督者：任务流上还有未完成的工作，自动重启编排器');
    flowRunner.start();
  }, 2500);
  log.info('任务流监督者已启动（每 2.5s 检查一次，页面有变化就自动继续）');
}

/** 任务流宿主的初始化：注册、挂面板、自动开始、启动监督者。 */
function setupFlowRole(): void {
  if (roleReady.flow) return;
  roleReady.flow = true;
  log.info('按任务流宿主角色初始化');
  setupTopPanel();
  bridge.registerFlow({
    courseId: courseKey,
    url: safeUrl(location.href),
    frameId: 0,
    confidence: 1,
  });
  // 把自己当作「可接收指令的 frame」，这样状态才会推给悬浮面板
  amWorker = true;
  patchStatus({
    detected: true,
    confidence: 1,
    message: '已识别到 AI 实践任务流，正在扫描节点…',
  });
  try {
    localStorage.setItem('cxai:lastCourse', courseKey);
  } catch {
    /* 忽略 */
  }
  if (config.autoStart && !autoStarted && !userStoppedFlow) {
    autoStarted = true;
    log.info('autoStart 已开启，自动开始整条任务流');
    flowRunner.start();
  }
  startFlowSupervisor();
}

/** 对话页面的初始化：探测循环 + 被动拉起状态机。 */
function setupChatRole(): void {
  if (roleReady.chat) return;
  roleReady.chat = true;
  log.info('按对话角色初始化（探测循环已启动）');
  runDetection();
  setInterval(() => {
    if (role === 'chat') runDetection();
  }, DETECT_POLL_INTERVAL_MS);
}

/**
 * 路由变化时重新判定角色并补齐初始化。
 *
 * ⚠️ 为什么是**轮询 URL** 而不是 patch `history.pushState`：
 * 内容脚本跑在隔离世界，在那里给 `history.pushState` 赋值**不会**影响页面自己的调用
 * （隔离世界的属性是各世界独立的）—— 那条路根本拦不到 SPA 导航。
 * 轮询 `location.href`（800ms）+ `popstate` / `hashchange` 事件才是可靠的。
 * 具体实现（与回归）见 `@/common/route-watch`。
 */
function startRouteWatch(): void {
  watchRouteChanges({
    patterns: ROLE_PATTERNS,
    initialRole: role,
    onChange: (next) => {
      role = next;
      applyRole();
    },
  });
}

/** 按当前角色补齐初始化（幂等）。 */
function applyRole(): void {
  if (role === 'flow') {
    setupFlowRole();
    return;
  }
  if (role === 'chat') {
    setupChatRole();
    if (IS_TOP_FRAME) setupTopPanel();
  }
}

/** 面板点击指令：交给 background 转发到真正的 worker frame。 */
function handleCommandFromUI(cmd: Command): void {
  if (amWorker) {
    executeCommand(cmd);
    return;
  }
  // 没有任何 worker 可用时，「清空计数」退化为直接请求 background 处理，
  // 否则指令会因为没有接收者而丢失。
  if (cmd === 'RESET' && !pushedHasWorker) {
    void sendToBackground({ type: MSG.RESET_COUNTER, courseId: courseKey });
    return;
  }
  bridge.sendCommand(cmd);
  log.info(`面板指令已下发：${cmd}`);
}

/** 在顶层 frame 打开选择器调试器的兜底路径。 */
function handleOpenDebug(): void {
  if (amWorker || !pushedHasWorker) openPickerHere();
  else bridge.sendCommand('DEBUG');
}

/** 打开选择器调试器（必须在 worker frame 内执行，因为要操作对话 DOM）。 */
function openPickerHere(): void {
  openPicker({
    initial: overrides,
    onClose: () => log.info('选择器调试模式已关闭'),
    onAutoDetect: () => {
      const found = detectChat({});
      if (!found) return null;
      return { ...found.matched } as SelectorOverrides;
    },
    onSave: async (picks) => {
      overrides = await setOverrides(picks);
      log.info('自定义选择器已保存', overrides);
      // 立即用新选择器重新探测一次
      runDetection();
    },
  });
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

/** 元素 → 稳定的 CSS 路径（用于和「选择器调试模式」里点选的结果对照）。 */
function pathOf(el: HTMLElement | null | undefined): string | null {
  return el ? buildCssPath(el) : null;
}

/**
 * 输出一份完整诊断到页面控制台。
 *
 * 目的是在无法直连用户浏览器时，让用户「点一下 + 复制日志」就能把
 * 探测结果、消息解析结果、每个消息条目的 DOM 路径一次性发回来。
 */
function runDiagnose(): void {
  const targets = detectChat(overrides);
  if (!targets) {
    console.warn('[CX-AI] 诊断：当前 frame 未探测到对话窗口', {
      frame: safeUrl(location.href),
      textareaCount: document.querySelectorAll('textarea').length,
      contenteditableCount: document.querySelectorAll('[contenteditable="true"]').length,
    });
    patchStatus({ message: '诊断：未探测到对话窗口（详情见控制台 [CX-AI] 开头日志）' });
    return;
  }

  const messages = getMessages(targets.list);
  const dump = describeMessages(targets.list);

  console.log('[CX-AI] ===== 诊断开始（请把以下所有 [CX-AI] 开头的行复制发回） =====');
  console.log('[CX-AI] frame：', safeUrl(location.href));
  console.log('[CX-AI] 探测：', {
    来源: targets.source,
    置信度: targets.confidence,
    输入框是否锁定: isInputLocked(targets.input),
    命中选择器: targets.matched,
  });
  console.log('[CX-AI] 关键元素：', {
    输入框: pathOf(targets.input),
    消息列表: pathOf(targets.list),
    对话根容器: pathOf(targets.root),
    发送按钮: pathOf(targets.sendBtn),
    继续按钮: pathOf(targets.unlockBtn),
  });
  console.log(`[CX-AI] 消息解析：\n${dump}`);
  messages.forEach((m, i) => {
    console.log(`[CX-AI] 消息 #${i} [${m.side}] ${pathOf(m.el)} :: ${m.text.replace(/\s+/g, ' ').slice(0, 60)}`);
  });
  console.log('[CX-AI] ===== 诊断结束 =====');

  patchStatus({ message: `诊断已输出到控制台（解析到 ${messages.length} 条消息）` });
}

/**
 * 任务流诊断：把节点解析结果与上传相关节点状态打到控制台。
 *
 * 任务流宿主里没有对话输入框，`runDiagnose()` 只会报「未探测到对话窗口」，
 * 所以这里单独给流角色一份更有用的现场快照。
 */
function runFlowDiagnose(): void {
  const state = readFlowState();
  console.log('[CX-AI] ===== 任务流诊断开始 =====');
  console.log('[CX-AI] frame：', safeUrl(location.href));
  if (!state) {
    console.warn('[CX-AI] 未解析到任务流（.flow-card 为空）');
    console.log('[CX-AI] ===== 任务流诊断结束 =====');
    patchStatus({ message: '诊断：未解析到任务流节点' });
    return;
  }
  console.log('[CX-AI] 概览：', {
    角色: role,
    编排器运行中: flowRunner.isRunning(),
    监督者已启动: flowSupervisorTimer !== null,
    用户已点结束: userStoppedFlow,
    已渲染节点: state.nodes.length,
    待解锁节点: state.pendingNodes.length,
    当前节点下标: state.currentIndex,
    当前节点标题: state.currentTitle,
    当前节点类型: state.currentType,
    右侧内容区: state.activeContent,
    右侧内容区标题: state.activeTitle || '(对话节点无标题)',
    页面上还有可进入节点: hasNextNodeEntry(),
    全部完成: state.allCompleted,
    判定还有活要干: flowNeedsWork(state),
    最终评估得分: readChainFinalScore() || '(未生成)',
  });
  state.nodes.forEach((n, i) => {
    console.log(
      `[CX-AI] 节点#${i} ${n.current ? '← 当前' : ''} [${n.typeLabel}→${n.type}] ` +
        `${n.title}｜已完成=${n.completed}｜成绩=${n.score || '-'}`,
    );
  });
  state.pendingNodes.forEach((n, i) => console.log(`[CX-AI] 待解锁#${i} [${n.typeLabel}→${n.type}] ${n.title}`));
  console.log('[CX-AI] 内容区标题（原始读取）：', readActiveTitle() || '(空，多为对话节点)');
  console.log('[CX-AI] 上传节点判定：', {
    '有 .upload-content': Boolean(document.querySelector('.upload-content')),
    '已挂文件(.uploaded-files)': Boolean(document.querySelector('.uploaded-files')),
    '有 .upload-actions(已传待评估)': Boolean(document.querySelector('.upload-actions')),
    '有 .choose-btn(未选文件)': Boolean(document.querySelector('.choose-btn')),
    '有 .evaluate-btn(开始评估)': Boolean(document.querySelector('.evaluate-btn')),
    '选择器弹层可见': isPickerOverlayVisibleInHost(),
  });
  console.log('[CX-AI] 上传要求：\n' + readUploadRequirement().slice(0, 400));
  console.log('[CX-AI] ===== 任务流诊断结束 =====');
  patchStatus({ message: '任务流诊断已输出到控制台' });
}

/** 从宿主页面看附件选择器弹层是否可见。 */
function isPickerOverlayVisibleInHost(): boolean {
  const overlay = document.querySelector('.file-picker-iframe-overlay') as HTMLElement | null;
  if (!overlay) return false;
  const cs = getComputedStyle(overlay);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

/* ------------------------------------------------------------------ */
/* 指令执行                                                            */
/* ------------------------------------------------------------------ */

/**
 * 执行控制指令。
 *
 * `flow` 角色把指令交给任务流编排器；`chat` 角色交给对话状态机。
 * 面板点击「开始」时，background 会按角色路由到正确的 frame。
 */
function executeCommand(cmd: Command): void {
  // 任务流宿主：整条链路由编排器接管
  if (role === 'flow') {
    switch (cmd) {
      case 'START':
      case 'RESUME':
        userStoppedFlow = false;
        autoStarted = true;
        flowRunner.start();
        break;
      case 'PAUSE':
        flowRunner.pause();
        break;
      case 'STOP':
        // 记住「用户主动结束」——监督者不再自动拉起，直到用户再点开始
        userStoppedFlow = true;
        flowRunner.stop();
        void clearPendingDocx(courseKey);
        break;
      case 'RESET':
        userStoppedFlow = true;
        flowRunner.stop();
        runner.clearRound();
        void clearFlowRecords(courseKey);
        void clearPendingDocx(courseKey);
        void sendToBackground({ type: MSG.RESET_COUNTER, courseId: courseKey, fromWorker: true });
        patchStatus({ message: '已清空节点记录与轮次计数' });
        break;
      case 'DIAGNOSE':
        runFlowDiagnose();
        break;
      default:
        break;
    }
    return;
  }

  switch (cmd) {
    case 'START':
      userStopped = false;
      void startDialogueSmart();
      break;
    case 'RESUME':
      userStopped = false;
      runner.resume();
      break;
    case 'PAUSE':
      runner.pause();
      break;
    case 'STOP':
      userStopped = true;
      runner.stop();
      break;
    case 'STEP':
      runner.step();
      break;
    case 'SKIP':
      runner.skip();
      break;
    case 'DEBUG':
      openPickerHere();
      break;
    case 'FINISH_DIALOGUE':
      void finishDialogueNode();
      break;
    case 'DIAGNOSE':
      runDiagnose();
      break;
    case 'RESET':
      runner.stop();
      runner.clearRound();
      // 同步清空 background 侧的轮次计数与对话上下文
      void sendToBackground({ type: MSG.RESET_COUNTER, courseId: courseKey, fromWorker: true });
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 对话节点的开场与收尾（供任务流编排器调用）                           */
/* ------------------------------------------------------------------ */

/**
 * 智能开始对话。
 *
 * 对话节点刚选中时，iframe 停在「开场页」（`pcStudentIndex`），页面上只有一个
 * 「开始对话」按钮 —— 这时不能直接跑状态机，必须先把它点掉，
 * 页面才会跳到真正的对话界面（`pcDialogue`）。
 */
async function startDialogueSmart(): Promise<void> {
  const introBtn = findButtonByText(FLOW_ACTIONS.startDialogue);
  // `introClicked` 兜住「探测循环刚刚点时过」的情况，避免连点造成重复导航
  if (introBtn && !introClicked) {
    introClicked = true;
    log.info('检测到对话开场页，点击「开始对话」');
    patchStatus({ message: '正在开始对话…', tone: 'running', state: 'DETECTING' });
    await clickAndSettle(introBtn, 1200);
  }

  /*
   * ⚠️ 关键：点完「开始对话」后，页面切到真正的对话界面走的是 **vue-router 的
   * 同文档路由变化**（不是重新加载）—— 内容脚本**不会**重新注入。
   * 所以不能像以前那样「点完就 return，等新文档接管」：
   * 那样在 SPA 场景下状态机永远不会被拉起来，表现就是
   * 「对话节点已经进去了，界面上也有输入框，但一个轮次都不跑」。
   *
   * 这里显式等对话界面就绪，然后自己启动状态机。
   */
  for (let i = 0; i < 40; i += 1) {
    const found = detectChat(overrides);
    if (found) {
      targets = found;
      registerWorker(found, 0.8);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!runner.isRunning()) {
    log.info('对话界面就绪，启动对话状态机');
    runner.start();
  }
}

/**
 * 结束对话节点：在对话界面里寻找「完成对话 / 开始评估」之类的收尾按钮并点击。
 *
 * ⚠️ 两个要点：
 * 1. **必须轮询**。收尾按钮是对话真正结束后才渲染的，只查一次必然错过 ——
 *    这就是「对话完成后『开始评估』还得自己点」的直接原因。
 * 2. **要跨同源 iframe 找**。站点不同版本把该按钮放在对话 iframe 里或宿主页面上，
 *    只搜自己这一层会漏掉一半情况。
 *
 * @returns 是否点到了按钮。
 */
async function finishDialogueNode(): Promise<boolean> {
  runner.stop();
  const clicked = await clickButton(
    [...FLOW_ACTIONS.startEvaluate, ...FLOW_ACTIONS.finishDialogue],
    { timeoutMs: 45_000, intervalMs: 1000, settleMs: 1200, deep: true },
  );
  if (clicked) {
    log.info(`点击对话收尾按钮：「${clicked}」`);
    patchStatus({ message: '正在结束对话并提交评估…', tone: 'running', state: 'SENDING' });
    return true;
  }
  log.warn('未找到对话收尾按钮（可能已自动结束）');
  return false;
}

/* ------------------------------------------------------------------ */
/* 文件选择器 frame：自动上传 Word 作品                                 */
/* ------------------------------------------------------------------ */

/**
 * 在附件选择器 frame 内接管上传。
 *
 * 选择器由宿主页面动态创建，URL 是 `/mooc2-ans/attCommon/s`；它与主站同源，
 * 因此本内容脚本也会被注入进去。这里读取 background 生成好的 .docx，
 * 写入它的文件输入框并点「确定」，宿主页面即可收到 `attachmentConfirm`。
 */
async function runPickerRole(): Promise<void> {
  log.info('本 frame 是附件选择器，等待待上传文档…');
  const courseId = resolveCourseKey(location.href);

  /**
   * 读取待上传文档。
   *
   * 选择器 URL 里的 `courseId` 与宿主一致，但为稳妥起见仍用宿主写入的
   * localStorage 兜底键再查一次（两者都查不到才算没有）。
   */
  const readPending = async () =>
    (await getPendingDocx(courseId)) ?? (await getPendingDocx(fallbackCourseId));

  /*
   * 关键设计：**一个持续循环**，而不是「查一次 / 固定重试几次」。
   *
   * 三条原因：
   * 1. 选择器 iframe 由宿主用 `v-show` 控制，弹层没被正常关闭时再次打开
   *    不会重新导航，内容脚本也就不会二次注入 —— 只查一次会永远错过后面才生成的文档；
   * 2. 文档是任务流跑到上传节点时才生成的，与 frame 加载之间有分钟级时间差；
   * 3. 弹层的打开、页面挂载、文件输入框出现都是异步的，任何「固定等待」都可能不够。
   */
  const deadline = Date.now() + PICKER_WAIT_TIMEOUT_MS;
  let lastReason = '刚启动';
  while (Date.now() < deadline) {
    if (!isPickerOverlayVisible()) {
      lastReason = '弹层未打开';
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const pending = await readPending();
    if (!pending) {
      lastReason = '暂无待上传文档';
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }

    try {
      // 文件输入框可能比弹层晚出现，这里单独等（不要求可见）；
      // 上传过一次之后它会被页面收起，`ensureFileInput` 会先点「继续添加」再等
      const input = await ensureFileInput(15_000);
      if (!input) {
        lastReason = '文件输入框未出现';
        log.warn(`待上传文档已就绪（${pending.fileName}），但弹层内还没有文件输入框，继续等…`);
        continue;
      }
      log.info(`拿到待上传文档：${pending.fileName}（${Math.round(pending.base64.length / 1365)} KB）`);
      const ok = await runPickerUpload(pending);
      if (ok) {
        await clearPendingDocx(pending.courseId);
        log.info('自动上传完成，已通知宿主');
        return;
      }
      lastReason = 'runPickerUpload 返回失败';
    } catch (err) {
      lastReason = `异常：${(err as Error)?.message ?? String(err)}`;
      log.error(`自动上传异常：${lastReason}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log.info(`附件选择器等待结束（${lastReason}），保持原样`);
}

/**
 * 选择器页面的 URL 里 `courseId` 命名与宿主一致，但 `cpi` 等参数不同，
 * 这里保留一个兜底键，避免因为解析差异导致找不到待上传文档。
 */
let fallbackCourseId = '';

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/** 重新载入配置 / 覆盖 / 调试开关。 */
async function reloadSettings(): Promise<void> {
  const [nextConfig, nextOverrides, nextDebug] = await Promise.all([
    getConfig(),
    getOverrides(),
    getDebugMode(),
  ]);
  config = nextConfig;
  overrides = nextOverrides;
  debugMode = nextDebug;
  patchStatus({ maxRounds: config.maxRounds });
}

function init(): void {
  // 文件选择器 frame：只做自动上传，不参与探测与面板
  if (role === 'picker') {
    roleReady.picker = true;
    // 宿主页面把待上传文档放在了「宿主课程 ID」下，选择器 URL 里的 courseId 与之一致，
    // 但解析失败时用 localStorage 里记录的值兜底
    try {
      fallbackCourseId = localStorage.getItem('cxai:lastCourse') ?? '';
    } catch {
      /* 忽略 */
    }
    void reloadSettings().then(() => runPickerRole());
    return;
  }

  void reloadSettings().then(() => {
    // 后台消息订阅
    bridge.onCommand((cmd) => {
      log.info(`收到指令：${cmd}`);
      executeCommand(cmd);
    });
    bridge.onConfigChanged(() => {
      log.info('配置已变更，热更新');
      void reloadSettings().then(() => runDetection());
    });
    bridge.onStatus((pushed, hasWorker, detect) => {
      if (!IS_TOP_FRAME) return;
      pushedHasWorker = hasWorker;
      if (!amWorker && pushed) pushedStatus = pushed;
      if (detect) log.debug('background 诊断信息已更新');
      renderPanel();
    });

    bridge.connect();

    // 按当前角色补齐初始化（任务流宿主 / 对话页面）
    applyRole();
  });

  // 配置/选择器变更时热更新
  subscribeChanges(() => {
    void reloadSettings().then(() => runDetection());
  });

  /*
   * 🚨 持续监听路由变化 —— 这是「不刷新页面也能自动识别」的关键。
   *
   * 内容脚本只在文档加载时注入一次；站点从课程页 / 任务列表跳到任务流用的是
   * 同文档路由（SPA），脚本不会重新注入。以前角色是加载时的常量，于是
   * 「进去时 URL 还不是任务流 → 角色永远是 chat → 编排器从不启动」，
   * 只能靠 F5 恢复 —— 这正是用户反复反馈的「要刷新页面才能自动点击」。
   */
  startRouteWatch();

  // 任务流宿主只需要编排 + 面板，不需要对话探测循环
  if (role === 'flow') {
    log.info('content script 就绪（任务流宿主）');
    roleReady.chat = true; // 明确不使用 chat 探测
    return;
  }

  setupChatRole();

  // 页面隐藏时不停机；SPA 路由变化由 startRouteWatch 处理
  log.info(`content script 就绪（top=${IS_TOP_FRAME}）`);
}

/**
 * 重复注入护栏。
 *
 * 扩展「重新加载」后，background 会主动把内容脚本补注入到已打开的标签页
 * （这样用户不必手动 F5）。但同一 frame 若同时也被浏览器正常注入过，
 * 就会跑两份 —— 出现两个悬浮面板、两个 worker 抢状态机。
 * 同一个扩展的 content script 共享隔离世界的全局对象，用一个标记即可去重。
 */
declare global {
  interface Window {
    __cxaiContentLoaded?: boolean;
  }
}

if (window.__cxaiContentLoaded) {
  log.info('检测到重复注入，已跳过初始化');
} else {
  window.__cxaiContentLoaded = true;
  init();
}
