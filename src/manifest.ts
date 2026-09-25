import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

/**
 * Manifest V3 声明。
 *
 * 关键设计说明：
 * 1. `all_frames: true` —— 学习通大量使用 iframe 嵌套，AI 实践对话窗口极可能
 *    位于子 iframe 中，必须在所有 frame 注入才能探测到目标 DOM。
 * 2. `optional_host_permissions` —— 用户可自定义 Base URL（第三方中转 / 兼容
 *    OpenAI 协议的端点）。出于最小权限原则，不默认申请 `<all_urls>`，而是在
 *    Popup 中「保存 / 测试连接」时按需申请该 Base URL 的源权限。
 * 3. `web_accessible_resources` —— 面板资源需要在页面上下文中可访问。
 */
export default defineManifest({
  manifest_version: 3,
  name: '学习通 AI 实践助手',
  version: pkg.version,
  description:
    '自动完成学习通（超星）AI 实践对话：抓取 AI 提问 → DeepSeek 作答 → 自动填写并发送，支持轮数上限、间隔控制与悬浮控制面板。',
  minimum_chrome_version: '114',

  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },

  permissions: ['storage', 'scripting', 'activeTab', 'tabs'],

  // 默认即可用的源：学习通站点 + DeepSeek 官方 API
  host_permissions: [
    '*://*.chaoxing.com/*',
    'https://api.deepseek.com/*',
  ],

  // 自定义 Base URL 时按需申请（最小权限原则）
  optional_host_permissions: ['https://*/*', 'http://*/*'],

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  content_scripts: [
    {
      matches: ['*://*.chaoxing.com/*'],
      js: ['src/content/index.tsx'],
      css: ['src/content/content.css'],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],

  action: {
    default_popup: 'src/popup/index.html',
    default_title: '学习通 AI 实践助手',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },

  web_accessible_resources: [
    {
      resources: ['icons/*', 'assets/*'],
      matches: ['*://*.chaoxing.com/*'],
    },
  ],
});
