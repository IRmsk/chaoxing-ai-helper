import { createLogger } from '@/common/logger';

/**
 * 「图片类上传节点」的作品生成：**程序运行的控制台截图**。
 *
 * ## 为什么需要这个模块
 *
 * 真机实测（2026-09）：任务流里的上传节点有两种提交类型，站点在作品卡片上写明
 *
 * ```
 * 类型：文档   数量：1   ← 提交 .docx
 * 类型：图片   数量：1   ← 提交 .png / .jpg
 * ```
 *
 * 而且**附件选择器的入参完全不同**：
 *
 * ```
 * 类型=文档 → /attCommon/s?…&fileTypes=doc,docx
 * 类型=图片 → /attCommon/s?…&fileTypes=png,jpg,jpeg
 * ```
 *
 * 旧实现只会生成 `.docx`，遇到「类型：图片」的节点时：
 * - 选择器直接显示 **「上传失败：类型不支持」**；
 * - 因为没挂上附件，点「开始评估」只会弹 `评估失败，请稍后重试`；
 * - 助手在那一格**永远走不动**（真机上就是这样卡住整个流程的）。
 *
 * ## 怎么画
 *
 * 用 `<canvas>` 画一个终端窗口（标题栏 + 等宽字体正文），再 `toDataURL('image/png')`。
 * canvas 只在有 DOM 的上下文可用，所以这一步必须放在**内容脚本**里
 * （background 的 Service Worker 没有 DOM，画不了）。
 * 2 倍缩放保证截图清晰。
 */

const log = createLogger('content:console-image');

/** 生成参数。 */
export interface ConsoleShotOptions {
  /** 窗口标题（一般是「节点标题 — 控制台输出」）。 */
  title: string;
  /** 控制台正文（多行文本）。 */
  text: string;
  /** 输出的文件名（不含扩展名）。 */
  fileName: string;
}

/** 生成结果。 */
export interface ConsoleShot {
  fileName: string;
  base64: string;
  /** 正文行（供记录与展示）。 */
  lines: string[];
}

const FONT_STACK = 'Consolas, "Cascadia Mono", "Courier New", Menlo, monospace';
const LINE_HEIGHT = 24;
const FONT_SIZE = 15;
const PAD_X = 20;
const PAD_Y = 16;
const TITLE_BAR = 38;
const SCALE = 2;
const MIN_WIDTH = 720;
const MAX_LINES = 22;

/** 去掉 Markdown 包裹、规整空白，得到纯控制台文本。 */
function cleanConsoleText(raw: string): string[] {
  const text = (raw || '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/\r/g, '');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, i, arr) => !(line === '' && (i === 0 || arr[i - 1] === '')))
    .slice(0, MAX_LINES);
}

/** 行 → 颜色（让截图看起来像真的终端输出）。 */
function colorOf(line: string): string {
  if (/exception|error|错误|失败|FAIL/i.test(line)) return '#f48771';
  if (/成功|通过|BUILD SUCCESS|passed|OK\b|正确|completed/i.test(line)) return '#89d185';
  if (/^\s*(PS\s*[^>]*>|\$|>|javac?|mvn|gradle)\b/i.test(line)) return '#4fc1ff';
  if (/^\s*(at\s|Caused by)/.test(line)) return '#d7ba7d';
  return '#d4d4d4';
}

/**
 * 把控制台文本画成一张 PNG 截图。
 *
 * @param options 标题、正文、文件名。
 * @returns 文件信息 + base64（不含 `data:` 前缀）。
 * @throws 在没有 canvas 的环境（如 Service Worker）里抛错。
 */
export function generateConsoleScreenshot(options: ConsoleShotOptions): ConsoleShot {
  const lines = cleanConsoleText(options.text);
  if (lines.length === 0) lines.push('(无输出)');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境不支持 canvas，无法生成截图');

  // 先量宽度（等宽字体：按字符数估算，够稳且不需要真实测量）
  const longest = lines.reduce((max, line) => Math.max(max, line.length), options.title.length);
  const width = Math.max(MIN_WIDTH, PAD_X * 2 + Math.ceil(longest * FONT_SIZE * 0.62) + 8);
  const height = TITLE_BAR + PAD_Y * 2 + lines.length * LINE_HEIGHT + 8;

  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  ctx.scale(SCALE, SCALE);

  // 背景
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);

  // 标题栏
  ctx.fillStyle = '#323233';
  ctx.fillRect(0, 0, width, TITLE_BAR);
  ctx.fillStyle = '#3c3c3c';
  ctx.fillRect(0, TITLE_BAR - 1, width, 1);

  // 三个圆点
  const dots = ['#ff5f56', '#ffbd2e', '#27c93f'];
  dots.forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(PAD_X + i * 20, TITLE_BAR / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // 标题文字
  ctx.fillStyle = '#c8c8c8';
  ctx.font = `13px ${FONT_STACK}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(options.title.slice(0, 80), PAD_X + 76, TITLE_BAR / 2);

  // 正文
  ctx.textBaseline = 'top';
  ctx.font = `${FONT_SIZE}px ${FONT_STACK}`;
  lines.forEach((line, i) => {
    ctx.fillStyle = colorOf(line);
    ctx.fillText(line, PAD_X, TITLE_BAR + PAD_Y + i * LINE_HEIGHT);
  });

  // 外框
  ctx.strokeStyle = '#3c3c3c';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const fileName = `${sanitizeFileName(options.fileName)}.png`;
  log.info(`已生成控制台截图：${fileName}（${width}×${height}，${lines.length} 行）`);
  return { fileName, base64, lines };
}

/** 去掉文件名里不能用于附件的字符。 */
export function sanitizeFileName(name: string): string {
  return (name || '作品')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 60);
}

/**
 * 让模型给出「修复后运行成功」的控制台输出。
 *
 * 只产出纯文本（不要 Markdown 代码块），随后交给 canvas 画成截图。
 */
export function buildConsolePrompt(params: {
  title: string;
  requirement: string;
  previousSummary?: string;
}): string {
  const { title, requirement, previousSummary } = params;
  return [
    `你是一名 Java 工程师。任务节点「${title}」要求提交一份作品，提交要求原文如下：`,
    requirement.slice(0, 600) || '(未读到具体要求)',
    '',
    '请写出这段程序**修复后运行成功**时的控制台输出，用于截图提交。要求：',
    '1. 8~14 行，包含：执行的编译/运行命令、关键日志、最终的正确结果；',
    '2. 只输出控制台文本本身，不要任何解释、不要 Markdown 代码块标记；',
    '3. 与下面的前序成果保持一致，不要编造矛盾的数据。',
    previousSummary ? `\n【前序节点的成果（供衔接）】\n${previousSummary.slice(0, 900)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
