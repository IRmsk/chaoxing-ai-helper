import { detectChat } from '@/content/detector';
import { clickElement, ensureInputReady, fillInput, isInputLocked, sendMessage } from '@/content/injector';
import {
  describeMessages,
  getMessages,
  getPageContext,
  getMessagesSignature,
  getPendingQuestion,
  waitForNewQuestion,
  waitForStableReply,
} from '@/content/observer';
import { setActiveOverrides } from '@/common/dom-utils';
import type { ChatTargets, SelectorOverrides } from '@/types';
import { createMockChat, type MockChat, type MockMode } from './mock-chat';
import {
  createFlowDoneScene,
  createFlowScene,
  createPickerScene,
  createStaleCurrentScene,
  createUploadFirstScene,
  type FlowDoneScene,
  type FlowScene,
} from './mock-flow';
import {
  clickAndSettle,
  clickButton,
  dismissInitDialog,
  dismissStrayDialog,
  enterUpcomingNode,
  findButtonByText,
  findDialogueCompleteBlock,
  findDialogueCompleteText,
  findSummaryPendingRow,
  flowNeedsWork,
  hasNextNodeEntry,
  hasUploadedFile,
  isContentActionable,
  isDialogueRoundComplete,
  isNodeSettled,
  readChainFinalScore,
  readFlowErrorToast,
  readFlowState,
  pickUsableRow,
  readUploadKind,
  readUploadRequirement,
} from '@/content/flow-dom';
import { classifyPageRole, watchRouteChanges } from '@/common/route-watch';
import { generateConsoleScreenshot } from '@/content/console-image';
import { runPickerUpload, waitForFileInput } from '@/content/file-picker-frame';
import {
  clearPendingDocx,
  getFlowRecords,
  getPendingDocx,
  saveFlowRecord,
  setPendingDocx,
} from '@/common/storage';
import { buildDocx, parseDocumentSpec } from '@/background/docx';

/**
 * Mock 验证台入口。
 *
 * 在无扩展运行时的普通页面中，直接调用 content 层的纯逻辑模块，验证：
 * 1. `detectChat` 能否在两种类名风格下找到输入框 / 消息列表 / 发送按钮；
 * 2. `fillInput` 能否把文本写进 textarea 并通过校验；
 * 3. `sendMessage` 能否触发发送并在消息列表上观察到新消息；
 * 4. `waitForStableReply` 能否在流式输出结束后判定完成。
 */

const logEl = document.getElementById('log') as HTMLPreElement;
const mount = document.getElementById('chat-mount') as HTMLDivElement;
const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;

/** 测试结果汇总（供自动化脚本读取）。 */
interface MockResult {
  pass: boolean;
  steps: string[];
  error?: string;
}

declare global {
  interface Window {
    __cxaiMock?: MockResult;
  }
}

let chat: MockChat | null = null;
/** 任务流模式下的场景句柄。 */
let flowScenes: FlowScene[] = [];

/** 验证台支持的全部模式（对话类走 `MockMode`，任务流类另有几种）。 */
type AnyMode = MockMode | 'flow' | 'flowStale' | 'flowUploadFirst' | 'flowDone';

/** 任务流模式。 */
const FLOW_MODES: readonly string[] = ['flow', 'flowStale', 'flowUploadFirst', 'flowDone'];

/** 完成态场景句柄（用于「移除哨兵行」的二级断言）。 */
let doneScene: FlowDoneScene | null = null;

const steps: string[] = [];

