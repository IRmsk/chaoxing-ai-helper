import { MAX_CONTEXT_MESSAGES } from '@/common/constants';
import type { ChatMessage } from './llm-client';

/**
 * 对话上下文管理。
 *
 * 目的（对应文档 4.6）：让 DeepSeek 的回答在多轮之间保持连贯 —— 每轮把
 * 「AI 提问 + 我方作答」压入历史，下轮请求时一并带上。
 *
 * 持久化策略：写入 `chrome.storage.session`。
 * MV3 的 Service Worker 随时可能被回收，纯内存 Map 会丢历史；
 * 而 `session` 区域在浏览器会话期间有效、且不落盘到用户磁盘，兼顾健壮与隐私。
 */

const KEY_PREFIX = 'cxai:ctx:';

/** 读取某课程的对话历史。 */
async function readHistory(courseId: string): Promise<ChatMessage[]> {
  const key = KEY_PREFIX + courseId;
  try {
    const result = await chrome.storage.session.get(key);
    const value = result[key];
    return Array.isArray(value) ? (value as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** 写入某课程的对话历史（自动按上限截断，始终保留最近 N 条）。 */
async function writeHistory(courseId: string, history: ChatMessage[]): Promise<void> {
  const key = KEY_PREFIX + courseId;
  const trimmed = history.slice(-MAX_CONTEXT_MESSAGES);
  try {
    await chrome.storage.session.set({ [key]: trimmed });
  } catch {
    /* session 存储不可用时降级为「仅本次请求内存有效」，不影响主流程 */
  }
}

/**
 * 构造本轮请求的完整消息数组。
 *
 * 页面背景资料（任务介绍 / 出场角色 / 完成条件 / 任务流）会被拼进 **system 消息**，
 * 而不是单独加一条 system —— 部分兼容 OpenAI 协议的端点只接受一条 system。
 * 它每轮重新采集，所以轮次进度之类的动态内容也是最新的。
 *
 * @param courseId 课程 ID（历史分桶键）。
 * @param systemPrompt 系统提示词。
 * @param question 本轮抓取到的 AI 提问。
 * @param pageContext 对话之外的整页文字（可为空）。
 * @returns `[system, ...history, user(question)]`。
 */
export async function buildMessages(
  courseId: string,
  systemPrompt: string,
  question: string,
  pageContext = '',
): Promise<ChatMessage[]> {
  const history = await readHistory(courseId);
  const context = pageContext.trim();
  const system = context
    ? `${systemPrompt}\n\n【页面背景资料】\n以下是本任务页面上的文字（任务介绍、出场角色、完成条件、任务流等），请结合它理解任务要求，但不要复述这些文字：\n${context}`
    : systemPrompt;
  return [
    { role: 'system', content: system },
    ...history.slice(-MAX_CONTEXT_MESSAGES),
    { role: 'user', content: question },
  ];
}

/**
 * 记录一轮完整的问答（在发送成功后调用）。
 *
 * @param courseId 课程 ID。
 * @param question 本轮 AI 提问。
 * @param answer 我方提交的答案。
 */
export async function pushTurn(courseId: string, question: string, answer: string): Promise<void> {
  const history = await readHistory(courseId);
  history.push({ role: 'user', content: question });
  history.push({ role: 'assistant', content: answer });
  await writeHistory(courseId, history);
}

/** 清空某课程的对话上下文。 */
export async function resetHistory(courseId: string): Promise<void> {
  await writeHistory(courseId, []);
}

/** 读取上下文条数（用于 Popup 诊断展示）。 */
export async function historyLength(courseId: string): Promise<number> {
  return (await readHistory(courseId)).length;
}
