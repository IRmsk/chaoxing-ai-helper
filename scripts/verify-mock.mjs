/**
 * 零依赖 CDP 验证器。
 *
 * 直接在 Chrome/Edge 上跑 Mock 验证台并读回结果，不依赖任何浏览器自动化 CLI
 * （其 socket 目录可能被沙箱限制）。
 *
 * 用法：
 *   node scripts/verify-mock.mjs [模式] [页面相对路径]
 *   node scripts/verify-mock.mjs realNested
 *   node scripts/verify-mock.mjs keyword mock-dist/index.html
 *
 * 环境变量：
 *   CHROME_PATH  浏览器可执行文件路径（默认用 agent-browser 已下载的 Chromium）
 *   CDP_PORT     调试端口（默认 9333）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CDP_PORT || 9333);

const CANDIDATE_BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Users/20235/.agent-browser/browsers/chrome-154.0.8037.57/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const MODE = process.argv[2] || 'realNested';
const PAGE = process.argv[3] || 'mock-dist/index.html';
const PROFILE = join(ROOT, '.verify-profile');
const DEADLINE_MS = Number(process.env.VERIFY_TIMEOUT_MS || 120_000);

/** 找一个可用的浏览器可执行文件。 */
function findBrowser() {
  const hit = CANDIDATE_BROWSERS.find((p) => existsSync(p));
  if (!hit) throw new Error(`未找到浏览器可执行文件，请用 CHROME_PATH 指定。已尝试：\n${CANDIDATE_BROWSERS.join('\n')}`);
  return hit;
}

/** 轮询直到 CDP 端点可用。 */
async function waitForEndpoint(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() > deadline) throw new Error(`等待 CDP 端点超时：${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 极简 CDP 客户端（Node 22 自带 WebSocket）。 */
function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => rejectConn(new Error('WebSocket 连接失败')));
    ws.addEventListener('open', () => {
      resolveConn({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((res, reject) => {
            pending.set(id, { resolve: res, reject });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async eval(expression) {
          const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? '页面执行异常');
          }
          return result.result.value;
        },
        close: () => ws.close(),
      });
    });
  });
}

async function main() {
  const browser = findBrowser();
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const pageUrl = pathToFileURL(join(ROOT, PAGE)).href;
  console.log(`浏览器：${browser}`);
  console.log(`页面　：${pageUrl}`);
  console.log(`模式　：${MODE}\n`);

  const child = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = async () => {
    // 先等浏览器进程真正退出，否则 profile 里的文件仍被占用，删除会抛 EBUSY
    if (child.exitCode === null && !child.killed) child.kill();
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      child.once('exit', resolveExit);
      setTimeout(resolveExit, 5000);
    });
    await new Promise((r) => setTimeout(r, 300));
    try {
      rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 清理失败不影响结论（profile 是临时目录，下次运行会先清空）
    }
  };

  try {
    await waitForEndpoint(`http://127.0.0.1:${PORT}/json/version`);

    // 创建目标页面（新版 CDP 的 /json/new 需要 PUT）
    const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(pageUrl)}`, {
      method: 'PUT',
    }).then((r) => r.json());

    const cdp = await connect(created.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // 等页面里的模块真正执行完
    for (let i = 0; i < 60; i += 1) {
      const ready = await cdp.eval('document.readyState === "complete" && !!document.getElementById("mode-select")');
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // 切模式并开跑
    await cdp.eval(
      `(() => {
        const sel = document.getElementById('mode-select');
        sel.value = ${JSON.stringify(MODE)};
        sel.dispatchEvent(new Event('change'));
        return true;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 300));

    const shape = await cdp.eval(
      `JSON.stringify({
        mode: document.getElementById('mode-select').value,
        rounds: document.querySelectorAll('.agent').length,
        users: document.querySelectorAll('.userAnswer').length,
        nested: !!document.querySelector('.agent .userAnswer'),
      })`,
    );
    console.log(`页面结构：${shape}\n`);

    await cdp.eval(`document.getElementById('btn-run').click(), true`);

    const deadline = Date.now() + DEADLINE_MS;
    let result = { pass: false, steps: [] };
    while (Date.now() < deadline) {
      const raw = await cdp.eval('JSON.stringify(window.__cxaiMock || null)');
      result = raw ? JSON.parse(raw) : { pass: false, steps: [] };
      if (result.pass || result.error) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log('===== 执行日志 =====');
    for (const line of result.steps ?? []) console.log(line);
    console.log('====================\n');

    // 可选：截图留证（SHOT=<绝对路径>）
    if (process.env.SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
      console.log(`📷 截图：${process.env.SHOT}\n`);
    }

    if (result.pass) {
      console.log(`✅ ${MODE} 模式：验证通过`);
      cdp.close();
      await cleanup();
      process.exit(0);
    }
    console.error(`❌ ${MODE} 模式：失败`);
    if (result.error) console.error(result.error);
    cdp.close();
    await cleanup();
    process.exit(1);
  } catch (err) {
    console.error(`❌ 验证器异常：${err.message}`);
    await cleanup();
    process.exit(1);
  }
}

await main();
