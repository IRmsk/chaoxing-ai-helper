import type { ReactNode } from 'react';

/**
 * 表单字段容器：统一「标签 + 必填标记 + 错误提示」的排版。
 */
export interface FieldProps {
  /** 字段名。 */
  label: string;
  /** 是否必填（显示红色星号）。 */
  required?: boolean;
  /** 校验错误信息。 */
  error?: string;
  /** 右侧灰色提示。 */
  tip?: string;
  children: ReactNode;
}

export function Field({ label, required, error, tip, children }: FieldProps) {
  return (
    <div className="field">
      <div className="field-label">
        <span>
          {label}
          {required && <span className="required"> *</span>}
        </span>
        {tip && <span className="inline-tip">{tip}</span>}
      </div>
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
