// dev-bundle-server: Klaud 의 hot-swap 인프라.
//
// out/ 폴더의 file 들을 host. Klaud (사용자 PC) 가 5초마다 /manifest.json 를 polling
// 해서 sha 비교 → 차이 발견 시 changed file 만 fetch → 자기 자신의 app.asar.unpacked/out/
// 으로 write → app.relaunch. 빌드 cycle ~5초 (electron-vite build 만, NSIS 패키징 skip).
//
// 실행:
//   npm run serve:dev-bundle
//   npm run serve:dev-bundle -- --port 8774
//
// 프로토콜:
//   GET /health             → { ok: true, files: N }
//   GET /manifest.json      → { files: [{ path, sha256, size }] }  (out/ 의 모든 file)
//   GET /<rel-path>         → file 내용 (out/ 안의 path)
//
// Klaud 가 정식 release 한 번 받은 뒤부터 동작. 다음 사이클부터는 npm run build 만 하면
// 자동 swap.

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { walk } from './_walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const OUT_DIR = join(PKG_DIR, 'out');

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const PORT = Number(process.env.PORT ?? opt('port', 8773));

function buildManifest() {
  if (!existsSync(OUT_DIR)) return { files: [], generatedAt: Date.now() };
  const files = [];
  for (const abs of walk(OUT_DIR)) {
    const rel = abs.slice(OUT_DIR.length + 1).split(sep).join(posix.sep);
    const buf = readFileSync(abs);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    files.push({ path: rel, sha256, size: buf.length });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, generatedAt: Date.now() };
}

function logLine(s) {
  console.log(`[${new Date().toISOString()}] ${s}`);
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = (req.url ?? '/').split('?')[0];

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('method not allowed');
    return;
  }

  if (url === '/health') {
    const m = buildManifest();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, files: m.files.length, out_dir: OUT_DIR }));
    return;
  }

  if (url === '/manifest.json') {
    const m = buildManifest();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(m));
    return;
  }

  // /<rel-path> 형태로 file fetch.
  // 보안: out/ 밖으로 못 나가도록 simple normalization.
  const rel = decodeURIComponent(url.replace(/^\/+/, ''));
  if (!rel || rel.includes('..')) {
    res.statusCode = 400;
    res.end('bad path');
    return;
  }
  const abs = join(OUT_DIR, rel);
  if (!abs.startsWith(OUT_DIR + sep) || !existsSync(abs)) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  try {
    const st = statSync(abs);
    if (!st.isFile()) {
      res.statusCode = 400;
      res.end('not a file');
      return;
    }
    const buf = readFileSync(abs);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.end(`error: ${e.message}`);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logLine(`dev-bundle-server listening 0.0.0.0:${PORT} → ${OUT_DIR}`);
  if (!existsSync(OUT_DIR)) {
    logLine(`(주의) out/ 폴더 없음 — npm run build 먼저 실행 필요`);
  }
});

process.on('SIGINT', () => {
  logLine('shutdown');
  server.close(() => process.exit(0));
});
