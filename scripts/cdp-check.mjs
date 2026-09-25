/**
 * CDP 端点健康检查。
 *
 * 为什么单独做一个：Edge 通过 `edge://inspect/#remote-debugging` 打开调试端口后，
 * **HTTP 端口正常、WebSocket 升级会卡死**（TCP 能连上，但永远收不到 101）。
 * 这时 `curl http://127.0.0.1:9222/` 会照常返回，很容易误判成「端口是好的」。
 *
 * 用法：node scripts/cdp-check.mjs
 *
 * 判定：
 * - 纯 HTTP 请求 404 → 正常（Edge 的调试端点不暴露 /json/* 的 HTTP API）
 * - WS 升级 5 秒内没有响应 → **端点已卡死**，必须重启 Edge（或把
 *   `edge://inspect` 里的远程调试开关关掉再打开）才能恢复
 *
 * ⚠️ 已知坑：浏览器级 CDP 端点容易被残留的半开连接拖住。脚本被 Ctrl+C 打断后
 * 要等它自己退出，不要反复重连 —— 越连越卡。每次探测都要给超时并主动 close。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 常见浏览器的 DevToolsActivePort 位置。 */
const PORT_FILES = [
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft/Edge/User Data/DevToolsActivePort'),
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google/Chrome/User Data/DevToolsActivePort'),
];

function readEndpoint() {
  for (const file of PORT_FILES) {
    if (!existsSync(file)) continue;
    const parts = readFileSync(file, 'utf8').split(/\r?\n/);
    if (!parts[0]) continue;
    return {
      file,
      port: Number(parts[0]),
      path: (parts[1] ?? '').trim(),
      mtime: statSync(file).mtime.toISOString(),
    };
  }
  return null;
}

/** 发一个原始 TCP 请求，返回首行 / TIMEOUT / ERR。 */
function probe(port, path, upgrade) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    let req = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`;
    req += upgrade
      ? `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n`
      : 'Connection: close\r\n';
    req += '\r\n';

    const sock = net.connect(port, '127.0.0.1', () => sock.write(req));
    let buf = '';
    let done = false;
    const finish = (verdict) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(verdict);
    };
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) finish(buf.split('\r\n')[0]);
    });
    sock.on('error', (e) => finish(`ERR ${e.message}`));
    setTimeout(() => finish('TIMEOUT'), 5000);
  });
}

const ep = readEndpoint();
if (!ep) {
  console.log('❌ 没找到 DevToolsActivePort —— 浏览器没有开启远程调试。');
  console.log('   请在 Edge 打开 edge://inspect/#remote-debugging 并打开开关，然后重跑本脚本。');
  process.exit(1);
}

console.log(`端口文件：${ep.file}`);
console.log(`  端口 ${ep.port}　路径 ${ep.path}`);
console.log(`  写入时间 ${ep.mtime}\n`);

const http = await probe(ep.port, '/json/version', false);
const ws = await probe(ep.port, ep.path, true);

console.log(`HTTP GET /json/version      => ${http}`);
console.log(`WS   升级 ${ep.path.slice(0, 28)}… => ${ws}\n`);

if (ws.startsWith('HTTP/1.1 101')) {
  console.log('✅ CDP 端点可用（WebSocket 握手成功）。');
  process.exit(0);
}

console.log('❌ CDP 端点不可用：WebSocket 升级没有响应。');
console.log('   表现：TCP 能连上、HTTP 请求有响应，但 WS 握手永远挂住。');
console.log('   这是浏览器进程级的故障，**只能重启浏览器才能恢复**：');
console.log('   1) 完全退出 Edge（任务栏右键退出，确认任务管理器里没有 msedge.exe）；');
console.log('   2) 重新打开 Edge，进入 edge://inspect/#remote-debugging，把开关打开；');
console.log('   3) 重跑本脚本确认 101。');
process.exit(2);
