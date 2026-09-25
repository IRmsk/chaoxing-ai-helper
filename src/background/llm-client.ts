import { RETRY_DELAYS_MS } from '@/common/constants';
import { CxaiError, apiError, toCxaiError } from '@/common/errors';
import type { TestConnectionResult } from '@/common/messages';

/**
 * 大模型客户端（OpenAI 兼容协议）。
 *
 * 之所以做成「OpenAI 兼容」而不是写死 DeepSeek：
 * - 默认值填 DeepSeek 官方（`https://api.deepseek.com` + `deepseek-chat`）；
 * - 用户可改 Base URL 指向任意兼容端点（第三方中转、Ollama、SiliconFlow 等）；
 * - 模型列表通过 `GET {baseUrl}/models` 动态拉取，用户从下拉框选择。
 *
 * 所有请求都带超时与指数退避重试（见 `withRetry`）。
 */

/** OpenAI 协议下的对话消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 对话补全请求参数。 */
export interface ChatRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** 超时毫秒数。 */
  timeoutMs?: number;
  /** 外部中止信号。 */
  signal?: AbortSignal;
  /** 是否开启退避重试，默认开启。 */
  retry?: boolean;
}

/** 模型列表请求参数。 */
export interface ModelsRequest {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 规整 Base URL：去掉尾部斜杠，并剥离可能被用户误填的端点后缀。
 *
 * 允许的输入形态：
 * - `https://api.deepseek.com` → `https://api.deepseek.com`
 * - `https://api.deepseek.com/v1` → `https://api.deepseek.com/v1`
 * - `https://api.deepseek.com/chat/completions` → `https://api.deepseek.com`
 * - `https://api.deepseek.com/v1/chat/completions` → `https://api.deepseek.com/v1`
 *
 * @param raw 用户输入的原始地址。
 * @returns 规整后的根地址。
 */
export function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '');
  base = base.replace(/\/models$/i, '');
  return base.replace(/\/+$/, '');
}

/** 拼出对话补全端点。 */
export function buildChatUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** 拼出模型列表端点。 */
export function buildModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

/* ------------------------------------------------------------------ */
/* 重试                                                                */
/* ------------------------------------------------------------------ */

/**
 * 指数退避重试。
 *
 * 策略：首次失败后等待 1s，第二次失败后等待 3s，共 3 次尝试（1 次原始 + 2 次重试）。
 * 仅对可重试错误（网络 / 429 / 5xx）生效，401 等鉴权错误立即抛出。
 *
 * @param task 待执行任务。
 * @param signal 中止信号。
 * @returns 任务结果。
 */
async function withRetry<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await task();
    } catch (err) {
      lastError = err;
      const cxErr = toCxaiError(err);
      if (!cxErr.retryable || attempt === RETRY_DELAYS_MS.length) throw cxErr;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, RETRY_DELAYS_MS[attempt]);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  throw toCxaiError(lastError);
}

/* ------------------------------------------------------------------ */
/* 请求实现                                                            */
/* ------------------------------------------------------------------ */

/** 组合超时信号与外部中止信号。 */
function composeSignal(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(new DOMException('Aborted', 'AbortError'));
  external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 将 HTTP 状态码映射为可读的业务错误。
 *
 * @param status HTTP 状态码。
 * @param body 响应正文（截断后用于提示）。
 */
function mapHttpError(status: number, body: string): CxaiError {
  const brief = body.slice(0, 300);
  if (status === 401 || status === 403) {
    return apiError('API_UNAUTHORIZED', `鉴权失败（HTTP ${status}）：API Key 无效或已过期。${brief}`, false);
  }
  if (status === 429) {
    return apiError('API_RATE_LIMITED', `请求过于频繁或余额不足（HTTP 429）。建议增大「每轮间隔」。${brief}`, true);
  }
  if (status >= 500) {
    return apiError('API_SERVER', `服务端错误（HTTP ${status}），将自动重试。${brief}`, true);
  }
  return apiError('API_BAD_RESPONSE', `请求被拒绝（HTTP ${status}）：${brief}`, false);
}

/**
 * 调用对话补全接口，返回助手回复文本。
 *
 * @param req 请求参数。
 * @returns 助手回复正文。
 * @throws CxaiError（带 code / retryable）。
 */
export async function chatCompletion(req: ChatRequest): Promise<string> {
  const {
    apiKey,
    baseUrl,
    model,
    messages,
    temperature = 1.0,
    timeoutMs = 60_000,
    signal,
    retry = true,
  } = req;

  if (!apiKey?.trim()) throw apiError('API_CONFIG_MISSING', '未配置 API Key，请在扩展弹窗中填写', false);
  if (!model?.trim()) throw apiError('API_CONFIG_MISSING', '未配置模型名称，请在扩展弹窗中选择或填写', false);

  const run = async (): Promise<string> => {
    const { signal: composed, cleanup } = composeSignal(timeoutMs, signal);
    try {
      const resp = await fetch(buildChatUrl(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: model.trim(),
          messages,
          stream: false,
          temperature,
        }),
        signal: composed,
      });

      if (!resp.ok) throw mapHttpError(resp.status, await resp.text());

      let data: unknown;
      try {
        data = await resp.json();
      } catch {
        throw apiError('API_BAD_RESPONSE', '接口返回的不是合法 JSON，请确认 Base URL 指向 OpenAI 兼容端点', false);
      }

      const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
        ?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw apiError('API_BAD_RESPONSE', '接口返回内容为空，请检查模型名称是否正确', true);
      }
      return content.trim();
    } catch (err) {
      // fetch 网络层失败统一转为可重试错误
      if (err instanceof CxaiError) throw err;
      const name = (err as { name?: string })?.name;
      if (name === 'AbortError') throw apiError('ABORTED', '请求被中止', false);
      if (name === 'TimeoutError') throw apiError('API_NETWORK', '请求超时，请检查网络或增大「单次请求超时」', true);
      throw apiError('API_NETWORK', `网络请求失败：${(err as Error)?.message ?? String(err)}`, true);
    } finally {
      cleanup();
    }
  };

  return retry ? withRetry(run, signal) : run();
}

