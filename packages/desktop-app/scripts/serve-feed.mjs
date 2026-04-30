// release/ 디렉터리를 정적 HTTP 로 노출.
// 설치된 Project K 앱이 PROJK_UPDATE_FEED_URL 로 폴링 → latest.yml + .exe 받아감.
//
// WSL2 의 localhost 포트는 Windows 호스트에서도 바로 접근됨.
// 즉 사용자 PC 에서 http://localhost:8765/ 로 도달.
//
// 옵션:
//   PORT=8765         (default 8765)
//   --port 8770
//   --host 0.0.0.0    (다른 머신에서도 접근하려면, 기본은 127.0.0.1)

import { createServer } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'release');

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const PORT = Number(process.env.PORT ?? opt('port', 8765));
const HOST = String(opt('host', '127.0.0.1'));

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.zip': 'application/zip',
  '.json': 'application/json',
};

if (!existsSync(ROOT)) {
  console.error(`[serve-feed] ${ROOT} 가 없습니다 — 먼저 npm run release 실행`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const decoded = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const safe = decoded.replace(/^\/+/, '').replace(/\.\.+/g, '');
  const filePath = safe ? join(ROOT, safe) : ROOT;

  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.end('not found');
    console.log(`[serve-feed] 404 ${decoded}`);
    return;
  }
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    // 간단한 디렉터리 인덱스
    const entries = (require('node:fs').readdirSync(filePath) ?? []).map((n) => `<li><a href="${n}">${n}</a></li>`).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h3>release/</h3><ul>${entries}</ul>`);
    return;
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'no-cache');
  console.log(`[serve-feed] 200 ${decoded} (${mime}, ${stat.size}B)`);
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[serve-feed] http://${HOST}:${PORT}/  (root: ${ROOT})`);
  console.log(`[serve-feed] 사용자 앱의 PROJK_UPDATE_FEED_URL 을 위 URL 로 설정`);
  console.log(`[serve-feed] Ctrl+C 로 종료`);
});
