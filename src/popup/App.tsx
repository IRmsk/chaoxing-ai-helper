import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CONFIG } from '@/common/constants';
import { createLogger } from '@/common/logger';
import {
  MSG,
  sendToBackground,
  type DetectInfo,
  type LogsPayload,
  type TestConnectionResult,
} from '@/common/messages';
import {
  clearOverrides,
  getConfig,
  getDebugMode,
  getOverrides,
  saveConfig,
  setDebugMode,
  validateConfig,
} from '@/common/storage';
import type { Config, PanelStatus, ValidationIssue } from '@/types';
import { AdvancedSection } from './components/AdvancedSection';
import { ApiSection } from './components/ApiSection';
import { BehaviorSection } from './components/BehaviorSection';
import { StatusCard } from './components/StatusCard';

/**
 * Popup 主界面。
 *
 * 职责：配置读写、连接测试、模型列表拉取、运行状态轮询、日志导出。
 */

const log = createLogger('popup');

/** 判定当前标签页是否在学习通站点下。 */
const SITE_RE = /chaoxing\.com/i;

/**
 * 读取扩展版本号用于展示。
 *
 * 优先从 manifest 取（避免与 package.json 版本脱节）；在 UI 预览台等没有
 * 真实扩展运行时的环境里退回占位值。
 */
const EXTENSION_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '1.0.0';
  }
})();

type Toast = { kind: 'ok' | 'err' | 'info'; text: string } | null;

/**
 * 按需申请自定义 Base URL 的访问权限。
 *
 * 浏览器要求权限申请必须由用户手势触发，因此该函数只在按钮点击链路中调用。
 *
 * @param baseUrl 用户填写的根地址。
 * @throws 用户拒绝授权时抛出中文错误。
 */
async function ensurePermission(baseUrl: string): Promise<void> {
  let origin: string;
  try {
    origin = new URL(baseUrl.trim()).origin + '/*';
  } catch {
    throw new Error('Base URL 不是合法地址，请检查是否包含协议（https://）');
  }
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`未授权访问 ${origin}，扩展无法向该地址发起请求。请重新点击并允许授权。`);
  }
}

