// 2026-05-13 릴리스-A2: renderer log-capture 의 tag 추출 + context 머지 분기 검증.
//
// vitest env 는 node. window 는 minimal mock. console 은 한 번만 wrap (모듈 install
// 가드) — 테스트마다 reset 하면 wrap 체인이 누적돼 first-match 가 오래된 모듈을 가리킴.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushSpy = vi.fn();
let updateLogContext!: (patch: Record<string, unknown>) => void;

beforeAll(async () => {
  pushSpy.mockResolvedValue({ ok: true });
  (globalThis as unknown as { window: unknown }).window = {
    projk: { klaudLog: { push: pushSpy } },
    addEventListener: () => undefined,
    location: { href: 'http://test' },
  };
  const mod = await import('../../src/renderer/klaud-log-capture');
  mod.installKlaudLogCapture();
  updateLogContext = mod.updateLogContext;
});

beforeEach(() => {
  pushSpy.mockClear();
  // context reset — 각 테스트가 독립적으로 검사.
  updateLogContext({ active_tab: undefined });
});

describe('klaud-log-capture', () => {
  it('console.log 호출 → main 으로 push, [tag] 분리', () => {
    console.log('[review] start streaming');
    expect(pushSpy).toHaveBeenCalled();
    const entry = pushSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.source).toBe('renderer');
    expect(entry.level).toBe('log');
    expect(entry.tag).toBe('review');
    expect(entry.message).toBe('start streaming');
  });

  it('tag 없는 메시지 — tag 는 빈 문자열, message 전체', () => {
    console.warn('plain warning');
    const entry = pushSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.tag).toBe('');
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('plain warning');
  });

  it('updateLogContext 가 push 의 extra 에 머지됨', () => {
    updateLogContext({ active_tab: 'confluence:3' });
    console.log('[ctx] hello');
    const entry = pushSpy.mock.calls[0]![0] as { extra: Record<string, unknown> };
    expect(entry.extra).toMatchObject({ active_tab: 'confluence:3' });
  });

  it('Error 객체는 직렬화 (message 포함) + level=error', () => {
    const err = new Error('boom');
    console.error('[crash]', err);
    const entry = pushSpy.mock.calls[0]![0] as { message: string; level: string };
    expect(entry.level).toBe('error');
    // 다중 라인이라 tag 추출은 안 되지만 message 에 'Error: boom' 은 포함.
    expect(entry.message).toContain('Error: boom');
  });

  it('이중 install 가드 — 두 번째 호출은 no-op', async () => {
    const mod = await import('../../src/renderer/klaud-log-capture');
    // 이미 installed=true 라 추가 wrap 안 함.
    mod.installKlaudLogCapture();
    console.log('single');
    const calls = pushSpy.mock.calls.filter(
      (c) => (c[0] as { message?: string }).message === 'single',
    );
    expect(calls.length).toBe(1);
  });
});
