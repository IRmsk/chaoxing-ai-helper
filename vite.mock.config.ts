import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * 独立于扩展构建的「Mock 验证」配置。
 *
 * 目的：在真实学习通页面之外，用一份模拟聊天 DOM 验证 content 层的
 * 「探测 → 写值 → 发送 → 回复完成检测」闭环，符合文档「先写 mock.html
 * 验证输入注入 + 回复检测逻辑，再上真实页面」的建议。
 *
 * 与扩展构建完全隔离，不会影响 `dist/` 产物。
 */
export default defineConfig({
  root: 'mock',
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../mock-dist',
    emptyOutDir: true,
    target: 'chrome114',
    // 打成 IIFE，便于后续内联进单个 HTML（可以用 file:// 直接双击打开，无需起服务）
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/mock.js',
        assetFileNames: 'assets/mock.[ext]',
      },
    },
  },
  server: {
    port: 5180,
    open: true,
  },
});
