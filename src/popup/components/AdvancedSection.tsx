import { Switch } from './Switch';

/**
 * 高级区：选择器调试模式与日志工具。
 */
export interface AdvancedSectionProps {
  debug: boolean;
  onDebugChange: (next: boolean) => void;
  onExportLogs: () => void;
  onClearLogs: () => void;
  onClearOverrides: () => void;
  /** 当前已保存的自定义选择器数量（0 表示全部走内置候选表）。 */
  overrideCount: number;
  busy: boolean;
}

export function AdvancedSection({
  debug,
  onDebugChange,
  onExportLogs,
  onClearLogs,
  onClearOverrides,
  overrideCount,
  busy,
}: AdvancedSectionProps) {
  return (
    <div className="card">
      <div className="card-title">
        <span>高级</span>
        <span className="hint">排查选择器失效</span>
      </div>

      <Switch checked={debug} onChange={onDebugChange} title="选择器调试模式" />

      {overrideCount > 0 && (
        <div className="footnote" style={{ marginTop: 8 }}>
          已保存 <b>{overrideCount}</b> 个自定义选择器。若出现「探测到了但读不到消息」，
          多半是它们指向了错误的节点（例如把正文段落当成了消息列表），点下面按钮清掉即可回到内置候选表。
        </div>
      )}

      <div className="footer" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy} onClick={onExportLogs}>
          导出日志
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onClearLogs}>
          清空日志
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || overrideCount === 0}
          onClick={onClearOverrides}
          title="清除所有已保存的自定义选择器，恢复使用内置候选表"
        >
          清除自定义选择器
        </button>
        <span className="spacer" />
      </div>
    </div>
  );
}