function log(line: string): void {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logEl.textContent += `${time}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/** 清空日志与结果（切换模式 / 重置 / 重跑时调用）。 */
function resetLog(): void {
  logEl.textContent = '';
  steps.length = 0;
  window.__cxaiMock = { pass: false, steps };
}

function recreateChat(): void {
  chat?.dispose();
  flowScenes.forEach((s) => s.dispose());
  flowScenes = [];

  const mode = modeSelect.value as AnyMode;
  if (FLOW_MODES.includes(mode)) {
    chat = null;
    doneScene = null;
    if (mode === 'flow') flowScenes.push(createFlowScene(mount));
    else if (mode === 'flowStale') flowScenes.push(createStaleCurrentScene(mount));
    else if (mode === 'flowUploadFirst') flowScenes.push(createUploadFirstScene(mount));
    else {
      doneScene = createFlowDoneScene(mount);
      flowScenes.push(doneScene);
    }
    resetLog();
    return;
  }
  chat = createMockChat(mount, mode as MockMode);
  resetLog();
}

function record(line: string): void {
  steps.push(line);
  log(line);
  window.__cxaiMock = { pass: false, steps };
}

/* ---------------- 步骤 1：探测 ---------------- */

function stepDetect(): ChatTargets {
  const targets = detectChat({});
  if (!targets) throw new Error('detectChat 返回 null：未能识别出对话窗口');

  record(
    `① 探测成功｜来源=${targets.source}｜置信度=${targets.confidence}｜输入框=${
      targets.input instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
    }｜发送按钮=${targets.sendBtn ? '已命中' : '未命中'}｜继续按钮=${
      targets.unlockBtn ? '已命中' : '未命中'
    }｜输入框状态=${isInputLocked(targets.input) ? 'LOCKED' : '可写'}`,
  );

  const messages = getMessages(targets.list);
  record(
    `   消息解析：共 ${messages.length} 条（AI ${messages.filter((m) => m.side === 'ai').length} / 我 ${
      messages.filter((m) => m.side === 'user').length
    } / 未知 ${messages.filter((m) => m.side === 'unknown').length}）`,
  );

  const pending = getPendingQuestion(targets.list);
  record(`   待答问题：${pending ? pending.text.slice(0, 40) + '…' : '无'}`);
  return targets;
}

/* ---------------- 步骤 1.4：页面背景资料采集自检 ---------------- */

/**
 * 断言：能采集到「对话之外」的整页文字，且**没有把对话内容混进去**。
 *
 * 需求要求不只依赖对话框内容，还要带上任务介绍 / 任务流之类的页面文字；
 * 同时消息列表必须被排除，否则会和「提问 + 历史」重复占用 token。
 *
 * @param targets 探测结果。
 */
function assertPageContext(): void {
  // 自己重新探测一次，不复用 stepDetect() 的结果 ——
  // stepDetect 会把提问文本写进日志 DOM，那会污染「页面文字」的采集结果
  const targets = detectChat({});
  if (!targets) throw new Error('页面背景资料自检：detectChat 返回 null');
  const context = getPageContext(targets);
  if (!context.trim()) throw new Error('页面背景资料为空：未采集到对话之外的页面文字');
  if (!/逻辑要素梳理|AI 实践/.test(context)) {
    throw new Error(`页面背景资料缺少任务说明类文字：${context.slice(0, 120)}`);
  }
  // 用「列表里第一条消息」的片段反向验证消息列表确实被排除了
  const first = getMessages(targets.list)[0]?.text.slice(0, 16);
  if (first && context.includes(first)) {
    throw new Error('页面背景资料里混进了对话正文（消息列表未被排除）');
  }
  record(`   页面背景资料：${context.replace(/\s+/g, ' ').slice(0, 56)}…（共 ${context.length} 字）`);
}

/* ---------------- 步骤 1.5：失效自定义选择器的拦截自检 ---------------- */

/**
 * 断言：**指向正文段落的失效自定义选择器不会把消息解析搞成 0 条**。
 *
 * 这是线上真实故障：用户在调试器里误把 `… > .answer_content > p` 存成了
 * 「消息列表」，导致 `collectMessageItems` 永远返回空 ——
 * 表现是「探测成功，但读不到提问、也不作答」。现在必须被结构体检拦截。
 */
function assertBrokenOverridesAreRejected(): void {
  const paragraph = 'div.agent > div.agentRight > div.agentAnswer > div.answer_content > p';
  const poisoned: SelectorOverrides = {
    input: paragraph,
    sendBtn: 'div.agent > div.agentRight > div.agentAnswer',
    messageList: paragraph,
    chatRoot: paragraph,
    messageItemAI: paragraph,
    messageItemUser: paragraph,
  };

  setActiveOverrides(poisoned);
  const targets = detectChat(poisoned);
  const count = targets ? getMessages(targets.list).length : 0;
  setActiveOverrides({});

  if (!targets) throw new Error('注入失效选择器后连对话窗口都探测不到了');
  if (count === 0) throw new Error('失效的自定义选择器未被拦截：消息解析仍为 0 条');
  record(`   [自检] 失效自定义选择器已被拦截：仍解析出 ${count} 条消息 ✅`);
}

/* ---------------- 步骤 2：跑完整多轮 ---------------- */

async function runFullTest(rounds = 3): Promise<void> {
  record(`=== 开始完整链路测试（${rounds} 轮） ===`);
  assertPageContext();
  assertBrokenOverridesAreRejected();
  let previousSignature: string | null = null;

  for (let index = 0; index < rounds; index += 1) {
    // 每轮都重新探测，模拟真实页面的重渲染
    const targets = stepDetect();

    const question = await waitForNewQuestion(targets.list, previousSignature, { timeoutMs: 15_000 });
    record(`   [第 ${index + 1} 轮] 抓到提问：${question.text.slice(0, 46)}…`);

    const answer = `这是第 ${index + 1} 轮自动生成的回答，用于验证「解锁 → 写入 → 发送 → 回复检测」链路。`;

    // 真实站点上输入框默认锁定，必须先点「继续」解锁
    if (isInputLocked(targets.input)) {
      record(`   [第 ${index + 1} 轮] 输入框处于锁定态，点击「继续」解锁…`);
    }
    await ensureInputReady(targets.input, targets.unlockBtn);
    record(`   [第 ${index + 1} 轮] 解锁结果：${isInputLocked(targets.input) ? '❌ 仍锁定' : '✅ 已解锁'}`);

    await fillInput(targets.input, answer);
    const wroteBack = (targets.input as HTMLTextAreaElement).value.trim();
    record(`   [第 ${index + 1} 轮] 写入校验：${wroteBack === answer ? '通过' : '未通过'}`);
    if (wroteBack !== answer) throw new Error(`第 ${index + 1} 轮写入内容与目标不一致`);

    const before = getMessagesSignature(targets.list);
    await sendMessage(targets, { beforeSignature: before, sentText: answer });
    record(`   [第 ${index + 1} 轮] 发送成功：消息列表已变化（${before} → ${getMessagesSignature(targets.list)}）`);

    // 校验我方消息确实进入了列表（失败时打印实际解析结果，便于定位侧别判定问题）
    const parsed = getMessages(targets.list);
    const mine = parsed.filter((m) => m.side === 'user' && m.text.includes(answer.slice(0, 12)));
    if (mine.length === 0) {
      const dump = parsed
        .map((m) => `[${m.side}] ${m.text.replace(/\s+/g, ' ').slice(0, 36)}`)
        .join(' ｜ ');
      throw new Error(`第 ${index + 1} 轮：列表中未找到自己的作答消息。实际解析：${dump}`);
    }
    record(`   [第 ${index + 1} 轮] 消息核对：列表中已出现我方作答`);

    // 关键断言（对应线上问题）：发完言后「最后一条消息」必须是我方，
    // 此时绝不能把任何东西当成待答问题，否则会自己答复自己、陷入死循环。
    const afterSend = getPendingQuestion(targets.list);
    if (afterSend) {
      throw new Error(
        `第 ${index + 1} 轮：发送后仍判定存在待答问题（侧别判错）。解析结果：\n${describeMessages(targets.list)}`,
      );
    }
    record(`   [第 ${index + 1} 轮] 侧别核对：最后一条消息=我方 → 不重复作答 ✅`);

    const reply = await waitForStableReply(targets.list, { timeoutMs: 20_000, sentText: answer });
    record(`   [第 ${index + 1} 轮] 回复完成检测：稳定，共 ${reply.length} 字`);

    // 回复到达后，「最后一条消息」应重新变成 AI（即下一轮的提问）
    const nextQuestion = getPendingQuestion(targets.list);
    record(
      `   [第 ${index + 1} 轮] 侧别核对：最后一条消息=${
        nextQuestion ? 'AI（可作为下一轮提问）' : '我方/空'
      }`,
    );

    previousSignature = question.signature;
  }

  record(`=== ✅ 全部 ${rounds} 轮通过 ===`);
  window.__cxaiMock = { pass: true, steps };
}

/* ---------------- 事件绑定 ---------------- */

document.getElementById('btn-detect')?.addEventListener('click', () => {
  resetLog();
  try {
    stepDetect();
  } catch (err) {
    record(`❌ 探测失败：${(err as Error).message}`);
    window.__cxaiMock = { pass: false, steps, error: (err as Error).message };
  }
});

document.getElementById('btn-run')?.addEventListener('click', () => {
  resetLog();
  window.__cxaiMock = { pass: false, steps };
  const mode = modeSelect.value as AnyMode;
  const task =
    mode === 'flow'
      ? runFlowTest()
      : mode === 'flowStale'
        ? runFlowStaleTest()
        : mode === 'flowUploadFirst'
          ? runFlowUploadFirstTest()
          : mode === 'flowDone'
            ? runFlowDoneTest()
            : runFullTest(3);
  void task.catch((err: Error) => {
    record(`❌ 测试中断：${err.message}`);
    window.__cxaiMock = { pass: false, steps, error: err.message };
  });
});

/* ---------------- 任务流测试 ---------------- */

/**
 * 任务流场景的两组断言。
 *
 * 1. **节点解析**：卡片 + 「解锁下一节点条件」里的待解锁节点要能拼出完整节点表，
 *    节点类型必须是干净的文案（不能带 `.task-index` 的序号）；
 * 2. **附件上传**：复刻的附件选择器上跑一遍真实的上传实现，
 *    断言文件确实写进了 `input[type=file]`、并点了「确定」。
 */
/**
 * 断言：`chrome.storage.session` 不可用时，会话级存储仍能通过 `local` 兜底正常工作。
 *
 * 这是线上「上传弹窗被调出来了，文件却永远传不上去」的**根因回归**：
 * 内容脚本访问 `chrome.storage.session` 默认被拒
 * （`Access to storage is not allowed from this context`），
 * 旧实现 catch 掉之后静默返回 null，附件选择器 frame 就永远等不到待上传文档。
 */
async function assertSessionStorageFallback(): Promise<void> {
  const mem: Record<string, unknown> = {};
  const denied = () => Promise.reject(new Error('Access to storage is not allowed from this context.'));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: { get: denied, set: denied, remove: denied },
      local: {
        get: async () => ({ ...mem }),
        set: async (items: Record<string, unknown>) => void Object.assign(mem, items),
        remove: async (key: string) => void delete mem[key],
      },
    },
  };

  await setPendingDocx({
    courseId: 'mock',
    fileName: '兜底.docx',
    base64: 'AA==',
    createdAt: Date.now(),
    outline: [],
  });
  const read = await getPendingDocx('mock');
  if (!read || read.fileName !== '兜底.docx') {
    throw new Error('session 不可用时未能通过 local 兜底读回待上传文档');
  }
  await clearPendingDocx('mock');
  if (await getPendingDocx('mock')) throw new Error('clearPendingDocx 未生效');

  await saveFlowRecord('mock', { domIndex: 1, title: '兜底节点', type: 'upload', transcript: [] });
  const records = await getFlowRecords('mock');
  if (records['1']?.title !== '兜底节点') throw new Error('session 不可用时节点记录兜底失败');

  record('   ✅ session 不可用时 local 兜底读写正常（线上「传不上去」的根因已覆盖）');
}

async function runFlowTest(): Promise<void> {
  record('=== 存储兜底（session 不可用）===');
  await assertSessionStorageFallback();

  record('=== 任务流解析 ===');
  const state = readFlowState();
  if (!state) throw new Error('readFlowState 返回 null：任务流解析失败');

  record(`   已渲染节点 ${state.nodes.length} 个，待解锁节点 ${state.pendingNodes.length} 个`);
  state.nodes.forEach((n) =>
    record(`     · [${n.completed ? '✓' : n.current ? '▶' : ' '}] ${n.typeLabel}「${n.title}」${n.score}`),
  );
  state.pendingNodes.forEach((n) => record(`     · [待解锁] ${n.typeLabel}「${n.title}」`));

  if (state.nodes.length !== 3) throw new Error(`已渲染节点数应为 3，实际 ${state.nodes.length}`);
  if (state.pendingNodes.length !== 1) throw new Error(`待解锁节点数应为 1，实际 ${state.pendingNodes.length}`);
  if (state.pendingNodes[0].type !== 'upload') {
    throw new Error(`待解锁节点类型应为 upload，实际 ${state.pendingNodes[0].type}`);
  }
  if (state.currentIndex !== 1) throw new Error(`当前节点下标应为 1，实际 ${state.currentIndex}`);
  if (state.allCompleted) throw new Error('还有待解锁节点时不应判定为「全部完成」');
  for (const node of state.nodes) {
    if (/^\d/.test(node.typeLabel)) throw new Error(`节点类型文案带了序号前缀：${node.typeLabel}`);
  }
  record('   ✅ 节点表 / 当前节点 / 待解锁节点 / 类型文案 全部正确');

  const requirement = readUploadRequirement();
  if (!requirement.includes('修复方案说明文档') && !requirement.includes('问题定位')) {
    throw new Error(`作品要求未读到：${requirement.slice(0, 80)}`);
  }
  record(`   ✅ 作品要求已读到：${requirement.replace(/\s+/g, ' ').slice(0, 60)}…`);

  record('=== Word 文档生成 ===');
  const spec = parseDocumentSpec(
    '{"title":"修复方案","sections":[{"heading":"问题定位","paragraphs":["竞态条件导致计数丢失。"]}]}',
    '兜底标题',
  );
  if (spec.title !== '修复方案' || spec.sections[0].heading !== '问题定位') {
    throw new Error('JSON 文档结构解析失败');
  }
  const md = parseDocumentSpec(['## 问题定位', '- 竞态条件', '- 可见性问题'].join('\n'), '兜底标题');
  if (md.sections[0].bullets?.length !== 2) throw new Error('Markdown 兜底解析失败');

  const docx = await buildDocx(spec, spec.title);
  const bytes = Uint8Array.from(atob(docx.base64), (c) => c.charCodeAt(0));
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('生成的不是合法 ZIP（.docx 魔数校验失败）');
  if (!docx.fileName.endsWith('.docx')) throw new Error(`文件名后缀不对：${docx.fileName}`);
  record(`   ✅ 已生成 ${docx.fileName}（${Math.round(bytes.length / 1024)} KB）`);

  record('=== 附件选择器自动上传 ===');
  let confirmed = '';
  flowScenes.push(createPickerScene((payload) => void (confirmed = payload)));

  /*
   * 回归前提校验：列表里必须**本来就有禁用的历史行**。
   *
   * 没有这一条，下面的断言就会变成「摆设」——
   * 旧实现「取第一个勾选框」在没有禁用行时刚好能碰对，掩盖掉真正的 bug。
   */
  const disabledBoxes = document.querySelectorAll('.el-checkbox.is-disabled').length;
  const firstBox = document.querySelector<HTMLInputElement>('.el-checkbox__original');
  if (disabledBoxes < 5 || !firstBox?.disabled) {
    throw new Error(
      `mock 前提不成立：应有多个禁用的历史行勾选框（实测 ${disabledBoxes} 个，第一个 disabled=${firstBox?.disabled}）`,
    );
  }
  record(`   ✅ 前提：列表里已有 ${disabledBoxes} 个禁用的历史行勾选框（旧实现会点到它们）`);


  // 回归：真实站点的文件输入是 0×0 的透明覆盖层，定位时**不能要求可见**
  const hiddenInput = await waitForFileInput(2000);
  if (!hiddenInput) {
    throw new Error('waitForFileInput 未找到 0×0 的隐藏文件输入框（回归：不能要求元素可见）');
  }
  const rect = hiddenInput.getBoundingClientRect();
  if (rect.width > 1 || rect.height > 1) {
    throw new Error(`mock 的隐藏输入框未生效（尺寸 ${rect.width}×${rect.height}），回归断言失去意义`);
  }
  record(`   ✅ 0×0 隐藏文件输入框仍能被定位（尺寸 ${rect.width}×${rect.height}）`);

  const ok = await runPickerUpload({
    courseId: 'mock',
    fileName: docx.fileName,
    base64: docx.base64,
    createdAt: Date.now(),
    outline: docx.outline,
  });
  if (!ok) throw new Error('runPickerUpload 返回 false');
  if (!confirmed) throw new Error('未触发「确定」回调（附件的 attachmentConfirm 未发生）');
  if (confirmed === '[]') {
    throw new Error(
      '「确定」回传的是**空附件列表** —— 这正是真机上「文件传上去了但作品卡片上看不到」的现场' +
        '（宿主实测收到 data="[]"）。说明勾选落到了被禁用的历史行上。',
    );
  }
  if (!confirmed.includes(docx.fileName)) {
    throw new Error(`「确定」回传的附件列表里没有生成的文件：${confirmed}`);
  }
  record(`   ✅ 文件已写入并确认（载荷非空）：${confirmed}`);

  /*
   * 回归：**上传过一次之后再传一次**必须也能成功。
   *
   * 真机：上传完成后页面会把上传框收起来，`input[type=file]` 从 DOM 里消失，
   * 只留一个「继续添加」按钮。这条路径就是「评估失败 → 换一份新作品重传」——
   * 旧实现会一直报「弹层内还没有文件输入框」卡到超时。
   */
  const uploadBox = document.querySelector<HTMLElement>('.upload-box');
  if (!uploadBox) throw new Error('mock 里没有 .upload-box');
  if (uploadBox.style.display !== 'none') {
    throw new Error('mock 前提不成立：上传成功后上传框应当被收起（否则这条回归测不到「继续添加」）');
  }
  confirmed = '';
  const second = await runPickerUpload({
    courseId: 'mock',
    fileName: '重传-控制台截图.png',
    base64: docx.base64,
    mime: 'image/png',
    createdAt: Date.now(),
    outline: docx.outline,
  });
  if (!second) throw new Error('第二次上传（重传）失败 —— 「继续添加」这条路径没有走通');
  if (!confirmed.includes('重传-控制台截图.png')) {
    throw new Error(`重传的文件没有出现在确认载荷里：${confirmed}`);
  }
  record(`   ✅ 重传可用（上传框收起后能自动点「继续添加」再传）：${confirmed}`);

  await assertSecondRoundFixes();

  record('=== 进入「即将作答」节点 ===');
  const beforeState = readFlowState();
  if (!beforeState) throw new Error('进入前 readFlowState 返回 null');
  const upcomingIndex = beforeState.nodes.findIndex((n) => n.upcoming);
  if (upcomingIndex < 0) throw new Error('mock 里没有 is-upcoming 节点，该回归失去意义');

  // 关键回归：点卡片本身必须**无效**（真实页面 selectTask 对 upcoming 直接 return）
  (document.querySelector('.flow-card.is-upcoming') as HTMLElement).click();
  if (!readFlowState()?.nodes[upcomingIndex]?.upcoming) {
    throw new Error('点卡片竟然让 upcoming 节点解锁了 —— 与真实页面行为不符');
  }
  record('   ✅ 直接点卡片无效（与真实页面一致）');

  const entered = await enterUpcomingNode(upcomingIndex);
  if (!entered) throw new Error('未找到「进入任务」按钮');
  // 用「可见性」而不是「元素是否存在」判断：弹窗是 v-show 控制的，
  // 关闭后元素仍在 DOM 里但尺寸为 0
  const dialogVisible = (): boolean => {
    const mask = document.querySelector<HTMLElement>('.init-dialog-mask');
    return Boolean(mask) && getComputedStyle(mask).display !== 'none';
  };
  if (!dialogVisible()) throw new Error('点「进入任务」后未出现初始化提示弹窗');
  record('   ✅ 已点击「进入任务」并弹出初始化提示');

  const dismissed = await dismissInitDialog();
  if (!dismissed) throw new Error('初始化提示未被确认');
  if (dialogVisible()) throw new Error('确认后弹窗仍未关闭');
  if (!readFlowState()?.nodes[upcomingIndex]?.current) {
    throw new Error('确认初始化提示后，该节点未变成「当前节点」');
  }
  if (!document.querySelector('iframe.dialogue-frame')) throw new Error('进入后未渲染对话窗口');
  record('   ✅ 确认后节点已解锁为当前节点，且对话窗口已出现');

  await assertDelayedButtonIsPolled();
  await assertDelayedInitDialogIsPolled();
  assertClickFiresExactlyOnce();
  await assertLooseMatchSkipsContainer();
  assertDialogueCompleteDetected();

  record('=== ✅ 任务流链路全部通过 ===');
  window.__cxaiMock = { pass: true, steps };
}

/**
 * 第二轮真机联调发现的缺陷回归（都对应「还得自己点」这类现象）。
 *
 * ① 宿主侧「文件已挂上」的判据：站点源码里 `hasUploadedFiles` 一为真就会渲染
 *    `.upload-actions`（重新上传 / 开始评估）。只盯文件列表类名会漏判，
 *    结果编排器一直以为没上传成功、反复重传。
 * ② 节点「翻篇」的判据：`.is-completed` 是后端回写后才加的，页面上往往更早
 *    就出现「进入任务」入口。只盯 `.is-completed` 会傻等 5 分钟且什么都不点。
 * ③ 意外弹窗：盖在页面上的提示层会让**页面自己**忽略点击。
 *    关闭时必须只点白名单内的收尾按钮，绝不能点「取消 / 我再想想」。
 */
async function assertSecondRoundFixes(): Promise<void> {
  record('=== 回归⑧：宿主「文件已挂上」应认 .upload-actions ===');
  const marker = document.createElement('div');
  marker.className = 'upload-actions';
  marker.style.cssText = 'position:fixed;left:0;top:0';
  marker.innerHTML = '<button type="button">重新上传</button><button type="button">开始评估</button>';
  document.body.appendChild(marker);
  if (!hasUploadedFile()) {
    marker.remove();
    throw new Error('存在 .upload-actions 时 hasUploadedFile() 仍为 false —— 会误判成「还没上传」而反复重传');
  }
  marker.remove();
  if (hasUploadedFile()) throw new Error('移除 .upload-actions 后仍判定为「已上传」');
  record('   ✅ .upload-actions 被认作「文件已挂到作品卡片」');

  record('=== 回归⑨：节点「翻篇」不能只等 .is-completed ===');
  const state = readFlowState();
  if (!state) throw new Error('readFlowState 返回 null');
  const openNode = state.nodes.find((n) => !n.completed);
  if (!openNode) throw new Error('mock 里没有未完成节点，该回归失去意义');
  if (!hasNextNodeEntry()) throw new Error('mock 里没有「进入任务」入口，该回归失去意义');
  if (!isNodeSettled(state, openNode.title, openNode.type)) {
    throw new Error(
      `「${openNode.title}」尚未回写 is-completed，但页面上已有「进入任务」入口 —— ` +
        '应判定为已翻篇（否则编排器会傻等 5 分钟且什么都不点）',
    );
  }
  record('   ✅ 出现「进入任务」即视为当前节点已翻篇（不再死等 .is-completed）');

  record('=== 回归⑩：挡路弹窗只点白名单按钮 ===');
  const closable = document.createElement('div');
  closable.className = 'el-message-box';
  closable.style.cssText = 'position:fixed;left:0;top:0;z-index:99';
  closable.innerHTML = '<div class="el-message-box__btns"><button type="button" class="ok">我知道了</button></div>';
  let okClicked = 0;
  closable.querySelector('.ok')?.addEventListener('click', () => (okClicked += 1));
  document.body.appendChild(closable);

  const trap = document.createElement('div');
  trap.className = 'el-message-box';
  trap.style.cssText = 'position:fixed;left:0;top:200px;z-index:99';
  trap.innerHTML =
    '<div class="el-message-box__btns"><button type="button" class="cancel">取消</button>' +
    '<button type="button" class="think">我再想想</button></div>';
  let trapClicked = 0;
  trap.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => (trapClicked += 1)),
  );
  document.body.appendChild(trap);

  const closed = dismissStrayDialog();
  closable.remove();
  trap.remove();

  if (okClicked !== 1) throw new Error(`带「我知道了」的提示弹窗没有被关掉（点击 ${okClicked} 次）`);
  if (trapClicked !== 0) {
    throw new Error('点到了「取消 / 我再想想」—— 这会把刚发起的动作撤销掉，绝不能点');
  }
  if (closed !== 1) throw new Error(`应只关掉 1 个弹窗，实际报告 ${closed} 个`);
  record('   ✅ 只关「我知道了」这类收尾按钮，绝不点「取消 / 我再想想」');

  record('=== 回归⑪：评估失败提示必须能被看到（否则会无限重试同一个按钮）===');
  if (readFlowErrorToast() !== '') throw new Error('干净页面上不应读到错误提示');
  const toast = document.createElement('div');
  toast.className = 'el-message el-message--error';
  toast.style.cssText = 'position:fixed;left:0;top:0;z-index:99';
  toast.innerHTML = '<p class="el-message__content">评估失败，请稍后重试</p>';
  document.body.appendChild(toast);
  const toastText = readFlowErrorToast();
  toast.remove();
  if (!toastText.includes('评估失败')) {
    throw new Error(
      `没有读到错误提示（读到的是「${toastText}」）—— 站点在评估失败时不改变任何 DOM 状态，` +
        '只弹这条几秒就消失的提示；读不到它就会无限重试「开始评估」，表现为「一直点、什么都不发生」',
    );
  }
  record('   ✅ 能读到「评估失败，请稍后重试」，可据此换成「重新生成并重传」');

  record('=== 回归⑫：作品类型（文档 / 图片）必须分开处理 ===');
  const meta = document.querySelector('.work-meta');
  if (!meta) throw new Error('mock 里没有 .work-meta，该回归失去意义');
  const originalMeta = meta.innerHTML;

  if (readUploadKind() !== 'document') {
    throw new Error(`「类型：文档」时应判为 document，实际 ${readUploadKind()}`);
  }
  // 真机现场：这个上传节点要求「程序运行成功的控制台截图」，类型是图片
  meta.innerHTML = '<span>类型：图片</span><i></i><span>数量：1</span>';
  const imageKind = readUploadKind();
  meta.innerHTML = originalMeta;
  if (imageKind !== 'image') {
    throw new Error(
      `「类型：图片」时应判为 image，实际 ${imageKind} —— 真机上该节点要求交控制台截图，` +
        '选择器入参是 fileTypes=png,jpg；按文档提交会被服务端判「上传失败：类型不支持」，该节点永远走不动',
    );
  }
  record('   ✅ 能从「类型：文档 / 类型：图片」正确分流作品类型');

  const shot = generateConsoleScreenshot({
    title: '最终校验 — 控制台输出',
    text: '> java -cp out Main\n正在初始化线程池...\n[main] 修复后结果 = 20000\nBUILD SUCCESS\n运行成功',
    fileName: '最终校验-控制台输出',
  });
  if (!shot.fileName.endsWith('.png')) throw new Error(`截图文件名后缀应为 .png：${shot.fileName}`);
  const shotBytes = Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0));
  if (shotBytes[0] !== 0x89 || shotBytes[1] !== 0x50 || shotBytes[2] !== 0x4e || shotBytes[3] !== 0x47) {
    throw new Error('生成的控制台截图不是合法 PNG（魔数校验失败）');
  }
  if (shot.lines.length < 3) throw new Error(`截图正文行数异常：${shot.lines.length}`);
  record(
    `   ✅ 控制台截图已生成：${shot.fileName}（${Math.round(shotBytes.length / 1024)} KB，${shot.lines.length} 行）`,
  );

  record('=== 回归⑬：明确「上传失败」的行绝不能被勾选 ===');
  const table = document.createElement('div');
  table.innerHTML = `
    <table><tbody>
      <tr><td><label class="el-checkbox"><span class="el-checkbox__input">
        <input type="checkbox" class="el-checkbox__original" /></span></label></td>
        <td class="cell">好文件.docx</td><td class="cell">上传失败：类型不支持</td></tr>
      <tr><td><label class="el-checkbox"><span class="el-checkbox__input">
        <input type="checkbox" class="el-checkbox__original" /></span></label></td>
        <td class="cell">好文件.docx</td><td class="cell">上传成功</td></tr>
    </tbody></table>`;
  const allRows = Array.from(table.querySelectorAll('tr'));
  const pickedRow = pickUsableRow(allRows, '好文件.docx');
  if (!pickedRow) throw new Error('应能在两行里挑出「上传成功」的那一行');
  if (/上传失败/.test(pickedRow.textContent ?? '')) {
    throw new Error('挑中了「上传失败：类型不支持」的行 —— 勾选它只会提交一个无效附件');
  }
  if (pickUsableRow(allRows.slice(0, 1), '好文件.docx') !== null) {
    throw new Error('只有「上传失败」的行时应当返回 null，而不是硬选一行交上去');
  }
  record('   ✅ 只挑「上传成功」的行；全是失败行时返回 null（不去提交无效附件）');

  await assertRouteReactivity();

  await Promise.resolve();
}

/**
 * 回归⑭：**角色必须能随路由变化重新判定** —— 「要刷新页面才能用」的唯一根因。
 *
 * 内容脚本只在文档加载时注入一次，而站点用同文档路由（SPA）在页面之间跳转。
 * 若角色是加载时的常量（`const ROLE = …`），从课程页跳进任务流后角色永远是 `chat`
 * → 编排器从不启动 → 面板点了没反应，**只有 F5 才恢复**。
 *
 * 这条回归用「可注入的 href + 可注入的定时器」直接驱动路由监听器，不依赖真实导航。
 */
async function assertRouteReactivity(): Promise<void> {
  record('=== 回归⑭：角色必须随路由变化重新判定（不刷新也要能识别）===');

  const patterns = { picker: /\/attCommon\/s/i, flow: /taskChain\/student\/answer/i };

  const cases: [string, string][] = [
    ['https://mooc2-ans.chaoxing.com/mooc2-ans-vue/taskChain/student/answer?courseId=1', 'flow'],
    ['https://mooc2-ans.chaoxing.com/mooc2-ans/attCommon/s?courseId=1', 'picker'],
    ['https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=1', 'chat'],
    ['https://mooc2-ans.chaoxing.com/mooc2-ans-vue/taskDialogue/pcDialogue?x=1', 'chat'],
  ];
  for (const [href, want] of cases) {
    const got = classifyPageRole(href, patterns);
    if (got !== want) throw new Error(`classifyPageRole(${href.slice(-50)}) 应为 ${want}，实际 ${got}`);
  }
  // 最深、最专用的 picker 必须优先判定（否则被宿主规则截胡）
  if (classifyPageRole('https://x/attCommon/s?u=%2FtaskChain%2Fstudent%2Fanswer', patterns) !== 'picker') {
    throw new Error('同时命中 picker 与 flow 特征时应判为 picker（先判最深的那个 frame）');
  }
  record('   ✅ 角色判定正确（flow / picker / chat，且 picker 优先）');

  // 用可变 href + 手动 tick 驱动监听器
  let href = cases[2][0]; // 起点：课程页 → chat
  const changes: string[] = [];
  const watcher = watchRouteChanges({
    patterns,
    getHref: () => href,
    intervalMs: 60_000, // 不靠定时器，手动 tick
    onChange: (next, prev) => changes.push(`${prev}→${next}`),
  });

  // 同文档路由跳到任务流 —— 这正是「必须 F5 才生效」的那个场景
  href = cases[0][0];
  const fired = watcher.check();
  watcher.stop();

  if (!fired) {
    throw new Error(
      'URL 从课程页变到任务流时没有触发角色变化 —— 内容脚本不会重新注入，' +
        '角色就永远停在 chat，编排器从不启动（用户只能按 F5）',
    );
  }
  if (changes.length !== 1 || changes[0] !== 'chat→flow') {
    throw new Error(`角色变化回调异常：${JSON.stringify(changes)}（应为 ["chat→flow"]）`);
  }
  // 再来一次同样的 tick：URL 没变 → 不能再触发（避免重复初始化）
  const noop = watchRouteChanges({
    patterns,
    getHref: () => cases[0][0],
    intervalMs: 60_000,
    onChange: () => changes.push('不该发生'),
  });
  noop.check();
  noop.stop();
  if (changes.length !== 1) throw new Error('URL 未变化时不应触发角色回调');
  record('   ✅ URL 变化 → 回调 chat→flow；URL 未变 → 不重复触发');

  await Promise.resolve();
}

/**
 * 回归⑦：**对话「已完成作答轮数要求，点击开始评估」必须被专门识别**。
 *
 * 🚨 真机实测：对话节点达标后，对话 iframe 里会渲染
 * ```html
 * <div class="complete newChapeter wrap1000">
 *   <div class="taskChainCompleteText">已完成作答轮数要求，点击开始评估</div>
 * </div>
 * ```
 * 这是对话节点**唯一的评估入口**。两个坑叠在一起：
 *
 * 1. 文案 16 字 > 「按文案找按钮」的 14 字上限 → **按文案永远找不到它**，
 *    所以必须走专门的选择器；
 * 2. 它不是 `<button>`，而是个 `<div>` 块 → 也得靠专门的选择器。
 *
 * 不处理就会出现：对话其实早就达标，助手还在傻等「下一个提问」，
 * 「开始评估」只能用户自己点 —— 正是线上反馈的现象。
 */
function assertDialogueCompleteDetected(): void {
  record('=== 回归⑦：对话「已完成作答轮数要求，点击开始评估」必须被识别 ===');

  const block = document.createElement('div');
  block.className = 'complete newChapeter wrap1000';
  block.style.cssText = 'position:fixed;left:0;top:0';
  block.innerHTML = '<div class="taskChainCompleteText">已完成作答轮数要求，点击开始评估</div>';
  document.body.appendChild(block);

  let ok = true;
  let reason = '';

  if (!isDialogueRoundComplete()) {
    ok = false;
    reason = '未识别到对话达标提示（.taskChainCompleteText）';
  } else {
    const inner = findDialogueCompleteText();
    const outer = findDialogueCompleteBlock();
    if (!inner) {
      ok = false;
      reason = 'findDialogueCompleteText 未命中';
    } else if (!outer) {
      ok = false;
      reason = 'findDialogueCompleteBlock 未命中 .complete 容器（点它才是开始评估的入口）';
    } else if (findButtonByText(['开始评估', '点击开始评估'], block)) {
      // 这一条是「前提校验」：如果按文案能找到，说明文案长度变了，本回归的针对性失效
      ok = false;
      reason = '断言前提不成立：按文案竟然能命中这个提示块（文案长度或匹配规则变了）';
    }
  }

  block.remove();
  if (ok && isDialogueRoundComplete()) {
    ok = false;
    reason = '移除提示块后仍判定为「已达标」';
  }

  if (!ok) throw new Error(reason);
  record('   ✅ 达标提示被专门选择器识别，且确认它 16 字文案超出词表上限（按文案找不到）');
}

/**
 * 回归⑥：**按文案找按钮必须落在真正的按钮上，而不是「包着按钮的容器」**。
 *
 * 🚨 这是真机上「按钮明明在屏幕上，助手点了却毫无反应、还得自己点」的根因。
 *
 * 现场（最终评估弹窗）：
 * ```html
 * <div class="init-dialog__body"><p>开始最终评估后…</p></div>
 * <div class="init-dialog__footer">
 *   <button>我再想想</button>
 *   <button class="init-dialog__btn--primary">开始评估</button>
 * </div>
 * ```
 * 文案词表里只有「开始」（不是「开始评估」），走的是**包含匹配**；
 * 旧实现「取第一个命中的」会落到 `<p>` 或 footer 容器上 ——
 * 它们**没有任何点击处理器**，Vue 的 `handleFinalEvalConfirm` 一次都不会被调用。
 * 现在改为「取文本最短（最内层）的那个」，就落在真正的按钮上。
 */
async function assertLooseMatchSkipsContainer(): Promise<void> {
  record('=== 回归⑥：按文案找按钮不能点到容器 ===');

  const wrap = document.createElement('div');
  wrap.className = 'init-dialog';
  wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:9';
  wrap.innerHTML = `
    <div class="init-dialog__body"><p>开始最终评估后本次作答将结束</p></div>
    <div class="init-dialog__footer">
      <button type="button" class="init-dialog__btn init-dialog__btn--secondary">我再想想</button>
      <button type="button" class="init-dialog__btn init-dialog__btn--primary">开始评估</button>
    </div>`;
  document.body.appendChild(wrap);

  let containerHits = 0;
  let primaryHits = 0;
  wrap.querySelector('.init-dialog__footer')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) containerHits += 1;
  });
  wrap.querySelector('.init-dialog__body')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) containerHits += 1;
  });
  wrap.querySelector('.init-dialog__btn--primary')?.addEventListener('click', () => (primaryHits += 1));

  const hit = findButtonByText(['开始'], wrap);
  const desc = hit ? `${hit.tagName}.${String(hit.className)}「${(hit.textContent || '').trim()}」` : 'null';

  let ok = true;
  let reason = '';
  if (!hit || !String(hit.className).includes('init-dialog__btn--primary')) {
    ok = false;
    reason = `包含匹配落到了 ${desc} —— 应该是主按钮 .init-dialog__btn--primary（旧实现会落到 <p> / footer 容器上，点了毫无反应）`;
  } else {
    await clickAndSettle(hit, 100);
    if (primaryHits !== 1) {
      ok = false;
      reason = `主按钮处理器被调用 ${primaryHits} 次（应为 1 次）`;
    } else if (containerHits !== 0) {
      ok = false;
      reason = `点击落到了容器上 ${containerHits} 次（应直接落在按钮上）`;
    }
  }

  wrap.remove();
  if (!ok) throw new Error(reason);
  record('   ✅ 包含匹配落在主按钮上并真正触发了处理器（不会点到容器）');
}

/**
 * 回归：**一次点击必须恰好触发一次处理器**（不漏、也不重复）。
 *
 * 为什么必须有这一条：真机上发现「手工 `new MouseEvent('click')` 派发」在
 * 学习通「开始最终评估」的确认按钮上**完全不生效**（弹窗不关、接口不发），
 * 而换成原生 `el.click()` 立刻生效。于是 `clickElement` 改成
 * 「先派发指针 / 鼠标按下抬起，再用原生 click() 收尾」——
 * 这个组合必须保证 click 只触发一次，否则会出现重复提交这类更糟的问题。
 */
function assertClickFiresExactlyOnce(): void {
  record('=== 回归⑤：点击原语必须恰好触发一次处理器 ===');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '计数按钮';
  btn.style.cssText = 'position:fixed;left:0;top:0';
  document.body.appendChild(btn);

  let clicks = 0;
  let pointerDowns = 0;
  btn.addEventListener('click', () => (clicks += 1));
  btn.addEventListener('pointerdown', () => (pointerDowns += 1));

  clickElement(btn);
  btn.remove();

  if (clicks !== 1) {
    throw new Error(`click 处理器被调用了 ${clicks} 次（应为 1 次）`);
  }
  if (pointerDowns !== 1) {
    throw new Error(`pointerdown 处理器被调用了 ${pointerDowns} 次（应为 1 次，供只监听指针事件的组件使用）`);
  }
  record('   ✅ click=1、pointerdown=1（原生 click + 指针序列，既兼容也不重复）');
}

/**
 * 回归：**延迟渲染的按钮必须被轮询命中**。
 *
 * 线上「对话完成后『开始评估』还得自己点」的直接原因就是旧实现「查一次、找不到就算了」。
 * 这里造一个 1.5 秒后才出现的「提交并评估」，断言 `clickButton` 会等到它。
 *
 * 刻意用「提交并评估」而不是「开始评估」：场景里本来就有一个常驻的「开始评估」按钮，
 * 用它就测不出「等待」这件事。
 */
async function assertDelayedButtonIsPolled(): Promise<void> {
  record('=== 回归③：延迟渲染的按钮必须被轮询命中 ===');

  const lateBtn = document.createElement('button');
  lateBtn.type = 'button';
  lateBtn.textContent = '提交并评估';
  lateBtn.style.cssText = 'position:fixed;left:0;top:0;display:none';
  document.body.appendChild(lateBtn);
  setTimeout(() => void (lateBtn.style.display = 'block'), 1500);

  const started = Date.now();
  const clicked = await clickButton(['提交并评估'], { timeoutMs: 9000, intervalMs: 400, settleMs: 100 });
  const elapsed = Date.now() - started;
  lateBtn.remove();

  if (clicked !== '提交并评估') {
    throw new Error('clickButton 没能在按钮延迟 1.5s 出现后点到它（收尾按钮正是这种情况）');
  }
  if (elapsed < 1200) throw new Error(`断言前提不成立：按钮似乎一开始就可见（耗时 ${elapsed}ms）`);
  record(`   ✅ 延迟 1.5s 才渲染的「提交并评估」被轮询命中并点击（耗时 ${elapsed}ms）`);
}

/**
 * 回归：**延迟渲染的初始化提示必须被等到，且只能点主按钮**。
 *
 * 线上「『直接来吧』还得自己点」的根因是：旧实现点完「进入任务」只查一次弹窗，
 * 弹窗 0.5~3 秒后才渲染，于是直接放弃。更糟的是旧兜底会去点「次要按钮」，
 * 而那是「我再想想」= 取消，反而把刚发起的进入动作取消掉。
 */
async function assertDelayedInitDialogIsPolled(): Promise<void> {
  record('=== 回归④：延迟渲染的初始化提示必须等到并点主按钮 ===');

  const dlg = document.createElement('div');
  dlg.className = 'init-dialog';
  dlg.style.cssText = 'position:fixed;left:0;top:0;display:none';
  dlg.innerHTML = `
    <div class="init-dialog__body"><p>即将进入新的任务节点，是否继续？</p></div>
    <div class="init-dialog__footer">
      <button type="button" class="init-dialog__btn init-dialog__btn--secondary">我再想想</button>
      <button type="button" class="init-dialog__btn init-dialog__btn--primary">直接来吧</button>
    </div>`;
  document.body.appendChild(dlg);

  let clickedWhich = '';
  dlg.querySelector('.init-dialog__btn--secondary')?.addEventListener('click', () => void (clickedWhich = 'secondary'));
  dlg.querySelector('.init-dialog__btn--primary')?.addEventListener('click', () => {
    clickedWhich = 'primary';
    dlg.style.display = 'none';
  });
  setTimeout(() => void (dlg.style.display = 'block'), 1200);

  const handled = await dismissInitDialog({ timeoutMs: 9000 });
  dlg.remove();

  if (!handled) throw new Error('dismissInitDialog 没能在弹窗延迟 1.2s 出现后处理它');
  if (clickedWhich !== 'primary') {
    throw new Error(
      `初始化提示点错了按钮（${clickedWhich || '一个都没点'}）—— 必须点主按钮「直接来吧」，点「我再想想」会把进入动作取消掉`,
    );
  }
  record('   ✅ 延迟 1.2s 出现的初始化提示被轮询等到，且点的是主按钮「直接来吧」');
}

/* ---------------- 故障复刻回归 ---------------- */

/**
 * 回归①：**卡片 `is-current` 标记滞留在上一节点时，当前节点必须按内容区定位**。
 *
 * 对应线上反馈：「已经到上传 word 节点了，助手显示的还是上一个对话节点」。
 */
async function runFlowStaleTest(): Promise<void> {
  record('=== 回归①：卡片 is-current 标记滞留在上一节点 ===');

  const state = readFlowState();
  if (!state) throw new Error('readFlowState 返回 null');

  state.nodes.forEach((n, i) =>
    record(`     #${i} ${n.typeLabel}「${n.title}」 已完成=${n.completed} 带当前标记=${n.current} 判定=${n.type}`),
  );
  record(`     内容区=${state.activeContent} 内容区标题=「${state.activeTitle}」 当前下标=${state.currentIndex}`);

  if (state.nodes.length !== 3) throw new Error(`卡片数应为 3，实际 ${state.nodes.length}`);
  if (!state.nodes[1].current) {
    throw new Error('场景没构造出「上一节点仍带 is-current 标记」的前提，这条回归失去意义');
  }
  if (state.activeContent !== 'upload') throw new Error(`内容区应为 upload，实际 ${state.activeContent}`);
  if (state.activeTitle !== '假设验证与修复') {
    throw new Error(`内容区标题应为「假设验证与修复」，实际「${state.activeTitle}」`);
  }
  if (state.currentIndex !== 2) {
    throw new Error(
      `当前节点下标应为 2（上传作品），实际 ${state.currentIndex} —— 旧实现只信 is-current，会停在 1（上一个对话节点）`,
    );
  }
  if (state.currentTitle !== '假设验证与修复') throw new Error(`当前节点标题不对：${state.currentTitle}`);
  if (state.currentType !== 'upload') throw new Error(`当前节点类型应为 upload，实际 ${state.currentType}`);
  if (state.nodes[2].type !== 'upload') {
    throw new Error(`第 3 张卡片（.task-type 缺失）应从文案推断为 upload，实际 ${state.nodes[2].type}`);
  }
  if (state.allCompleted) throw new Error('还有未完成节点时不应判定为「全部完成」');

  record('   ✅ 内容区标题对号入座 → 当前节点 = 第 3 张卡片「假设验证与修复」');
  record('   ✅ 类型由文案推断为「上传作品」（旧实现会得到 unknown 并被当对话跑）');

  // 监督者判据：这个场景确实还有活要干 —— 编排器被任何原因打断后都该被自动拉起
  if (!flowNeedsWork(state)) {
    throw new Error('还有未完成节点，flowNeedsWork 应为 true（否则编排器停了就不会自动重启）');
  }
  record('   ✅ flowNeedsWork=true（监督者会把它自动拉起）');
  window.__cxaiMock = { pass: true, steps };
}

