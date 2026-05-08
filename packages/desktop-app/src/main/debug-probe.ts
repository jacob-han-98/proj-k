// dev 전용 진단 HTTP 서버. bash 에서 curl 로 SP HEAD probe 를 trigger.
// Klaud 의 persist:onedrive partition (인증된 SSO cookie) 으로 HEAD 보냄.
//
// 사용 예:
//   curl -sS -X POST http://127.0.0.1:8770/head-probe \
//     -H "Content-Type: application/json" \
//     -d '{"relPaths":["7_System/PK_HUD 시스템","7_System/PK_NPC 시스템"]}'
//
// production build 에선 자동 비활성. dev (app.isPackaged=false) 만 listen.

import { createServer } from 'node:http';
import { app, session } from 'electron';

import { detectSyncAccount } from './onedrive-sync';

const PORT = 8770;
const KLAUD_TEMP_DIR = 'Klaud-temp';

interface ProbeResult {
  relPath: string;
  url: string;
  headStatus: number | null;
  headContentLength: number | null;
  headRedirectLocation: string | null;
  rangeStatus: number | null;
  zipBytes: string | null;
  isZipMagic: boolean | null;
  elapsedMs: number;
  error?: string;
}

async function probeOne(folder: string, relPath: string): Promise<ProbeResult> {
  const account = detectSyncAccount();
  if (!account) {
    return {
      relPath,
      url: '',
      headStatus: null,
      headContentLength: null,
      headRedirectLocation: null,
      rangeStatus: null,
      zipBytes: null,
      isZipMagic: null,
      elapsedMs: 0,
      error: 'OneDrive Sync 계정 미감지',
    };
  }
  const onedriveSession = session.fromPartition('persist:onedrive');
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  const url = `${account.userUrl}/Documents/${folder}/${encoded}.xlsx`;
  const t0 = Date.now();
  try {
    // redirect:'follow' — Electron 33 의 session.fetch 가 'manual' 시 'Redirect was cancelled'
    // 로 throw (회귀 2026-05-08, onedrive-sync.ts 와 같은 사유). follow 후 res.redirected /
    // res.url 로 분기. Location 헤더는 follow 시 사라지므로 final url 로 진단정보 노출.
    const headRes = await onedriveSession.fetch(url, { method: 'HEAD', redirect: 'follow' });
    const cl = headRes.headers.get('content-length');
    const loc = headRes.redirected ? (headRes.url || null) : null;

    let rangeStatus: number | null = null;
    let zipBytes: string | null = null;
    let isZipMagic: boolean | null = null;
    if (headRes.status === 200) {
      try {
        const rangeRes = await onedriveSession.fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-3' },
          redirect: 'follow',
        });
        rangeStatus = rangeRes.status;
        if (rangeRes.status === 200 || rangeRes.status === 206) {
          const buf = new Uint8Array(await rangeRes.arrayBuffer());
          zipBytes = Array.from(buf.slice(0, 4))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          isZipMagic =
            buf.length >= 4
            && buf[0] === 0x50
            && buf[1] === 0x4b
            && buf[2] === 0x03
            && buf[3] === 0x04;
        }
      } catch (e) {
        // range GET 예외 무시 — head 결과만 반환.
        zipBytes = `range-get-error: ${(e as Error).message}`;
      }
    }
    return {
      relPath,
      url,
      headStatus: headRes.status,
      headContentLength: cl != null ? Number(cl) : null,
      headRedirectLocation: loc,
      rangeStatus,
      zipBytes,
      isZipMagic,
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      relPath,
      url,
      headStatus: null,
      headContentLength: null,
      headRedirectLocation: null,
      rangeStatus: null,
      zipBytes: null,
      isZipMagic: null,
      elapsedMs: Date.now() - t0,
      error: (e as Error).message,
    };
  }
}

export function installDebugProbeServer(): void {
  if (app.isPackaged) {
    return;
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/head-probe' && req.url !== '/head-probe/')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'POST /head-probe only' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}') as {
          relPaths?: string[];
          folder?: string;
        };
        const folder = parsed.folder ?? KLAUD_TEMP_DIR;
        const relPaths = parsed.relPaths ?? [];
        if (!Array.isArray(relPaths) || relPaths.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'relPaths array required' }));
          return;
        }
        console.log(`[debug-probe] HEAD probe ${relPaths.length} files in ${folder}`);
        const results: ProbeResult[] = [];
        for (const rp of relPaths) {
          results.push(await probeOne(folder, rp));
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(results, null, 2));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[debug-probe] listening on http://127.0.0.1:${PORT}/head-probe (POST)`);
  });
  server.on('error', (e) => {
    console.warn(`[debug-probe] server error: ${(e as Error).message}`);
  });
}
