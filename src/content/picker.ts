import { buildCssPath, isVisible } from '@/common/dom-utils';
import { createLogger } from '@/common/logger';
import type { SelectorKey, SelectorOverrides } from '@/types';

/**
 * 选择器调试模式（可视化点选）。
 *
 * 当默认候选表与启发式嗅探都命中失败时，用户可在页面上手动点选元素，
 * 生成稳定 CSS 选择器并写入 `chrome.storage.local` 覆盖默认值
 * —— 对应文档 4.2 的「选择器调试模式」要求。
 *
 * 实现要点：
 * - 全部 UI 放在 Shadow DOM 中，样式与学习通页面完全隔离；
 * - 遮罩层 `pointer-events: none`，用 `elementFromPoint` 取真实命中元素，
 *   因此不会「点到自己」；
 * - 拦截 capture 阶段的 click，阻止默认行为，避免误触页面按钮。
 */

const log = createLogger('content:picker');

/** 可点选目标的展示名与是否必需。 */
const TARGETS: { key: SelectorKey; label: string; required: boolean }[] = [
  { key: 'chatRoot', label: '对话根容器', required: true },
  { key: 'messageList', label: '消息列表', required: true },
  { key: 'messageItem', label: '单条消息', required: false },
  { key: 'messageItemAI', label: 'AI 消息', required: false },
  { key: 'messageItemUser', label: '用户消息', required: false },
  { key: 'input', label: '输入框', required: true },
  { key: 'sendBtn', label: '发送按钮', required: false },
  { key: 'unlockBtn', label: '「继续」按钮', required: false },
];

