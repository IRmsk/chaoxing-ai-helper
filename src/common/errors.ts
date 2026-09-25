/**
 * 统一错误类型。
 *
 * 通过 `code` 让上层状态机能够区分「可重试」与「必须让用户介入」的错误，
 * 并给出对应的中文提示。
 */

export type CxaiErrorCode =
  | 'NOT_DETECTED'
  | 'DETECT_FAILED'
  | 'QUESTION_TIMEOUT'
  | 'API_CONFIG_MISSING'
  | 'API_UNAUTHORIZED'
  | 'API_RATE_LIMITED'
  | 'API_NETWORK'
  | 'API_SERVER'
  | 'API_BAD_RESPONSE'
  | 'FILL_FAILED'
  | 'SEND_FAILED'
  | 'REPLY_TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'ABORTED'
  | 'UNKNOWN';

/** 业务错误基类。 */
export class CxaiError extends Error {
  readonly code: CxaiErrorCode;
  /** 是否可以通过「重试」恢复。 */
  readonly retryable: boolean;

  constructor(code: CxaiErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'CxaiError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 便捷构造：检测类错误（不可自动恢复，需要用户检查页面 / 选择器）。 */
export const detectError = (msg: string) => new CxaiError('DETECT_FAILED', msg, true);

/** 便捷构造：网络/接口类错误（可重试）。 */
export const apiError = (code: CxaiErrorCode, msg: string, retryable = true) => new CxaiError(code, msg, retryable);

/** 便捷构造：用户主动中止。 */
export const abortedError = () => new CxaiError('ABORTED', '任务已被用户停止', false);

/**
 * 将任意异常规整为 CxaiError，保证 `code` 始终可用。
 *
 * @param err 原始异常。
 * @returns 规整后的 CxaiError。
 */
export function toCxaiError(err: unknown): CxaiError {
  if (err instanceof CxaiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new CxaiError('ABORTED', '请求已取消', false);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new CxaiError('UNKNOWN', msg, true);
}
