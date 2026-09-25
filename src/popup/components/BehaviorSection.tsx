import { DEFAULT_CONFIG } from '@/common/constants';
import type { Config, ValidationIssue } from '@/types';
import { Field } from './Field';
import { Switch } from './Switch';

/**
 * 作答行为配置区：系统提示词、轮数上限、间隔与各类超时。
 */
export interface BehaviorSectionProps {
  config: Config;
  onPatch: (patch: Partial<Config>) => void;
  errors: ValidationIssue[];
}

export function BehaviorSection({ config, onPatch, errors }: BehaviorSectionProps) {
  const errorOf = (field: keyof Config) => errors.find((e) => e.field === field)?.message;

  return (
    <div className="card">
      <div className="card-title">
        <span>作答行为</span>
        <span className="hint">决定回答风格与节奏</span>
      </div>

      <Field
        label="System Prompt"
        required
        error={errorOf('systemPrompt')}
        tip={`${config.systemPrompt.length} 字`}
      >
        <textarea
          rows={4}
          className={errorOf('systemPrompt') ? 'invalid' : ''}
          value={config.systemPrompt}
          onChange={(event) => onPatch({ systemPrompt: event.target.value })}
        />
        <div className="footnote" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="ghost"
            style={{ padding: '2px 6px', fontSize: 11 }}
            onClick={() => onPatch({ systemPrompt: DEFAULT_CONFIG.systemPrompt })}
          >
            恢复默认
          </button>
        </div>
      </Field>

      <div className="row cols-2">
        <Field label="最大轮数" required error={errorOf('maxRounds')}>
          <input
            type="number"
            min={1}
            max={500}
            value={config.maxRounds}
            onChange={(event) => onPatch({ maxRounds: Number(event.target.value) })}
          />
        </Field>
        <Field label="每轮间隔" error={errorOf('intervalSec')} tip="秒">
          <input
            type="number"
            min={0}
            max={600}
            value={config.intervalSec}
            onChange={(event) => onPatch({ intervalSec: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="row cols-2">
        <Field label="回复超时" error={errorOf('replyTimeoutSec')} tip="秒">
          <input
            type="number"
            min={5}
            max={1800}
            value={config.replyTimeoutSec}
            onChange={(event) => onPatch({ replyTimeoutSec: Number(event.target.value) })}
          />
        </Field>
        <Field label="等提问超时" error={errorOf('questionTimeoutSec')} tip="秒">
          <input
            type="number"
            min={5}
            max={1800}
            value={config.questionTimeoutSec}
            onChange={(event) => onPatch({ questionTimeoutSec: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="footnote">
        多轮上下文保留最近 <code>20</code> 条消息（自动截断最早的对话），保证回答连贯同时控制 token 消耗。
      </div>

      <Switch
        checked={config.autoStart}
        onChange={(next) => onPatch({ autoStart: next })}
        title="打开页面后自动开始"
        description="默认开启。探测到对话窗口即自动作答；关闭后需手动点悬浮面板的「开始」。"
      />
    </div>
  );
}
