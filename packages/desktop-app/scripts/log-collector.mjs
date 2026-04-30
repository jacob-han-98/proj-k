// Klaud → WSL log push collector.
//
// Klaud 의 main process console.log/warn/error 를 fire-and-forget POST 로 받아
// packages/desktop-app/debug/klaud-<YYYY-MM-DD>.log 에 append + stdout 미러.
//
// 실행:
//   npm run serve:log-collector
//   npm run serve:log-collector -- --port 8773
//
// 프로토콜:
//   POST /log   { level, message, ts, pid, app_version? }
//   GET  /health → { ok: true }
//
// CORS 전부 허용. 사용자 PC Klaud 가 ws/http 둘 다 로컬호스트 → WSL forwarding 으로 접근.
//
// stdout 한 줄 = 한 라인 로그 (JSON 아님 — 사람 읽기 좋게 평문). Claude 는 BashOutput
// 또는 Monitor 로 tail 가능.

import { createServer } from 'node:http';
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const LOG_DIR = join(PKG_DIR, 'debug');

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const PORT = Number(process.env.PORT ?? opt('port', 8772));

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function logFilePath() {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(LOG_DIR, `klaud-${stamp}.log`);
}

function writeLine(line) {
  appendFileSync(logFilePath(), line + '\n');
  console.log(line);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = (req.url ?? '/').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, log_file: logFilePath() }));
    return;
  }

  if (req.method === 'POST' && url === '/screenshot') {
    try {
      const body = await readJsonBody(req);
      const b64 = body.png_base64;
      if (!b64 || typeof b64 !== 'string') {
        res.statusCode = 400;
        res.end('missing png_base64');
        return;
      }
      const SCREENSHOTS_DIR = join(LOG_DIR, 'screenshots');
      if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fname = `klaud-${stamp}.png`;
      const localPath = join(SCREENSHOTS_DIR, fname);
      writeFileSync(localPath, Buffer.from(b64, 'base64'));
      writeLine(`screenshot saved → ${localPath}`);

      // tmpfiles.org 에 익명 upload — 외부 URL 받아 모바일에서도 볼 수 있게.
      try {
        const url0 = await uploadToTmpfiles(localPath);
        writeLine(`screenshot uploaded → ${url0}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, url: url0, local_path: localPath }));
      } catch (e) {
        writeLine(`upload 실패: ${String(e)}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: String(e), local_path: localPath }));
      }
    } catch (e) {
      res.statusCode = 400;
      res.end(`bad request: ${e.message}`);
    }
    return;
  }

  if (req.method === 'POST' && url === '/log') {
    try {
      const body = await readJsonBody(req);
      const ts = body.ts ? new Date(body.ts).toISOString() : new Date().toISOString();
      const level = (body.level ?? 'log').toUpperCase().padEnd(5, ' ');
      const tag = body.tag ? `[${body.tag}]` : '';
      const msg = typeof body.message === 'string' ? body.message : JSON.stringify(body.message);
      writeLine(`${ts} ${level} ${tag} ${msg}`);
      res.statusCode = 204;
      res.end();
    } catch (e) {
      res.statusCode = 400;
      res.end(`bad request: ${e.message}`);
    }
    return;
  }

  res.statusCode = 404;
  res.end('not found');
});

// tmpfiles.org — 익명 free file host. 응답 JSON: { status, data: { url } }.
// 0x0.st 는 AI botnet 스팸으로 중단됨, transfer.sh 는 다운, catbox 는 412 — tmpfiles 가
// 현재 가장 안정적. 60분 안에 사용자가 봐야 함 (자동 만료).
function uploadToTmpfiles(localPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', ['-sSf', '-F', `file=@${localPath}`, 'https://tmpfiles.org/api/v1/upload']);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c.toString()));
    proc.stderr.on('data', (c) => (err += c.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`curl exit=${code} stderr=${err.trim()}`));
      try {
        const body = JSON.parse(out);
        const url = body?.data?.url;
        if (!url) return reject(new Error(`no url in response: ${out.slice(0, 200)}`));
        // tmpfiles 의 view URL → direct download URL 로 변환 (인라인 이미지 보기 좋음).
        const direct = url.replace('://tmpfiles.org/', '://tmpfiles.org/dl/');
        resolve(direct);
      } catch (e) {
        reject(new Error(`json parse: ${e.message} body=${out.slice(0, 200)}`));
      }
    });
    proc.on('error', reject);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  writeLine(`---- log collector listening 0.0.0.0:${PORT} → ${logFilePath()} ----`);
});

process.on('SIGINT', () => {
  writeLine('---- log collector shutting down ----');
  server.close(() => process.exit(0));
});
