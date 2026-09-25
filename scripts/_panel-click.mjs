/**
 * 点一下悬浮面板上的按钮，并把随后的控制台输出抓回来。
 *
 * 用途：在不重载页面的前提下，确认**页面里正在跑的内容脚本是哪个版本**，
 * 以及让扩展把自己的现场（诊断）打到控制台。
 *
 * 用法：node scripts/_panel-click.mjs [按钮文案] [URL子串] [秒数]
 */

import { connect, findPage, makeArgv } from './_cdp.mjs';

const { positional } = makeArgv();
const BUTTON = positional[0] || '诊断';
const URL_FILTER = positional[1] || 'taskChain';
const SECONDS = Number(positional[2] || 6);

const logs = [];
const cdp = await connect((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || [])
      .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
      .join(' ');
    logs.push({ kind: m.params.type, text });
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push({ kind: 'exception', text: m.params.exceptionDetails?.exception?.description ?? '' });
  }
});

const { page } = await findPage(cdp, URL_FILTER);
if (!page) {
  console.log('❌ 没找到页面');
  await cdp.close(1);
}

const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);

const { result, exceptionDetails } = await cdp.send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const host = document.querySelector('[data-cxai-ui="panel-host"]');
      const root = host && host.shadowRoot;
      if (!root) return '没有面板';
      const want = ${JSON.stringify(BUTTON)};
      const btn = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent || '').replace(/\\s+/g, '').trim() === want);
      if (!btn) return '没找到按钮：' + want + '（现有：' + Array.from(root.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).join('/') + '）';
      btn.click();
      return '已点击「' + want + '」';
    })()`,
    returnByValue: true,
  },
  sessionId,
);

console.log(exceptionDetails ? `❌ ${exceptionDetails.exception?.description}` : result.value);
await new Promise((r) => setTimeout(r, SECONDS * 1000));

console.log(`\n随后捕获 ${logs.length} 条控制台输出：\n`);
for (const l of logs) console.log(`[${l.kind}] ${String(l.text).slice(0, 400)}`);

await cdp.close(0);
