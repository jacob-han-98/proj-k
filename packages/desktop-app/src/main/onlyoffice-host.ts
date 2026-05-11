/**
 * OnlyOffice viewer host manager (PoC 0.1.53+).
 *
 * Spawns the existing PoC serve.py in WSL on demand to host one xlsx file at a
 * time, and returns a URL the renderer can drop into a webview. The container
 * (OnlyOffice DS CE running in WSL Docker) fetches the file via
 * host.docker.internal:<port>, the renderer iframes the embed HTML at
 * http://<wsl-ip>:<port>/.
 *
 * Limitations (intentional, PoC scope):
 *  - Single xlsx at a time (serve.py is single-file). Switching sheets/files
 *    restarts the server (~1-2s).
 *  - WSL-only — assumes `wsl` CLI is available and OnlyOffice DS CE runs in WSL
 *    Docker. Production would need a different transport.
 *  - No JWT — relies on SSRF allowlist set on the OnlyOffice container.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { app } from 'electron';
import { getDesktopAppDir } from './paths';

// PoC 0.1.53+ 진단용 — Electron production stdout 가 Windows 에선 capture 안 되는 케이스
// (test:electron Playwright 의 app.process().stdout 가 빈 경우) 가 있어 파일로도 push.
// release 후엔 제거 또는 IPC.LOG_PUSH 로 통일 권장.
const DEBUG_LOG = pathJoin(tmpdir(), 'klaud-onlyoffice-debug.log');
function dlog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(DEBUG_LOG, line, 'utf8');
  } catch {
    /* ignore */
  }
  console.log(msg);
}

const FILE_PORT = 9000;
const PORT_WAIT_MS = 30_000;
const PORT_FREE_WAIT_MS = 5_000;
const WSL_IP_CACHE_MS = 60_000;

let serveProc: ChildProcess | null = null;
let cachedWslIp: { ip: string; ts: number } | null = null;

export interface PrepareViewerInput {
  sidecarBaseUrl: string;
  relPath: string;
  sheetName?: string;
  onlyOfficeUrl: string;
}

export interface PrepareViewerResult {
  ok: boolean;
  viewerUrl?: string;
  error?: string;
}

function windowsPathToWsl(p: string): string {
  if (!p) return p;
  if (p.startsWith('//') || p.startsWith('\\\\')) {
    // UNC \\wsl.localhost\<distro>\... → /...
    const tail = p.replace(/^[\\/]{2}wsl(\.localhost|\$)[\\/][^\\/]+[\\/]/i, '');
    if (tail !== p) return '/' + tail.replace(/\\/g, '/');
  }
  if (/^[a-z]:[\\/]/i.test(p)) {
    const drive = p[0].toLowerCase();
    const rest = p.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }
  return p.replace(/\\/g, '/');
}

