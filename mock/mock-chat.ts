/**
 * 模拟聊天窗口。
 *
 * 五种渲染模式用于覆盖 content 层的探测路径：
 * - `realSite`：**1:1 还原学习通 AI 实践页（`taskDialogue/pcDialogue`）的真实 DOM**
 *   （2026-09 用 CDP 直连真实页面抓到，见下方注释）；
 * - `keyword`：类名包含 message/chat 等关键字 → 命中 `SELECTORS` 候选表；
 * - `obfuscated`：类名替换为构建产物风格的哈希 → 只能靠启发式嗅探命中；
 * - `real`：早期猜测的结构（`.agent` / `.userAnswer` 为兄弟节点）；
 * - `realNested`：另一种可能的结构（我方消息嵌在对方条目内部）。
 */

export type MockMode = 'realSite' | 'keyword' | 'obfuscated' | 'real' | 'realNested' | 'flow';

/** AI 回复模板池（末尾都带提问，便于连续多轮）。 */
const AI_REPLIES = [
  '很好，你的理解基本到位。那我接着追问：如果把这个思路放到真实的课程场景里，你认为最先会遇到什么约束？请结合具体例子回答。',
  '这个角度很有意思。再深入一点：你提到的两点里，哪一点对最终效果影响更大？为什么？',
  '回答得不错。最后一个问题：如果让你用一句话向同学解释今天讨论的核心方法，你会怎么说？',
  '谢谢你的分享，本次 AI 实践到此结束。祝学习顺利！',
];

