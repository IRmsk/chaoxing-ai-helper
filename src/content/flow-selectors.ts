import type { FlowNodeType } from '@/types';

/**
 * AI 实践「任务流」页面的选择器与按钮文案词表。
 *
 * 数据来源：2026-09 用 CDP 直连真实页面（`…/taskChain/student/answer`）实测，
 * 并配合其前端 chunk（`js/6727.*.js`、`js/6907.*.js`）确认了渲染结构。
 *
 * ## 真实结构速览
 *
 * ```
 * .task-chain
 *  ├ .flow-card-list
 *  │   ├ article.flow-card.is-completed          ← 已完成节点
 *  │   │   ├ .task-type（情景对话 / 上传作品）
 *  │   │   ├ .task-score（95分）
 *  │   │   ├ .flow-card-body > h3（标题）+ p（说明）
 *  │   │   └ .complete-condition（已完成条件）
 *  │   ├ article.flow-card.is-current.is-selected ← 当前节点
 *  │   │   ├ .task-index（02）+ .task-type + .task-status（当前任务）
 *  │   │   └ .flow-card-body > h3 + p
 *  │   └ .unlock-condition（解锁下一节点条件 + .unlock-target 目标节点名）
 *  └ .right-content                                ← 随 activeContent 切换
 *      ├ iframe.dialogue-frame                     ← 对话节点
 *      ├ .upload-content                           ← 上传作品节点（Vue 组件，非 iframe）
 *      │   ├ .upload-card > .task-detail > h3 + p  ← 标题 + 提交要求
 *      │   ├ .upload-card > .work-panel
 *      │   │   ├ h3（作品标题）+ .work-meta（类型 / 数量）+ p（作品要求）
 *      │   │   ├ .uploaded-files                   ← 已上传文件
 *      │   │   └ button.choose-btn                 ← 「选择文件」
 *      │   └ button（开始评估）
 *      └ .completed-view                           ← 评估完成
 * ```
 *
 * ## 两个必须记牢的坑（都是实测踩出来的）
 *
 * 1. **`.task-type` 里的序号**：真实 DOM 是
 *    `<div class="task-type"><span class="task-index">02</span><span>情景对话</span></div>`，
 *    直接取外层文本会得到「02情景对话」。
 * 2. **卡片标记会滞后**：`.is-current` / `.is-selected` 由前端在**切换动作完成后**
 *    才更新，切换途中（甚至切换失败时）会**同时有多个卡片带当前标记**。
 *    因此**不能只信卡片 class** —— 真正的权威信号是 `.right-content` 里渲染的是
 *    对话 iframe 还是上传组件。`flow-dom.ts` 的 `readFlowState()` 就是按
 *    「内容区优先、卡片标记兜底」的多信号互证来判定的。
 *
 * ## 上传为什么不是 `input[type=file]`
 *
 * 上传节点的「选择文件」只是 `$emit('open-file-picker')`，父组件会把
 * `iframe.file-picker-iframe` 的地址设为超星通用附件选择器：
 * ```
 * {origin}/mooc2-ans/attCommon/s?courseId=…&cpi=…&type=0&fileTypes=doc,docx&visibleTabs
 * ```
 * 那个页面里才有真正的 `<input type="file" class="attCommonUploadBtn">`，
 * 且与宿主同源 —— 所以本扩展的内容脚本会被注入进去，可以完整接管上传。
 */

/** 任务流页面路由特征（用于判定「这个 frame 是任务流宿主」）。 */
export const FLOW_URL_RE = /taskChain\/student\/answer/i;

/** 通用附件选择器路由特征（判定「这个 frame 是文件选择器」）。 */
export const FILE_PICKER_URL_RE = /\/attCommon\/s/i;

/** 对话节点 iframe 的路由特征。 */
export const DIALOGUE_URL_RE = /taskDialogue\/(pcStudentIndex|pcDialogue)/i;

/**
 * 任务流页面选择器（按优先级）。
 *
 * 与 `selectors.ts` 一样采用「多级回退 + 取首个可见命中」的策略，
 * 便于站点改版后只需追加候选。
 */
