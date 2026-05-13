// 2026-05-13 릴리스-A2: Klaud 통합 로그 sink (운영 모니터링 + 제보).
//
// 사용자 결정 (2026-05-13): 크래시 자동 보고는 후순위 (지금까지 0건). 핵심은 *오동작
// 운영 모니터링*. frontend(renderer + main) + backend(sidecar + WSL agent) 의 로그가
// 한 store 에 적재되어 관리자가 사용자별 / 시점별 조회 가능 + 사용자가 제보 버튼 누르면
// 그 시점 이전 로그가 묶음으로 보임.
//
// 이 파일은 main 측 sink — renderer 가 IPC 로 push 한 로그 + main 자체 console + sidecar
// stdout 을 같이 받음. 처리:
//   1. 항상 in-memory ring buffer (max 5000) 에 저장. 마지막 N분 빠른 lookup 용.
//   2. 항상 userData/klaud-logs.jsonl 에 append. 세션 영속 + 한 줄 = 한 entry.
//   3. settings.klaudLogSinkUrl 가 채워져 있고 reportingEnabled !== false 면 batch POST
//      (5s 또는 100개 — 둘 중 먼저). fire-and-forget — 실패 silent drop.
//
// 기존 src/main/log-push.ts 와 공존. log-push 는 WSL 8772 collector (dev 전용) 로
// console 만 보내고, 이 파일은 production 사내 backend 로 통합 로그 보냄. 둘 다 console
// 을 같이 tap 하지 않게 — log-push 는 main 의 console 만, 이 파일은 main 의 console 도
// 동일 entry 로 ring buffer + sink 에 넣음. dual-send 단 (file/ring/sink) vs (collector).

import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSettings, setSettings } from './settings';
import type { KlaudLogEntry, KlaudReportPayload } from '../shared/types';

const RING_MAX = 5000;
const FILE_ROTATE_BYTES = 5 * 1024 * 1024; // 5MB per file
const FILE_KEEP = 3; // 최근 3개 파일만
const BATCH_MAX = 100;
const BATCH_INTERVAL_MS = 5000;

let ring: KlaudLogEntry[] = [];
let queueForSink: KlaudLogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let sessionId: string | null = null;
let appVersion: string | null = null;
let installed = false;

function ensureSessionId(): string {
  if (!sessionId) sessionId = randomUUID();
  return sessionId;
}

// 첫 부팅 시 자동 발급. 사용자 변경 불가 (UI 미노출).
function ensureMachineId(): string {
  const s = getSettings();
  if (s.klaudMachineId) return s.klaudMachineId;
  const id = randomUUID();
  try {
    setSettings({ klaudMachineId: id });
  } catch {
    /* 디스크 못 쓰면 in-memory 사용 — 다음 부팅 때 다시 발급 */
  }
  return id;
}

