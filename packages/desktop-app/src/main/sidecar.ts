import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { getSidecarDir, getDesktopAppDir } from './paths';
import { effectiveRetrieverUrl, effectiveAgentUrl, effectiveRepoRoot, effectiveP4WorkspaceRoot } from './settings';
import type { SidecarStatus } from '../shared/types';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 250;
const RESTART_BACKOFF_MS = [1000, 3000, 6000];

let proc: ChildProcess | null = null;
let port: number | null = null;
let status: SidecarStatus = { state: 'starting', port: null, pid: null };
let restartAttempts = 0;
const listeners: Array<(s: SidecarStatus) => void> = [];

function setStatus(next: SidecarStatus) {
  status = next;
  listeners.forEach((l) => l(next));
}

export function getSidecarStatus(): SidecarStatus {
  return status;
}

export function onSidecarStatus(fn: (s: SidecarStatus) => void): () => void {
  listeners.push(fn);
  fn(status);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForHealth(p: number): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return false;
}

// 시스템에서 동작 가능한 Python 인터프리터를 한 번 찾는다.
// Windows: python.exe → py -3 (python launcher)
// Unix:    python3 → python
function findSystemPython(): string | null {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        { cmd: 'python.exe', args: ['--version'] },
        { cmd: 'py', args: ['-3', '--version'] },
      ]
    : [
        { cmd: 'python3', args: ['--version'] },
        { cmd: 'python', args: ['--version'] },
      ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c.cmd, c.args, { stdio: 'pipe', windowsHide: true });
      if (r.status === 0) return c.cmd;
    } catch {
      // continue
    }
  }
  return null;
}

function venvDir(): string {
  return join(app.getPath('userData'), 'sidecar-venv');
}

function venvPython(): string {
  return process.platform === 'win32'
    ? join(venvDir(), 'Scripts', 'python.exe')
    : join(venvDir(), 'bin', 'python');
}

function spawnAsync(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    c.stderr?.on('data', (d) => (stderr += d.toString()));
    c.stdout?.on('data', (d) => console.log(`[sidecar:bootstrap] ${d.toString().trimEnd()}`));
    c.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
    c.on('error', (e) => resolve({ code: -1, stderr: e.message }));
  });
}

// 사용자 PC 의 venv 가 없으면 자동 생성하고 sidecar 의존성을 설치한다.
// 진행상황은 SidecarStatus.message 로 렌더러에 노출된다.
async function ensureSidecarPython(): Promise<string | null> {
  // 1) 명시 override
  if (process.env.PROJK_PYTHON) return process.env.PROJK_PYTHON;

  const isWin = process.platform === 'win32';

  // 2) dev: packages/desktop-app/.venv (npm run setup 이 만든 것)
  const devVenv = isWin
    ? join(getDesktopAppDir(), '.venv', 'Scripts', 'python.exe')
    : join(getDesktopAppDir(), '.venv', 'bin', 'python');
  if (existsSync(devVenv)) return devVenv;

  // 3) packaged: userData/sidecar-venv (자동 생성)
  if (existsSync(venvPython())) return venvPython();

  // venv 가 없으면 시스템 Python 으로 만든다.
  const sysPython = findSystemPython();
  if (!sysPython) {
    setStatus({
      state: 'error',
      port: null,
      pid: null,
      message: 'Python 이 발견되지 않습니다. python.org/downloads 에서 3.11+ 설치 후 PATH 에 추가하세요.',
    });
    return null;
  }

  setStatus({ state: 'starting', port: null, pid: null, message: 'sidecar venv 생성 중 (~30초)' });
  const r1 = await spawnAsync(sysPython, ['-m', 'venv', venvDir()]);
  if (r1.code !== 0) {
    setStatus({
      state: 'error',
      port: null,
      pid: null,
      message: `venv 생성 실패: ${r1.stderr.trim() || `code=${r1.code}`}`,
    });
    return null;
  }

  setStatus({ state: 'starting', port: null, pid: null, message: 'sidecar 의존성 설치 중 (~1분, 한 번만)' });
  const reqFile = join(getSidecarDir(), 'requirements.txt');
  const r2 = await spawnAsync(venvPython(), ['-m', 'pip', 'install', '--quiet', '-r', reqFile]);
  if (r2.code !== 0) {
    setStatus({
      state: 'error',
      port: null,
      pid: null,
      message: `pip install 실패: ${r2.stderr.split('\n').slice(-3).join(' ')}`,
    });
    return null;
  }

  setStatus({ state: 'starting', port: null, pid: null, message: 'sidecar 시작 중' });
  return venvPython();
}