export function App() {
  const [config, setConfig] = useState<Config>({ ...DEFAULT_CONFIG });
  const [debug, setDebug] = useState(false);
  /** 已保存的自定义选择器（用于展示数量与一键清除）。 */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const [models, setModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<Toast>(null);

  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [hasWorker, setHasWorker] = useState(false);
  const [detect, setDetect] = useState<DetectInfo | null>(null);
  const [onSite, setOnSite] = useState(false);
  const tabIdRef = useRef<number | null>(null);

  /* ---------------- 初始化 ---------------- */

  useEffect(() => {
    void (async () => {
      const [cfg, dbg, ov] = await Promise.all([getConfig(), getDebugMode(), getOverrides()]);
      setConfig(cfg);
      setDebug(dbg);
      setOverrides((ov ?? {}) as Record<string, string>);
      setLoaded(true);
      log.info('配置已载入');
    })();
  }, []);

  /* ---------------- 状态轮询 ---------------- */

  const refreshStatus = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    tabIdRef.current = tab.id;
    setOnSite(SITE_RE.test(tab.url ?? ''));

    const reply = await sendToBackground<{
      ok: boolean;
      data?: { status: PanelStatus | null; hasWorker: boolean; detect: DetectInfo | null };
    }>({ type: MSG.GET_STATUS, tabId: tab.id });

    if (reply?.ok && reply.data) {
      setStatus(reply.data.status);
      setHasWorker(reply.data.hasWorker);
      setDetect(reply.data.detect);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1000);
    return () => window.clearInterval(timer);
  }, [loaded, refreshStatus]);

  /* ---------------- 表单操作 ---------------- */

  const patch = useCallback((next: Partial<Config>) => {
    setConfig((prev) => ({ ...prev, ...next }));
  }, []);

  /** 当前应展示的校验错误（首次点击保存后才显示，避免打开即满屏红）。 */
  const errors: ValidationIssue[] = showErrors ? validateConfig(config, { requireApiKey: true }) : [];

  const handleSave = useCallback(async () => {
    setShowErrors(true);
    const issues = validateConfig(config, { requireApiKey: true });
    if (issues.length > 0) {
      setToast({ kind: 'err', text: `请修正以下问题：${issues.map((i) => i.message).join('；')}` });
      return;
    }
    setSaving(true);
    setToast(null);
    try {
      await ensurePermission(config.baseUrl);
      await saveConfig(config);
      setToast({ kind: 'ok', text: '配置已保存，窗口即将自动关闭…' });
      log.info('配置已保存，600ms 后关闭弹窗');
      // 保存成功后自动关闭弹窗；留一点时间让用户看到成功提示
      window.setTimeout(() => window.close(), 600);
    } catch (err) {
      setToast({ kind: 'err', text: (err as Error)?.message ?? '保存失败' });
      setSaving(false);
      return;
    }
    setSaving(false);
  }, [config]);

  const handleTest = useCallback(async () => {
    setShowErrors(true);
    const issues = validateConfig(config, { requireApiKey: true }).filter(
      (i) => i.field === 'apiKey' || i.field === 'baseUrl' || i.field === 'model',
    );
    if (issues.length > 0) {
      setTestMessage({ kind: 'err', text: issues.map((i) => i.message).join('；') });
      return;
    }
    setTesting(true);
    setTestMessage({ kind: 'info', text: '正在连接…' });
    try {
      await ensurePermission(config.baseUrl);
      const reply = await sendToBackground<{ ok: boolean; data?: TestConnectionResult; error?: string }>({
        type: MSG.TEST_CONNECTION,
        payload: { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model },
      });
      if (!reply?.ok || !reply.data) {
        setTestMessage({ kind: 'err', text: reply?.error ?? '测试失败' });
        return;
      }
      if (reply.data.models?.length) setModels(reply.data.models);
      setTestMessage({
        kind: reply.data.ok ? 'ok' : 'err',
        text: `${reply.data.message}${reply.data.latencyMs ? `（耗时 ${reply.data.latencyMs} ms）` : ''}`,
      });
    } catch (err) {
      setTestMessage({ kind: 'err', text: (err as Error)?.message ?? '测试失败' });
    } finally {
      setTesting(false);
    }
  }, [config]);

  const handleFetchModels = useCallback(async () => {
    setShowErrors(true);
    if (!config.apiKey.trim() || !config.baseUrl.trim()) {
      setTestMessage({ kind: 'err', text: '请先填写 Base URL 与 API Key，再获取模型列表' });
      return;
    }
    setFetching(true);
    try {
      await ensurePermission(config.baseUrl);
      const reply = await sendToBackground<{ ok: boolean; data?: string[]; error?: string }>({
        type: MSG.FETCH_MODELS,
        payload: { apiKey: config.apiKey, baseUrl: config.baseUrl },
      });
      if (!reply?.ok || !reply.data) {
        setTestMessage({ kind: 'err', text: reply?.error ?? '获取模型列表失败' });
        return;
      }
      setModels(reply.data);
      patch({ model: config.model || reply.data[0] });
      setTestMessage({ kind: 'ok', text: `已获取 ${reply.data.length} 个模型，可在「模型」下拉框中选择` });
    } catch (err) {
      setTestMessage({ kind: 'err', text: (err as Error)?.message ?? '获取模型列表失败' });
    } finally {
      setFetching(false);
    }
  }, [config, patch]);

  const handleDebugChange = useCallback(async (next: boolean) => {
    setDebug(next);
    await setDebugMode(next);
    setToast({
      kind: 'info',
      text: next
        ? '已开启选择器调试模式：刷新学习通页面后将自动弹出可视化拾取面板'
        : '已关闭选择器调试模式',
    });
  }, []);

  const handleExportLogs = useCallback(async () => {
    const reply = await sendToBackground<{ ok: boolean; data?: LogsPayload; error?: string }>({
      type: MSG.GET_LOGS,
    });
    const text = reply?.data?.text ?? '';
    if (!text) {
      setToast({ kind: 'err', text: '暂无日志可导出' });
      return;
    }
    // 优先复制到剪贴板，失败则退化为下载文件
    try {
      await navigator.clipboard.writeText(text);
      setToast({ kind: 'ok', text: `已复制 ${reply.data?.entries.length ?? 0} 条日志到剪贴板` });
    } catch {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cxai-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      setToast({ kind: 'ok', text: '日志文件已开始下载' });
    }
  }, []);

  const handleClearLogs = useCallback(async () => {
    await sendToBackground({ type: MSG.CLEAR_LOGS });
    setToast({ kind: 'info', text: '日志已清空' });
  }, []);

  const handleClearOverrides = useCallback(async () => {
    await clearOverrides();
    setOverrides({});
    setToast({ kind: 'ok', text: '自定义选择器已清除，已恢复内置候选表（刷新页面后生效）' });
  }, []);

  /* ---------------- 渲染 ---------------- */

  if (!loaded) {
    return (
      <div className="app">
        <div className="card">正在载入配置…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="top">
        <span className="top-logo">AI</span>
        <span className="top-title">学习通 AI 实践助手</span>
        <span className="top-version">v{EXTENSION_VERSION}</span>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

      <StatusCard
        status={status}
        hasWorker={hasWorker}
        detect={detect}
        onSite={onSite}
        onRefresh={() => void refreshStatus()}
      />

      <ApiSection
        config={config}
        onPatch={patch}
        errors={errors}
        models={models}
        fetching={fetching}
        onFetchModels={() => void handleFetchModels()}
        testing={testing}
        onTest={() => void handleTest()}
        testMessage={testMessage}
      />

      <BehaviorSection config={config} onPatch={patch} errors={errors} />

      <AdvancedSection
        debug={debug}
        onDebugChange={(next) => void handleDebugChange(next)}
        onExportLogs={() => void handleExportLogs()}
        onClearLogs={() => void handleClearLogs()}
        onClearOverrides={() => void handleClearOverrides()}
        overrideCount={Object.keys(overrides).length}
        busy={false}
      />

      <div className="footer">
        <span className="spacer" />
        <button className="primary" type="button" disabled={saving} onClick={() => void handleSave()}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  );
}
