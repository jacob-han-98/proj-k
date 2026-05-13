// 2026-05-13 릴리스-A2: klaud-log-sink 의 sanitize / shape 가드 단위 테스트.
//
// 실제 sink 는 electron app.getPath 를 import 하므로 main 환경 종속이라 vitest 에서 직접
// import 가 무거움. 대신 IPC handler 가 받는 raw payload → safe entry 변환 로직을 그대로
// 재현해 분기 검증. 회귀 방지: 신뢰 boundary 인 renderer 에서 임의 shape 가 와도 main 의
// ring buffer / 파일 / backend POST 에는 항상 정상 entry 만 들어가야.

import { describe, expect, it } from 'vitest';
import type { KlaudLogEntry } from '../../src/shared/types';

// ipc.ts 의 KLAUD_LOG_PUSH 핸들러 sanitize 로직과 동일. 변경 시 ipc.ts 도 같이.
function sanitize(entry: unknown): KlaudLogEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.message !== 'string') return null;
  return {
    ts: typeof e.ts === 'number' ? e.ts : Date.now(),
    source: e.source === 'sidecar' ? 'sidecar' : e.source === 'main' ? 'main' : 'renderer',
    level: ['log', 'info', 'warn', 'error'].includes(e.level as string)
      ? (e.level as KlaudLogEntry['level'])
      : 'log',
    tag: typeof e.tag === 'string' ? e.tag : '',
    message: (e.message as string).slice(0, 8192),
    extra: e.extra && typeof e.extra === 'object' ? (e.extra as Record<string, unknown>) : undefined,
  };
}

describe('klaud-log-sink IPC sanitize', () => {
  it('정상 entry — 그대로 통과', () => {
    const out = sanitize({
      ts: 123,
      source: 'renderer',
      level: 'warn',
      tag: 'foo',
      message: 'hello',
      extra: { tabId: 'x' },
    });
    expect(out).toEqual({
      ts: 123,
      source: 'renderer',
      level: 'warn',
      tag: 'foo',
      message: 'hello',
      extra: { tabId: 'x' },
    });
  });

  it('message 누락 → null', () => {
    expect(sanitize({ level: 'log' })).toBeNull();
  });

  it('non-object → null', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeNull();
    expect(sanitize('foo')).toBeNull();
    expect(sanitize(42)).toBeNull();
  });

  it('source 미지정/이상 → renderer 로 기본화', () => {
    expect(sanitize({ message: 'm' })?.source).toBe('renderer');
    expect(sanitize({ message: 'm', source: 'bogus' })?.source).toBe('renderer');
    expect(sanitize({ message: 'm', source: 'main' })?.source).toBe('main');
    expect(sanitize({ message: 'm', source: 'sidecar' })?.source).toBe('sidecar');
  });

  it('level 이상값 → log 로 기본화', () => {
    expect(sanitize({ message: 'm', level: 'critical' })?.level).toBe('log');
    expect(sanitize({ message: 'm', level: 'error' })?.level).toBe('error');
    expect(sanitize({ message: 'm', level: 'info' })?.level).toBe('info');
  });

  it('message 8KB 이상 → 자름 (메모리 폭주 방지)', () => {
    const big = 'a'.repeat(20_000);
    const out = sanitize({ message: big });
    expect(out?.message.length).toBe(8192);
  });

  it('tag 누락/이상 → 빈 문자열', () => {
    expect(sanitize({ message: 'm' })?.tag).toBe('');
    expect(sanitize({ message: 'm', tag: 42 })?.tag).toBe('');
    expect(sanitize({ message: 'm', tag: 'x' })?.tag).toBe('x');
  });

  it('extra 가 object 아니면 undefined', () => {
    expect(sanitize({ message: 'm', extra: 'string' })?.extra).toBeUndefined();
    expect(sanitize({ message: 'm', extra: { a: 1 } })?.extra).toEqual({ a: 1 });
  });
});
