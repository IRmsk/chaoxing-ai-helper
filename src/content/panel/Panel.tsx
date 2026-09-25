import { useCallback, useEffect, useRef, useState } from 'react';
import { getPanelPrefs, setPanelPrefs } from '@/common/storage';
import type { Command } from '@/common/messages';
import type { PanelStatus, StateName, StateTone } from '@/types';
import styles from './panel.css?inline';

/**
 * 悬浮控制面板（对应文档 4.8）。
 *
 * - 折叠态：右下角一个带状态色的小圆球，可拖拽；
 * - 展开态：状态灯 / 当前轮次 / 开始·暂停·停止·单次触发 / 调试入口；
 * - 位置与折叠状态持久化到 `chrome.storage.local`，刷新后保持不变。
 */

/** 指示灯颜色（灰=空闲 / 绿=运行中 / 黄=等待 / 红=错误）。 */
const TONE_COLOR: Record<StateTone, string> = {
  idle: '#98a2b3',
  waiting: '#f79009',
  running: '#12b76a',
  error: '#f04438',
};

/** 状态中文名。 */
const STATE_LABEL: Record<StateName, string> = {
  IDLE: '空闲',
  DETECTING: '探测中',
  WAITING_QUESTION: '等待提问',
  CALLING_DEEPSEEK: '请求 AI',
  FILLING: '写入中',
  SENDING: '发送中',
  WAITING_REPLY: '等待回复',
  PAUSED: '已暂停',
  DONE: '已完成',
  ERROR: '出错',
};

/** 处于「忙碌」的状态集合（此时只允许暂停/停止）。 */
const BUSY_STATES = new Set<StateName>([
  'DETECTING',
  'WAITING_QUESTION',
  'CALLING_DEEPSEEK',
  'FILLING',
  'SENDING',
  'WAITING_REPLY',
]);

