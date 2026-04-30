// Renderer-only Vite config for headless web testing.
//
// electron-vite's dev command bundles main+preload+renderer together and spawns
// Electron — which we cannot do from a Linux-only WSL environment. This config
// serves the React renderer on its own at http://127.0.0.1:5180/ so Playwright
// (or any browser) can load it. Tests inject a mock `window.projk` via
// `page.addInitScript` so the renderer doesn't need real IPC.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  server: {
    port: 5180,
    host: '127.0.0.1',
    strictPort: true,
  },
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
