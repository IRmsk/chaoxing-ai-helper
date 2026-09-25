/**
 * 列出 / 查看错误 / 重载「已加载的扩展」。
 *
 * ## 为什么需要它（这是「装了扩展但完全没反应」的第一大原因）
 *
 * MV3 扩展是**在被加载时把 manifest 读进内存**的。你一旦重新构建 `dist/`，
 * 产物的哈希文件名就变了，而扩展宿主还在用旧 manifest →
 * 页面里的内容脚本 loader 会去 fetch 已经不存在的 `assets/chunk-老哈希.js`，
 * 报 `ERR_FILE_NOT_FOUND` / `Failed to fetch dynamically imported module`，
 * **内容脚本一行都不会执行**（连 `[CX-AI]` 日志都没有）。
 *
 * 所以「改完代码 → 重载扩展 → 重载页面」这个顺序必须严格执行。
 * 本脚本通过 `chrome.developerPrivate`（只有扩展管理页能用）来列出 / 重载扩展，
 * 不需要用户手点。
 *
 * 用法：
 *   node scripts/_ext-reload.mjs --list
 *   node scripts/_ext-reload.mjs --errors <关键词|id>
 *   node scripts/_ext-reload.mjs --reload <关键词|id>
 */

import { connect } from './_cdp.mjs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIST = argv.includes('--list');
const SHOW_ERRORS = arg('errors');
const RELOAD = arg('reload');
const KEYWORD = SHOW_ERRORS || RELOAD || '';

const cdp = await connect();

/* 打开（或复用）一个扩展管理页 */
const { targetInfos } = await cdp.send('Target.getTargets');
let extPage = (targetInfos || []).find(
  (t) => t.type === 'page' && /^(chrome|edge):\/\/(extensions|settings)/.test(t.url || ''),
);
let created = false;
if (!extPage) {
  extPage = await cdp.send('Target.createTarget', { url: 'chrome://extensions' });
  created = true;
  await new Promise((r) => setTimeout(r, 1800));
}

const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: extPage.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);

const { result, exceptionDetails } = await cdp.send(
  'Runtime.evaluate',
  {
    expression: `(async () => {
      if (!chrome.developerPrivate) return { error: 'chrome.developerPrivate 不可用（不在扩展管理页上下文）' };
      const infos = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      return { list: infos.map((e) => ({
        id: e.id, name: e.name, version: e.version, state: e.state, path: e.path || '',
        errors: (e.runtimeErrors || []).length + (e.manifestErrors || []).length,
        runtimeErrors: (e.runtimeErrors || []).map((r) => String(r.message || '').slice(0, 300)),
        manifestError: (e.manifestErrors || [])[0]?.message || '',
      })) };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  },
  sessionId,
);

if (exceptionDetails) {
  console.log('❌ 求值失败：', exceptionDetails.exception?.description);
  await cdp.close(1);
}
if (result.value?.error) {
  console.log('❌', result.value.error);
  await cdp.close(1);
}

const list = result.value.list || [];
const hit = list.filter((e) => e.id === KEYWORD || e.name.includes(KEYWORD) || e.path.includes(KEYWORD));

if (LIST || (!SHOW_ERRORS && !RELOAD)) {
  console.log(`共 ${list.length} 个扩展：\n`);
  for (const e of list) {
    console.log(`  ${e.name}`);
    console.log(`    id=${e.id}  v${e.version}  ${e.state}  错误数=${e.errors}`);
    if (e.path) console.log(`    path=${e.path}`);
    if (e.manifestError) console.log(`    ⚠️ manifest: ${e.manifestError}`);
    console.log('');
  }
  if (created) await cdp.send('Target.closeTarget', { targetId: extPage.targetId }).catch(() => undefined);
  await cdp.close(0);
}

if (hit.length === 0) {
  console.log(`❌ 没有匹配「${KEYWORD}」的扩展`);
  await cdp.close(1);
}
if (hit.length > 1) {
  console.log(`⚠️ 匹配到 ${hit.length} 个，请用完整 id：${hit.map((h) => h.id).join(' / ')}`);
  await cdp.close(1);
}

const target = hit[0];

if (SHOW_ERRORS) {
  console.log(`${target.name}  v${target.version}  ${target.state}`);
  console.log(`id=${target.id}\n`);
  console.log(`运行期错误 ${target.runtimeErrors.length} 条（按消息聚合）：\n`);
  const seen = new Map();
  for (const msg of target.runtimeErrors) {
    const key = msg.slice(0, 140).replace(/\s+/g, ' ');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [msg, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ×${count}  ${msg}`);
  }
  if (target.manifestError) console.log(`\nmanifest 错误：${target.manifestError}`);
  if (created) await cdp.send('Target.closeTarget', { targetId: extPage.targetId }).catch(() => undefined);
  await cdp.close(0);
}

/* -------- 重载 -------- */
console.log(`重载扩展：${target.name}（${target.id}，v${target.version}）`);
/*
 * ⚠️ 不要 await 这个调用的回包。
 *
 * reload 会让扩展上下文整体重建，扩展管理页自己也会刷新列表 ——
 * 请求回包经常永远不来（表现成 send 超时并抛错）。发出去就算，等几秒，
 * 然后**重新列一次**来验证是否真的重载成功。
 */
await cdp
  .send(
    'Runtime.evaluate',
    {
      expression: `chrome.developerPrivate.reload(${JSON.stringify(target.id)}, { failQuietly: true })`,
      awaitPromise: false,
    },
    sessionId,
    3000,
  )
  .catch(() => undefined);
await new Promise((r) => setTimeout(r, 4000));

const after = await cdp
  .send(
    'Runtime.evaluate',
    {
      expression: `chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true })
        .then((l) => { const e = l.find((x) => x.id === ${JSON.stringify(target.id)});
          return e ? e.state + '|' + e.version + '|' + ((e.runtimeErrors || []).length) : 'missing'; })`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
    10_000,
  )
  .catch(() => null);

const verdict = after?.result?.value;
console.log(
  verdict && verdict !== 'missing'
    ? `✅ 重载成功：状态 ${verdict.split('|')[0]}，v${verdict.split('|')[1]}，运行期错误 ${verdict.split('|')[2]} 条`
    : '⚠️ 未能确认重载结果（稍后用 --list 复查）',
);

if (created) await cdp.send('Target.closeTarget', { targetId: extPage.targetId }).catch(() => undefined);
await cdp.close(0);
