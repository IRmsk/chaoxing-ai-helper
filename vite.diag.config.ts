import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * 真实页面诊断包的构建配置。
 *
 * 用 **lib 模式**打成单个 IIFE（没有 HTML 入口），产物 `diag-dist/diag.js`
 * 可被 CDP 直接注入用户真实页面执行 —— 不依赖任何浏览器自动化 CLI，
 * 也不需要把扩展装进那个浏览器。
 *
 * 与扩展构建、Mock 验证台都完全隔离。
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'diag-dist',
    emptyOutDir: true,
    target: 'chrome114',
    lib: {
      entry: fileURLToPath(new URL('./diag/main.ts', import.meta.url)),
      formats: ['iife'],
      name: 'CxaiDiag',
      fileName: () => 'diag.js',
    },
  },
});