export async function startSidecar(): Promise<void> {
  if (proc && !proc.killed) return;

  setStatus({ state: 'starting', port: null, pid: null, message: 'sidecar 부트스트래핑' });
  const python = await ensureSidecarPython();
  if (!python) return; // status 는 ensureSidecarPython 안에서 이미 error 로 세팅됨

  port = await pickFreePort();
  setStatus({ state: 'starting', port, pid: null, message: 'sidecar 시작 중' });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROJK_SIDECAR_PORT: String(port),
    PROJK_PROXY_URL: process.env.PROJK_PROXY_URL ?? '',
    // settings.json 에 저장된 백엔드 URL 을 sidecar 에 주입 →
    // sidecar/server.py 가 httpx 로 그쪽으로 HTTP/SSE proxy.
    PROJK_RETRIEVER_URL: effectiveRetrieverUrl() ?? '',
    PROJK_AGENT_URL: effectiveAgentUrl() ?? '',
    // settings 의 repoRoot(UNC 또는 native) 를 sidecar 에 전달 →
    // /tree/* 가 _normalize_repo_root() 로 native Linux 경로 변환 후 fs 접근.
    PROJK_REPO_ROOT: effectiveRepoRoot() ?? '',
    // 0.1.48 — P4 워크스페이스 root (.xlsx 원본 sync 된 path). /xlsx_raw 가 사용.
    PROJK_P4_ROOT: effectiveP4WorkspaceRoot() ?? '',
  };

  const sidecarDir = getSidecarDir();
  console.log(`[sidecar] launching ${python} from ${sidecarDir}`);
  const child = spawn(
    python,
    ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: sidecarDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  child.stdout?.on('data', (d) => console.log(`[sidecar] ${d.toString().trimEnd()}`));
  child.stderr?.on('data', (d) => console.warn(`[sidecar:err] ${d.toString().trimEnd()}`));

  child.on('error', (err) => {
    console.error('[sidecar] spawn error', err);
    setStatus({
      state: 'error',
      port,
      pid: null,
      message: `spawn 실패: ${err.message}. PROJK_PYTHON 으로 절대경로 지정 가능.`,
    });
  });

  child.on('exit', (code, signal) => {
    console.warn(`[sidecar] exited code=${code} signal=${signal}`);
    proc = null;
    if (status.state === 'stopped') return;
    setStatus({ state: 'error', port, pid: null, message: `exited code=${code}` });
    if (restartAttempts < RESTART_BACKOFF_MS.length) {
      const delay = RESTART_BACKOFF_MS[restartAttempts++];
      setTimeout(() => {
        if (status.state === 'stopped') return;
        startSidecar().catch((e) => console.error('[sidecar] restart failed', e));
      }, delay);
    }
  });

  proc = child;
  setStatus({ state: 'starting', port, pid: child.pid ?? null });

  const ok = await waitForHealth(port);
  if (!ok) {
    setStatus({ state: 'error', port, pid: child.pid ?? null, message: 'health check timeout' });
    return;
  }
  restartAttempts = 0;
  setStatus({ state: 'ready', port, pid: child.pid ?? null });
}

export function stopSidecar(): void {
  if (!proc) return;
  setStatus({ state: 'stopped', port, pid: null });
  try {
    proc.kill('SIGTERM');
  } catch (e) {
    console.error('[sidecar] kill failed', e);
  }
  proc = null;
}

app.on('before-quit', stopSidecar);