function logsDir(): string {
  const dir = join(app.getPath('userData'), 'klaud-logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function currentLogFile(): string {
  return join(logsDir(), 'current.jsonl');
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return;
    const st = statSync(file);
    if (st.size < FILE_ROTATE_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(file, join(logsDir(), `klaud-${stamp}.jsonl`));
    // 옛 파일 정리.
    const entries = readdirSync(logsDir())
      .filter((n) => n.startsWith('klaud-') && n.endsWith('.jsonl'))
      .map((n) => ({ n, t: statSync(join(logsDir(), n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const e of entries.slice(FILE_KEEP)) {
      try {
        unlinkSync(join(logsDir(), e.n));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 회전 실패 — sink 자체에 영향 X */
  }
}

function appendToFile(entry: KlaudLogEntry): void {
  const file = currentLogFile();
  try {
    rotateIfNeeded(file);
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* 디스크 가득 등 — silent */
  }
}

// settings 가 OK 면 batch POST. 미설정 시 큐만 차오르고 drain X (메모리 cap = RING_MAX).
async function flushQueue(): Promise<void> {
  flushTimer = null;
  if (queueForSink.length === 0) return;
  const s = getSettings();
  if (s.reportingEnabled === false) {
    // opt-out: 큐 자체를 drop. 메모리 유지 안 함.
    queueForSink = [];
    return;
  }
  const url = (s.klaudLogSinkUrl ?? '').replace(/\/+$/, '');
  if (!url) return; // endpoint 없으면 queue 에 쌓아둠 — 나중에 url 설정되면 flush.
  const batch = queueForSink.slice(0, BATCH_MAX);
  const body = {
    machine_id: ensureMachineId(),
    session_id: ensureSessionId(),
    klaud_version: appVersion ?? 'unknown',
    entries: batch,
  };
  try {
    const res = await fetch(`${url}/klaud/log/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      queueForSink = queueForSink.slice(batch.length);
    } else {
      // 4xx/5xx — 큐에서 빼고 drop. 무한 재시도 방지.
      queueForSink = queueForSink.slice(batch.length);
    }
  } catch {
    // 네트워크 실패 — 큐에서 빼고 drop. 사용자 영향 0.
    queueForSink = queueForSink.slice(batch.length);
  }
  if (queueForSink.length > 0) scheduleFlush();
}

function scheduleFlush(immediate = false): void {
  if (flushTimer) return;
  flushTimer = setTimeout(
    () => {
      void flushQueue();
    },
    immediate ? 0 : BATCH_INTERVAL_MS,
  );
}

// 단일 진입점 — renderer 의 IPC 또는 main 의 console 가 호출.
export function recordLog(entry: KlaudLogEntry): void {
  if (!installed) return;
  // ring buffer 갱신.
  if (ring.length >= RING_MAX) ring.shift();
  ring.push(entry);
  // 파일 append (best-effort).
  appendToFile(entry);
  // sink 큐.
  if (queueForSink.length >= RING_MAX) queueForSink.shift();
  queueForSink.push(entry);
  if (queueForSink.length >= BATCH_MAX) scheduleFlush(true);
  else scheduleFlush();
}

export function getRingSnapshot(): KlaudLogEntry[] {
  return [...ring];
}

export function clearRing(): void {
  ring = [];
}

// main 의 console.* 도 자동 tap. log-push.ts 가 이미 console 을 한 번 덮어쓴 상태라
// 여기서는 다시 덮어쓰지 않고 process 의 stdout/stderr write 도 안 건드림 — log-push 의 hook
// 이 enqueue 호출하기 전에 recordLog 도 같이 부르도록 별도 helper 를 노출 (installLogPush 가 호출).
// 가장 단순한 방법: log-push 의 enqueue 가 recordLog 도 호출. 그게 어렵다면 우리도 console 을
// 한 번 더 wrap.
//
// 결정: log-push.ts 를 살짝 수정해 enqueue 시점에 mirrorToSink(level, tag, message) 도 호출.
export function mirrorToSink(level: KlaudLogEntry['level'], tag: string, message: string): void {
  recordLog({
    ts: Date.now(),
    source: 'main',
    level,
    tag,
    message,
  });
}

export interface InstallOptions {
  version: string;
}

export function installKlaudLogSink(opts: InstallOptions): void {
  if (installed) return;
  installed = true;
  appVersion = opts.version;
  ensureSessionId();
  ensureMachineId();
  // 부팅 마커.
  recordLog({
    ts: Date.now(),
    source: 'main',
    level: 'info',
    tag: 'klaud-log-sink',
    message: `boot session=${sessionId} version=${appVersion}`,
  });
  // 5초 단위 flush 가 idle 일 때도 큐를 비울 수 있게 보조 timer. unref 로 종료 차단 X.
  setInterval(() => {
    if (queueForSink.length > 0) scheduleFlush();
  }, BATCH_INTERVAL_MS).unref();
}

// 제보. backend 의 /klaud/report 로 POST. ring snapshot 도 같이 보냄 — backend 가 자체
// store 와 cross-reference 가능. opt-out 켜져 있으면 송신 자체 안 함 (사용자 의도 존중).
export async function submitReport(payload: KlaudReportPayload): Promise<{ ok: boolean; reason?: string }> {
  const s = getSettings();
  if (s.reportingEnabled === false) return { ok: false, reason: 'reporting disabled' };
  const url = (s.klaudLogSinkUrl ?? '').replace(/\/+$/, '');
  // url 미설정도 정상 — 큐가 비어있게만. 다만 제보는 url 없으면 의미가 없으므로 false 리턴.
  if (!url) return { ok: false, reason: 'klaudLogSinkUrl unset' };
  const body = {
    machine_id: ensureMachineId(),
    session_id: ensureSessionId(),
    klaud_version: appVersion ?? 'unknown',
    ts: Date.now(),
    note: payload.note,
    context: payload.context,
    screenshot_b64: payload.screenshotB64 ?? null,
    recent_logs: getRingSnapshot().slice(-500),
  };
  try {
    const res = await fetch(`${url}/klaud/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
