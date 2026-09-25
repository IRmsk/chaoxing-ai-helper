/**
 * 在真实浏览器里重载扩展并做在线确认测试。
 *
 * 流程：
 * 1. 从 Service Worker 上下文调用 `chrome.runtime.reload()`（等价于点「重新加载」）；
 * 2. 重载页面，让内容脚本以新代码重新注入；
 * 3. 在扩展的**隔离世界**里断言 `chrome.storage.session` 已可访问
 *    （这是本次「上传文件传不上去」的根因）；
 * 4. 断言任务流宿主 frame 上挂载了悬浮面板（「刷新后按钮消失」的修复）；
 * 5. 持续收集 `[CX-AI]` 控制台日志，观察任务流编排器是否自动跑起来。
 *
 * 用法：node scripts/_verify-live.mjs [观察秒数]
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const PORT_FILE = 'C:/Users/20235/AppData/Local/Microsoft/Edge/User Data/DevToolsActivePort';
const EXT_NAME = '学习通 AI 实践助手';
const EXT_ID = 'bchoabeopfimnaafmciekpekanogildf';
const WATCH_SECONDS = Number(process.argv[2] || 40);

const LOG_FILE = 'C:/Users/20235/Desktop/ai实践/chaoxing-ai-helper/.verify-live.log';
try {
  writeFileSync(LOG_FILE, '');
} catch {
  /* 忽略 */
}

function readPort() {
  const [port, wsPath] = readFileSync(PORT_FILE, 'utf8').split(/\r?\n/);
  return { port: Number(port), wsPath: wsPath.trim() };
}

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
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      listeners.forEach((fn) => fn(msg));
    });
    ws.addEventListener('error', () => rejectConn(new Error('WS 失败')));
    ws.addEventListener('open', () =>
      resolveConn({
        send(method, params = {}, sessionId, timeoutMs = 15000) {
          const id = ++seq;
          return new Promise((res, reject) => {
            pending.set(id, { resolve: res, reject });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            // ⚠️ 必须带超时：重载扩展会让 Service Worker target 直接消失，
            // 此时对应的请求永远不会返回，没有超时就会永久挂住（踩过一次）。
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(method + ' 超时'));
              }
            }, timeoutMs);
          });
        },
        on(fn) {
          listeners.push(fn);
        },
        close: () => ws.close(),
      }),
    );
  });
}

function trace(line) {
  process.stdout.write(line + '\n');
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* 忽略 */
  }
}

const { port, wsPath } = readPort();
const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`);

/* ---------------- 1) 重载扩展 ---------------- */
{
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw) {
    trace('✗ 未找到扩展的 Service Worker，无法自动重载');
    process.exit(1);
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  // 不等响应：SW 会在重载瞬间被销毁，请求不会有回包
  cdp
    .send('Runtime.evaluate', { expression: 'chrome.runtime.reload()', returnByValue: true }, sessionId, 4000)
    .catch(() => {});
  trace('✓ 已请求扩展重载（chrome.runtime.reload）');
  await new Promise((r) => setTimeout(r, 5000));
}

/* ---------------- 2) 重载页面并挂监听 ---------------- */
const { targetInfos } = await cdp.send('Target.getTargets');
const page = targetInfos.find((t) => (t.url || '').includes('taskChain/student/answer'));
if (!page) {
  trace('✗ 未找到任务流页面');
  process.exit(1);
}
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const send = (m, p) => cdp.send(m, p, sessionId);

const contexts = [];
cdp.on((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
  if (msg.method === 'Runtime.executionContextsCleared') contexts.length = 0;
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
      .join(' ');
    if (text.includes('[CX-AI]')) trace('  📋 ' + text.replace(/\s+/g, ' ').slice(0, 300));
  }
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: false });
trace('✓ 已重载页面，等待内容脚本注入…\n');
await new Promise((r) => setTimeout(r, 8000));

/* ---------------- 3) 断言：隔离世界 + 面板 + 弹层 ---------------- */

async function evalIn(contextFilter, expression) {
  const ctx = contexts.find(contextFilter);
  if (!ctx) return null;
  const res = await send('Runtime.evaluate', {
    expression,
    contextId: ctx.id,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    return '异常: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result.value;
}

const { frameTree } = await send('Page.getFrameTree');
const frames = [];
(function walk(n) {
  frames.push(n.frame);
  (n.childFrames ?? []).forEach(walk);
})(frameTree);

trace('=== 断言 1：内容脚本的 storage.session 访问 ===');
for (const frame of frames) {
  // 注意：扩展重载后页面里可能同时存在**旧的孤儿世界**与**新的世界**，
  // 必须逐个查、按 chrome.storage 是否存在来区分，不能只取第一个匹配。
  const matches = contexts.filter(
    (c) => c.auxData?.frameId === frame.id && !c.auxData?.isDefault && c.name === EXT_NAME,
  );
  trace('  frame: ' + (frame.url || '').slice(0, 78) + ' —— 隔离世界 ' + matches.length + ' 个');
  for (const ctx of matches) {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => {
        if (!chrome || !chrome.storage) return '孤儿世界（无 chrome.storage）';
        try {
          const r = await chrome.storage.session.get(null);
          return 'session 可访问 ✓ 键=' + JSON.stringify(Object.keys(r).slice(0, 6));
        } catch (e) { return 'session 不可访问 ✗ => ' + (e && e.message); }
      })()`,
      contextId: ctx.id,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = res.exceptionDetails
      ? '异常: ' + (res.exceptionDetails.exception?.description ?? '').slice(0, 120)
      : res.result.value;
    trace('      → ' + value);
  }
}