export const FLOW_SELECTORS = {
  cardList: ['.flow-card-list', '[class*="flow-card-list"]'],
  card: ['.flow-card', 'article[class*="flow-card"]'],
  taskType: ['.task-type', '[class*="task-type"]'],
  taskIndex: ['.task-index'],
  taskStatus: ['.task-status'],
  /**
   * 「当前任务」角标。
   *
   * 站点源码里两种状态都渲染 `.task-status`：
   * - `i.current`  → `<div class="task-status">当前任务</div>`
   * - `i.upcoming` → `<div class="task-status task-status--upcoming">即将作答</div>`
   *
   * 所以要用 `:not([class*="upcoming"])` 把「即将作答」那种排除掉，
   * 否则即将作答的卡片会被误判成当前节点。
   */
  taskStatusCurrent: ['.task-status:not([class*="upcoming"])'],
  taskScore: ['.task-score'],
  cardTitle: ['.flow-card-body h3', '.flow-card-body h4', 'h3'],
  cardDesc: ['.flow-card-body p', 'p'],
  completeCondition: ['.complete-condition'],
  unlockCondition: ['.unlock-condition'],
  rightContent: ['.right-content', '[class*="right-content"]'],
  dialogueFrame: [
    'iframe.dialogue-frame',
    'iframe[class*="dialogue"]',
    '.dialogue-frame iframe',
    'iframe[name*="dialogue"]',
  ],
  uploadContent: ['.upload-content', '[class*="upload-content"]'],
  uploadTitle: ['.task-detail h3', '.upload-card h3'],
  uploadRequirement: ['.task-detail p', '.upload-card p'],
  workPanel: ['.work-panel'],
  workTitle: ['.work-panel h3'],
  workRequirement: ['.work-panel p'],
  workMeta: ['.work-meta'],
  /**
   * 「文件已经挂到作品卡片上」的标志。
   *
   * ⚠️ `.upload-actions` 是**最可靠的**一个：站点源码（`6907.*.js`）里
   * `hasUploadedFiles ? <div.upload-actions>（重新上传 / 开始评估） : <button.choose-btn>`
   * —— 也就是说，只要这个操作条出现，就说明附件真的挂上了；
   * 而 `.choose-btn` 还在 = 还没挂上。
   *
   * 只盯文件列表那几个类名是不够的：不同版本渲染的名字不一样，
   * 而且「文件名出现在页面上」并不等于「已挂到作品卡片上」。
   */
  uploadedFiles: [
    '.upload-actions',
    '.uploaded-files',
    '.uploaded-images',
    '.doc-preview-wrap',
    '.submitted-file',
    '.uploaded-file-item',
    '.file-item',
    '[class*="uploaded-file"]',
  ],
  /** 已上传待评估时的操作条（「重新上传 / 开始评估」）。 */
  uploadActions: ['.upload-actions'],
  /** 「开始评估」按钮（上传成功后才会出现）。 */
  evaluateBtn: [
    '.evaluate-btn',
    'button[class*="evaluate"]',
    '.start-eval-btn',
    'button[class*="start-eval"]',
    '[class*="evaluate-btn"]',
  ],
  /** 「重新上传」按钮（表示文件已挂上）。 */
  reuploadBtn: ['.reupload-btn'],
  /** 附件选择器弹层（用于判断是否残留、以及复位）。 */
  filePickerOverlay: ['.file-picker-iframe-overlay'],
  chooseBtn: ['.choose-btn', 'button[class*="choose"]'],
  completedView: ['.completed-view'],
  initDialog: ['.init-dialog', '[class*="init-dialog"]'],
  /** 初始化提示弹窗的**确认**按钮（文案是「直接来吧」）。 */
  initDialogBtn: [
    '.init-dialog__btn--primary',
    '.init-dialog__footer .init-dialog__btn--primary',
    '.init-dialog [class*="primary"]',
  ],
  /** 初始化提示弹窗的次要按钮（「我再想想」/关闭），只用于兜底关闭。 */
  initDialogCancel: ['.init-dialog__btn--secondary', '.init-dialog__close'],
  /** 「进入任务」按钮（出现在「即将作答」的卡片上）。 */
  enterTaskBtn: [
    '.flow-card-enter-btn',
    'button[class*="enter-btn"]',
    '[class*="enter-task"]',
    'button[class*="enterTask"]',
  ],
  /**
   * 「整条任务流已完成」的标记。
   *
   * 真机实测：全部节点做完后，`.flow-card-list` 末尾会多出一个
   * `article.flow-card.flow-card--done`，里面是 `.task-done-row` + 「任务已完成 /
   * 查看最终评估结果」。⚠️ 它**没有 `.task-type` 也没有 `h3`**，
   * 如果当成普通节点读，会得到「类型 unknown、未完成」的幽灵节点 ——
   * 编排器会以为还有活要干，于是永远收不了尾。
   */
  doneMarker: ['.flow-card--done', '.task-done-row', '[class*="task-done"]'],
  /**
   * 「最终评估还没生成」的汇总行。
   *
   * 站点源码（`6727.*.js`）里的判定是 `0 === recordStatus`：
   * ```
   * 0 === recordStatus
   *   ? <div class="task-done-row task-done-row--pending" @click="handleSummaryPendingClick">
   *       任务已完成 / 查看最终评估结果
   *   : <div class="task-done-row">
   *       <div class="task-done-score">最终评估得分：<strong class="task-done-score-num">96</strong>
   * ```
   *
   * ⚠️ **所有节点做完 ≠ 任务完成**：还要点这一行、在弹出的对话框里点「开始评估」，
   * 才会生成最终评估并回写成绩。不做这一步，学习计划里会一直显示 0% / 未达标 ——
   * 用户看到的就是「跑完了但好像没用」。
   */
  summaryPendingRow: ['.task-done-row--pending', '[class*="task-done-row--pending"]'],
  /** 最终评估得分容器。 */
  summaryScore: ['.task-done-score-num', '.task-done-score'],
  /**
   * 对话节点「已达标、等待开始评估」的提示块（真机实测结构）。
   *
   * ```html
   * <div class="complete newChapeter wrap1000">          <!-- 989x84，可点 -->
   *   <div class="taskChainCompleteText">已完成作答轮数要求，点击开始评估</div>   <!-- 292x50 -->
   * </div>
   * ```
   *
   * ⚠️ 这是**对话节点「开始评估」的唯一入口**，而且它的文案是
   * 「已完成作答轮数要求，点击开始评估」（16 字）—— 超过按文案找按钮的 14 字上限，
   * 所以**按文案永远找不到它**。不专门处理，就会出现
   * 「对话其实早就达标了，助手还在傻等提问，『开始评估』只能自己点」。
   */
  dialogueCompleteText: ['.taskChainCompleteText', '[class*="taskChainCompleteText"]'],
  /** 提示块的可点容器（优先点它，文案节点多半只是里面的文字）。 */
  dialogueCompleteBlock: [
    '.complete.newChapeter',
    '.rightBox .complete',
    '[class*="newChapeter"]',
    '.complete.wrap1000',
  ],
} as const;

