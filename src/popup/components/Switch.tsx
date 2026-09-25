/**
 * 开关组件（纯 CSS 实现，无需额外依赖）。
 */
export interface SwitchProps {
  /** 当前状态。 */
  checked: boolean;
  /** 变更回调。 */
  onChange: (next: boolean) => void;
  /** 标题。 */
  title: string;
  /** 说明文案。 */
  description?: string;
  /** 是否禁用。 */
  disabled?: boolean;
}

export function Switch({ checked, onChange, title, description, disabled }: SwitchProps) {
  return (
    <label className="switch-row" style={disabled ? { opacity: 0.6 } : undefined}>
      <span className="switch-text">
        <span className="t">{title}</span>
        {description && (
          <>
            <br />
            <span className="d">{description}</span>
          </>
        )}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch-track" />
      </span>
    </label>
  );
}
