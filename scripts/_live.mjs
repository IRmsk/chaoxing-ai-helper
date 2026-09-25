/**
 * 真机 CDP 探针（可复用）。
 *
 * 按 URL 子串挑目标页，在**指定 frame** 里求值一段 JS 并把结果打印出来。
 * 用于直接看真实页面的 DOM / 扩展内容脚本的现场。
 *
 * 用法：
 *   node scripts/_live.mjs --list
 *   node scripts/_live.mjs --url taskChain --file tmp/probe.js
 *   node scripts/_live.mjs --url taskChain --expr "document.title"
 *   node scripts/_live.mjs --url taskChain --expr "..." --frame dialogue
 *   node scripts/_live.mjs --url taskChain --all-frames --expr "location.href"
 *
 * 连接自带重试（浏览器级端点被连多次后会整体拒绝握手，等一会儿就好）。
 */

import { readFileSync } from 'node:fs';
import { connect } from './_cdp.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, dflt) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const LIST_ONLY = has('list');
const URL_FILTER = arg('url', 'taskChain');
const FRAME_FILTER = arg('frame', '');
const ALL_FRAMES = has('all-frames');
const EXPR = has('expr') ? arg('expr') : has('file') ? readFileSync(arg('file'), 'utf8') : '';

const cdp = await connect();
const { targetInfos } = await cdp.send('Target.getTargets');
const pages = (targetInfos || []).filter((t) => t.type === 'page');

if (LIST_ONLY) {
  console.log(`共 ${pages.length} 个页面：`);
  pages.forEach((p, i) => console.log(`  [${i}] ${(p.url || '').slice(0, 130)}`));
  await cdp.close(0);
}

const page = pages.find((p) => (p.url || '').includes(URL_FILTER));
if (!page) {
  console.log(`❌ 没找到 URL 含「${URL_FILTER}」的页面。现有页面：`);
  pages.forEach((p) => console.log('  - ' + (p.url || '').slice(0, 130)));
  await cdp.close(1);
}
console.log(`目标页：${(page.url || '').slice(0, 130)}\n`);

const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const send = (m, p, t) => cdp.send(m, p, sessionId, t);
await send('Runtime.enable');
await send('Page.enable');

const { frameTree } = await send('Page.getFrameTree');
const frames = [];
(function walk(node, depth) {
  frames.push({ ...node.frame, depth });
  (node.childFrames ?? []).forEach((c) => walk(c, depth + 1));
})(frameTree, 0);

console.log('frames：');
frames.forEach((f, i) => console.log(`  [${i}] ${'  '.repeat(f.depth)}${(f.url || '(empty)').slice(0, 110)}`));
console.log('');

if (!EXPR) await cdp.close(0);

/** 在某个 frame 里求值：用隔离世界跑最稳（不污染页面主世界）。 */
async function evalInFrame(frame) {
  const { executionContextId } = await send('Page.createIsolatedWorld', {
    frameId: frame.id,
    grantUniveralAccess: true,
    worldName: 'cxai-live-probe',
  });
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: EXPR,
    returnByValue: true,
    awaitPromise: true,
    contextId: executionContextId,
  });
  if (exceptionDetails) return `❌ ${exceptionDetails.exception?.description ?? exceptionDetails.text}`;
  return result.value;
}

const targets = ALL_FRAMES
  ? frames
  : FRAME_FILTER
    ? frames.filter((f) => (f.url || '').includes(FRAME_FILTER))
    : [frames[0]];

if (targets.length === 0) {
  console.log(`❌ 没有匹配的 frame（--frame ${FRAME_FILTER}）`);
  await cdp.close(1);
}

for (const frame of targets) {
  console.log('─'.repeat(78));
  console.log(`frame: ${(frame.url || '(empty)').slice(0, 110)}`);
  console.log('─'.repeat(78));
  try {
    const value = await evalInFrame(frame);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
  } catch (err) {
    console.log(`❌ 求值失败：${err.message}`);
  }
  console.log('');
}

await cdp.close(0);
