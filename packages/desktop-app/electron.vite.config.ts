import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// package.json 의 version 을 빌드 시점 string 으로 박아둔다.
// 자동 업데이트로 새 빌드가 적용되면 그 시점의 version 이 새 코드 안에 들어가므로
// 추가 IPC 호출 없이 어디에서나 정확한 표기가 가능.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const APP_VERSION = JSON.stringify(pkg.version);

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // sql.js 의 emscripten runtime 은 module/exports 객체를 기대하는 commonjs.
        // vite 가 ESM 으로 변환하면 'Cannot set properties of undefined (exports)'.
        // external 로 두어 packaged 가 raw require('sql.js') 사용하게 한다.
        external: ['sql.js'],
      },
    },
    define: {
      __APP_VERSION__: APP_VERSION,
      // ws 가 require('bufferutil') 을 시도해서 packaged 빌드에 깨진 reference 가
      // 박히는 0.1.23~0.1.24 버그 fix. ws 의 공식 escape hatch — 이 env var 가
      // truthy 면 ws/lib/buffer-util.js 의 try block 통째 skip → 항상 pure-JS mask.
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'confluence-inject': resolve(__dirname, 'src/preload/confluence-inject.ts'),
        },
      },
    },
    define: {
      __APP_VERSION__: APP_VERSION,
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
    define: {
      __APP_VERSION__: APP_VERSION,
    },
  },
});
