import { MSG, sendToBackground, type DetectInfo } from '@/common/messages';
import type { PanelStatus } from '@/types';

/**
 * 运行状态卡片：展示当前状态、轮次、探测诊断，并提供轻量操作入口。
 */

const TONE_COLOR: Record<string, string> = {
  idle: '#98a2b3',
  waiting: '#f79009',
  running: '#12b76a',
  error: '#f04438',
};

const STATE_LABEL: Record<string, string> = {
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

export interface StatusCardProps {
  status: PanelStatus | null;
  hasWorker: boolean;
  detect: DetectInfo | null;
  /** 当前标签页是否在学习通站点下。 */
  onSite: boolean;
  /** 轮次变更后刷新。 */
  onRefresh: () => void;
}

export function StatusCard({ status, hasWorker, detect, onSite, onRefresh }: StatusCardProps) {
  const state = status?.state ?? 'IDLE';
  const tone = status?.tone ?? 'idle';

  /** 清空当前课程计数（同时清空对话上下文）。 */
  const handleReset = async () => {
    const courseId = status?.courseId || undefined;
    const reply = await sendToBackground<{ ok: boolean; error?: string }>({
      type: MSG.RESET_COUNTER,
      courseId,
    });
    if (!reply?.ok) {
      window.alert(reply?.error ?? '清空失败');
      return;
    }
    onRefresh();
  };

  return (
    <div className="card">
      <div className="card-title">
        <span>运行状态</span>
        <span className="hint">{onSite ? '已打开学习通页面' : '当前不是学习通页面'}</span>
      </div>

      <div className="status-head">
        <span className="lamp" style={{ background: TONE_COLOR[tone] ?? TONE_COLOR.idle }} />
        <span className="status-name">
          {STATE_LABEL[state] ?? state}
          {!hasWorker && onSite && ' · 未探测到对话窗口'}
        </span>
        <span className="status-round">
          {status?.round ?? 0} / {status?.maxRounds ?? '-'} 轮
        </span>
      </div>

      <div className={`status-msg${state === 'ERROR' ? ' is-error' : ''}`}>
        {status?.error ?? status?.message ?? (onSite ? '等待内容脚本上报…' : '请先打开学习通 AI 实践页面')}
      </div>

      <div className="kv">
        <div className="kv-row">
          <span className="kv-key">课程</span>
          <span className="kv-val">{status?.courseId || '—'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">探测</span>
          <span className="kv-val">
            {detect
              ? `${detect.source} · 置信度 ${(detect.confidence * 100).toFixed(0)}% · 输入框 ${detect.inputKind} · 消息 ${detect.messageCount} 条（AI ${detect.aiMessageCount} / 我 ${detect.userMessageCount}）`
              : '尚无诊断信息'}
          </span>
        </div>
        {detect?.sample && (
          <div className="kv-row">
            <span className="kv-key">样本</span>
            <span className="kv-val">{detect.sample}</span>
          </div>
        )}
      </div>

      <div className="footer" style={{ marginTop: 10 }}>
        <button className="ghost" onClick={handleReset} title="清空当前课程的轮次计数与对话上下文">
          清空当前课程计数
        </button>
      </div>
    </div>
  );
}
