/* eslint-disable */
/**
 * 学习通 AI 实践对话窗口 —— 控制台探针（零依赖，直接粘贴到 DevTools Console 运行）
 *
 * 用法：
 *   1. 打开 AI 实践对话页面；
 *   2. F12 → Console；
 *   3. 把本文件全部内容粘进去回车；
 *   4. 把输出的【CX-PROBE】开头的所有行复制发给开发者。
 *
 * 它只读取 DOM、不做任何修改，也不会发起任何网络请求。
 */
(() => {
  const TAG = '[CX-PROBE]';
  const out = [];
  const w = window;

  /** 生成元素的稳定 CSS 路径。 */
  const path = (el) => {
    if (!el || !el.tagName) return null;
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const seg = [];
    let node = el;
    while (node && node !== document.body && node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const cls = Array.from(node.classList).filter((c) => c.length <= 30 && !/^[a-z]+[-_]?[0-9a-f]{5,}$/i.test(c));
      let s = tag + cls.map((c) => '.' + CSS.escape(c)).join('');
      const sibs = Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName);
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      seg.unshift(s);
      if (seg.length >= 6) break;
      node = node.parentElement;
    }
    return seg.join(' > ');
  };

  const clip = (t, n = 60) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);

  const text = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n = walker.nextNode();
    while (n) {
      parts.push(n.nodeValue.trim());
      n = walker.nextNode();
    }
    return parts.join('\n');
  };

  out.push('frame=' + location.href.slice(0, 120));
  out.push('iframeCount=' + document.querySelectorAll('iframe').length);

  /* ---------- 1. 输入框 ---------- */
  const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
  out.push('--- 可编辑元素（' + inputs.length + '） ---');
  inputs.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    out.push(
      `  [${i}] ${path(el)} disabled=${!!el.disabled} readonly=${!!el.readOnly}` +
        ` lockClass=${/lock|disabled/i.test(el.className)} size=${Math.round(r.width)}x${Math.round(r.height)}`,
    );
  });

  /* ---------- 2. 输入框的祖先链（用于定位底栏/根容器） ---------- */
  const input = inputs.find((el) => /messageInput/i.test(el.className || '')) || inputs[0];
  if (input) {
    out.push('--- 输入框祖先链 ---');
    let node = input.parentElement;
    for (let i = 0; node && i < 8; i += 1) {
      const r = node.getBoundingClientRect();
      out.push(
        `  ^${i} ${path(node)} | children=${node.children.length}` +
          ` | size=${Math.round(r.width)}x${Math.round(r.height)} | text=${clip(node.textContent, 40)}`,
      );
      node = node.parentElement;
    }
  }

  /* ---------- 3. 按钮 ---------- */
  const buttons = Array.from(document.querySelectorAll('span, button, a, div[role="button"]')).filter((el) => {
    const t = (el.textContent || '').trim();
    return t.length > 0 && t.length <= 8 && /继续|发送|提交|开始|下一步/.test(t);
  });
  out.push('--- 疑似按钮（' + buttons.length + '） ---');
  buttons.slice(0, 12).forEach((el) => {
    out.push(`  ${path(el)} | text=${clip(el.textContent, 10)} | class=${clip(el.className, 60)} | disabled=${!!el.disabled}`);
  });

  /* ---------- 4. 消息条目候选 ---------- */
  const CANDIDATES = [
    '.agent',
    '.userAnswer',
    '.agentAnswer',
    '.answer_content',
    '.answerList',
    '.answerBox',
    '[class*="item"]',
    '[class*="msg"]',
    '[class*="message"]',
    '[class*="chat"]',
    '[class*="bubble"]',
  ];
  out.push('--- 选择器命中计数 ---');
  CANDIDATES.forEach((sel) => {
    let n = -1;
    try {
      n = document.querySelectorAll(sel).length;
    } catch {}
    out.push(`  ${sel} -> ${n}`);
  });

  /* ---------- 5. 逐条消息：类名路径 + 侧别 + 文本 ---------- */
  const items = Array.from(document.querySelectorAll('div.agent, div.userAnswer'));
  out.push('--- 消息条目（div.agent / div.userAnswer，共 ' + items.length + '） ---');
  const listRect = (() => {
    const l = document.querySelector('.answerList') || (items[0] && items[0].parentElement);
    return l ? l.getBoundingClientRect() : null;
  })();
  items.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const side =
      listRect && r.width > 0
        ? r.left + r.width / 2 - (listRect.left + listRect.width / 2) < 0
          ? '左(AI?)'
          : '右(我方?)'
        : '未知';
    const nestedUser = el.querySelectorAll('.userAnswer').length;
    const nestedAgent = el.querySelectorAll('.agent').length;
    out.push(
      `  #${i} ${path(el)}` +
        ` | ${side} | 自身=${clip(el.className, 40)}` +
        ` | 内含userAnswer=${nestedUser} 内含agent=${nestedAgent}` +
        ` | text=${clip(text(el), 70)}`,
    );
  });

  /* ---------- 6. 按文档顺序列出「叶子级」消息（候选列表容器下的直接子元素） ---------- */
  const listEl = document.querySelector('.answerList') || (items[0] && items[0].parentElement);
  if (listEl) {
    out.push('--- 列表容器 ' + path(listEl) + ' 的直接子元素 ---');
    Array.from(listEl.children).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      out.push(
        `  (${i}) <${el.tagName.toLowerCase()} class="${clip(el.className, 60)}">` +
          ` children=${el.children.length} size=${Math.round(r.width)}x${Math.round(r.height)} text=${clip(text(el), 50)}`,
      );
    });
  }

  const report = out.join('\n');
  console.log(TAG + ' ===== 开始 =====');
  console.log(report);
  console.log(TAG + ' ===== 结束（请把以上全部内容复制发回） =====');
  return report;
})();
