/**
 * 真实页面探针：直连用户日常浏览器的 DevTools（CDP），在目标 frame 内运行诊断脚本。
 *
 * 前置条件：用户在 `edge://inspect/#remote-debugging` 勾选了
 * "Allow remote debugging for this browser instance"。
 *
 * 该模式下 Edge/Chrome **不提供** `/json/*` HTTP 端点，
 * 只开放浏览器级 WebSocket；端口与路径写在 profile 的 `DevToolsActivePort` 里。
 *
 * 用法：
 *   node scripts/probe-real.mjs [frame 关键字] [要注入的脚本] [后续求值表达式]
 *   node scripts/probe-real.mjs pcDialogue docs/console-probe.js
 *   node scripts/probe-real.mjs pcDialogue diag-dist/diag.js "JSON.stringify(window.__cxaiDiag(), null, 2)"
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PORT_FILE_CANDIDATES = [
  'C:/Users/20235/AppData/Local/Microsoft/Edge/User Data/DevToolsActivePort',
  'C:/Users/20235/AppData/Local/Google/Chrome/User Data/DevToolsActivePort',
];

const URL_KEYWORD = process.argv[2] || 'pcDialogue';
const SCRIPT_FILE = process.argv[3] || 'docs/console-probe.js';
/** 注入脚本后要额外求值的表达式（可选），用于读取脚本挂到 window 上的结果。 */
const FOLLOW_UP = process.argv[4] || null;

/** 读取 DevToolsActivePort（第一行端口，第二行浏览器 WS 路径）。 */
function readDevToolsPort() {
  for (const file of PORT_FILE_CANDIDATES) {
    if (!existsSync(file)) continue;
    const [port, wsPath] = readFileSync(file, 'utf8').split(/\r?\n/);
    if (port && wsPath) return { port: Number(port), wsPath: wsPath.trim(), file };
  }
  throw new Error('未找到 DevToolsActivePort —— 请先在 edge://inspect/#remote-debugging 勾选允许远程调试');
}

/** 极简 CDP 客户端（支持 flatten 模式的 sessionId 多路复用）。 */
function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else res(msg.result);
        return;
      }
      listeners.forEach((fn) => fn(msg));
    });
    ws.addEventListener('error', () => rejectConn(new Error(`WebSocket 连接失败：${wsUrl}`)));
    ws.addEventListener('open', () => {
      resolveConn({
        send(method, params = {}, sessionId) {
          const id = ++seq;
          return new Promise((res, reject) => {
            pending.set(id, { resolve: res, reject });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        on(fn) {
          listeners.push(fn);
        },
        close: () => ws.close(),
      });
    });
  });
}

async function main() {
  const { port, wsPath, file } = readDevToolsPort();
  console.log(`DevToolsActivePort：${file}`);
  console.log(`浏览器：ws://127.0.0.1:${port}${wsPath}\n`);

  const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`);

  const { targetInfos } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page' || t.type === 'iframe');
  console.log(`候选页面 ${pages.length} 个：`);
  for (const t of pages) console.log(`  - ${(t.url || '').slice(0, 110)}`);
  console.log('');

  const script = readFileSync(join(ROOT, SCRIPT_FILE), 'utf8');

  /**
   * 逐个候选页面 attach 并取 frame 树，找出「frame 树里含有目标 frame」的那一个。
   *
   * 不能只看页面 URL —— AI 实践的真实对话界面是页面内的一个 **iframe**
   * （`taskChain/student/answer` 里套 `taskDialogue/pcDialogue`），
   * 必须用 frame 关键字才能定位到真正的执行上下文。
   */
  let attached = null;
  for (const page of pages) {
    let sessionId;
    try {
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
    } catch {
      continue;
    }
    const contexts = [];
    const onMessage = (msg) => {
      if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    };
    cdp.on(onMessage);
    const send = (method, params) => cdp.send(method, params, sessionId);
    try {
      await send('Runtime.enable');
      await send('Page.enable');
      await new Promise((r) => setTimeout(r, 800));
      const { frameTree } = await send('Page.getFrameTree');
      const frames = [];
      const walk = (node) => {
        frames.push(node.frame);
        (node.childFrames ?? []).forEach(walk);
      };
      walk(frameTree);
      const matchedFrames = frames.filter((f) => (f.url || '').includes(URL_KEYWORD));
      if (matchedFrames.length > 0) {
        attached = { page, sessionId, contexts, frames: matchedFrames, send };
        break;
      }
    } catch {
      /* 这个页面不可 attach，继续找 */
    }
  }

  if (!attached) throw new Error(`所有候选页面里都没有匹配「${URL_KEYWORD}」的 frame`);

  console.log(`命中页面：${attached.page.url.slice(0, 120)}`);
  console.log(`命中 frame ${attached.frames.length} 个\n`);

  for (const frame of attached.frames) {
    console.log('='.repeat(70));
    console.log(`frame：${frame.url.slice(0, 140)}`);
    const ctx = attached.contexts.find(
      (c) => c.auxData?.frameId === frame.id && c.auxData?.isDefault,
    );
    if (!ctx) {
      console.log('（没有可用的执行上下文，跳过 —— 可能是跨进程 iframe）\n');
      continue;
    }
    try {
      const result = await attached.send('Runtime.evaluate', {
        expression: script,
        contextId: ctx.id,
        returnByValue: true,
        // 允许脚本本身是 async IIFE（需要等 Promise 才有返回值）
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        console.log('执行异常：', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      } else if (FOLLOW_UP) {
        const follow = await attached.send('Runtime.evaluate', {
          expression: FOLLOW_UP,
          contextId: ctx.id,
          returnByValue: true,
          awaitPromise: true,
        });
        if (follow.exceptionDetails) {
          console.log('后续求值异常：', follow.exceptionDetails.exception?.description ?? follow.exceptionDetails.text);
        } else {
          console.log(follow.result.value ?? '(空)');
        }
      } else {
        console.log(result.result.value ?? '(空)');
      }
    } catch (err) {
      console.log('求值失败：', err.message);
    }
    console.log('');
  }

  cdp.close();
}

await main().catch((err) => {
  console.error('探针失败：', err.message);
  process.exit(1);
});
