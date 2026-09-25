/**
 * 真机 CDP 客户端的公共部分。
 *
 * 三个硬约束（本会话被它们坑过多次，全部固化在这里）：
 *
 * 1. **每请求必带超时**。浏览器级端点会整体卡死：TCP 通、HTTP 有响应，
 *    但 WS 请求永远不回包。不带超时就会永久挂住。
 * 2. 🚨 **`ws.close()` 之后必须等 close 事件再退进程**。
 *    `close()` 紧接 `process.exit()` 会在浏览器侧留下**半开连接**，
 *    把端点锁住 → 之后的握手全部超时（要等几十秒才恢复）。
 * 3. **不要 `await` 会让目标消失的调用**（典型：`chrome.runtime.reload()`），
 *    给个短超时然后 `.catch(() => {})`。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 常见浏览器的 DevToolsActivePort 位置。 */
export const PORT_FILES = [
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft/Edge/User Data/DevToolsActivePort'),
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google/Chrome/User Data/DevToolsActivePort'),
];

/** 读出浏览器级 WebSocket 地址。 */
export function readWsUrl() {
  if (process.env.CDP_PORT) return `ws://127.0.0.1:${process.env.CDP_PORT}`;
  for (const file of PORT_FILES) {
    if (!existsSync(file)) continue;
    const parts = readFileSync(file, 'utf8').split(/\r?\n/);
    if (parts[0] && parts[1]) return `ws://127.0.0.1:${parts[0]}${parts[1].trim()}`;
  }
  throw new Error('没找到 DevToolsActivePort（浏览器没开远程调试？跑 npm run cdp:check 看看）');
}

/**
 * 建立连接。
 *
 * ⚠️ 浏览器级端点很不稳定：短时间内多次连接后**会整体拒绝握手**，
 * 表现是 TCP 能连上但永远收不到 101，通常 20~60 秒后才自己恢复。
 * 所以这里内置重试（默认 6 次，间隔 8 秒），把「等一会儿再来」这件事自动化，
 * 免得每次调探针都要手动 sleep。
 *
 * @param onEvent 非响应消息的回调（`{ method, params, sessionId }`）。
 * @param options.tries 最大尝试次数。
 * @returns `{ send, close }`；`close()` 会等挥手完成再退进程。
 */
export async function connect(onEvent, options = {}) {
  const tries = options.tries ?? 6;
  let lastError = null;
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await connectOnce(onEvent);
    } catch (err) {
      lastError = err;
      if (i < tries) {
        process.stderr.write(`（第 ${i} 次连接失败：${err.message}，8 秒后重试…）\n`);
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  }
  throw lastError ?? new Error('连接失败');
}

function connectOnce(onEvent) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(readWsUrl());
    let seq = 0;
    const pending = new Map();
    const timer = setTimeout(
      () => rejectConn(new Error('连接超时（调试端点可能卡死，跑 npm run cdp:check）')),
      12_000,
    );

    const closer = async (code = 0) => {
      try {
        if (ws.readyState === 1) {
          await new Promise((resolve) => {
            const done = () => resolve();
            ws.addEventListener('close', done, { once: true });
            ws.close();
            setTimeout(done, 2000);
          });
        }
      } catch {
        /* 忽略 */
      }
      process.exit(code);
    };

    ws.addEventListener('error', () => rejectConn(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
        return;
      }
      if (m.method && onEvent) onEvent(m);
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolveConn({
        send(method, params = {}, sessionId, timeoutMs = 25_000) {
          const id = ++seq;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`${method} 超时`));
              }
            }, timeoutMs);
          });
        },
        close: closer,
      });
    });
  });
}

/** 简单命令行取值。 */
export function makeArgv() {
  const argv = process.argv.slice(2);
  return {
    argv,
    flags: argv.filter((a) => a.startsWith('--')),
    positional: argv.filter((a) => !a.startsWith('--')),
    has: (name) => argv.includes(`--${name}`),
    arg: (name, dflt) => {
      const i = argv.indexOf(`--${name}`);
      return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
    },
  };
}

/** 找到 URL 含 `filter` 的页面 target。 */
export async function findPage(cdp, filter) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return {
    targetInfos: targetInfos || [],
    page: (targetInfos || []).find((t) => t.type === 'page' && (t.url || '').includes(filter)),
  };
}