trace('\n=== 断言 2：任务流宿主上的悬浮面板 ===');
const panelOut = await evalIn(
  (c) => c.auxData?.frameId === frames[0].id && c.auxData?.isDefault,
  `(() => {
    const host = document.querySelector('[data-cxai-ui="panel-host"]');
    const root = host && host.shadowRoot;
    return JSON.stringify({
      面板已挂载: Boolean(host),
      面板内容: root ? (root.querySelector('.cxai-status-title') || {}).textContent : null,
      状态文案: root ? (root.querySelector('.cxai-status-msg') || {}).textContent : null,
      节点行: root ? (root.querySelector('.cxai-node') || {}).textContent : null,
      按钮: root ? Array.from(root.querySelectorAll('.cxai-actions .cxai-btn')).map((b) => b.textContent) : [],
      弹层可见: (() => { const o = document.querySelector('.file-picker-iframe-overlay'); if (!o) return false; const cs = getComputedStyle(o); return cs.display !== 'none' && cs.visibility !== 'hidden'; })(),
      已挂文件: Boolean(document.querySelector('.uploaded-files')),
      选择文件按钮: Boolean(document.querySelector('.choose-btn')),
    }, null, 1);
  })()`,
);
trace(panelOut ?? '  （未取到）');

/* ---------------- 4) 观察一段时间，收集运行日志 ---------------- */
trace(`\n=== 观察 ${WATCH_SECONDS}s（任务流自动运行）===`);
const deadline = Date.now() + WATCH_SECONDS * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const snap = await evalIn(
    (c) => c.auxData?.frameId === frames[0].id && c.auxData?.isDefault,
    `(() => {
      const host = document.querySelector('[data-cxai-ui="panel-host"]');
      const root = host && host.shadowRoot;
      const o = document.querySelector('.file-picker-iframe-overlay');
      let open = false;
      if (o) { const cs = getComputedStyle(o); open = cs.display !== 'none' && cs.visibility !== 'hidden'; }
      return JSON.stringify({
        msg: root ? (root.querySelector('.cxai-status-msg') || {}).textContent : null,
        node: root ? ((root.querySelector('.cxai-node') || {}).textContent || '').trim() : null,
        弹层: open,
        已挂文件: Boolean(document.querySelector('.uploaded-files')),
        重新上传: Boolean(document.querySelector('.reupload-btn')),
        开始评估: Boolean(document.querySelector('.evaluate-btn')),
      });
    })()`,
  );
  trace('  · ' + (snap ?? '无快照'));
}

cdp.close();
process.exit(0);