/**
 * 「不是节点」的卡片类名特征。
 *
 * 这些是列表里的装饰/状态行（例如任务全部完成后的汇总行），必须排除，
 * 否则会多出一个永远不可能完成的节点。
 */
export const NOISE_CARD_CLASS_RE = /flow-card--(done|placeholder|add|empty)/;

/**
 * 「解锁下一节点条件」里的目标节点选择器。
 *
 * 结构：`<div class="unlock-target"><p>上传作品</p><h4>假设验证与修复</h4></div>` ——
 * `p` 是节点类型，`h4` 是标题。后续节点在完成当前节点前不会渲染成卡片，
 * 只能从这里读到。
 */
export const FLOW_UPCOMING_TARGET = '.unlock-target';

/** 文件选择器页面选择器。 */
export const PICKER_SELECTORS = {
  root: ['#attCommonApp', '.attCommon'],
  uploadInput: ['input.attCommonUploadBtn', 'input[type="file"]'],
  localTab: ['.tab-item'],
  chooseLocalBtn: ['.upload-box .modal-btn'],
  confirmBtn: ['.modal-btn-tip .flex'],
  uploadBox: ['.upload-box'],
  fileTable: ['.el-table__body-wrapper', '.table-box'],
  checkedRows: ['.el-table__body .el-checkbox__original:checked', '.el-checkbox__original:checked'],
} as const;

/**
 * 动作按钮的文案词表。
 *
 * 这里刻意用「文案匹配」而不是脆弱的结构选择器：这些按钮由不同组件渲染，
 * 类名不统一（`.pc_btn` / `.choose-btn` / `.modal-btn` / 纯 `.el-button`），
 * 但文案在各版本间相当稳定。按数组顺序取首个命中。
 */
