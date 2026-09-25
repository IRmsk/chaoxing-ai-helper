import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

/**
 * Word（.docx）文档生成。
 *
 * 学习通「上传作品」节点只接受 `.docx`，且服务端会对文档做**智能批注**解析，
 * 因此必须是结构合法的 OOXML —— 这里用成熟库 `docx`（dolanmiu）生成，
 * 而不是手写 ZIP + XML（那种做法容易产出 Word 打不开的残次品）。
 *
 * 生成位置选在 **background（Service Worker）** 而不是内容脚本：
 * - 内容脚本会注入到每个 frame，把几百 KB 的打包体积摊到每个 frame 是浪费；
 * - background 只有一个实例，且 `docx` 不依赖 DOM（已验证 `Packer.toBase64String`
 *   在无 DOM 环境下可正常工作）。
 */

/** 文档结构描述（由大模型按此结构输出，再由本模块渲染成 docx）。 */
export interface DocumentSpec {
  /** 文档标题。 */
  title: string;
  /** 副标题 / 说明（可选）。 */
  subtitle?: string;
  /** 正文分节。 */
  sections: {
    /** 小节标题。 */
    heading?: string;
    /** 普通段落。 */
    paragraphs?: string[];
    /** 无序列表项。 */
    bullets?: string[];
  }[];
}

/** 生成结果。 */
export interface GeneratedDocx {
  /** 文件名（已做安全化处理）。 */
  fileName: string;
  /** base64 编码的 .docx 字节（不带 data URL 前缀）。 */
  base64: string;
  /** 结构摘要（用于记录与 UI 展示）。 */
  outline: string[];
}

/** 把任意文本里不适合做文件名的字符替换掉。 */
export function safeFileName(raw: string, fallback = '实践作品'): string {
  const cleaned = (raw || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 48);
  const name = cleaned || fallback;
  return name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`;
}

/**
 * 渲染为 .docx。
 *
 * @param spec 文档结构。
 * @param fileNameHint 文件名提示（会做安全化）。
 * @returns 文件名 + base64 内容 + 大纲。
 */
export async function buildDocx(spec: DocumentSpec, fileNameHint?: string): Promise<GeneratedDocx> {
  const children: Paragraph[] = [new Paragraph({ text: spec.title, heading: HeadingLevel.HEADING_1 })];

  if (spec.subtitle) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: spec.subtitle, italics: true, size: 21 })],
        spacing: { after: 200 },
      }),
    );
  }

  const outline: string[] = [];
  for (const section of spec.sections ?? []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }));
      outline.push(section.heading);
    }
    for (const paragraph of section.paragraphs ?? []) {
      const text = (paragraph || '').trim();
      if (!text) continue;
      children.push(new Paragraph({ text, spacing: { after: 120 } }));
    }
    for (const bullet of section.bullets ?? []) {
      const text = (bullet || '').trim();
      if (!text) continue;
      children.push(new Paragraph({ text, bullet: { level: 0 } }));
    }
  }

  const doc = new Document({
    creator: '学习通 AI 实践助手',
    title: spec.title,
    description: spec.subtitle ?? '',
    sections: [{ children }],
  });

  const base64 = await Packer.toBase64String(doc);
  return { fileName: safeFileName(fileNameHint || spec.title), base64, outline };
}

/**
 * 把大模型返回的文本解析成 `DocumentSpec`。
 *
 * 优先按 JSON 解析（提示词里要求输出 JSON）；失败时退化为**轻量 Markdown 解析**
 * （`#` / `##` 标题、`-` 列表、其余按段落）—— 模型偶尔会加 ```json 包裹或直接给 Markdown，
 * 这两种情况都不该让整个流程失败。
 *
 * @param raw 模型返回的原始文本。
 * @param fallbackTitle 解析不出标题时的兜底标题。
 */
export function parseDocumentSpec(raw: string, fallbackTitle: string): DocumentSpec {
  const text = (raw || '').trim();

  // 1) 尝试 JSON（兼容 ```json 包裹）
  const jsonText = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(jsonText.slice(start, end + 1)) as Partial<DocumentSpec>;
      if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.sections)) {
        return {
          title: parsed.title.trim() || fallbackTitle,
          subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : undefined,
          sections: parsed.sections.map((s) => ({
            heading: typeof s?.heading === 'string' ? s.heading : undefined,
            paragraphs: Array.isArray(s?.paragraphs) ? s.paragraphs.map(String) : undefined,
            bullets: Array.isArray(s?.bullets) ? s.bullets.map(String) : undefined,
          })),
        };
      }
    } catch {
      /* 落到 Markdown 解析 */
    }
  }

  // 2) 轻量 Markdown 解析
  const sections: DocumentSpec['sections'] = [];
  let title = fallbackTitle;
  let current: DocumentSpec['sections'][number] | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, '').trim() || title;
      continue;
    }
    if (/^#{2,}\s+/.test(line)) {
      current = { heading: line.replace(/^#{2,}\s+/, '').trim(), paragraphs: [], bullets: [] };
      sections.push(current);
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      if (!current) {
        current = { paragraphs: [], bullets: [] };
        sections.push(current);
      }
      current.bullets = [...(current.bullets ?? []), line.replace(/^[-*•]\s+/, '').trim()];
      continue;
    }
    if (!current) {
      current = { paragraphs: [], bullets: [] };
      sections.push(current);
    }
    current.paragraphs = [...(current.paragraphs ?? []), line];
  }

  if (sections.length === 0) {
    sections.push({ paragraphs: [text || '（无内容）'] });
  }
  return { title, sections };
}

/**
 * 提示词：让模型产出「作品文档」的内容结构。
 *
 * @param options 任务标题 / 提交要求 / 页面背景资料 / 之前节点的记录。
 */
export function buildDocumentPrompt(options: {
  taskTitle: string;
  requirement: string;
  pageContext: string;
  previousSummary: string;
}): string {
  const parts = [
    '请为下面的学习任务撰写一份**作品文档**，用于作为「上传作品」节点提交的 Word 文件。',
    '',
    `【任务标题】${options.taskTitle || '（未提供）'}`,
    `【提交要求】${options.requirement || '（未提供）'}`,
  ];
  if (options.pageContext) parts.push(`【页面背景资料】\n${options.pageContext}`);
  if (options.previousSummary) parts.push(`【前序节点内容（需衔接、不要重复）】\n${options.previousSummary}`);
  parts.push(
    '',
    '要求：',
    '1. 内容必须紧扣提交要求，是可直接提交的成品，不要出现"以下是"这类对话口吻；',
    '2. 结构清晰，含若干小节，每节用标题 + 段落（必要时用列表）；',
    '3. 语言专业、具体，适当引用前序节点中已经完成的分析与结论；',
    '4. **只输出 JSON**，不要任何解释、不要 Markdown 代码块围栏，格式如下：',
    '{"title":"文档标题","subtitle":"一句话说明","sections":[{"heading":"小节标题","paragraphs":["段落1","段落2"],"bullets":["要点1"]}]}',
  );
  return parts.join('\n');
}
