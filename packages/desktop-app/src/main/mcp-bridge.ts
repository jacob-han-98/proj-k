// Klaud → MCP server 측 WebSocket bridge.
//
// settings.mcpBridgeEnabled 가 true 이고 mcpBridgeUrl 이 설정되어 있으면 부팅 시
// 그 URL 에 connect 하고, 끊어지면 backoff 으로 재연결한다. WSL 에서 도는
// klaud-mcp-server.mjs 가 Claude Code 의 stdio MCP 호출을 이리로 forward 하면,
// Klaud 가 받아서 동작 + 응답.
//
// RPC protocol (JSON over WS):
//   server → klaud:  { id: number, method: string, params: object }
//   klaud  → server: { id: number, result: any }  또는  { id, error: string }
//   서버가 method='ping' 으로 보내면 즉시 result={pong:true} 응답 (heartbeat).
//
// 진단 강화 (0.1.22):
//   - 모든 dispatch 시작/종료/에러를 console.log → log-push 통해 WSL 에 흐름.
//   - sock.send 실패도 catch + log.
//   - heartbeat: server 가 5초 간격 ping. 그 응답을 통해 stuck 감지.

import { BrowserWindow, ipcMain, app } from 'electron';
import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSettings } from './settings';
import { getSidecarStatus } from './sidecar';

const execFileAsync = promisify(execFile);

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STEP_TIMEOUT_MS = 15_000;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let manualStopped = false;

// 콘솔 로그 ring buffer — klaud_get_logs 가 반환.
// dev 진단 시 updater/ping 등 background spam 으로 사용자 click 흔적 overflow 되어 4000 으로
// 늘림. release 빌드도 실용적 (메모리 ~수백KB 수준).
const LOG_BUFFER_LIMIT = 4000;
const logBuffer: string[] = [];

function pushLog(line: string) {
  logBuffer.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer.shift();
}

// console 의 ring buffer 캡처. log-push.ts 의 console tap 과 별도이지만
// 두 tap 모두 정상 작동 (각자 orig 호출).
function tapConsole() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      orig[level](...args);
      try {
        pushLog(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
      } catch { /* ignore */ }
    };
  }
}

