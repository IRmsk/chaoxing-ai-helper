/**
 * URL / 页面信息工具。
 */

/**
 * 从 URL 中解析课程 ID。
 *
 * 学习通不同页面的参数名不统一（`courseId` / `courseid` / `course_id`），
 * 这里做兼容处理；同时兼容 hash 路由（`#/...?courseId=xxx`）。
 *
 * @param url 待解析的 URL；省略时使用当前页面地址。
 * @returns 课程 ID；解析不到时返回空串。
 */
export function parseCourseId(url?: string): string {
  const target = url ?? (typeof location !== 'undefined' ? location.href : '');
  if (!target) return '';
  const patterns = [/[?&#]courseId=([^&#]+)/i, /[?&#]courseid=([^&#]+)/i, /[?&#]course_id=([^&#]+)/i];
  for (const re of patterns) {
    const match = re.exec(target);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  // 兜底：用整个 URL 的 hash 作为分桶键，保证「至少不串课」
  return '';
}

/**
 * 生成一个稳定的「课程分桶键」。
 *
 * 优先使用课程 ID；若页面上确实拿不到，则退化为基于路径的键，
 * 保证轮次计数至少在同一个页面路径下是隔离且可持久化的。
 *
 * @param url 页面 URL。
 * @returns 分桶键。
 */
export function resolveCourseKey(url: string): string {
  const courseId = parseCourseId(url);
  if (courseId) return courseId;
  try {
    const u = new URL(url);
    return `path:${u.host}${u.pathname}`;
  } catch {
    return 'unknown';
  }
}

/**
 * 剔除 URL 中的敏感查询参数，便于日志输出。
 *
 * @param url 原始 URL。
 * @returns 仅保留协议、主机、路径的 URL。
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

/**
 * 命中「AI 实践对话页」路由特征。
 *
 * 真实页面的对话界面是 `…/mooc2-ans-vue/taskDialogue/pcDialogue`，
 * 外层壳是 `…/mooc2-ans-vue/taskChain/student/answer`。
 * 这两个路径本身就是很强的信号：命中时可以放宽探测门槛、并提高置信度，
 * 让「一打开页面就自动开始」更可靠。
 */
const AI_PRACTICE_URL_RE = /(taskDialogue|pcDialogue|taskChain\/student\/answer|ai-?practice)/i;

/**
 * 判断某个 URL 是否像 AI 实践对话页。
 *
 * @param url 待判断的 URL；省略时使用当前页面地址。
 */
export function isAiPracticeUrl(url?: string): boolean {
  const target = url ?? (typeof location !== 'undefined' ? location.href : '');
  return AI_PRACTICE_URL_RE.test(target);
}

