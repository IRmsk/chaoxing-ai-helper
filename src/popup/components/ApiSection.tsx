import { useState } from 'react';
import { PRESET_BASE_URLS, PRESET_MODELS } from '@/common/constants';
import type { Config, ValidationIssue } from '@/types';
import { ComboInput } from './ComboInput';
import { Field } from './Field';

/**
 * 接口配置区：Base URL / API Key / 模型 / 温度。
 *
 * 三个硬性约束（对应文档验收标准与用户要求）：
 * - `Base URL`、`API Key`、`模型` 均为**必填**，为空时保存会被拦截并给出中文提示；
 * - `Base URL` 与 `API Key` 填好后可一键「获取模型列表」，从下拉候选中挑选模型；
 * - 模型与 Base URL 都用自绘下拉（`ComboInput`），既能点选也能手动输入 ——
 *   原生 `<datalist>` 在扩展弹窗里**不会渲染**，必须替换。
 */
export interface ApiSectionProps {
  config: Config;
  onPatch: (patch: Partial<Config>) => void;
  errors: ValidationIssue[];
  models: string[];
  fetching: boolean;
  onFetchModels: () => void;
  testing: boolean;
  onTest: () => void;
  testMessage: { kind: 'ok' | 'err' | 'info'; text: string } | null;
}

/** 预设模型的展示文案。 */
const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  PRESET_MODELS.map((item) => [item.value, `（${item.label.replace(/^.*?（|）$/g, '')}）`]),
);

/** 预设 Base URL 的展示文案。 */
const BASE_URL_LABELS: Record<string, string> = Object.fromEntries(
  PRESET_BASE_URLS.map((item) => [item.value, `（${item.label}）`]),
);

export function ApiSection({
  config,
  onPatch,
  errors,
  models,
  fetching,
  onFetchModels,
  testing,
  onTest,
  testMessage,
}: ApiSectionProps) {
  const [showKey, setShowKey] = useState(false);

  const errorOf = (field: keyof Config) => errors.find((e) => e.field === field)?.message;

  // 已拉取的模型优先，其后是预设
  const modelOptions = [...models, ...PRESET_MODELS.map((m) => m.value)];

  return (
    <div className="card">
      <div className="card-title">
        <span>接口配置</span>
        <span className="hint">默认 DeepSeek 官方</span>
      </div>

      <Field label="Base URL" required error={errorOf('baseUrl')} tip="自动补 /chat/completions">
        <div className="input-with-btn">
          <ComboInput
            value={config.baseUrl}
            onChange={(next) => onPatch({ baseUrl: next })}
            options={PRESET_BASE_URLS.map((item) => item.value)}
            labels={BASE_URL_LABELS}
            placeholder="https://api.deepseek.com"
            invalid={Boolean(errorOf('baseUrl'))}
            toggleTitle="展开常用 Base URL"
          />
        </div>
      </Field>

      <Field label="API Key" required error={errorOf('apiKey')} tip="仅保存在本机浏览器">
        <div className="input-with-btn">
          <input
            type={showKey ? 'text' : 'password'}
            className={errorOf('apiKey') ? 'invalid' : ''}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            value={config.apiKey}
            onChange={(event) => onPatch({ apiKey: event.target.value })}
          />
          <button className="icon-btn" type="button" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        {config.apiKey.trim() === '' && (
          <div className="footnote" style={{ marginTop: 4 }}>
            提示：API Key 不会写入源码，也不会随浏览器账号同步。
          </div>
        )}
      </Field>

      <Field
        label="模型"
        required
        error={errorOf('model')}
        tip={models.length ? `已获取 ${models.length} 个` : '可点选或手动输入'}
      >
        <div className="input-with-btn">
          <ComboInput
            value={config.model}
            onChange={(next) => onPatch({ model: next })}
            options={modelOptions}
            labels={MODEL_LABELS}
            placeholder="deepseek-chat"
            invalid={Boolean(errorOf('model'))}
            emptyHint="点右侧「获取列表」拉取，或直接手动输入模型名"
            toggleTitle="展开模型候选"
          />
          <button type="button" disabled={fetching} onClick={onFetchModels}>
            {fetching ? '获取中…' : '获取列表'}
          </button>
        </div>
      </Field>

      <div className="row cols-2">
        <Field label="温度" error={errorOf('temperature')} tip="0~2">
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={config.temperature}
            onChange={(event) => onPatch({ temperature: Number(event.target.value) })}
          />
        </Field>
        <Field label="单次请求超时" error={errorOf('requestTimeoutSec')} tip="秒">
          <input
            type="number"
            min={5}
            max={600}
            value={config.requestTimeoutSec}
            onChange={(event) => onPatch({ requestTimeoutSec: Number(event.target.value) })}
          />
        </Field>
      </div>

      <button className="primary" type="button" disabled={testing} onClick={onTest}>
        {testing ? '测试中…' : '测试连接'}
      </button>

      {testMessage && (
        <div className={`toast ${testMessage.kind}`} style={{ marginTop: 10 }}>
          {testMessage.text}
        </div>
      )}
    </div>
  );
}