function rendererCommand(win: BrowserWindow, cmd: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = `mcp:result:${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const handler = (_e: Electron.IpcMainEvent, payload: unknown) => {
      clearTimeout(timer);
      ipcMain.removeListener(channel, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      reject(new Error('renderer timeout'));
    }, STEP_TIMEOUT_MS);
    ipcMain.on(channel, handler);
    win.webContents.send('mcp:cmd', { cmd, replyChannel: channel });
  });
}

async function captureScreenshotBase64(win: BrowserWindow): Promise<string> {
  // 1차: Electron capturePage. background spawn 한 Klaud 의 OS-level DWM occlusion 으로
  // 빈 frame 만 받는 케이스가 흔해 — Win32 PrintWindow fallback 으로 대체.
  // Windows 환경에선 곧바로 PrintWindow 로 가서 진짜 frame 받음.
  if (process.platform === 'win32') {
    try {
      return await captureViaPrintWindow(win);
    } catch (e) {
      console.warn(`[screenshot] PrintWindow fallback 실패: ${(e as Error).message} — capturePage 로 대체`);
    }
  }
  const img = await win.webContents.capturePage(undefined, { stayHidden: true });
  return img.toPNG().toString('base64');
}

// Win32 PrintWindow(PW_RENDERFULLCONTENT) 통해 hidden/occluded BrowserWindow 도 진짜 frame
// 캡처. PowerShell helper (`scripts/capture-window.ps1`) 를 spawn 해서 PNG 파일에 저장 후
// base64 로 읽어 반환. 일부 Windows 환경/콘솔 인코딩 한계로 inline -Command 보다 -File 안전.
async function captureViaPrintWindow(win: BrowserWindow): Promise<string> {
  const hwndBuf = win.getNativeWindowHandle();
  // x64 build 면 8 byte HWND, x86 면 4. Klaud 는 x64.
  const hwnd = hwndBuf.length === 8
    ? Number(hwndBuf.readBigUInt64LE())
    : hwndBuf.readUInt32LE();

  // helper script 위치 — dev 모드는 src 의 형제 scripts/, packaged 는 process.resourcesPath/scripts/.
  const scriptPath = app.isPackaged
    ? join(process.resourcesPath, 'scripts', 'capture-window.ps1')
    : join(__dirname, '..', '..', 'scripts', 'capture-window.ps1');

  const tmpPng = join(tmpdir(), `klaud-cap-${Date.now()}-${process.pid}.png`);

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Hwnd', String(hwnd),
        '-Out', tmpPng,
      ],
      { timeout: 10_000, windowsHide: true },
    );
    console.log(`[screenshot] PrintWindow ok hwnd=${hwnd} ${stdout.trim()}`);
    const buf = await fsp.readFile(tmpPng);
    return buf.toString('base64');
  } finally {
    await fsp.unlink(tmpPng).catch(() => {});
  }
}

async function dispatch(method: string, params: unknown, getWindow: () => BrowserWindow | null): Promise<unknown> {
  if (method === 'ping') return { pong: true, ts: Date.now() };

  const win = getWindow();
  if (!win || win.isDestroyed()) throw new Error('no main window');

  switch (method) {
    case 'health': {
      const sc = getSidecarStatus();
      return {
        connected: true,
        sidecar: sc,
        ts: Date.now(),
      };
    }
    case 'screenshot': {
      // captureScreenshotBase64 가 Win32 PrintWindow helper 통해 진짜 frame 캡처.
      // background spawn / OS occluded window 에서도 동작. 사용자 화면을 forefront 로
      // 튀어 올리는 부수효과 없음 (PrintWindow 가 in-place capture).
      const t0 = Date.now();
      const png_base64 = await captureScreenshotBase64(win);
      const pngBytes = Buffer.byteLength(png_base64, 'base64');
      console.log(`[screenshot] captured ${pngBytes}B in ${Date.now() - t0}ms`);
      return { png_base64, pngBytes };
    }
    case 'show': {
      try { if (!win.isVisible()) win.show(); } catch { /* ignore */ }
      try { if (win.isMinimized()) win.restore(); } catch { /* ignore */ }
      try { win.focus(); } catch { /* ignore */ }
      return { ok: true, visible: win.isVisible(), focused: win.isFocused() };
    }
    case 'state': {
      // renderer 가 자기 DOM 상태를 종합해서 응답.
      return await rendererCommand(win, { kind: 'mcp-state' });
    }
    case 'send_cmd': {
      // mcp-cmd 채널 — renderer 가 받아 동작.
      return await rendererCommand(win, params);
    }
    case 'get_logs': {
      const lines = (params as { lines?: number } | undefined)?.lines ?? 50;
      const recent = logBuffer.slice(-Math.max(1, Math.min(LOG_BUFFER_LIMIT, lines)));
      return { logs: recent.join('\n') };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

function safeSend(sock: WebSocket, payload: unknown): boolean {
  try {
    if (sock.readyState !== WebSocket.OPEN) {
      console.warn(`[mcp-bridge] sock.send skipped — readyState=${sock.readyState}`);
      return false;
    }
    sock.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn(`[mcp-bridge] sock.send 실패: ${(e as Error).message}`);
    return false;
  }
}

function tryConnect(url: string, getWindow: () => BrowserWindow | null): void {
  if (manualStopped) return;
  console.log(`[mcp-bridge] connecting ${url}`);

  const sock = new WebSocket(url);
  ws = sock;
  let heartbeat: NodeJS.Timeout | null = null;
  let lastActivity = Date.now();

  sock.on('open', () => {
    reconnectAttempts = 0;
    lastActivity = Date.now();
    console.log('[mcp-bridge] connected');
    // 서버 측이 ping 을 보내지만, 우리도 보내면서 양방향 살아있는지 검증.
    heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastActivity;
      if (idleMs > 30_000) {
        console.warn(`[mcp-bridge] idle ${idleMs}ms — force reconnect`);
        try { sock.close(); } catch { /* ignore */ }
      }
    }, 5_000);
  });

  sock.on('message', async (raw) => {
    lastActivity = Date.now();
    let msg: { id?: number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw.toString('utf-8'));
    } catch (e) {
      console.warn(`[mcp-bridge] 메시지 파싱 실패: ${(e as Error).message}`);
      return;
    }
    const { id, method = '<missing>', params } = msg;
    console.log(`[mcp-bridge] ← rpc id=${id} method=${method}`);
    try {
      const result = await dispatch(method, params, getWindow);
      const ok = safeSend(sock, { id, result });
      console.log(`[mcp-bridge] → response id=${id} sent=${ok}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[mcp-bridge] dispatch 실패 id=${id} method=${method}: ${errMsg}`);
      safeSend(sock, { id, error: errMsg });
    }
  });

  sock.on('close', (code, reason) => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    console.log(`[mcp-bridge] disconnected code=${code} reason=${reason?.toString() || ''}`);
    ws = null;
    if (manualStopped) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempts++;
    setTimeout(() => tryConnect(url, getWindow), delay);
  });

  sock.on('error', (e) => {
    console.warn(`[mcp-bridge] error: ${e.message}`);
  });
}

const DEFAULT_MCP_BRIDGE_URL = 'ws://localhost:8769';

export function startMcpBridgeIfEnabled(getWindow: () => BrowserWindow | null): void {
  tapConsole();
  const s = getSettings();
  // 0.1.22 부터: mcpBridgeEnabled 단독 (selfTestEnabled 와 분리). default true.
  const enabled = s.mcpBridgeEnabled !== false;
  if (!enabled) {
    console.log('[mcp-bridge] mcpBridgeEnabled OFF — bridge 비활성');
    return;
  }
  const url = (s.mcpBridgeUrl ?? '').trim() || DEFAULT_MCP_BRIDGE_URL;
  tryConnect(url, getWindow);
}

export function stopMcpBridge(): void {
  manualStopped = true;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}
