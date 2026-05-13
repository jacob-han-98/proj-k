// 2026-05-13 릴리스-A2: renderer 측 통합 로그 캡처.
//
// renderer 의 console.* 와 unhandled error / rejection 을 main 으로 push.
// main 측 klaud-log-sink.ts 가 ring buffer + 파일 + (설정되면) backend POST 처리.
//
// 호출 정책:
// - App.tsx 부팅 시 한 번만 installKlaudLogCapture() 호출.
// - 이중 install 방어 (HMR / StrictMode 재실행).
// - window.projk 가 미준비 (preload 실패 등) 면 silent — 사용자 영향 0.

import type { KlaudLogEntry } from '../shared/types';

let installed = false;

// 마지막으로 본 활성 탭/모드 등 컨텍스트 — log push 시 extra 에 동봉.
// updateContext() 로 외부에서 갱신.
let currentContext: Record<string, unknown> = {};

export function updateLogContext(patch: Record<string, unknown>): void {
  currentContext = { ...currentContext, ...patch };
}

export function getLogContext(): Record<string, unknown> {
  return { ...currentContext };
}

function safePush(entry: Omit<KlaudLogEntry, 'ts' | 'source'>): void {
  if (typeof window === 'undefined') return;
  const projk = (window as unknown as { projk?: { klaudLog?: { push: (e: unknown) => Promise<unknown> } } }).projk;
  if (!projk?.klaudLog?.push) return;
  void projk.klaudLog.push({
    ts: Date.now(),
    source: 'renderer',
    level: entry.level,
    tag: entry.tag,
    message: entry.message,
    extra: { ...currentContext, ...(entry.extra ?? {}) },
  }).catch(() => {
    // IPC 실패 시 silent — 콘솔 자체는 살아있음.
  });
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

function tagOf(msg: string): { tag: string; message: string } {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(msg);
  return m ? { tag: m[1] ?? '', message: m[2] ?? '' } : { tag: '', message: msg };
}

export function installKlaudLogCapture(): void {
  if (installed) return;
  installed = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  (['log', 'info', 'warn', 'error'] as const).forEach((level) => {
    console[level] = (...args: unknown[]) => {
      orig[level](...args);
      try {
        const joined = args.map(fmtArg).join(' ');
        const { tag, message } = tagOf(joined);
        safePush({ level, tag, message });
      } catch {
        /* never let logging break the app */
      }
    };
  });

  // unhandled error — 스크립트 단계 syntax / DOM 이벤트 핸들러 throw 등.
  window.addEventListener('error', (e: ErrorEvent) => {
    try {
      const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
      const msg = `${e.message}${where}\n${e.error?.stack ?? ''}`;
      safePush({ level: 'error', tag: 'window.error', message: msg });
    } catch {
      /* ignore */
    }
  });

  // promise rejection — async 핸들러 catch 누락.
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    try {
      const reason = e.reason;
      const msg =
        reason instanceof Error
          ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
          : fmtArg(reason);
      safePush({ level: 'error', tag: 'unhandledRejection', message: msg });
    } catch {
      /* ignore */
    }
  });

  // 부팅 마커.
  safePush({ level: 'info', tag: 'klaud-log-capture', message: 'renderer install' });
}
