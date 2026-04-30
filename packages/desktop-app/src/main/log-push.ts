// Klaud main process console → WSL log collector 일방향 push.
//
// console.log/warn/error 를 tap 해서 POST http://<collector>/log 로 fire-and-forget
// 전송. WSL 측 collector(8772) 가 file append + stdout 미러 → Claude (WSL) 가
// 즉시 봄. 사용자 PC ↔ WSL 디버그 단방향 채널.
//
// settings.logCollectorUrl 미설정 시 비활성. 로컬 ring buffer 는 mcp-bridge 가
// 별도로 유지 (klaud_get_logs 가 그쪽 사용).

import { getSettings } from './settings';

const QUEUE_LIMIT = 200;
let queue: Array<Record<string, unknown>> = [];
let flushTimer: NodeJS.Timeout | null = null;
let collectorUrl: string | null = null;
let appVersion: string | null = null;
let installed = false;

async function flushOnce() {
  if (!collectorUrl || queue.length === 0) return;
  const batch = queue;
  queue = [];
  // 각각 POST — 단순 우선. batching 은 추후. fire-and-forget.
  for (const entry of batch) {
    try {
      await fetch(`${collectorUrl}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch {
      // collector 다운 시 silent — 콘솔 자체는 살아있음.
    }
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushOnce().catch(() => {});
  }, 100);
}

function enqueue(level: 'log' | 'warn' | 'error', tag: string, msg: string) {
  if (!collectorUrl) return;
  if (queue.length >= QUEUE_LIMIT) queue.shift();
  queue.push({
    level,
    tag,
    message: msg,
    ts: Date.now(),
    pid: process.pid,
    app_version: appVersion ?? undefined,
  });
  scheduleFlush();
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function installLogPush(version: string): void {
  if (installed) return;
  installed = true;
  appVersion = version;

  const DEFAULT_LOG_COLLECTOR_URL = 'http://localhost:8772';
  const refreshUrl = () => {
    const s = getSettings();
    // mcpBridgeEnabled 가 켜진 dev 모드면 logCollectorUrl 미설정도 default 로 push.
    const dev = s.mcpBridgeEnabled !== false;
    const explicit = (s.logCollectorUrl ?? '').replace(/\/+$/, '');
    if (explicit) collectorUrl = explicit;
    else collectorUrl = dev ? DEFAULT_LOG_COLLECTOR_URL : null;
  };
  refreshUrl();
  // settings 변경 후에도 즉시 반영되도록 5초마다 재조회 (빈도 낮으면 충분).
  setInterval(refreshUrl, 5000).unref();

  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      orig[level](...args);
      const joined = args.map(fmtArg).join(' ');
      // tag 추정 — 메시지가 [foo] 로 시작하면 그걸 tag 로 분리.
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(joined);
      const tag = m ? m[1] : '';
      const message = m ? m[2] : joined;
      try {
        enqueue(level, tag, message);
      } catch {
        // ignore
      }
    };
  }

  // unhandled rejection 도 같이 흘러가게.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });
}
