import { PICKER_WAIT_TIMEOUT_MS } from '@/common/constants';
import { sleep } from '@/common/dom-utils';
import { createLogger } from '@/common/logger';
import { clickElement } from './injector';
import { FILE_PICKER_URL_RE, FLOW_ACTIONS, PICKER_SELECTORS } from './flow-selectors';
import { findButtonByText, findUploadedRow, pick, pickAny } from './flow-dom';
import type { PendingDocx } from '@/types';

/**
 * 超星通用附件选择器的自动化。
 *
 * ## 为什么会有这个模块
 *
 * 上传节点的「选择文件」按钮并不直接挂 `input[type=file]`，而是 `$emit('open-file-picker')`，
 * 父组件把 `iframe.file-picker-iframe` 指向：
 * ```
 * {origin}/mooc2-ans/attCommon/s?courseId=…&cpi=…&type=0&fileTypes=doc,docx&visibleTabs
 * ```
 * 那个页面（标题「添加附件」）才是真正的上传入口：
 *
 * ```
 * #attCommonApp.attCommon > .modal > .modal-cont
 *  ├ .tab-box > .tab-item            ← 本地上传 / 云盘
 *  ├ .tab-con > .upload-box
 *  │   └ input[type=file].attCommonUploadBtn   ← ★ 真正的文件输入（accept=".doc,.docx"）
 *  │       .modal-btn > p.sure「选择本地文件」
 *  └ .modal-btn.flex.modal-btn-tip > .flex     ← 「取消 / 确定」
 * ```
 *
 * 确认时页面会调用全局 `attCommonConfirm(json)`，其实现是
 * `window.parent.postMessage({ type: 'attachmentConfirm', data: json }, '*')`，
 * 宿主页面据此把文件挂到作品卡片上 —— 所以只要点「确定」即可，无需自己调接口。
 *
 * ## 它和宿主同源
 *
 * 选择器页面与学习通主站同源，因此本扩展的内容脚本（`all_frames: true`）会被注入进去，
 * 可以直接操作它的 DOM —— 不需要跨 frame 访问，也不需要伪造上传请求。
 */

const log = createLogger('content:picker');

/**
 * 选择器弹层当前是否**真的可见**。
 *
 * 为什么必须判断：宿主组件是 `v-show` 控制显隐的，而且
 * `handleFilePickerMessage` 只在 `showFilePickerIframe === true` 时才处理
 * 「确定」消息 —— 如果在弹层收起的状态下点确定，宿主会**直接忽略**，
 * 表现为「文件传上去了但作品卡片上看不到」。
 *
 * 同源 iframe 可以通过 `window.frameElement` 拿到宿主文档里的自己，
 * 因此能直接读到祖先弹层的计算样式。
 */
export function isPickerOverlayVisible(): boolean {
  try {
    const frame = window.frameElement;
    if (!frame) return true;
    const overlay = frame.closest('.file-picker-iframe-overlay') ?? frame;
    const style = getComputedStyle(overlay);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return overlay.getBoundingClientRect().width > 0;
  } catch {
    // 跨域或父文档不可访问时保守认为可见（由后续步骤兜底）
    return true;
  }
}

/**
 * 等待「待上传文档」出现且弹层可见。
 *
 * ⚠️ 这段是本次故障的核心修复点。之前 `runPickerRole` 只在 frame 首次加载时
 * 查一次 `pendingDocx`，查不到就直接 return —— 而选择器 iframe 是 `v-show` 的：
 * 正常关闭时 `filePickerIframeUrl` 会被置为 `about:blank`，下次打开会重新加载；
 * 但**若上一次弹层没有被正常关闭**，再次点「选择文件」设置的是同一个 URL，
 * 浏览器不会重新导航 → 内容脚本不会再注入第二次 → 上传永远等不到执行。
 * 因此必须在这里持续轮询，而不能依赖重新注入。
 *
 * @param read 读取待上传文档。
 */
export async function waitForPendingDocx<T>(
  read: () => Promise<T | null>,
  options: { timeoutMs?: number; requireVisible?: boolean; signal?: AbortSignal } = {},
): Promise<T | null> {
  const { timeoutMs = PICKER_WAIT_TIMEOUT_MS, requireVisible = true, signal } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    if (!requireVisible || isPickerOverlayVisible()) {
      const pending = await read();
      if (pending) return pending;
    }
    await sleep(1200);
  }
  return null;
}

/** 当前 frame 是否是附件选择器。 */
export function isPickerFrame(): boolean {
  try {
    return FILE_PICKER_URL_RE.test(location.pathname) || FILE_PICKER_URL_RE.test(location.href);
  } catch {
    return false;
  }
}