function getWslIp(): string | null {
  const now = Date.now();
  if (cachedWslIp && now - cachedWslIp.ts < WSL_IP_CACHE_MS) return cachedWslIp.ip;
  const r = spawnSync('wsl', ['--', 'hostname', '-I'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return cachedWslIp?.ip ?? null;
  const ip = r.stdout.trim().split(/\s+/)[0];
  if (!ip) return cachedWslIp?.ip ?? null;
  cachedWslIp = { ip, ts: now };
  return ip;
}

// serve.py 위치는 Klaud 코드 (packages/desktop-app/) 의 sibling — repoRoot (사용자 데이터)
// 와 다른 개념이므로 분리. dev 모드: app.getAppPath() = packages/desktop-app → ../excel-viewer-poc/.
// production 패키지: process.resourcesPath 안에 extraResources 로 포함 필요 (TODO — 현재 PoC scope).
function getServePyWslPath(): string {
  const winFallback = 'E:\\repos\\proj-k\\packages\\excel-viewer-poc\\serve.py';
  const desktopAppDir = getDesktopAppDir();
  // dev: e:\repos\proj-k\packages\desktop-app -> e:\repos\proj-k\packages\excel-viewer-poc\serve.py
  const winPath = desktopAppDir
    ? pathResolve(desktopAppDir, '..', 'excel-viewer-poc', 'serve.py')
    : winFallback;
  return windowsPathToWsl(winPath);
}

async function fetchXlsxStat(
  sidecarBase: string,
  relPath: string,
): Promise<{ path: string } | null> {
  try {
    const res = await fetch(`${sidecarBase}/xlsx_stat?relPath=${encodeURIComponent(relPath)}`);
    if (!res.ok) return null;
    return (await res.json()) as { path: string };
  } catch {
    return null;
  }
}

function killServe(): void {
  if (serveProc && !serveProc.killed) {
    try {
      serveProc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  serveProc = null;
  // Belt-and-braces: WSL detached children may survive parent kill.
  try {
    spawnSync(
      'wsl',
      ['--', 'bash', '-c', "pgrep -f 'excel-viewer-poc/serve.py' | xargs -r kill -9 2>/dev/null"],
      { timeout: 5000 },
    );
  } catch {
    /* ignore */
  }
}

async function pollPort(port: number, want: 'busy' | 'free', timeoutMs: number): Promise<boolean> {
  const tStart = Date.now();
  while (Date.now() - tStart < timeoutMs) {
    const r = spawnSync(
      'wsl',
      ['--', 'bash', '-c', `ss -tln | grep -q ':${port} '`],
      { encoding: 'utf8', timeout: 3000 },
    );
    const isBusy = r.status === 0;
    if (want === 'busy' && isBusy) return true;
    if (want === 'free' && !isBusy) return true;
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

export async function prepareOnlyOfficeViewer(
  input: PrepareViewerInput,
): Promise<PrepareViewerResult> {
  const t0 = Date.now();
  const tag = `[onlyoffice-host] ${input.relPath}${input.sheetName ? ` "${input.sheetName}"` : ''}`;
  dlog(`${tag} prepare start`);

  if (!input.onlyOfficeUrl) {
    return { ok: false, error: 'onlyOfficeUrl 미설정 — Settings 에서 입력하세요' };
  }
  const wslIp = getWslIp();
  if (!wslIp) {
    return { ok: false, error: 'WSL IP 감지 실패 — wsl 미설치/미실행' };
  }
  const stat = await fetchXlsxStat(input.sidecarBaseUrl, input.relPath);
  if (!stat?.path) {
    return {
      ok: false,
      error: `sidecar /xlsx_stat 응답 없음 — relPath="${input.relPath}" (P4 워크스페이스 미동기화?)`,
    };
  }
  const wslXlsxPath = windowsPathToWsl(stat.path);
  dlog(`${tag} resolved win=${stat.path} wsl=${wslXlsxPath} wslIp=${wslIp}`);

  killServe();
  const free = await pollPort(FILE_PORT, 'free', PORT_FREE_WAIT_MS);
  if (!free) {
    return { ok: false, error: `포트 ${FILE_PORT} 가 다른 프로세스 점유 중 (${PORT_FREE_WAIT_MS}ms)` };
  }

  const servePy = getServePyWslPath();
  const args = [
    '--',
    'python3',
    servePy,
    wslXlsxPath,
    '--port',
    String(FILE_PORT),
    '--onlyoffice-url',
    input.onlyOfficeUrl,
    '--title',
    input.relPath,
  ];
  if (input.sheetName) args.push('--sheet', input.sheetName);
  dlog(`${tag} servePy=${servePy} spawn args=${JSON.stringify(args)}`);
  serveProc = spawn('wsl', args, { stdio: 'pipe', windowsHide: true });
  dlog(`${tag} spawn returned pid=${serveProc.pid ?? '(null)'}`);
  serveProc.stdout?.on('data', (d) => dlog(`[serve.py:out] ${String(d).replace(/\s+$/, '')}`));
  serveProc.stderr?.on('data', (d) => dlog(`[serve.py:err] ${String(d).replace(/\s+$/, '')}`));
  serveProc.on('error', (e) => dlog(`[onlyoffice-host] serve.py spawn ERROR: ${e.message}`));
  serveProc.on('exit', (code, signal) => {
    dlog(`[onlyoffice-host] serve.py exited code=${code} signal=${signal}`);
    serveProc = null;
  });

  const ready = await pollPort(FILE_PORT, 'busy', PORT_WAIT_MS);
  if (!ready) {
    killServe();
    return { ok: false, error: `serve.py 가 ${PORT_WAIT_MS}ms 안에 포트 ${FILE_PORT} 응답 안 함` };
  }

  const viewerUrl = `http://${wslIp}:${FILE_PORT}/`;
  console.log(`${tag} ready ${Date.now() - t0}ms url=${viewerUrl}`);
  return { ok: true, viewerUrl };
}

export function shutdownOnlyOfficeHost(): void {
  killServe();
}

app.on('before-quit', shutdownOnlyOfficeHost);
app.on('will-quit', shutdownOnlyOfficeHost);

// Test-only exports — never used by main code paths.
export const __test = { windowsPathToWsl, getServePyWslPath };