export const FLOW_ACTIONS = {
  /** 对话节点开场页上的按钮（pcStudentIndex）。 */
  startDialogue: ['开始对话', '继续上次练习', '开始新练习', '开始练习', '开始作答', '进入对话'],
  /** 对话结束后的收尾按钮。 */
  finishDialogue: [
    '完成对话',
    '结束对话',
    '结束练习并提交',
    '结束本次练习',
    '提交对话',
    '结束作答',
    '完成并提交',
    '提交',
  ],
  /** 进入评估。 */
  startEvaluate: [
    '开始评估',
    '提交并评估',
    '生成评估报告',
    '开始评测',
    '查看评估',
    '生成报告',
    '查看报告',
    '去评估',
    '查看成绩',
  ],
  /**
   * 整条任务流的**最终评估**入口。
   *
   * 流程收尾时列表末尾会出现「任务已完成 / 查看最终评估结果」的汇总行，
   * 点它弹出的对话框里，确认按钮的文案是「开始评估」（加载中变成「评估中...」）。
   * 注意它和单个节点的「开始评估」不是同一个东西，但可以共用这一份词表。
   */
  finalEvaluate: ['开始评估', '查看最终评估结果', '生成最终评估', '立即评估'],
  /** 上传节点选择文件。 */
  chooseFile: ['选择文件', '上传文件', '添加附件', '选择本地文件', '上传'],
  /** 通用确认。 */
  confirm: ['确定', '确认', '提交', '保存'],
  /** 跳转下一节点。 */
  nextNode: ['下一节点', '下一步', '进入下一节点', '继续', '去下一个任务'],
  /**
   * 「进入任务」按钮。
   *
   * 为什么必须点它而不是点卡片：页面的 `selectTask(task)` 第一行就是
   * `if (task.upcoming) return;` —— 即将作答的卡片**点了没有反应**，
   * 唯一入口是它上面的 `.flow-card-enter-btn`。
   */
  enterTask: ['进入任务', '开始任务', '进入作答'],
  /**
   * 初始化提示弹窗的确认文案。
   *
   * 点「进入任务」会弹出该提示，确认按钮的文案是**「直接来吧」**
   * （点它会调 `taskChainInit` 接口，之后任务流刷新、该节点才变成当前节点）。
   *
   * ⚠️ 这里**绝不能**包含「继续」这类词：其他弹窗（例如提交确认）里也有，
   * 误点会造成非预期提交。真遇到文案对不上时，`dismissInitDialog` 会退回
   * 「弹窗里的主按钮选择器」，而不是随便点一个。
   */
  initDialogOk: ['直接来吧', '我知道了', '知道了', '确定', '开始', '进入', '立即进入'],
} as const;

/** 「上传」类节点的文案特征。 */
const UPLOAD_HINT_RE = /上传|作品|附件|文件|文档|提交材料|作业|成果/;

/** 「对话」类节点的文案特征。 */
const DIALOGUE_HINT_RE = /对话|情景|互动|故事|思辨|口语|代码|思维|研讨|答辩|评审|汇报|追问|模拟/;

/** 节点类型文案 → 内部类型。 */
export function classifyNodeType(typeLabel: string): FlowNodeType {
  const text = (typeLabel || '').trim();
  if (!text) return 'unknown';
  if (UPLOAD_HINT_RE.test(text)) return 'upload';
  if (DIALOGUE_HINT_RE.test(text)) return 'dialogue';
  return 'unknown';
}

/**
 * 当 `.task-type` 读不到（卡片还没渲染完整、或站点改版把该类名去掉了）时，
 * 从卡片整段文案里推断节点类型。
 *
 * 这一层很重要：以前 `.task-type` 读空会直接落到 `unknown`，
 * 而编排器把「不是 upload」一律当成对话节点处理 ——
 * 于是「第一个节点是上传作品」时会被拿去跑对话，永远传不上文件。
 *
 * @param text 卡片可见文案（标题 + 说明 + 完成条件）。
 */
export function inferNodeTypeFromText(text: string): FlowNodeType {
  const t = (text || '').trim();
  if (!t) return 'unknown';
  const upload =
    /上传|选择文件|提交作品|作品要求|作品标题|附件|\.docx?|文档格式|不少于\s*\d+\s*字/.test(t);
  const dialogue = /对话|情景|回复|作答|追问|模拟|互动|轮次/.test(t);
  if (upload && !dialogue) return 'upload';
  if (dialogue && !upload) return 'dialogue';
  if (upload) return 'upload';
  if (dialogue) return 'dialogue';
  return 'unknown';
}

/** 节点类型 → 展示名。 */
export const NODE_TYPE_LABEL: Record<FlowNodeType, string> = {
  dialogue: '情景对话',
  upload: '上传作品',
  unknown: '未知',
};