/**
 * base64 → File。
 *
 * ⚠️ MIME 必须跟作品类型一致（文档 vs 图片）：选择器页面按 `fileTypes` 校验，
 * 传错会显示「上传失败：类型不支持」，附件挂不上、评估必然失败。
 */
function base64ToFile(
  base64: string,
  fileName: string,
  mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}

/**
 * 把文件塞进 `<input type="file">`。
 *
 * 通过 `DataTransfer` 构造 `FileList` —— 这是浏览器里唯一能程序化设置 input.files 的方式，
 * 且对 Vue/Element 的受控组件同样有效（随后必须派发 `change`）。
 */
function assignFile(input: HTMLInputElement, file: File): boolean {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch (err) {
    log.warn(`写入文件输入框失败：${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

/**
 * 勾选一行，并**验证真的勾上了**。
 *
 * 三种点法依次尝试（不同版本的 Element-UI 挂处理器的层级不一样）：
 * 可见的 `.el-checkbox__inner` → `label.el-checkbox` → 原生 input。
 *
 * ⚠️ 必须验证：旧实现点完就走，日志还打印「已勾选上传列表首行」，
 * 但实际一个都没勾上 —— 这种「假成功」比直接失败更难查。
 *
 * @param row 目标行。
 * @returns 是否确认勾选成功。
 */
/**
 * 让「刚上传成功的那一行」处于可提交状态。
 *
 * 🚨 真机实测（2026-09）——这里必须区分**两张不同的表**：
 *
 * | 表 | 表头 | 有勾选列？ |
 * | --- | --- | --- |
 * | 本地上传（`el-table_2_*`） | 文件名 / 大小 / 状态 / 操作 | ❌ **没有** |
 * | 云盘（`el-table_1_*`） | ☑ / 文件名 / 大小 / 创建时间 | ✅ 有（历史行全部 `is-disabled`） |
 *
 * 也就是说：**我们上传的文件落在「本地上传」表里，那一行根本没有勾选框**，
 * 页面自己会把它一起提交。旧实现「找不到勾选框就拒绝提交」，
 * 于是明明上传成功却始终不点「确定」 —— 表现就是「文件传上去了，作品卡片上却没有」。
 *
 * 正确行为：
 * - 该行**有**勾选列（云盘行）→ 勾上并**验证**真的勾上了；
 * - 该行**没有**勾选列（本地上传行）→ 页面会自行带上，直接放行。
 *
 * @param row 目标行。
 * @returns 是否已处于可提交状态。
 */
async function ensureRowSelected(row: HTMLElement): Promise<boolean> {
  const native = row.querySelector<HTMLInputElement>('input.el-checkbox__original');
  const hasSelectionColumn = Boolean(row.querySelector('.el-checkbox'));
  if (!hasSelectionColumn) {
    log.info('该行来自「本地上传」列表（无勾选列），页面会自行带上它，跳过勾选');
    return true;
  }

  const isChecked = (): boolean =>
    Boolean(native?.checked) || Boolean(row.querySelector('.el-checkbox.is-checked'));
  if (isChecked()) return true;

  const clickers = [
    row.querySelector<HTMLElement>('.el-checkbox__inner'),
    row.querySelector<HTMLElement>('label.el-checkbox'),
    native,
  ].filter((el): el is HTMLElement => Boolean(el));

  for (const el of clickers) {
    clickElement(el);
    await sleep(350);
    if (isChecked()) {
      log.info('已勾选上传成功的文件');
      return true;
    }
  }
  return false;
}

/**
 * 找真正的文件输入框。
 *
 * ⚠️ 这里**刻意不用 `pick()`**（它要求元素可见）：
 * `.attCommonUploadBtn` 是铺在 `.upload-box` 上的透明覆盖层，页面尚未完成布局、
 * 或处于某些过渡状态时它的尺寸会退化成 0×0 —— 但**给隐藏的 file input 赋值 + 派发
 * change 一样有效**。用「可见」当门槛会直接错过它，线上报「未找到文件输入框」就是这么来的。
 *
 * @returns 文件输入框；没有则 `null`。
 */
function findFileInput(): HTMLInputElement | null {
  const candidates = ['input.attCommonUploadBtn', 'input[type="file"]'];
  for (const selector of candidates) {
    try {
      const hit = Array.from(document.querySelectorAll(selector)).find(
        (el) => (el as HTMLInputElement).type === 'file',
      );
      if (hit) return hit as HTMLInputElement;
    } catch {
      /* 非法选择器，试下一个 */
    }
  }
  return null;
}

/**
 * 等待文件输入框出现在 DOM 中（不要求可见）。
 *
 * @param timeoutMs 超时毫秒数。
 */
export async function waitForFileInput(timeoutMs = 30_000): Promise<HTMLInputElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const input = findFileInput();
    if (input) return input;
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

/**
 * 拿到文件输入框；**没有就先点「继续添加」把它调出来**。
 *
 * 真机实测：上传过一次之后，页面会把原来的上传框换成文件列表，
 * `input[type=file]` 从 DOM 里**消失**，页面上多出一个「继续添加」按钮。
 * 于是「重传」这条路（评估失败后换一份新作品）会一直报
 * 「弹层内还没有文件输入框」，卡到超时 —— 必须先点「继续添加」。
 *
 * @param timeoutMs 点完「继续添加」后等输入框出现的上限。
 */
export async function ensureFileInput(timeoutMs = 15_000): Promise<HTMLInputElement | null> {
  const immediate = findFileInput();
  if (immediate) return immediate;

  const addMore = findButtonByText(['继续添加', '继续上传', '添加文件', '再添加一个']);
  if (addMore) {
    log.info('文件输入框已被收起，点「继续添加」把它调出来');
    clickElement(addMore);
    await sleep(700);
  }
  return waitForFileInput(timeoutMs);
}

/**
 * 执行一次自动上传。
 *
 * @param pending 待上传的文档（base64）。
 * @param signal 中止信号。
 * @returns 是否成功走完「写入 → 上传 → 确认」。
 */
export async function runPickerUpload(pending: PendingDocx, signal?: AbortSignal): Promise<boolean> {
  // 0) 弹层必须处于可见状态：宿主只在弹层可见时才处理「确定」消息
  if (!isPickerOverlayVisible()) {
    log.warn('附件选择器弹层当前不可见，先等它打开');
    return false;
  }

  // 1) 切到「本地上传」标签（默认就在，但显式点一下更稳）
  const tabs = Array.from(document.querySelectorAll(PICKER_SELECTORS.localTab.join(',')));
  const localTab = tabs.find((t) => (t.textContent ?? '').trim() === '本地上传');
  if (localTab instanceof HTMLElement) {
    clickElement(localTab);
    await sleep(300);
  }

  // 2) 找到文件输入（不要求可见，见 findFileInput 的说明）。
  //    上传过一次之后输入框会被收起，此时点「继续添加」把它调出来。
  const input = await ensureFileInput(12_000);
  if (!input) {
    log.warn(
      `未找到文件输入框｜url=${location.href.slice(0, 80)}｜` +
        `fileInput数=${document.querySelectorAll('input[type=file]').length}｜` +
        `弹层可见=${isPickerOverlayVisible()}`,
    );
    return false;
  }

  const file = base64ToFile(pending.base64, pending.fileName, pending.mime);
  log.info(
    `写入待上传文件：${pending.fileName}（${Math.round(file.size / 1024)} KB，${file.type || '未声明类型'}）`,
  );
  if (!assignFile(input, file)) return false;

  /*
   * 3) 等「本行上传成功」——注意**不能**用「页面上有勾选框」当条件。
   *
   * 这个列表里本来就有一堆云盘历史行（都带 `is-disabled` 的勾选框），
   * 用「存在勾选框」判断会立刻为真（实测写入文件后 0.4 秒就误报成功），
   * 结果在文件还没真正传完时就点了确定 —— 提交上去的是一个空列表。
   */
  const deadline = Date.now() + 40_000;
  let row: HTMLElement | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    row = findUploadedRow(pending.fileName);
    if (row) break;
    await sleep(600);
  }
  if (!row) {
    log.warn(
      `等待上传完成超时（列表里没有出现可用行）｜文件名=${pending.fileName}｜` +
        `总行数=${document.querySelectorAll('.el-table__body tr').length}`,
    );
    return false;
  }
  log.info(`文件已上传成功：${(row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  await sleep(400);

  // 4) 让这一行处于可提交状态（本地上传表没有勾选列，见 ensureRowSelected 的说明）
  if (!(await ensureRowSelected(row))) {
    log.warn('未能勾选上传成功的文件行，本次不上报（避免提交空附件列表）');
    return false;
  }

  // 5) 点「确定」→ 页面调用 attCommonConfirm → postMessage 给宿主
  if (!isPickerOverlayVisible()) {
    log.warn('点「确定」前弹层已不可见，放弃本次提交（宿主会忽略该消息）');
    return false;
  }
  const confirm = findButtonByText(FLOW_ACTIONS.confirm, document);
  if (!confirm) {
    log.warn('未找到「确定」按钮');
    return false;
  }
  clickElement(confirm);
  log.info(`已点击「确定」，附件选择完成（${(confirm.textContent ?? '').trim()}）`);
  await sleep(600);
  return true;
}

/** 读取当前选择器页面是否就绪。 */
export function isPickerReady(): boolean {
  return Boolean(pickAny(PICKER_SELECTORS.root)) && Boolean(pick(PICKER_SELECTORS.uploadInput));
}
