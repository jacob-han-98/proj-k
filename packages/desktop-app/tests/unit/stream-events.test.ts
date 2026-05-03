import { describe, expect, it } from 'vitest';
import { readErrorMessage, readResultData, readToken } from '../../src/renderer/stream-events';

// agent-sdk-poc 의 NDJSON 이벤트 schema 가 변하더라도 (token: text → payload → token → delta)
// 핸들러가 깨지지 않도록 defensive read. 신규 backend 도, 옛 mock 도, 변형도 모두 통과.

describe('readToken', () => {
  it('신규 agent schema — text 필드', () => {
    expect(readToken({ type: 'token', text: 'HUD' })).toBe('HUD');
  });

  it('옛 mock schema — payload 필드 (backwards-compat)', () => {
    expect(readToken({ type: 'token', payload: 'foo' })).toBe('foo');
  });

  it('변형 — token 필드', () => {
    expect(readToken({ type: 'token', token: 'bar' })).toBe('bar');
  });

  it('변형 — delta 필드', () => {
    expect(readToken({ type: 'token', delta: 'baz' })).toBe('baz');
  });

  it('우선순위: text > payload > token > delta', () => {
    expect(readToken({ type: 'token', text: 'A', payload: 'B', token: 'C', delta: 'D' })).toBe('A');
    expect(readToken({ type: 'token', payload: 'B', token: 'C', delta: 'D' })).toBe('B');
    expect(readToken({ type: 'token', token: 'C', delta: 'D' })).toBe('C');
  });

  it('필드 모두 없으면 null', () => {
    expect(readToken({ type: 'token' })).toBeNull();
  });

  it('non-string 값은 null', () => {
    expect(readToken({ type: 'token', text: 123 })).toBeNull();
    expect(readToken({ type: 'token', payload: { nested: 'x' } })).toBeNull();
  });
});

describe('readResultData', () => {
  it('신규 agent schema — data 필드', () => {
    const data = { answer: 'HUD 답변', sources: [] };
    expect(readResultData({ type: 'result', data })).toEqual(data);
  });

  it('옛 mock schema — payload 필드 (backwards-compat)', () => {
    const payload = { answer: 'old style' };
    expect(readResultData({ type: 'result', payload })).toEqual(payload);
  });

  it('우선순위: data > payload', () => {
    const fresh = { answer: 'new' };
    const old = { answer: 'old' };
    expect(readResultData({ type: 'result', data: fresh, payload: old })).toEqual(fresh);
  });

  it('필드 없으면 null', () => {
    expect(readResultData({ type: 'result' })).toBeNull();
  });

  it('non-object 값은 null', () => {
    expect(readResultData({ type: 'result', data: 'string' })).toBeNull();
    expect(readResultData({ type: 'result', payload: 42 })).toBeNull();
  });
});

describe('readErrorMessage', () => {
  it('error 필드 우선', () => {
    expect(readErrorMessage({ type: 'error', error: 'fail' })).toBe('fail');
  });

  it('message fallback', () => {
    expect(readErrorMessage({ type: 'error', message: 'oops' })).toBe('oops');
  });

  it('payload fallback (옛 schema)', () => {
    expect(readErrorMessage({ type: 'error', payload: 'old style err' })).toBe('old style err');
  });

  it('우선순위: error > message > payload', () => {
    expect(readErrorMessage({ type: 'error', error: 'A', message: 'B', payload: 'C' })).toBe('A');
    expect(readErrorMessage({ type: 'error', message: 'B', payload: 'C' })).toBe('B');
  });
});
