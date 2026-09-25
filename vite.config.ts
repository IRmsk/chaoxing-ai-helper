import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

/**
 * Vite 构建配置。
 *
 * - `@crxjs/vite-plugin` 负责解析 `src/manifest.ts`，自动把 manifest 中声明的
 *   service worker / content script / popup 页面作为多入口打包，并产出可直接
 *   「加载解压缩的扩展」的 `dist/` 目录。
 * - `resolve.alias` 提供 `@/` 指向 `src/`，让分层引用更短、更稳定。
 * - `build.target` 对齐 Edge/Chrome 114+（文档硬性约束）。
 */
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'chrome114',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // 避免产物名带过多层级，方便在扩展调试器中查看
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/chunk-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    hmr: false,
  },
});
