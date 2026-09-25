import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * 零依赖静态文件服务（用于预览 Mock 验证台 / 已构建产物）。
 *
 * 为什么不用 `python -m http.server`：在 Windows 上，Python 的 `mimetypes`
 * 会读取注册表，某些环境下 `.js` 被映射成 `text/plain`，导致浏览器以
 * 「MIME type 不是 JavaScript」为由拒绝执行 ES Module。这里显式声明 MIME。
 *
 * 用法：node scripts/serve.mjs [目录] [端口]
 */

const rootDir = resolve(process.argv[2] ?? 'mock-dist');
const port = Number(process.argv[3] ?? 5199);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = resolve(join(rootDir, normalize(urlPath)));

  // 防目录穿越
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`静态服务已启动：http://127.0.0.1:${port}/  （目录：${rootDir}）`);
});
