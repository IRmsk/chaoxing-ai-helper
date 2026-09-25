import type { SelectorKey } from '@/types';

/**
 * 学习通 DOM 适配层（最易失效的部分）。
 *
 * 学习通前端是 `mooc2-ans-vue` 构建产物，类名多为哈希。因此这里采用
 * 「**真实站点选择器优先 + 多级回退 + 关键字包含**」策略：
 *
 * - 数组靠前的条目来自真实页面实测（AI 实践对话窗口），命中率最高；
 * - 后面是通用回退候选，用于同站其他页面或站点改版后的兜底；
 * - 全部失败时，由 `@/content/detector` 的启发式嗅探兜底；
 * - 用户仍可通过「选择器调试模式」手动点选，结果写入 storage 覆盖本表。
 *
 * > **真实结构**（AI 实践页 `taskDialogue/pcDialogue`，2026-09 实测）：
 * > ```
 * > .taskChainRightBox > .actOne > .dialogueMain
 * >  ├ .chat > .wrap1000                     ← 消息列表
 * >  │   ├ h3.chapterName                    ← 章节名（非消息，靠选择器天然避开）
 * >  │   ├ div.agent                         ← AI 消息
 * >  │   │   ├ span.agentHead > img          ← 头像
 * >  │   │   └ div.agentRight
 * >  │   │       ├ div.agentName             ← 「测评专家」（发言人名，不算正文）
 * >  │   │       └ div.agentAnswer > div.answer_content > p   ← AI 正文
 * >  │   └ div.user-chat-item                ← 我方消息包裹层
 * >  │       ├ div.userRight
 * >  │       │   ├ div.userName              ← 「初级分析师」
 * >  │       │   └ div.userAnswer > 文本      ← 我方正文
 * >  │       └ span.userHead > img           ← 头像
 * >  └ .bottom.relativeClass
 * >      ├ .roundBx                          ← 轮次提示
 * >      ├ .dialogChapterRoleList            ← 出场角色
 * >      └ .sendMessage.sendMessageActive
 * >          ├ div > textarea.messageInput   ← 输入框
 * >          └ div.sendOptionBtn > span.sendBtn   ← 发送
 * > ```
 * >
 * > 注意：`.agent` 与 `.userAnswer` 是**兄弟节点**（都在 `.wrap1000` 下），
 * > 我方消息被 `.user-chat-item` 包了一层。
 * > 另外 `.messageInput` 在锁定时会追加 `messageInputLock`，
 * > 并出现 `span.goOnBtnSpan`（「继续」）用于解锁。
 * > ```
 */
export const SELECTORS: Record<SelectorKey, string[]> = {
  /* ---------------- A. AI 实践 / 对话根容器 ---------------- */
  chatRoot: [
    '[data-cxai-role="chat-root"]',
    // 真实站点：对话主体（同时容纳消息区与底栏）
    '.dialogueMain',
    '.taskChainRightBox',
    '.rightBox',
    // 通用回退
    '.answerBox',
    '.agentBox',
    '.chatBox',
    '.dialogueBox',
    '.questionBox',
    '#ai-practice-root',
    '[class*="ai-practice"]',
    '[class*="aiPractice"]',
    '[class*="chat-container"]',
    '[class*="chatContainer"]',
    '[class*="dialogue"]',
    '[class*="conversation"]',
    '[class*="aiChat"]',
    '[class*="ai-chat"]',
  ],

  /* ---------------- B. 消息列表容器 ---------------- */
  messageList: [
    '[data-cxai-role="message-list"]',
    // 真实站点：消息区（.agent / .user-chat-item 的共同父级）
    '.wrap1000',
    '.chat',
    // 通用回退
    '.answerList',
    '.agentList',
    '.messageList',
    '.recordList',
    '.dialogList',
    '[class*="message-list"]',
    '[class*="messageList"]',
    '[class*="msg-list"]',
    '[class*="chat-list"]',
    '[class*="record-list"]',
    '[class*="history-list"]',
  ],

  /* ---------------- C. 单条消息 ---------------- */
  messageItem: [
    '[data-cxai-role="message-item"]',
    // 真实站点：AI 与用户条目混排，用一个逗号选择器一次性拿下
    'div.agent, div.userAnswer',
    'div.agent',
    'div.userAnswer',
    '[class*="message-item"]',
    '[class*="messageItem"]',
    '[class*="msg-item"]',
    '[class*="chat-item"]',
  ],

  /* ---------------- D. AI（提问方）消息 ---------------- */
  messageItemAI: [
    '[data-cxai-role="message-ai"]',
    // 真实站点
    'div.agent',
    '.agent',
    // 兜底：仅取 AI 正文容器（用于页面只暴露正文时）
    '.agentAnswer',
    '[class*="message-item"][class*="left"]',
    '[class*="msg-item"][class*="left"]',
    '[class*="chat-item"][class*="left"]',
    '[class*="left-item"]',
    '[class*="is-left"]',
    '[class*="from-ai"]',
    '[class*="ai-msg"]',
    '[class*="robot"]',
    '[class*="assistant"]',
  ],

  /* ---------------- E. 用户（我方）消息 ---------------- */
  messageItemUser: [
    '[data-cxai-role="message-user"]',
    // 真实站点
    'div.userAnswer',
    '.userAnswer',
    '[class*="message-item"][class*="right"]',
    '[class*="msg-item"][class*="right"]',
    '[class*="chat-item"][class*="right"]',
    '[class*="right-item"]',
    '[class*="is-right"]',
    '[class*="from-user"]',
    '[class*="user-msg"]',
    '[class*="mine"]',
    '[class*="self"]',
  ],

  /* ---------------- F. 输入框 ---------------- */
  input: [
    '[data-cxai-role="input"]',
    // 真实站点（未锁定 / 已锁定两种 class 都能被它命中）
    'textarea.messageInput',
    '.messageInput',
    'textarea[class*="messageInput"]',
    'textarea[class*="input"]',
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="回答"]',
    'div[class*="input"] [contenteditable="true"]',
    'div[class*="editor"] [contenteditable="true"]',
    'div[contenteditable="true"]',
  ],

  /* ---------------- G. 发送按钮 ---------------- */
  sendBtn: [
    '[data-cxai-role="send"]',
    // 真实站点（位于 .sendOptionBtn 内；锁定时 class 追加 optionBtnLock）
    'span.sendBtn',
    '.sendBtn',
    'button[class*="send"]',
    'div[class*="send"][role="button"]',
    'span[class*="send"]',
    '[title*="发送"]',
    '[aria-label*="发送"]',
  ],

  /* ---------------- H. 「继续 / 开始作答」解锁按钮 ---------------- */
  unlockBtn: [
    '[data-cxai-role="unlock"]',
    // 真实站点
    'span.goOnBtnSpan',
    '.goOnBtnSpan',
    '.sendOptionBtn .goOnBtn',
    '[class*="goOnBtn"]',
    '[class*="continueBtn"]',
    '[class*="startBtn"]',
  ],
};

