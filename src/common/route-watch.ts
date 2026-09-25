import { createLogger } from './logger';

/**
 * 页面角色判定 + 路由变化监听。
 *
 * ## 为什么单独抽成模块
 *
 * 这是「**有时要刷新页面才能用**」的唯一根因，也是最容易写错的一处：
 *
 * 内容脚本**只在文档加载时注入一次**，而站点大量使用**同文档路由（SPA）**。
 * 如果把角色写成加载时的常量：
 *
 * ```ts
 * const ROLE = FLOW_URL_RE.test(location.href) ? 'flow' : 'chat';   // ❌
 * ```
 *
 * 那么从课程页 / 任务列表**同文档路由**跳到工作页时，脚本不会重新注入 ——
 * `location.href` 早就变了，`ROLE` 还是 `chat`，**整条工作流从不启动**。
 * 更坑的是背景脚本找不到目标 frame 时抛的提示恰好是「请刷新页面后重试」，
 * 用户会把这句话原样反馈回来，而代码逻辑看上去完全正确。
 *
 * 抽成纯函数 + 可注入的定时器，是为了**能被回归测到**
 * —— 否则这条修复只能靠真机手测，很容易在后续改动中被悄悄改回去。
 *
 * ## ⚠️ 为什么不 patch `history.pushState`
 *
 * 内容脚本跑在**隔离世界**，在那里给 `history`（或任何 DOM 对象）赋值只会创建
 * **该世界私有的 expando**，页面自己调用的仍是原函数 —— 根本拦不到。
 * 轮询 `location.href` 是唯一可靠且便宜的手段，再叠加 `popstate` / `hashchange`。
 */

const log = createLogger('route-watch');

/** 页面角色。 */
export type PageRole = 'picker' | 'flow' | 'chat';

/** 用于判定的 URL 特征。 */
export interface RolePatterns {
  /** 附件选择器页面。 */
  picker: RegExp;
  /** 任务流宿主页面。 */
  flow: RegExp;
}

/**
 * 按 URL 判定页面角色。
 *
 * 顺序很重要：先判最深、最专用的 `picker`（它是被宿主动态创建的最深层 iframe），
 * 否则会被宿主规则先截胡。
 *
 * @param href 当前 URL。
 * @param patterns 特征正则。
 * @param isPickerFrame 是否已由 frame 自身认定为选择器（例如按 `pathname` 判定）。
 * @returns 角色。
 */
export function classifyPageRole(href: string, patterns: RolePatterns, isPickerFrame = false): PageRole {
  if (isPickerFrame || patterns.picker.test(href)) return 'picker';
  if (patterns.flow.test(href)) return 'flow';
  return 'chat';
}

/** 路由监听的句柄。 */
export interface RouteWatcher {
  /** 手动触发一次检查（返回是否发生了角色变化）。 */
  check(): boolean;
  /** 停止监听（回归测试用）。 */
  stop(): void;
}

/**
 * 监听 URL 变化并在**角色发生变化**时回调。
 *
 * @param options.getHref 取当前 URL（默认 `location.href`，便于测试注入）。
 * @param options.patterns 角色特征。
 * @param options.isPickerFrame 是否强制认定为选择器 frame。
 * @param options.initialRole 起始角色（默认按当前 URL 判定）。
 * @param options.intervalMs 轮询间隔。
 * @param options.onChange 角色变化回调。
 * @param options.setIntervalFn / clearIntervalFn 便于测试注入的定时器。
 * @returns 句柄。
 */
export function watchRouteChanges(options: {
  patterns: RolePatterns;
  isPickerFrame?: boolean;
  getHref?: () => string;
  initialRole?: PageRole;
  intervalMs?: number;
  onChange: (role: PageRole, prev: PageRole, href: string) => void;
  setIntervalFn?: (fn: () => void, ms: number) => number;
  clearIntervalFn?: (id: number) => void;
}): RouteWatcher {
  const {
    patterns,
    isPickerFrame = false,
    getHref = () => location.href,
    intervalMs = 800,
    onChange,
    setIntervalFn = (fn, ms) => window.setInterval(fn, ms),
    clearIntervalFn = (id) => window.clearInterval(id),
  } = options;

  let lastHref = getHref();
  let role = options.initialRole ?? classifyPageRole(lastHref, patterns, isPickerFrame);

  const check = (): boolean => {
    const href = getHref();
    if (href === lastHref) return false;
    lastHref = href;
    const next = classifyPageRole(href, patterns, isPickerFrame);
    if (next === role) return false;
    const prev = role;
    role = next;
    log.info(`路由变化：${prev} → ${next}（${href.slice(-70)}）`);
    onChange(next, prev, href);
    return true;
  };

  const timer = setIntervalFn(check, intervalMs);
  const onEvent = (): void => {
    check();
  };
  try {
    window.addEventListener('popstate', onEvent);
    window.addEventListener('hashchange', onEvent);
  } catch {
    /* 极少数环境（无 window）忽略 */
  }

  return {
    check,
    stop() {
      clearIntervalFn(timer);
      try {
        window.removeEventListener('popstate', onEvent);
        window.removeEventListener('hashchange', onEvent);
      } catch {
        /* 忽略 */
      }
    },
  };
}
