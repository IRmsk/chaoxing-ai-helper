/**
 * UI 回归检查：无头加载 UI 预览台，**读真实 DOM** 断言面板与弹窗的关键元素。
 *
 * 为什么不用截图：截图只能人眼看，grep 源码只能证明字符串在包里。
 * 「按钮增删 / 改名 / 文案改动」这类需求，直接读 DOM 才既准确又能自动化。
 *
 * 用法：node scripts/check-ui.mjs
 * 退出码 0 = 全部通过。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CDP_PORT || 9344);
const BROWSER =
  process.env.CHROME_PATH ||
  'C:/Users/20235/.agent-browser/browsers/chrome-154.0.8037.57/chrome.exe';
const PROFILE = join(ROOT, '.verify-profile');

if (!existsSync(BROWSER)) throw new Error(`找不到浏览器：${BROWSER}`);
if (!existsSync(join(ROOT, 'ui-preview-dist/index.html'))) {
  throw new Error('请先执行 npm run ui:build');
}

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1280,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitEndpoint() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch {
      /* 未就绪 */
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { resolve: r, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : r(m.result);
      }
    });
    ws.addEventListener('error', () => rej(new Error('ws error')));
    ws.addEventListener('open', () =>
      res({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((r, j) => {
            pending.set(id, { resolve: r, reject: j });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async eval(expression) {
          const out = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'eval error');
          return out.result.value;
        },
        close: () => ws.close(),
      }),
    );
  });
}

const assertions = [];
function check(name, ok, detail = '') {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `（${detail}）` : ''}`);
}

try {
  await waitEndpoint();
  const url = pathToFileURL(join(ROOT, 'ui-preview-dist/index.html')).href;
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).then((r) => r.json());
  const cdp = await connect(created.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 60; i += 1) {
    if (await cdp.eval('!!document.querySelector("#popup-mount .card")')) break;
    await sleep(250);
  }

  const report = JSON.parse(
    await cdp.eval(`(() => {
      const host = document.querySelector('[data-cxai-ui="panel-host"]');
      const root = host && host.shadowRoot;
      const btnText = (sel) => (root ? Array.from(root.querySelectorAll(sel)).map(b => b.textContent.trim()) : []);
      const popup = document.querySelector('#popup-mount');
      const popupText = popup ? popup.innerText : '';
      return JSON.stringify({
        panelButtons: btnText('.cxai-actions .cxai-btn'),
        panelLinks: btnText('.cxai-foot .cxai-link'),
        bannerExists: root ? !!root.querySelector('.cxai-banner') : null,
        nodeLineExists: root ? !!root.querySelector('.cxai-node') : null,
        popupText,
        errors: window.__bootErrors ?? [],
      });
    })()`),
  );

  const buttons = report.panelButtons ?? [];
  check('悬浮面板只有 开始/暂停/结束 三个按钮', buttons.length === 3, buttons.join(' | '));
  check('按钮文案为 开始、暂停、结束', ['开始', '暂停', '结束'].every((t) => buttons.includes(t)));
  check('已移除「单次」按钮', !buttons.includes('单次'));
  check('已移除「停止」文案', !buttons.includes('停止'));
  check('已移除「未探测到对话窗口」提示条', report.bannerExists === false);
  check('面板含任务流节点行容器', report.nodeLineExists === true);
  check('弹窗不再含被删除的调试说明', !report.popupText.includes('开启后刷新学习通页面'));
  check('弹窗不再含被删除的刷新提示', !report.popupText.includes('若刚安装/更新扩展'));
  check('弹窗含「打开页面后自动开始」', report.popupText.includes('打开页面后自动开始'));
  check('自动开始说明已更新为默认开启', report.popupText.includes('默认开启'));
  check('页面无启动期错误', Array.isArray(report.errors) && report.errors.length === 0, String(report.errors));

  cdp.close();
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise((r) => {
    child.once('exit', r);
    setTimeout(r, 4000);
  });
  await sleep(300);
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 忽略 */
  }
}

const failed = assertions.filter((a) => !a.ok);
console.log(`\n${failed.length === 0 ? '✅ UI 回归全部通过' : `❌ ${failed.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