/**
 * 消息**正文容器**选择器（按侧别）。
 *
 * 为什么需要它：真实的 AI 消息条目里除了正文，还有**头像**和**发言人名**
 * （`.agentHead` / `.agentName`＝「测评专家」）。若直接取整个条目的文本，
 * 送给大模型的「提问」会变成「测评专家 项目启动会现场气氛严肃…」——
 * 发言人名污染了提问语义，也会干扰「是否收尾语」的判断。
 *
 * 命中时只取该容器内的文本；命中不到再退回「取整个条目但排除头像/人名」。
 */
export const CONTENT_SELECTORS: Record<'ai' | 'user', string[]> = {
  ai: [
    '.agentAnswer',
    '[class*="agentAnswer"]',
    '[class*="message-item"][class*="left"] [class*="content"]',
    '[class*="bubble"]',
  ],
  user: [
    '.userAnswer',
    '[class*="userAnswer"]',
    '[class*="message-item"][class*="right"] [class*="content"]',
    '[class*="bubble"]',
  ],
};

/**
 * 头像 / 昵称 / 时间戳等「非正文」元素选择器。
 *
 * 作为 `CONTENT_SELECTORS` 命中失败时的兜底：取整个条目文本，但要剔除这些节点，
 * 否则发言人名、时间会混进提问或作答。
 */
export const META_SELECTOR = [
  '[class*="agentHead"]',
  '[class*="userHead"]',
  '[class*="agentName"]',
  '[class*="userName"]',
  '[class*="Avatar"]',
  '[class*="avatar"]',
  '[class*="headImg"]',
  '[class*="time"]',
  '[class*="Time"]',
].join(', ');

/**
 * 群组容器选择器：优先在这些容器内查找输入框 / 发送按钮，
 * 避免命中页面上的搜索框（学习通顶栏也有输入框）。
 */
export const SCOPED_CONTAINERS: string[] = [
  // 真实站点
  '.dialogueMain',
  '.taskChainRightBox',
  '.sendMessage',
  // 通用
  '.answerBox',
  '.agentBox',
  '.chatBox',
  '[class*="ai-practice"]',
  '[class*="aiChat"]',
  '[class*="chat-container"]',
  '[class*="dialogue"]',
  '[class*="taskChain"]',
  '[class*="answer-wrap"]',
  '[class*="footer"]',
];

/**
 * 判定「AI 侧」的类名/属性关键字。
 *
 * 命中任意词即视为 AI 消息；与 `SELECTORS.messageItemAI` 形成双重判据。
 */
export const AI_HINTS = [
  // 真实站点
  'agent',
  'agentanswer',
  'agentright',
  // 通用
  'left',
  'ai',
  'robot',
  'bot',
  'assistant',
  'teacher',
  'system',
  'server',
  'remote',
  'other',
  'receive',
  'received',
  'ask',
  'question',
];

/**
 * 判定「用户侧」的类名/属性关键字。
 *
 * ⚠️ 注意不要加入 `answer`、`content` 这类**双方共用**的词：
 * 真实站点上 AI 正文的容器就叫 `.answer_content`、消息区叫 `.answerList`，
 * 一旦把它们算作用户侧，祖先容器会把 AI 消息「投票」成用户消息。
 */
export const USER_HINTS = [
  // 真实站点
  'useranswer',
  'user',
  // 通用
  'right',
  'self',
  'me',
  'mine',
  'my',
  'student',
  'client',
  'local',
  'sent',
  'own',
];

/**
 * 需要跳过的元素标签（嗅探时避免把脚本、样式当成消息）。
 */
export const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'LINK', 'META']);

/**
 * 需要跳过正文提取的「按钮类」元素。
 *
 * 学习通的「继续」（`span.goOnBtnSpan`）与「发送」（`span.sendBtn`）都是 `span`，
 * 且**可能就位于消息块内部**；若不排除，按钮文案会混进消息正文，干扰提问抓取与
 * 回复完成检测（长度一直在变）。
 */
export const SKIP_BUTTON_SELECTOR = 'button, [role="button"], [class*="btn" i], input[type="button"], input[type="submit"]';
