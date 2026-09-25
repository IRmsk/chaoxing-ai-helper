import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 把某个构建目录的 JS/CSS 内联进它的 `index.html`，产出**自包含单文件**。
 *
 * 用途：`mock-dist/`（Mock 验证台）与 `ui-preview-dist/`（UI 预览台）。
 * 好处：双击即可用 `file://` 打开，不需要起本地服务器。
 *
 * 为什么必须内联：ES Module 在 `file://` 下会被 CORS 拦截，因此两个预览台的
 * 产物都以 IIFE 形式打包（见各自的 vite 配置），再内联成经典脚本。
 *
 * 用法：node scripts/inline-html.mjs <目录名> [<目录名> ...]
 */

const rootDir = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error('用法：node scripts/inline-html.mjs <目录名> [...]');
  process.exit(1);
}

/** 内联单个目录。 */
function inlineOne(dirName) {
  const distDir = join(rootDir, dirName);
  const htmlPath = join(distDir, 'index.html');

  if (!existsSync(htmlPath)) {
    console.error(`✗ ${dirName}：未找到 index.html，请先完成构建`);
    process.exitCode = 1;
    return;
  }

  let html = readFileSync(htmlPath, 'utf8');

  // 1) 内联 CSS（保留原有位置，通常是 head）
  html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/g, (_match, href) => {
    const file = join(distDir, href);
    if (!existsSync(file)) return '';
    return `<style>\n${readFileSync(file, 'utf8')}\n</style>`;
  });

  // 2) 取出 JS，并清空原来的占位标签
  const scripts = [];
  html = html.replace(/<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/g, (_match, src) => {
    const file = join(distDir, src);
    if (existsSync(file)) scripts.push(readFileSync(file, 'utf8'));
    return '';
  });

  if (scripts.length === 0) {
    console.error(`✗ ${dirName}：未找到可内联的模块脚本，构建产物可能已变更`);
    process.exitCode = 1;
    return;
  }

  // 3) 把 JS 里可能出现的 `</script` 转义成 `<\/script`。
  //    在 JS 中 `\/` 与 `/` 完全等价，因此不影响语义，但可以避免它提前闭合 <script> 标签。
  const js = scripts.join('\n').replace(/<\/script/gi, '<\\/script');

  // 4) 插到 </body> 之前 —— 经典脚本没有 defer，
  //    若留在 <head> 会在 body 解析前执行，导致取不到 DOM 节点。
  //
  //    ⚠️ 必须用「函数形式」的 replace：字符串形式的替换会把 `$$` 当成转义序列
  //    折叠成 `$`，从而把 React 内部的 `$$typeof` 悄悄改成 `$typeof`，让整个包失效。
  const scriptTag = `<script>\n${js}\n</script>\n`;
  html = html.includes('</body>')
    ? html.replace('</body>', () => `${scriptTag}</body>`)
    : html + scriptTag;

  writeFileSync(htmlPath, html, 'utf8');

  // 5) 清理已内联的资源目录
  const assetsDir = join(distDir, 'assets');
  if (existsSync(assetsDir)) rmSync(assetsDir, { recursive: true, force: true });

  console.log(`✓ ${dirName}/index.html 已内联为单文件（可直接双击打开）`);
}

targets.forEach(inlineOne);