/**
 * 拉取可用模型列表（`GET {baseUrl}/models`）。
 *
 * @param req 请求参数。
 * @returns 模型 ID 数组（已排序去重）。
 */
export async function listModels(req: ModelsRequest): Promise<string[]> {
  const { apiKey, baseUrl, timeoutMs = 20_000, signal } = req;
  if (!apiKey?.trim()) throw apiError('API_CONFIG_MISSING', '请先填写 API Key', false);
  if (!baseUrl?.trim()) throw apiError('API_CONFIG_MISSING', '请先填写 Base URL', false);

  const { signal: composed, cleanup } = composeSignal(timeoutMs, signal);
  try {
    const resp = await fetch(buildModelsUrl(baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: composed,
    });
    if (!resp.ok) throw mapHttpError(resp.status, await resp.text());

    const data = (await resp.json()) as { data?: { id?: unknown }[] };
    const ids = (data?.data ?? [])
      .map((m) => (typeof m?.id === 'string' ? m.id : ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (ids.length === 0) {
      throw apiError('API_BAD_RESPONSE', '接口未返回任何模型，可能该端点不支持 /models，请手动填写模型名', false);
    }
    return Array.from(new Set(ids));
  } catch (err) {
    if (err instanceof CxaiError) throw err;
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError') throw apiError('API_NETWORK', '获取模型列表超时', true);
    throw apiError('API_NETWORK', `获取模型列表失败：${(err as Error)?.message ?? String(err)}`, true);
  } finally {
    cleanup();
  }
}

/**
 * 测试连接：优先走一次最小 token 的对话补全，并顺带尝试拉取模型列表。
 *
 * @param req 请求参数（`model` 可选；未提供时使用候选模型名做一次探测）。
 * @returns 连接测试结果。
 */
export async function testConnection(req: ModelsRequest & { model?: string }): Promise<TestConnectionResult> {
  const started = Date.now();
  let models: string[] | undefined;

  // 1) 先尝试拉模型列表：即使失败也不阻断，只作为附加信息
  try {
    models = await listModels(req);
  } catch {
    models = undefined;
  }

  const model = req.model?.trim() || models?.[0] || 'deepseek-chat';
  try {
    const reply = await chatCompletion({
      apiKey: req.apiKey,
      baseUrl: req.baseUrl,
      model,
      messages: [{ role: 'user', content: '你好，请只回复两个字：正常' }],
      temperature: 0,
      timeoutMs: 30_000,
      signal: req.signal,
      retry: false,
    });
    return {
      ok: true,
      message: `连接成功（模型 ${model}）：${reply.slice(0, 40)}`,
      latencyMs: Date.now() - started,
      models,
    };
  } catch (err) {
    const cxErr = toCxaiError(err);
    // 若会话失败但模型列表可用，给出更友好的结论
    if (models?.length) {
      return {
        ok: false,
        message: `模型列表可用，但对话测试失败：${cxErr.message}`,
        latencyMs: Date.now() - started,
        models,
      };
    }
    return { ok: false, message: cxErr.message, latencyMs: Date.now() - started };
  }
}
