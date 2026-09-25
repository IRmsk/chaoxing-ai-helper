import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * UI 预览台构建配置（独立于扩展构建，产物落在 `ui-preview-dist/`）。
 *
 * 为什么单独一份配置而不是复用 `vite.mock.config.ts`：
 * mock 验证台不需要 React（走 IIFE + 单文件内联），而 UI 预览台要渲染真实的
 * React 组件；两者插件与入口都不同，拆开更清晰，也避免互相牵扯。
 */
export default defineConfig({
  root: 'preview',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../ui-preview-dist',
    emptyOutDir: true,
    target: 'chrome114',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/ui.js',
        assetFileNames: 'assets/ui.[ext]',
      },
    },
  },
  server: {
    port: 5190,
    open: true,
  },
});
