import { LOG_BUFFER_SIZE, LOG_PREFIX } from './constants';
import type { LogEntry } from '@/types';

/**
 * 轻量日志器。
 *
 * 设计目标（对应文档「所有关键节点打日志：[CX-AI][state] ...」）：
 * - 统一前缀与 scope，便于在 DevTools 中按 `[CX-AI]` 过滤；
 * - 状态迁移日志固定输出 `[CX-AI][state] ...` 格式；
 * - 在内存中维护环形缓冲区，用户可在 Popup 中一键导出，方便反馈问题。
 */

const buffer: LogEntry[] = [];

/** 当前运行环境是否开启了详细日志（保留调试开关）。 */
let verbose = true;

/** 开关详细日志输出。 */
export function setVerbose(value: boolean): void {
  verbose = value;
}

function push(level: LogEntry['level'], scope: string, text: string): void {
  buffer.push({ ts: Date.now(), level, scope, text });
  if (buffer.length > LOG_BUFFER_SIZE) buffer.splice(0, buffer.length - LOG_BUFFER_SIZE);
}

/**
 * 创建一个带作用域的日志器。
 *
 * @param scope 作用域名，建议使用文件/模块名，例如 `content:state`。
 * @returns 日志器实例。
 */
export function createLogger(scope: string) {
  const prefix = `${LOG_PREFIX}[${scope}]`;

  const emit = (level: LogEntry['level'], text: string, args: unknown[]) => {
    push(level, scope, text);
    if (!verbose && level === 'debug') return;
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fn.call(console, prefix, text, ...args);
  };

  return {
    debug: (text: string, ...args: unknown[]) => emit('debug', text, args),
    info: (text: string, ...args: unknown[]) => emit('info', text, args),
    warn: (text: string, ...args: unknown[]) => emit('warn', text, args),
    error: (text: string, ...args: unknown[]) => emit('error', text, args),
    /**
     * 状态机迁移日志，固定格式 `[CX-AI][state] STATE -> message`。
     *
     * @param state 目标状态名。
     * @param text 附加描述。
     */
    state: (state: string, text = '') => emit('info', `[state] ${state}${text ? ' → ' + text : ''}`, []),
  };
}

/** 日志器类型。 */
export type Logger = ReturnType<typeof createLogger>;

/** 读取当前上下文的内存日志（用于导出）。 */
export function getLogBuffer(): LogEntry[] {
  return [...buffer];
}

/** 清空内存日志。 */
export function clearLogBuffer(): void {
  buffer.length = 0;
}

/**
 * 将日志条目渲染为纯文本，便于复制/下载。
 *
 * @param entries 日志条目；不传则使用当前缓冲区。
 * @returns 每行一条的文本。
 */
export function formatLogs(entries?: LogEntry[]): string {
  const list = entries ?? getLogBuffer();
  return list
    .map((e) => {
      const time = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      return `${time} [${e.level.toUpperCase()}] [${e.scope}] ${e.text}`;
    })
    .join('\n');
}