export interface PanelProps {
  status: PanelStatus | null;
  /** background 是否已登记 worker（即探测到对话窗口）。 */
  hasWorker: boolean;
  onCommand: (cmd: Command) => void;
  /** 打开「选择器调试模式」。 */
  onOpenDebug: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function Panel({ status, hasWorker, onCommand, onOpenDebug }: PanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [pos, setPos] = useState({ x: 24, y: 96 });
  const [ready, setReady] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  // 读取持久化的位置与折叠状态
  useEffect(() => {
    void getPanelPrefs().then((prefs) => {
      setCollapsed(prefs.collapsed);
      setPos({ x: prefs.x, y: prefs.y });
      setReady(true);
    });
  }, []);

  /**
   * 通用拖拽：以「距右/距下」为坐标系，避免窗口缩放时位置跑飞。
   *
   * @param event 指针按下事件。
   * @param onTap 未发生位移时视为点击的回调（悬浮球展开/折叠用）。
   */
  const startDrag = useCallback((event: React.PointerEvent, onTap?: () => void) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...posRef.current };
    let latest = { ...start };
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      const dy = startY - ev.clientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      latest = {
        x: clamp(start.x + dx, 8, Math.max(8, window.innerWidth - 80)),
        y: clamp(start.y + dy, 8, Math.max(8, window.innerHeight - 80)),
      };
      setPos(latest);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        onTap?.();
        return;
      }
      void setPanelPrefs(latest);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, []);

  const toggleCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    void setPanelPrefs({ collapsed: next });
  }, []);

  const tone: StateTone = status?.tone ?? 'idle';
  const state = status?.state ?? 'IDLE';
  const busy = BUSY_STATES.has(state);
  const round = status?.round ?? 0;
  const maxRounds = status?.maxRounds ?? 0;
  const percent = maxRounds > 0 ? Math.min(100, Math.round((round / maxRounds) * 100)) : 0;

  if (!ready) return null;

  const style: React.CSSProperties = { right: pos.x, bottom: pos.y };

  /* ---------------- 折叠态 ---------------- */
  if (collapsed) {
    return (
      <div className="cxai-panel" style={style} data-cxai-ui="panel">
        <div
          className={`cxai-ball tone-${tone}`}
          style={{ position: 'relative' }}
          title={`学习通 AI 实践助手 · ${STATE_LABEL[state]}${maxRounds ? `（${round}/${maxRounds}）` : ''}`}
          onPointerDown={(event) => startDrag(event, () => toggleCollapsed(false))}
        >
          <span className="cxai-ball-ring" />
          <span className="cxai-ball-dot" style={{ background: TONE_COLOR[tone] }} />
        </div>
      </div>
    );
  }

  /* ---------------- 展开态 ---------------- */
  return (
    <div className="cxai-panel" style={style} data-cxai-ui="panel">
      <div className="cxai-card">
        <div className="cxai-head" onPointerDown={(event) => startDrag(event)}>
          <span className="cxai-head-title">学习通 AI 实践助手</span>
          <button
            className="cxai-icon-btn"
            title="折叠为悬浮球"
            onClick={() => toggleCollapsed(true)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            —
          </button>
        </div>

        <div className="cxai-body">
          <div className="cxai-status">
            <span className="cxai-lamp" style={{ background: TONE_COLOR[tone] }} />
            <div className="cxai-status-text">
              <div className="cxai-status-title">
                {STATE_LABEL[state]}
                {!hasWorker && ' · 未探测到对话窗口'}
              </div>
              <div className={`cxai-status-msg${state === 'ERROR' ? ' is-error' : ''}`}>
                {status?.error ?? status?.message ?? '等待中…'}
              </div>
            </div>
          </div>

          {typeof status?.nodeTotal === 'number' && status.nodeTotal > 0 && (
            <div className="cxai-node">
              <span className="cxai-node-index">
                节点 {(status.nodeIndex ?? 0) || '-'}/{status.nodeTotal}
              </span>
              <span className="cxai-node-type">{status.nodeTypeLabel || '任务流'}</span>
              {status.nodeTitle && <span className="cxai-node-title">{status.nodeTitle}</span>}
            </div>
          )}

          <div className="cxai-meter">
            <span className="cxai-meter-label">轮次</span>
            <span className="cxai-meter-bar">
              <span className="cxai-meter-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="cxai-meter-value">
              {round} / {maxRounds}
            </span>
          </div>

          {(status?.lastQuestion || status?.lastAnswer) && (
            <div className="cxai-detail">
              {status?.lastQuestion && (
                <div className="cxai-detail-row">
                  <span className="cxai-detail-key">提问</span>
                  <span className="cxai-detail-val">{status.lastQuestion}</span>
                </div>
              )}
              {status?.lastAnswer && (
                <div className="cxai-detail-row">
                  <span className="cxai-detail-key">作答</span>
                  <span className="cxai-detail-val">{status.lastAnswer}</span>
                </div>
              )}
            </div>
          )}

          <div className="cxai-actions">
            <button
              className="cxai-btn primary"
              disabled={busy}
              onClick={() => onCommand(state === 'ERROR' || state === 'PAUSED' ? 'RESUME' : 'START')}
            >
              {state === 'ERROR' ? '重试' : state === 'PAUSED' ? '继续' : '开始'}
            </button>
            <button className="cxai-btn" disabled={!busy} onClick={() => onCommand('PAUSE')}>
              暂停
            </button>
            <button
              className="cxai-btn danger"
              disabled={!busy && state !== 'PAUSED' && state !== 'ERROR'}
              onClick={() => onCommand('STOP')}
            >
              结束
            </button>
          </div>

          <div className="cxai-foot">
            {state === 'ERROR' && (
              <button
                className="cxai-link"
                onClick={() => onCommand('SKIP')}
                title="跳过当前这一轮，继续往下跑"
              >
                跳过本轮
              </button>
            )}
            <button
              className="cxai-link"
              onClick={() => onCommand('DIAGNOSE')}
              title="把探测结果、消息解析结果与每条消息的 DOM 路径打印到页面控制台"
            >
              诊断
            </button>
            <button className="cxai-link" onClick={onOpenDebug} title="手动点选对话窗口的关键元素并保存">
              调试选择器
            </button>
            <button
              className="cxai-link"
              onClick={() => onCommand('RESET')}
              title="清空当前课程的轮次计数与对话上下文"
            >
              清空计数
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 悬浮面板使用的样式字符串（供 Shadow DOM 注入）。 */
export const panelStyles = styles;
