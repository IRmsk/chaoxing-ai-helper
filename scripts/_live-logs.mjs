/**
 * 真机日志抓取（含可选「重载扩展」）。
 *
 * 做法：先 `Runtime.enable` + `Log.enable` 打开事件通道，再 `Page.reload`，
 * 把重载后 N 秒内所有 console 消息 / 异常打印出来 —— 这样能看到扩展
 * 内容脚本从初始化到跑任务流的完整轨迹（内容脚本在隔离世界里，日志同样会
 * 通过 Runtime.consoleAPICalled 上报）。
 *
 * 用法：
 *   node scripts/_live-logs.mjs [URL子串] [秒数] [--all] [--no-reload]
 *
 *   --all        不过滤，打印全部日志（默认只打印 [CX-AI] 与异常）
 *   --no-reload  **只是挂上去听**，不重载页面 —— 用于观察正在运行的自动化，
 *                避免重载把跑到一半的流程打断
 *
 * ⚠️ 改完扩展代码必须先 `node scripts/_ext-reload.mjs --reload 学习通` 再跑本脚本，
 * 否则扩展宿主还拿着旧 manifest，内容脚本会因产物哈希变化而加载失败（一行日志都没有）。
 */

import { connect, findPage, makeArgv } from './_cdp.mjs';

const { positional, has } = makeArgv();
const URL_FILTER = positional[0] || 'taskChain';
const SECONDS = Number(positional[1] || 25);
const SHOW_ALL = has('all');
const NO_RELOAD = has('no-reload');

const logs = [];
let t0 = Date.now();

const cdp = await connect((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || [])
      .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
      .join(' ');
    logs.push({ at: Date.now(), kind: m.params.type, text });
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push({
      at: Date.now(),
      kind: 'exception',
      text: m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '',
    });
  } else if (m.method === 'Log.entryAdded') {
    logs.push({ at: Date.now(), kind: `log:${m.params.entry.level}`, text: m.params.entry.text });
  }
});

const { targetInfos, page } = await findPage(cdp, URL_FILTER);
if (!page) {
  console.log(`❌ 没找到 URL 含「${URL_FILTER}」的页面。现有页面：`);
  targetInfos.filter((t) => t.type === 'page').forEach((t) => console.log('  - ' + (t.url || '').slice(0, 120)));
  await cdp.close(1);
}
console.log(`目标页：${(page.url || '').slice(0, 120)}\n`);

const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Log.enable', {}, sessionId);
await cdp.send('Page.enable', {}, sessionId);

console.log(NO_RELOAD ? `只挂上听 ${SECONDS} 秒（不重载页面）…\n` : `重新加载页面并抓取 ${SECONDS} 秒日志…\n`);
logs.length = 0;
t0 = Date.now();
if (!NO_RELOAD) await cdp.send('Page.reload', {}, sessionId);
await new Promise((r) => setTimeout(r, SECONDS * 1000));

const shown = logs.filter((l) => SHOW_ALL || /CX-AI/.test(l.text) || l.kind === 'exception');
console.log(`共捕获 ${logs.length} 条，其中关键 ${shown.length} 条：\n`);
for (const l of shown) {
  const rel = ((l.at - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[+${rel}s][${l.kind}] ${String(l.text).slice(0, 300)}`);
}
if (logs.length === 0) {
  console.log('（一条日志都没有 —— 先确认扩展已重载：node scripts/_ext-reload.mjs --reload 学习通）');
}

await cdp.close(0);