/** 生成构建产物风格的随机类名。 */
function hashName(prefix: string): string {
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${rand}`;
}

/** 模拟聊天窗口实例。 */
export interface MockChat {
  /** 销毁并清空容器。 */
  dispose(): void;
}

/**
 * 创建模拟聊天窗口。
 *
 * @param mount 挂载容器。
 * @param mode 渲染模式。
 * @returns 实例控制器。
 */
export function createMockChat(mount: HTMLElement, mode: MockMode): MockChat {
  if (mode === 'realSite') return createRealSiteChat(mount);
  if (mode === 'realNested') return createNestedRealChat(mount);
  if (mode === 'real') return createRealChat(mount);
  return createGenericChat(mount, mode);
}

/* ------------------------------------------------------------------ */
/* 模式 E：真实站点（CDP 实测结构，优先级最高）                          */
/* ------------------------------------------------------------------ */

/** AI 回复模板池（与真实站点一样带提问，便于连续多轮）。 */
const REAL_AI_QUESTIONS = [
  '项目启动会现场气氛严肃，你正准备向资深专家汇报对业务规则的理解。这是展示你逻辑梳理能力的关键时刻，你需要清晰陈述选定的题目，并尝试列出初步的条件桩和动作桩。',
  '这个“1”可没法让我看懂你的思路呀。请具体说说你选定的业务场景是什么？初步梳理出的条件桩和动作桩分别有哪些？',
  '同学，请停止这种无意义的输入。这无法推进项目。我需要你具体描述业务场景，并列出清晰的条件桩和动作桩。请认真思考后重新汇报。',
];

/**
 * 真实站点结构（学习通 `taskDialogue/pcDialogue`，2026-09 用 CDP 实测）：
 *
 * ```
 * .dialogueMain
 *  ├ .chat > .wrap1000                       ← 消息列表
 *  │   ├ h3.chapterName                      ← 章节名（非消息）
 *  │   ├ div.agent                           ← AI 消息（我方消息是它的**兄弟**）
 *  │   │   ├ span.agentHead > img            ← 头像
 *  │   │   └ div.agentRight
 *  │   │       ├ div.agentName               ← 「测评专家」（发言人名，不是正文）
 *  │   │       └ div.agentAnswer             ← ★ AI 正文容器
 *  │   │           └ div.answer_content > p
 *  │   └ div.user-chat-item                  ← 我方消息包裹层
 *  │       ├ div.userRight
 *  │       │   ├ div.userName                ← 「初级分析师」
 *  │       │   └ div.userAnswer              ← ★ 我方正文
 *  │       └ span.userHead > img
 *  └ .bottom.relativeClass
 *      └ div.sendMessage.sendMessageActive
 *          ├ div > textarea.messageInput     ← 输入框
 *          └ div.sendOptionBtn > span.sendBtn ← 发送
 * ```
 *
 * 这一模式是**回归基准**：AI 条目里含 `agentName`（发言人名），
 * 正文取错就会把「测评专家」当成提问的一部分。
 * 另外还会周期性给输入框加锁（`messageInputLock` + `disabled`，
 * 并出现 `span.goOnBtnSpan`「继续」），逼代码每轮都走一遍解锁流程。
 */
function createRealSiteChat(mount: HTMLElement): MockChat {
  mount.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'rightBox taskChainRightBox';
  box.innerHTML = `
    <div class="actOne">
      <div class="dialogueMain">
        <div class="chat">
          <div class="wrap1000"><h3 class="chapterName">逻辑要素梳理</h3></div>
        </div>
      </div>
      <div class="bottom relativeClass">
        <div class="roundBx">任务完成条件 3 / 25 轮</div>
        <div class="dialogChapterRoleList">出场角色：初级分析师（学生扮演的角色，负责完成从逻辑分析到测试设计的全过程）</div>
        <div class="sendMessage sendMessageActive">
          <div>
            <textarea class="messageInput" placeholder="请输入你的回答"></textarea>
          </div>
          <div class="sendOptionBtn">
            <span class="goOnBtnSpan" style="display:none">继续</span>
            <span class="sendBtn">发送</span>
          </div>
        </div>
      </div>
    </div>
  `;
  mount.appendChild(box);

  const list = box.querySelector<HTMLElement>('.wrap1000')!;
  const input = box.querySelector<HTMLTextAreaElement>('textarea.messageInput')!;
  const sendBtn = box.querySelector<HTMLElement>('.sendBtn')!;
  const unlockBtn = box.querySelector<HTMLElement>('.goOnBtnSpan')!;

  let replyIndex = 0;
  let streaming = false;

  /** 追加一条 AI 消息（真实结构：agentHead + agentRight > agentName + agentAnswer）。 */
  const appendAgent = (): HTMLElement => {
    const agent = document.createElement('div');
    agent.className = 'agent';
    agent.innerHTML = `
      <span class="agentHead"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></span>
      <div class="agentRight">
        <div class="agentName">测评专家</div>
        <div class="agentAnswer"><div class="answer_content"><p></p></div></div>
      </div>
    `;
    list.appendChild(agent);
    return agent.querySelector('.agentAnswer p')!;
  };

  /** 追加一条我方消息（真实结构：user-chat-item > userRight > userName + userAnswer）。 */
  const appendUser = (text: string): void => {
    const item = document.createElement('div');
    item.className = 'user-chat-item';
    item.innerHTML = `
      <div class="userRight">
        <div class="userName">初级分析师</div>
        <div class="userAnswer"></div>
      </div>
      <span class="userHead"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></span>
    `;
    item.querySelector('.userAnswer')!.textContent = text;
    list.appendChild(item);
  };

  /** 上锁：输入框禁用 + 出现「继续」，发送按钮置灰（与真实站点一致）。 */
  const lock = (): void => {
    input.disabled = true;
    input.classList.add('messageInputLock');
    sendBtn.classList.add('optionBtnLock');
    unlockBtn.style.display = '';
  };

  /** 解锁。 */
  const unlock = (): void => {
    input.disabled = false;
    input.classList.remove('messageInputLock');
    sendBtn.classList.remove('optionBtnLock');
    unlockBtn.style.display = 'none';
  };

  /** 模拟流式回复。 */
  const streamReply = async (fullText: string): Promise<void> => {
    streaming = true;
    const p = appendAgent();
    for (let i = 1; i <= fullText.length; i += 1) {
      p.textContent = fullText.slice(0, i);
      await new Promise((r) => setTimeout(r, 6));
    }
    streaming = false;
    lock(); // 回复结束 → 重新上锁，下一轮必须再点「继续」
  };

  unlockBtn.addEventListener('click', () => {
    if (unlockBtn.style.display === 'none') return;
    unlock();
  });

  sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('optionBtnLock')) return; // 锁定态点击无效（与真实一致）
    const text = input.value.trim();
    if (!text || streaming) return;
    appendUser(text);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const reply = REAL_AI_QUESTIONS[Math.min(replyIndex, REAL_AI_QUESTIONS.length - 1)];
    replyIndex += 1;
    setTimeout(() => void streamReply(reply), 300);
  });

  // 开场提问（锁定态，等点「继续」）
  appendAgent().textContent = REAL_AI_QUESTIONS[0];
  lock();

  return {
    dispose() {
      mount.innerHTML = '';
    },
  };
}

/* ------------------------------------------------------------------ */
/* 模式 D：真实层级（.userAnswer 嵌在 .agent 内部）                     */
/* ------------------------------------------------------------------ */

/**
 * 真实站点结构（由用户提供的 3 个选择器反推，层级完全对齐）：
 *
 * ```
 * .answerList
 *  └ div.agent                        ← 一轮问答（:nth-of-type(1) 即第 1 轮）
 *      ├ div.agentRight               ← div #1
 *      │   ├ div.agentLeft            ← div #1（头像）
 *      │   └ div.agentAnswer          ← div #2  ← 用户给的 :nth-of-type(2) 正对上
 *      │       └ div.answer_content > p         ← AI 提问正文
 *      └ div.userAnswer               ← div #2  ← 用户给的 :nth-of-type(2) 正对上
 *          └ div.answer_content > p             ← 我方作答正文（未作答时为空）
 * ```
 *
 * 这条结构的关键点：**`.userAnswer` 是 `.agent` 的后代**。
 * 若按「元素被其他候选包含就去重」，所有用户消息都会消失，
 * 而 `.agent` 的文本又是「提问 + 作答」混在一起 —— 正是线上「探测到了却读不对」的成因。
 *
 * 交互规则与 `real` 模式一致：初始锁定、点「继续」解锁、发送后流式回复并重新上锁。
 */
function createNestedRealChat(mount: HTMLElement): MockChat {
  mount.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'answerBox';
  box.innerHTML = `
    <div class="answerHead">AI 实践 · 模拟对话（真实层级）</div>
    <div class="answerList"></div>
    <div class="footer">
      <textarea class="messageInput messageInputLock" placeholder="请输入你的回答" disabled></textarea>
      <span class="goOnBtnSpan">继续</span>
      <span class="sendBtn optionBtnLock">发送</span>
    </div>
  `;
  mount.appendChild(box);

  const list = box.querySelector<HTMLElement>('.answerList')!;
  const input = box.querySelector<HTMLTextAreaElement>('textarea.messageInput')!;
  const unlockBtn = box.querySelector<HTMLElement>('.goOnBtnSpan')!;
  const sendBtn = box.querySelector<HTMLElement>('.sendBtn')!;

  let replyIndex = 0;
  let streaming = false;

  /** 追加一轮：一个 .agent，内部同时含 AI 提问与我方作答占位。 */
  const appendRound = (): { ai: HTMLElement; user: HTMLElement } => {
    const agent = document.createElement('div');
    agent.className = 'agent';
    agent.innerHTML = `
      <div class="agentRight">
        <div class="agentLeft"><span class="agentAvatar"></span></div>
        <div class="agentAnswer">
          <div class="answer_content"><p></p></div>
        </div>
      </div>
      <div class="userAnswer">
        <div class="answer_content"><p></p></div>
      </div>
    `;
    list.appendChild(agent);
    return {
      ai: agent.querySelector('.agentAnswer p')!,
      user: agent.querySelector('.userAnswer p')!,
    };
  };

  /** 上锁：输入框禁用 + 显示「继续」，发送按钮带 optionBtnLock。 */
  const lock = (): void => {
    input.disabled = true;
    input.classList.add('messageInputLock');
    sendBtn.classList.add('optionBtnLock');
    unlockBtn.style.display = '';
  };

  /** 解锁：输入框可写 + 隐藏「继续」，发送按钮去掉 optionBtnLock。 */
  const unlock = (): void => {
    input.disabled = false;
    input.classList.remove('messageInputLock');
    sendBtn.classList.remove('optionBtnLock');
    unlockBtn.style.display = 'none';
  };

  let currentRound = appendRound();

  /** 模拟流式回复（追加新一轮，把提问写进新一轮的 AI 段落）。 */
  const streamReply = async (fullText: string): Promise<void> => {
    streaming = true;
    currentRound = appendRound();
    for (let i = 1; i <= fullText.length; i += 1) {
      currentRound.ai.textContent = fullText.slice(0, i);
      list.scrollTop = list.scrollHeight;
      await new Promise((r) => setTimeout(r, 10));
    }
    streaming = false;
    // 回复结束 → 重新上锁，等待用户点「继续」
    lock();
  };

  unlockBtn.addEventListener('click', () => {
    if (unlockBtn.style.display === 'none') return;
    unlock();
  });

  sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('optionBtnLock')) return; // 锁定态点击无效（与真实一致）
    const text = input.value.trim();
    if (!text || streaming) return;
    // 真实站点：作答写进**当前轮** .agent 内部的 .userAnswer，而不是列表级新节点
    currentRound.user.textContent = text;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const reply = AI_REPLIES[Math.min(replyIndex, AI_REPLIES.length - 1)];
    replyIndex += 1;
    setTimeout(() => void streamReply(reply), 350);
  });

  // 开场提问（第 1 轮，锁定态等用户点「继续」）
  currentRound.ai.textContent =
    '你好，我是本课的 AI 实践助手。先来第一个问题：你如何理解本节提到的核心概念？请用两三句话说明。';
  lock();

  return {
    dispose() {
      mount.innerHTML = '';
    },
  };
}

/* ------------------------------------------------------------------ */
/* 模式 C：1:1 还原真实站点                                            */
/* ------------------------------------------------------------------ */

/**
 * 真实站点结构（与学习通 AI 实践页一致）：
 *
 * ```
 * .answerBox
 *  ├ .answerList
 *  │   ├ div.agent                        ← AI 消息
 *  │   │   └ .agentRight > .agentAnswer > .answer_content > p
 *  │   └ div.userAnswer                   ← 用户消息
 *  └ .footer
 *      ├ textarea.messageInput(.messageInputLock)   ← 锁定时 disabled
 *      ├ span.goOnBtnSpan「继续」                    ← 点击后解锁
 *      └ span.sendBtn(.optionBtnLock)                ← 锁定时带 optionBtnLock
 * ```
 *
 * 交互规则（刻意还原真实行为）：
 * - 初始锁定：输入框 `disabled` + `messageInputLock`，发送按钮带 `optionBtnLock`；
 * - 点「继续」→ 解锁，输入框可写、发送按钮可用；
 * - 发送后 → AI 流式回复，**回复结束会重新上锁并再次出现「继续」**，
 *   这样每一轮都会真实地走一遍解锁流程。
 */
function createRealChat(mount: HTMLElement): MockChat {
  mount.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'answerBox';
  box.innerHTML = `
    <div class="answerHead">AI 实践 · 模拟对话</div>
    <div class="answerList"></div>
    <div class="footer">
      <textarea class="messageInput messageInputLock" placeholder="请输入你的回答" disabled></textarea>
      <span class="goOnBtnSpan">继续</span>
      <span class="sendBtn optionBtnLock">发送</span>
    </div>
  `;
  mount.appendChild(box);

  const list = box.querySelector<HTMLElement>('.answerList')!;
  const input = box.querySelector<HTMLTextAreaElement>('textarea.messageInput')!;
  const unlockBtn = box.querySelector<HTMLElement>('.goOnBtnSpan')!;
  const sendBtn = box.querySelector<HTMLElement>('.sendBtn')!;

  let replyIndex = 0;
  let streaming = false;

  /** 追加一条 AI 消息（.agent 结构）。 */
  const appendAgent = (text: string): HTMLElement => {
    const agent = document.createElement('div');
    agent.className = 'agent';
    agent.innerHTML = `
      <div class="agentRight">
        <div class="agentLeft"><span class="agentAvatar"></span></div>
        <div class="agentAnswer">
          <div class="answer_content"><p></p></div>
        </div>
      </div>
    `;
    const p = agent.querySelector('p')!;
    p.textContent = text;
    list.appendChild(agent);
    return p;
  };

  /** 追加一条用户消息（.userAnswer 结构）。 */
  const appendUser = (text: string): void => {
    const user = document.createElement('div');
    user.className = 'userAnswer';
    user.innerHTML = `<div class="answer_content"><p></p></div>`;
    user.querySelector('p')!.textContent = text;
    list.appendChild(user);
  };

  /** 上锁：输入框禁用 + 显示「继续」，发送按钮带 optionBtnLock。 */
  const lock = (): void => {
    input.disabled = true;
    input.classList.add('messageInputLock');
    input.classList.remove('messageInput');
    input.classList.add('messageInput');
    sendBtn.classList.add('optionBtnLock');
    unlockBtn.style.display = '';
  };

  /** 解锁：输入框可写 + 隐藏「继续」，发送按钮去掉 optionBtnLock。 */
  const unlock = (): void => {
    input.disabled = false;
    input.classList.remove('messageInputLock');
    sendBtn.classList.remove('optionBtnLock');
    unlockBtn.style.display = 'none';
  };

  /** 模拟流式回复：逐字写入 .agent 的 <p>。 */
  const streamReply = async (fullText: string): Promise<void> => {
    streaming = true;
    const p = appendAgent('');
    for (let i = 1; i <= fullText.length; i += 1) {
      p.textContent = fullText.slice(0, i);
      list.scrollTop = list.scrollHeight;
      await new Promise((r) => setTimeout(r, 10));
    }
    streaming = false;
    // 回复结束 → 重新上锁，等待用户点「继续」
    lock();
  };

  /** 「继续」按钮：解锁。 */
  unlockBtn.addEventListener('click', () => {
    if (unlockBtn.style.display === 'none') return;
    unlock();
  });

  /** 发送按钮：仅未锁定时生效。 */
  sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('optionBtnLock')) return; // 锁定态点击无效（与真实一致）
    const text = input.value.trim();
    if (!text || streaming) return;
    appendUser(text);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const reply = AI_REPLIES[Math.min(replyIndex, AI_REPLIES.length - 1)];
    replyIndex += 1;
    setTimeout(() => void streamReply(reply), 350);
  });

  // 开场提问（锁定态，等用户点「继续」）
  appendAgent('你好，我是本课的 AI 实践助手。先来第一个问题：你如何理解本节提到的核心概念？请用两三句话说明。');
  lock();

  return {
    dispose() {
      mount.innerHTML = '';
    },
  };
}

/* ------------------------------------------------------------------ */
/* 模式 A / B：通用结构（关键词类名 / 混淆类名）                        */
/* ------------------------------------------------------------------ */

function createGenericChat(mount: HTMLElement, mode: Exclude<MockMode, 'real' | 'realNested' | 'realSite'>): MockChat {
  const C = {
    container: mode === 'keyword' ? 'chat-container' : hashName('c'),
    header: mode === 'keyword' ? 'chat-header' : hashName('h'),
    list: mode === 'keyword' ? 'chat-message-list' : hashName('l'),
    item: mode === 'keyword' ? 'message-item' : hashName('m'),
    itemAI: mode === 'keyword' ? 'message-item left' : `${hashName('m')} left`,
    itemUser: mode === 'keyword' ? 'message-item right' : `${hashName('m')} right`,
    avatar: mode === 'keyword' ? 'message-avatar' : hashName('a'),
    bubble: mode === 'keyword' ? 'message-bubble' : hashName('b'),
    footer: mode === 'keyword' ? 'chat-footer' : hashName('f'),
    input: mode === 'keyword' ? 'chat-input' : `${hashName('i')} chat-input`,
    send: mode === 'keyword' ? 'send-btn' : `${hashName('s')} send-btn`,
  };

  mount.innerHTML = '';
  const container = document.createElement('div');
  container.className = C.container;
  container.innerHTML = `
    <div class="${C.header}">AI 实践 · 模拟对话</div>
    <div class="${C.list}"></div>
    <div class="${C.footer}">
      <textarea class="${C.input}" placeholder="请输入你的回答"></textarea>
      <button class="${C.send}" type="button">发送</button>
    </div>
  `;
  mount.appendChild(container);

  const list = container.querySelector<HTMLElement>(`.${C.list.split(' ')[0]}`)!;
  const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
  const sendBtn = container.querySelector<HTMLButtonElement>('button')!;

  let replyIndex = 0;
  let streaming = false;

  /** 追加一条消息。 */
  const appendMessage = (role: 'ai' | 'user', text: string): HTMLElement => {
    const item = document.createElement('div');
    item.className = role === 'ai' ? C.itemAI : C.itemUser;
    const avatar = document.createElement('div');
    avatar.className = C.avatar;
    avatar.textContent = role === 'ai' ? 'AI' : '我';
    const bubble = document.createElement('div');
    bubble.className = C.bubble;
    bubble.textContent = text;
    item.append(avatar, bubble);
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    return item;
  };

  /** 模拟流式回复。 */
  const streamReply = async (fullText: string) => {
    streaming = true;
    const bubble = appendMessage('ai', '').querySelector<HTMLElement>(`.${C.bubble.split(' ')[0]}`)!;
    for (let i = 1; i <= fullText.length; i += 1) {
      bubble.textContent = fullText.slice(0, i);
      list.scrollTop = list.scrollHeight;
      await new Promise((r) => setTimeout(r, 12));
    }
    streaming = false;
  };

  /** 发送处理。 */
  const handleSend = () => {
    const text = input.value.trim();
    if (!text || streaming) return;
    appendMessage('user', text);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const reply = AI_REPLIES[Math.min(replyIndex, AI_REPLIES.length - 1)];
    replyIndex += 1;
    setTimeout(() => void streamReply(reply), 400);
  };

  sendBtn.addEventListener('click', handleSend);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });

  appendMessage('ai', '你好，我是本课的 AI 实践助手。先来第一个问题：你如何理解本节提到的核心概念？请用两三句话说明。');

  return {
    dispose() {
      mount.innerHTML = '';
    },
  };
}
