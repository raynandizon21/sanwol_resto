import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

const normalizeWatchPath = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const projectRoot = normalizeWatchPath(__dirname);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Local development only. Add the production domain here once it's set up (see README).
      allowedHosts: ['localhost'],
      watch: {
        // On this shared host something (Tailwind v4's content auto-detection walking
        // up past the repo root, most likely) was picking up inotify watches on
        // constantly-written system files like /var/log/nginx/access.log and
        // /var/log/syslog. Every write to those triggered chokidar's "unknown file
        // changed" full-reload path, so the login page reloaded in an infinite loop.
        // Hard-restrict watching to this project so nothing outside it can trigger a reload.
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          // Compare normalized paths: on Windows chokidar passes forward slashes / a different
          // drive-letter case than __dirname, which made this ignore every project file.
          (file: string) => !normalizeWatchPath(file).startsWith(projectRoot),
        ],
      },
      proxy: {
        // Existing backend /api/* routes (dashboard, admin, etc.) — no rewrite needed
        '/api': { target: 'http://localhost:2000', changeOrigin: true },
        // socket.io realtime (waiter/kitchen/cashier live updates). ws:true is
        // required so the websocket Upgrade is forwarded to the Node server;
        // without this entry the handshake falls through to the SPA and the
        // mobile app's socket connection times out.
        '/socket.io': {
          target: 'http://localhost:2000',
          changeOrigin: true,
          ws: true,
        },
        // Menu-specific routes: use /data-api prefix → rewrite to root on backend
        // This avoids conflict with SPA route /menu
        '/data-api': {
          target: 'http://localhost:2000',
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/data-api/, ''),
        },
        '/branch': { target: 'http://localhost:2000', changeOrigin: true },
        '/uploads': { target: 'http://localhost:2000', changeOrigin: true },
        // Use /user/ (trailing slash) so /users/branches etc. are not proxied (SPA routes)
        '/user/': { target: 'http://localhost:2000', changeOrigin: true },
        '/audit-logs': { target: 'http://localhost:2000', changeOrigin: true },
        '/reports': { target: 'http://localhost:2000', changeOrigin: true },
      },
    },
  };
});
