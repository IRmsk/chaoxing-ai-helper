import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import type { PanelStatus } from '@/types';
import type { Command } from '@/common/messages';
import { Panel, panelStyles } from '@/content/panel/Panel';
import { App as PopupApp } from '@/popup/App';
import '@/popup/popup.css';

/**
 * UI 预览台入口。
 *
 * 目的：在没有 Edge 扩展运行时的普通页面里，把 Popup 与悬浮面板**真实渲染**出来，
 * 用于视觉回归检查（改样式后一眼就能看到有没有崩）。
 *
 * 扩展 API 由 `index.html` 里的内联桩提供，因此这里可以直接复用生产组件，
 * 不需要为了预览而改任何业务代码。
 */

/* ------------------------------------------------------------------ */
/* 场景数据                                                            */
/* ------------------------------------------------------------------ */

const BASE: Omit<PanelStatus, 'state' | 'tone' | 'message'> = {
  round: 3,
  maxRounds: 10,
  courseId: '266014297',
  detected: true,
  confidence: 0.9,
  lastQuestion: '如果把这个思路放到真实的课程场景里，你认为最先会遇到什么约束？请结合具体例子回答。',
  lastAnswer: '我觉得最先遇到的约束是数据可得性，其次是算力成本。课堂上我们能拿到的样本量很小…',
  updatedAt: Date.now(),
};

/** 场景定义：覆盖状态机的全部典型分支。 */
const SCENARIOS: { key: string; label: string; status: PanelStatus; hasWorker?: boolean }[] = [
  {
    key: 'idle',
    label: '任务流·对话节点',
    status: {
      ...BASE,
      state: 'WAITING_QUESTION',
      tone: 'waiting',
      round: 3,
      message: '节点 2/3「调试取证」：对话进行中…',
      nodeIndex: 2,
      nodeTotal: 3,
      nodeTitle: '调试取证',
      nodeTypeLabel: '情景对话',
      phase: 'dialogue',
    },
  },
  {
    key: 'upload',
    label: '任务流·上传节点',
    status: {
      ...BASE,
      state: 'FILLING',
      tone: 'running',
      round: 0,
      message: '节点 3/3「假设验证与修复」：正在生成 Word 作品…',
      nodeIndex: 3,
      nodeTotal: 3,
      nodeTitle: '假设验证与修复',
      nodeTypeLabel: '上传作品',
      phase: 'prepare-doc',
    },
  },
  {
    key: 'waiting',
    label: '等待回复',
    status: { ...BASE, state: 'WAITING_REPLY', tone: 'waiting', message: 'AI 正在回复…（已输出 46 字）' },
  },
  {
    key: 'calling',
    label: '请求 AI',
    status: { ...BASE, state: 'CALLING_DEEPSEEK', tone: 'running', message: '正在向 deepseek-chat 请求答案…' },
  },
  {
    key: 'paused',
    label: '已暂停',
    status: { ...BASE, state: 'PAUSED', tone: 'waiting', message: '已暂停（当前 3 轮，点「继续」可恢复）' },
  },
  {
    key: 'error',
    label: '出错',
    status: {
      ...BASE,
      state: 'ERROR',
      tone: 'error',
      message: '等待 AI 回复超时（90 秒），可在弹窗中调大「回复超时」。',
      error: '等待 AI 回复超时（90 秒），可在弹窗中调大「回复超时」。',
    },
  },
  {
    key: 'done',
    label: '已完成',
    status: { ...BASE, state: 'DONE', tone: 'running', round: 10, message: '已完成 10 轮，达到上限 10，任务结束' },
  },
  {
    key: 'nodetect',
    label: '未探测到',
    hasWorker: false,
    status: {
      ...BASE,
      state: 'IDLE',
      tone: 'idle',
      round: 0,
      detected: false,
      confidence: 0,
      message: '正在探测对话窗口…',
      lastQuestion: undefined,
      lastAnswer: undefined,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Popup 预览                                                          */
/* ------------------------------------------------------------------ */

const popupMount = document.getElementById('popup-mount');
if (popupMount) {
  popupMount.className = 'app';
  createRoot(popupMount).render(createElement(PopupApp));
}

/* ------------------------------------------------------------------ */
/* 悬浮面板预览                                                        */
/* ------------------------------------------------------------------ */

const stage = document.getElementById('panel-mount');
const commandLog = document.getElementById('command-log');

let panelRoot: ReturnType<typeof createRoot> | null = null;

/** 在 Shadow DOM 中挂载面板（与 content script 的挂载方式一致）。 */
function mountPanel(): HTMLDivElement {
  const host = document.createElement('div');
  host.setAttribute('data-cxai-ui', 'panel-host');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelStyles;
  // 仅预览用：把「固定定位」改成「随容器定位」，避免浮在整个预览页上
  const override = document.createElement('style');
  override.textContent = '.cxai-panel { position: absolute !important; }';
  const container = document.createElement('div');
  shadow.append(style, override, container);

  stage?.appendChild(host);
  panelRoot = createRoot(container);
  return container;
}

const panelContainer = mountPanel();

function renderPanel(scenarioIndex: number): void {
  const scenario = SCENARIOS[scenarioIndex];
  panelRoot?.render(
    createElement(Panel, {
      status: scenario.status,
      hasWorker: scenario.hasWorker ?? true,
      onCommand: (cmd: Command) => {
        if (commandLog) {
          const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          commandLog.textContent = `${time}  面板下发指令：${cmd}\n` + (commandLog.textContent ?? '');
        }
      },
      onOpenDebug: () => {
        if (commandLog) commandLog.textContent = '已触发「调试选择器」→ 真实运行时会打开可视化拾取面板\n' + (commandLog.textContent ?? '');
      },
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 场景切换                                                            */
/* ------------------------------------------------------------------ */

const bar = document.getElementById('scenario-bar');
SCENARIOS.forEach((scenario, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pv-scenario';
  button.textContent = scenario.label;
  if (index === 1) button.classList.add('active');
  button.addEventListener('click', () => {
    bar?.querySelectorAll('.pv-scenario').forEach((el) => el.classList.remove('active'));
    button.classList.add('active');
    renderPanel(index);
  });
  bar?.appendChild(button);
});

renderPanel(1);

void panelContainer;
