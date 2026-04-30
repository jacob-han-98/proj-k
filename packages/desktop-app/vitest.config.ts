import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // sql.js (WASM) 은 require 통과만 시키면 정상 동작. native ABI 고민 없음.
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
