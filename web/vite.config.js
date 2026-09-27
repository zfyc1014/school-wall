import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // …/web
const repoRoot = resolve(here, '..');

/**
 * 构建产物落在 web/dist/，用一个变量交给 server/ 的静态服务：
 *   WEB_ROOT=/srv/confession-wall/web/dist
 *   INDEX_FILE=index.html
 *
 * 为什么不直接把产物写到仓库根：
 *   1) 仓库根是 Vite 的 root，outDir 落在 root 之上会触发 Vite 的保护性告警；
 *   2) 产物与 school-confession-wall.html 单文件原型混在同一层，容易互相覆盖；
 *   3) 分离后 Caddy 可以直接把 web/dist/assets 当纯静态目录长缓存分发。
 * 单文件原型继续可用：把 INDEX_FILE 改回 school-confession-wall.html 即可，
 * 两者同源共存，共用 server/ 的 /api。
 */
export default defineConfig({
  root: repoRoot,           // 仓库根为 Vite 根（web/index.html 为唯一入口）
  base: './',               // 相对路径：既能挂在域名根，也能挂在子目录
  publicDir: resolve(here, 'public'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // 同时跑 server/ 时，前端直接 fetch('/api/…') 就能命中真实后端，无需 CORS。
    proxy: {
      '/api': {
        target: process.env.OD_API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.OD_API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2019', // 低配环境 / 老 WebView 友好
    sourcemap: false,
    assetsInlineLimit: 4096,
  },
});