/** 打开调试器所需参数。 */
export interface PickerOptions {
  /** 已有的自定义选择器。 */
  initial: SelectorOverrides;
  /** 用户点击「保存」时回调。 */
  onSave: (picks: SelectorOverrides) => void | Promise<void>;
  /** 关闭回调。 */
  onClose: () => void;
  /** 点击「自动探测」时回调，返回自动探测命中的选择器。 */
  onAutoDetect: () => SelectorOverrides | null;
}

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.hl {
  position: absolute; border: 2px solid #2f6bff; background: rgba(47,107,255,.12);
  border-radius: 4px; pointer-events: none; transition: all .05s linear;
}
.hl-label {
  position: absolute; top: -22px; left: 0; background: #2f6bff; color: #fff;
  font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 3px; white-space: nowrap; max-width: 420px;
  overflow: hidden; text-overflow: ellipsis;
}
.bar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; width: min(880px, calc(100vw - 32px));
  background: #101828; color: #e6ebf5; border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,.35); padding: 12px 14px; box-sizing: border-box;
}
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { font-size: 13px; font-weight: 600; margin-right: 6px; }
.hint { font-size: 12px; color: #98a2b3; flex: 1 1 260px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip {
  pointer-events: auto; cursor: pointer; border: 1px solid #344054; background: #1d2939; color: #d0d5dd;
  border-radius: 999px; padding: 4px 10px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;
}
.chip:hover { border-color: #2f6bff; color: #fff; }
.chip.active { border-color: #2f6bff; background: #1a3fb8; color: #fff; }
.chip.done { border-color: #12b76a; }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #667085; }
.chip.done .dot { background: #12b76a; }
.chip.req .dot { background: #f79009; }
.chip.done.req .dot { background: #12b76a; }
button.act {
  pointer-events: auto; cursor: pointer; border: 0; border-radius: 8px; padding: 6px 12px;
  font-size: 12px; background: #2f6bff; color: #fff; font-weight: 600;
}
button.act.ghost { background: transparent; border: 1px solid #344054; color: #d0d5dd; font-weight: 400; }
button.act.danger { background: #d92d20; }
.result { margin-top: 8px; font-size: 11px; color: #98a2b3; word-break: break-all; max-height: 72px; overflow: auto; }
`;

/**
 * 打开选择器调试模式。
 *
 * @param options 回调集合。
 * @returns 控制器（可主动关闭）。
 */
export function openPicker(options: PickerOptions): { close: () => void } {
  const picks: SelectorOverrides = { ...options.initial };
  let activeKey: SelectorKey = TARGETS[0].key;

  const host = document.createElement('div');
  host.setAttribute('data-cxai-ui', 'picker');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <div class="wrap" part="wrap">
      <div class="hl" style="display:none"><span class="hl-label"></span></div>
      <div class="bar">
        <div class="row">
          <span class="title">选择器调试模式</span>
          <span class="hint">先点下方目标，再点击页面上的对应元素。带 ● 的为必需项。</span>
          <button class="act" data-act="save">保存并应用</button>
          <button class="act ghost" data-act="auto">自动探测</button>
          <button class="act ghost" data-act="clear">清空</button>
          <button class="act danger" data-act="close">关闭</button>
        </div>
        <div class="chips"></div>
        <div class="result"></div>
      </div>
    </div>
  `;

  const wrap = shadow.querySelector('.wrap') as HTMLDivElement;
  const highlight = shadow.querySelector('.hl') as HTMLDivElement;
  const highlightLabel = shadow.querySelector('.hl-label') as HTMLSpanElement;
  const chips = shadow.querySelector('.chips') as HTMLDivElement;
  const result = shadow.querySelector('.result') as HTMLDivElement;

  /** 渲染目标 chips。 */
  function renderChips(): void {
    chips.innerHTML = '';
    for (const target of TARGETS) {
      const picked = Boolean(picks[target.key]);
      const chip = document.createElement('span');
      chip.className = `chip${target.required ? ' req' : ''}${picked ? ' done' : ''}${activeKey === target.key ? ' active' : ''}`;
      chip.innerHTML = `<span class="dot"></span>${target.label}${target.required ? ' ●' : ''}`;
      chip.title = picks[target.key] ?? '未设置';
      chip.addEventListener('click', () => {
        activeKey = target.key;
        renderChips();
        setResult(`当前目标：${target.label} —— 请在页面上点击对应元素`);
      });
      chips.appendChild(chip);
    }
  }

  function setResult(text: string): void {
    result.textContent = text;
  }

  /** 是否命中的是我们自己的 UI。 */
  function isSelf(node: EventTarget | null): boolean {
    if (!(node instanceof Node)) return false;
    return host.contains(node) || node === host;
  }

  /** 高亮指定元素。 */
  function paint(el: HTMLElement | null): void {
    if (!el || isSelf(el)) {
      highlight.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    const selector = buildCssPath(el);
    highlightLabel.textContent = `${el.tagName.toLowerCase()} · ${selector}`;
  }

  /** 事件监听：移动高亮。 */
  const onMove = (event: MouseEvent) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    paint(el instanceof HTMLElement ? el : null);
  };

  /** 事件监听：点击捕获。 */
  const onClick = (event: MouseEvent) => {
    if (isSelf(event.target) || isSelf(event.composedPath()[0] ?? null)) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!(el instanceof HTMLElement) || !isVisible(el)) {
      setResult('该元素不可见，请换一个位置点击');
      return;
    }

    const selector = buildCssPath(el);
    let count = 0;
    try {
      count = document.querySelectorAll(selector).length;
    } catch {
      count = 0;
    }
    if (count === 0) {
      setResult(`生成的选择器无法命中元素，请尝试点击更外层/更内层的节点。选择器：${selector}`);
      return;
    }

    picks[activeKey] = selector;
    log.info(`已采集 ${activeKey} → ${selector}（命中 ${count} 个）`);
    setResult(`已记录「${TARGETS.find((t) => t.key === activeKey)?.label}」：${selector}（当前文档命中 ${count} 个元素）`);

    // 自动跳到下一个未采集的目标
    const next = TARGETS.find((t) => !picks[t.key]);
    if (next) activeKey = next.key;
    renderChips();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };

  /** 关闭并清理。 */
  function close(): void {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.classList.remove('cxai-picking');
    host.remove();
    options.onClose();
  }

  shadow.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest('button')?.getAttribute('data-act');
    if (!action) return;

    if (action === 'save') {
      void Promise.resolve(options.onSave(picks))
        .then(() => setResult('已保存，正在应用新选择器…'))
        .then(() => close())
        .catch((err: Error) => setResult(`保存失败：${err.message}`));
    } else if (action === 'auto') {
      const detected = options.onAutoDetect();
      if (!detected) {
        setResult('自动探测未命中，请手动点选（通常先点「输入框」最容易定位）。');
        return;
      }
      Object.assign(picks, detected);
      renderChips();
      setResult(`自动探测命中：${JSON.stringify(detected)}`);
    } else if (action === 'clear') {
      for (const key of Object.keys(picks) as SelectorKey[]) delete picks[key];
      renderChips();
      setResult('已清空本地采集结果（尚未保存）');
    } else if (action === 'close') {
      close();
    }
  });

  renderChips();
  document.documentElement.classList.add('cxai-picking');
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  (document.body ?? document.documentElement).appendChild(host);

  log.info('选择器调试模式已开启');
  setResult('请在页面上点击对应的元素；按 Esc 可退出。');

  // wrap 目前只用于定位，保留引用避免被 tree-shaking 误判为未使用
  void wrap;

  return { close };
}
