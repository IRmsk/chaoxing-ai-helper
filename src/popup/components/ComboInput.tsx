import { useEffect, useRef, useState } from 'react';

/**
 * 带下拉候选的输入框。
 *
 * 为什么不用原生 `<datalist>`：**Chromium 的扩展弹窗（browser action popup）里
 * 不会渲染 `<datalist>` 的下拉浮层**，点击三角/输入时什么都不弹 —— 这正是
 * 「Base URL 与模型下拉无法展开」的根因。这里自绘一个列表浮层，行为完全可控。
 */
export interface ComboInputProps {
  value: string;
  onChange: (value: string) => void;
  /** 候选值列表。 */
  options: string[];
  /** 候选展示文案覆盖（key → 更友好的说明）。 */
  labels?: Record<string, string>;
  placeholder?: string;
  /** 校验失败时标红。 */
  invalid?: boolean;
  /** 输入框类型。 */
  type?: 'text' | 'password';
  /** 自动完成关闭（密码框用）。 */
  autoComplete?: string;
  /** 无候选时的提示文案。 */
  emptyHint?: string;
  /** 展开按钮的 title。 */
  toggleTitle?: string;
}

export function ComboInput({
  value,
  onChange,
  options,
  labels,
  placeholder,
  invalid,
  type = 'text',
  autoComplete = 'off',
  emptyHint = '暂无可选项，请手动输入',
  toggleTitle = '展开候选列表',
}: ComboInputProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // 点击组件外部 / 按 Esc 时收起
  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const deduped = Array.from(new Set(options.filter(Boolean)));

  return (
    <div className="combo" ref={wrapperRef}>
      <input
        type={type}
        className={invalid ? 'invalid' : ''}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="icon-btn combo-toggle"
        title={toggleTitle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▴' : '▾'}
      </button>

      {open && (
        <div className="combo-list" role="listbox">
          {deduped.length === 0 ? (
            <div className="combo-empty">{emptyHint}</div>
          ) : (
            deduped.map((option) => (
              <div
                key={option}
                role="option"
                aria-selected={option === value}
                className={`combo-item${option === value ? ' active' : ''}`}
                title={labels?.[option] ?? option}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {labels?.[option] ? `${option}　${labels[option]}` : option}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
