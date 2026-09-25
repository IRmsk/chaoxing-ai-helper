/**
 * 单次快照：任务流节点进度 + 对话 frame 的轮次 + 面板状态。
 *
 * 只建立一条短连接、查完即退出 —— 避免频繁重连把浏览器的调试端点拖住。
 *
 * 用法：node scripts/_snap.mjs [重试次数]
 */

import { readFileSync } from 'node:fs';

const PORT_FILE = 'C:/Users/20235/AppData/Local/Microsoft/Edge/User Data/DevToolsActivePort';
const MAX_TRY = Number(process.argv[2] || 4);

function readPort() {
  const parts = readFileSync(PORT_FILE, 'utf8').split(/\r?\n/);
  return `ws://127.0.0.1:${parts[0]}${parts[1].trim()}`;
}

function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    const timer = setTimeout(() => rejectConn(new Error('连接超时')), 12000);
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
        return;
      }
      listeners.forEach((f) => f(m));
    });
    ws.addEventListener('error', () => rejectConn(new Error('WS 失败')));
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolveConn({
        send(method, params = {}, sessionId, timeoutMs = 20000) {
          const id = ++seq;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(method + ' 超时'));
              }
            }, timeoutMs);
          });
        },
        close: () => ws.close(),
      });
    });
  });
}

async function once() {
  const cdp = await connect(readPort());
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((x) => (x.url || '').includes('taskChain/student/answer'));
  if (!page) throw new Error('未找到任务流页面');

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Runtime.enable');

  const { frameTree } = await send('Page.getFrameTree');
  const frames = [];
  (function walk(n) {
    frames.push(n.frame);
    (n.childFrames ?? []).forEach(walk);
  })(frameTree);

  const FLOW = `(() => {
    const host = document.querySelector('[data-cxai-ui="panel-host"]');
    const root = host && host.shadowRoot;
    return JSON.stringify({
      面板: root ? (root.querySelector('.cxai-status-title') || {}).textContent : null,
      状态: root ? (root.querySelector('.cxai-status-msg') || {}).textContent : null,
      节点行: root ? ((root.querySelector('.cxai-node') || {}).textContent || '').trim() : null,
      节点: Array.from(document.querySelectorAll('.flow-card')).map((c) => ({
        cls: (c.className || '').replace('flow-card', '').trim(),
        type: ((c.querySelector('.task-type') || {}).textContent || '').trim(),
        title: ((c.querySelector('.flow-card-body h3') || {}).textContent || '').trim(),
        score: ((c.querySelector('.task-score') || {}).textContent || '').trim(),
      })),
    }, null, 1);
  })()`;

  const flowRes = await send('Runtime.evaluate', { expression: FLOW, returnByValue: true });
  console.log('=== 任务流 ===\n' + (flowRes.result?.value ?? '无'));

  const dlgFrame = frames.find((f) => /pcDialogue/.test(f.url || ''));
  console.log('\n=== frames ===');
  frames.forEach((f) => console.log('  - ' + (f.url || '').slice(0, 96)));

  if (dlgFrame) {
    const MSG = `JSON.stringify({
      agents: document.querySelectorAll('div.agent').length,
      users: document.querySelectorAll('div.userAnswer').length,
      hasInput: !!document.querySelector('textarea.messageInput'),
      locked: (document.querySelector('textarea.messageInput') || {}).disabled === true,
      lastText: (() => { const n = document.querySelectorAll('.wrap1000 > *'); return n.length ? (n[n.length - 1].textContent || '').replace(/\\s+/g, ' ').slice(0, 70) : ''; })(),
    })`;
    const dlgRes = await send('Runtime.evaluate', { expression: MSG, returnByValue: true });
    console.log('\n=== 对话 frame ===\n' + (dlgRes.result?.value ?? '无'));
  } else {
    console.log('\n（没有 pcDialogue frame —— 可能还没进入到对话界面）');
  }

  cdp.close();
}

let lastError = null;
for (let i = 1; i <= MAX_TRY; i += 1) {
  try {
    await once();
    process.exit(0);
  } catch (err) {
    lastError = err;
    console.log(`第 ${i} 次失败：${err.message}，2s 后重试…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log('多次尝试均失败：' + lastError?.message);
process.exit(1);
