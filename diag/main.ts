/**
 * 真实页面诊断包。
 *
 * 直接调用 content 层的**生产代码**，在用户真实页面上跑一遍探测与消息解析，
 * 结果挂到 `window.__cxaiDiag()`，供 `scripts/probe-real.mjs` 通过 CDP 读取。
 *
 * 这是唯一能「在不装扩展的情况下，用真实代码验证真实页面」的手段。
 */

import { buildCssPath, getVisibleText, setActiveOverrides } from '@/common/dom-utils';
import { detectChat } from '@/content/detector';
import { getMessages, getPageContext, getPendingQuestion, describeMessages } from '@/content/observer';
import { readFlowState, readUploadRequirement, readCards, getDialogueFrame, hasNextNodeEntry, readActiveTitle } from '@/content/flow-dom';
import { classifyNodeType } from '@/content/flow-selectors';
import type { SelectorOverrides } from '@/types';

declare global {
  interface Window {
    __cxaiDiag?: (overrides?: SelectorOverrides) => unknown;
    /** 任务流解析诊断（在任务流宿主页面调用）。 */
    __cxaiFlow?: () => unknown;
  }
}

/** 指向正文段落的失效选择器（模拟线上被点错的自定义选择器）。 */
const POISONED: SelectorOverrides = {
  input: 'div.agent > div.agentRight > div.agentAnswer > div.answer_content > p',
  sendBtn: 'div.agent > div.agentRight > div.agentAnswer',
  messageList: 'div.agent > div.agentRight > div.agentAnswer > div.answer_content > p',
  chatRoot: 'div.agent > div.agentRight > div.agentAnswer > div.answer_content > p',
  messageItemAI: 'div.agent > div.agentRight > div.agentAnswer > div.answer_content > p',
  messageItemUser: 'div.agent > div.agentRight > div.agentAnswer > div.answer_content > p',
};

window.__cxaiDiag = (_overrides?: SelectorOverrides) => {
  const report: Record<string, unknown> = {};

  const run = (label: string, ov: SelectorOverrides, ignoreOverrides = false) => {
    setActiveOverrides(ignoreOverrides ? {} : ov);
    const targets = detectChat(ov, document, { ignoreOverrides });
    if (!targets) {
      report[label] = { ok: false, reason: 'detectChat 返回 null' };
      return null;
    }
    const messages = getMessages(targets.list);
    const pending = getPendingQuestion(targets.list);
    report[label] = {
      ok: messages.length > 0,
      来源: targets.source,
      置信度: targets.confidence,
      命中选择器: targets.matched,
      输入框: buildCssPath(targets.input),
      输入框是否锁定: (targets.input as HTMLTextAreaElement).disabled === true,
      消息列表: buildCssPath(targets.list),
      对话根容器: buildCssPath(targets.root),
      发送按钮: targets.sendBtn ? buildCssPath(targets.sendBtn) : null,
      继续按钮: targets.unlockBtn ? buildCssPath(targets.unlockBtn) : null,
      消息条数: messages.length,
      'AI/我方/未知': [
        messages.filter((m) => m.side === 'ai').length,
        messages.filter((m) => m.side === 'user').length,
        messages.filter((m) => m.side === 'unknown').length,
      ],
      待答问题: pending ? pending.text.slice(0, 80) : null,
      背景资料字数: getPageContext(targets).length,
      背景资料预览: getPageContext(targets).replace(/\s+/g, ' ').slice(0, 260),
      消息明细: messages.map((m) => ({
        侧别: m.side,
        路径: buildCssPath(m.el),
        文本: m.text.replace(/\s+/g, ' ').slice(0, 70),
      })),
    };
    return targets;
  };

  // 先无条件采集一次「整页文字」：即使当前没有可作答的输入框（例如已经跑到评估报告页），
  // 也能证明「不只读对话框」这条链路是通的
  const bodyText = document.body ? getVisibleText(document.body, [], false) : '';
  report['⓪ 整页文字'] = {
    字数: bodyText.length,
    预览: bodyText.replace(/\s+/g, ' ').slice(0, 300),
  };

  run('① 默认候选表', {});
  const withPoison = run('② 注入失效自定义选择器', POISONED);
  report['② 是否被拦截'] = withPoison ? '是（仍能解析出消息）' : '探测本身被拒';
  report['③ describeMessages'] = withPoison ? describeMessages(withPoison.list) : '无';

  setActiveOverrides({});
  return report;
};


/* ------------------------------------------------------------------ */
/* 任务流解析诊断                                                      */
/* ------------------------------------------------------------------ */

/**
 * 在任务流宿主页面上跑一遍节点解析，返回结构化结果。
 *
 * 用于在没有真实交互的情况下，验证「节点列表 / 当前节点 / 节点类型」是否读对 ——
 * 这类解析一旦读错，后续的上传与推进都会跑偏，必须在真实 DOM 上核对。
 */
window.__cxaiFlow = () => {
  const cards = readCards();
  const state = readFlowState();
  return {
    卡片数: cards.length,
    解析结果: state
      ? {
          节点总数: state.nodes.length,
          当前节点下标: state.currentIndex,
          当前节点类型: state.currentType,
          当前节点标题: state.currentTitle,
          右侧内容区: state.activeContent,
          右侧内容区标题: state.activeTitle || '(空，多为对话节点)',
          页面上还有可进入节点: hasNextNodeEntry(),
          全部完成: state.allCompleted,
          解锁条件: state.unlockCondition.slice(0, 120),
          待解锁节点: state.pendingNodes.map((p) => `${p.typeLabel} ${p.title}`),
          作品要求: state.requirement.slice(0, 200),
          对话iframe: Boolean(getDialogueFrame()),
          节点明细: state.nodes.map((n) => ({
            序号: n.label || String(n.domIndex + 1),
            类型: n.typeLabel,
            判定: classifyNodeType(n.typeLabel),
            标题: n.title,
            已完成: n.completed,
            当前: n.current,
            即将: n.upcoming,
            成绩: n.score || '',
            说明: n.description.slice(0, 60),
            完成条件: n.completeCondition.slice(0, 60),
          })),
        }
      : null,
    上传要求原文: readUploadRequirement().slice(0, 300),
    内容区标题原始读取: readActiveTitle() || '(空)',
  };
};