/**
 * 回归②：**首个节点是上传作品、且 `.task-type` 读不到时，必须判为 upload**。
 *
 * 对应线上反馈：「第一个节点为上传 word 节点但识别为对话节点，无法上传 word 文件」。
 */
async function runFlowUploadFirstTest(): Promise<void> {
  record('=== 回归②：第一个节点就是上传作品，且 .task-type 读不到 ===');

  const state = readFlowState();
  if (!state) throw new Error('readFlowState 返回 null');

  state.nodes.forEach((n, i) =>
    record(`     #${i} ${n.typeLabel}「${n.title}」 判定=${n.type} 带当前标记=${n.current}`),
  );

  if (state.nodes.length !== 2) throw new Error(`卡片数应为 2，实际 ${state.nodes.length}`);
  if (state.currentIndex !== 0) throw new Error(`当前节点下标应为 0，实际 ${state.currentIndex}`);
  if (state.currentType !== 'upload') {
    throw new Error(
      `首个节点类型应为 upload（靠卡片文案推断），实际 ${state.currentType} —— 旧实现会得到 unknown 并被当对话节点跑，文件永远传不上去`,
    );
  }
  if (state.nodes[0].type !== 'upload') throw new Error(`第 1 张卡片类型应为 upload，实际 ${state.nodes[0].type}`);
  if (state.nodes[0].typeLabel !== '上传作品') {
    throw new Error(`类型展示名应为「上传作品」，实际「${state.nodes[0].typeLabel}」`);
  }
  if (state.nodes[1].type !== 'dialogue') {
    throw new Error(`第 2 张卡片（答辩类）应推断为 dialogue，实际 ${state.nodes[1].type}`);
  }
  if (!hasNextNodeEntry()) throw new Error('应当存在「进入任务」入口（还有下一个节点）');
  if (state.allCompleted) throw new Error('还有未完成节点时不应判定为「全部完成」');

  const requirement = readUploadRequirement();
  if (!requirement.includes('成果提交') && !requirement.includes('设计思路')) {
    throw new Error(`作品要求未读到：${requirement.slice(0, 80)}`);
  }

  record('   ✅ 首个节点判为「上传作品」（旧实现：unknown → 当对话跑）');
  record('   ✅ 后续答辩节点判为「情景对话」，且存在可进入的下一节点入口');
  record(`   ✅ 作品要求已读到：${requirement.replace(/\s+/g, ' ').slice(0, 50)}…`);

  // 这个场景里「选择文件」还在 ⇒ 确实还有活可干（临时合成节点的安全阀门应为 true）
  if (!isContentActionable('upload')) {
    throw new Error('上传节点还没提交文件时，isContentActionable 应为 true');
  }
  record('   ✅ isContentActionable=true（未提交文件时确实还有活可干）');
  window.__cxaiMock = { pass: true, steps };
}

/**
 * 回归③：**全部完成后必须能收尾**。
 *
 * 真机实测：最后一题做完后，页面上同时存在三个「假信号」，旧实现被它们卡死，
 * 面板一直显示"正在处理…"，用户看起来就是「卡住 / 没有任何效果」：
 *
 * 1. 列表末尾多出一个 `.flow-card.flow-card--done` 汇总行（无类型、无标题）
 *    → 被当成一个「永远未完成的幽灵节点」；
 * 2. `.right-content` 仍挂着最后一题的 `.upload-content`（标题与最后一张卡片一致）
 *    → 只按内容区类型就临时合成节点 ⇒ 反复去啃一个已经做完的节点；
 * 3. 解锁区最后一条 `<p>结束</p><h4></h4>` → 被当成一个待解锁节点，`allCompleted` 永不成立。
 */
async function runFlowDoneTest(): Promise<void> {
  record('=== 回归③：全部完成后的收尾（幽灵节点 / 反复啃已完成的节点）===');

  const state = readFlowState();
  if (!state) throw new Error('readFlowState 返回 null');

  record(`     已渲染节点 ${state.nodes.length} 个，待解锁 ${state.pendingNodes.length} 个`);
  state.nodes.forEach((n, i) => record(`     #${i} ${n.typeLabel}「${n.title}」 已完成=${n.completed} 判定=${n.type}`));
  record(`     内容区=${state.activeContent} 内容区标题=「${state.activeTitle}」 页面完成标记=${state.doneMarked}`);

  // ① 哨兵行不能被当成节点（真机有 5 个 .flow-card，其中第 5 个是汇总行）
  const rawCardCount = document.querySelectorAll('.flow-card').length;
  if (rawCardCount !== 5) throw new Error(`场景应渲染 5 个 .flow-card（含 1 个哨兵行），实际 ${rawCardCount}`);
  if (state.nodes.length !== 4) {
    throw new Error(
      `节点数应为 4（哨兵行必须被排除），实际 ${state.nodes.length} —— 落单的那个会变成「永远未完成」的幽灵节点`,
    );
  }

  // ② 待解锁节点里不能出现「结束」这种终止标记
  if (state.pendingNodes.length !== 0) {
    throw new Error(
      `待解锁节点应为 0，实际 ${state.pendingNodes.length}（${state.pendingNodes.map((p) => p.title).join('、')}）` +
        ' —— <p>结束</p><h4></h4> 是终止标记，不是节点',
    );
  }

  // ③ 必须判定为「全部完成」
  if (!state.doneMarked) throw new Error('未识别到页面上的「任务已完成」标记（.flow-card--done）');
  if (!state.allCompleted) {
    throw new Error('已完成全部节点，但 allCompleted === false —— 编排器会继续「处理」一个已经不存在的节点');
  }

  // ④ 内容区仍挂着最后一题，“当前节点”必须还是那张已完成的卡片（不能凭空合成新节点）
  if (state.currentIndex !== 3) throw new Error(`当前节点下标应为 3，实际 ${state.currentIndex}`);
  if (state.currentTitle !== '测试用例设计') throw new Error(`当前节点标题不对：${state.currentTitle}`);

  record('   ✅ 哨兵行被排除（5 个 .flow-card → 4 个节点）');
  record('   ✅ 「结束」终止标记未被当成待解锁节点');
  record('   ✅ allCompleted = true（可正常收尾，不会反复啃已完成的节点）');

  /* ★ 最终评估：所有节点做完 ≠ 整条链路完成，还要生成最终评估 */
  const pendingRow = findSummaryPendingRow();
  if (!pendingRow) {
    throw new Error('未找到「查看最终评估结果」汇总行 —— 缺了这一步，学习计划会一直显示 0%/未达标');
  }
  if (readChainFinalScore() !== '') {
    throw new Error('最终评估还没生成，得分应为空');
  }
  record('   ✅ 识别到「查看最终评估结果」汇总行（最终评估未生成）');

  if (!doneScene) throw new Error('完成态场景句柄丢失');
  doneScene.markFinalEvaluated('96');
  if (findSummaryPendingRow()) throw new Error('最终评估已生成后，pending 汇总行应消失');
  if (readChainFinalScore() !== '96') {
    throw new Error(`最终评估得分应读到 96，实际「${readChainFinalScore()}」`);
  }
  record('   ✅ 最终评估生成后能读到得分（96），收尾链路完整');

  /*
   * 监督者判据：真做完了必须返回 false。
   *
   * 否则监督者会在「已经全部完成」之后每 2.5 秒重启一次编排器 ——
   * 把它自己变成死循环（这比不重启更糟：面板会永远在闪「正在处理…」）。
   */
  const finalState = readFlowState();
  if (flowNeedsWork(finalState)) {
    throw new Error('全部节点完成且最终评估已生成，flowNeedsWork 仍为 true —— 监督者会无限重启编排器');
  }
  record('   ✅ flowNeedsWork=false（真做完了，监督者不会再来打扰）');

  // ★ 核心安全阀门：已完成的节点必须判定为「没活可干」，
  //   否则「按内容区临时合成节点」会反复去啃它（真机上就是这样卡住的）
  if (isContentActionable('upload')) {
    throw new Error('已评估完成的上传节点被判定为「还有活可干」—— 编排器会反复啃它，永远收不了尾');
  }
  record('   ✅ isContentActionable=false（已完成的节点不会被反复啃）');

  /* 二级断言：**没有哨兵行时也必须能收尾**（靠标题匹配 + 待解锁为空） */
  if (!doneScene) throw new Error('完成态场景句柄丢失');
  doneScene.removeDoneSentinel();
  const noSentinel = readFlowState();
  if (!noSentinel) throw new Error('移除哨兵行后 readFlowState 返回 null');
  if (noSentinel.doneMarked) throw new Error('移除哨兵行后 doneMarked 仍为 true，二级断言失去意义');
  if (!noSentinel.allCompleted) {
    throw new Error('没有哨兵行时也应判定为全部完成（卡片全打勾 + 无待解锁 + 无进入任务入口）');
  }
  if (noSentinel.nodes.length !== 4) throw new Error(`移除哨兵行后节点数应为 4，实际 ${noSentinel.nodes.length}`);
  record('   ✅ 移除哨兵行后依然能收尾（不依赖单一信号）');

  window.__cxaiMock = { pass: true, steps };
}

document.getElementById('btn-reset')?.addEventListener('click', () => {
  resetLog();
  recreateChat();
  log('已重置模拟对话窗口');
});

modeSelect.addEventListener('change', () => {
  resetLog();
  recreateChat();
  log(`已切换到「${modeSelect.options[modeSelect.selectedIndex].text}」模式`);
});

/* ---------------- 初始化 ---------------- */

recreateChat();
log('模拟对话窗口已就绪。点击「1. 探测 DOM」或「2. 跑完整 3 轮」开始验证。');
