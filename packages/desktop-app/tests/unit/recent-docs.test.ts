import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentDocs,
  listRecentDocs,
  relativeVisitTime,
  removeRecentDoc,
  touchRecentDoc,
} from '../../src/renderer/recent-docs';

// vitest 가 node env 기본이라 localStorage 없음. 가벼운 in-memory shim 으로 충분.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
}

// CustomEvent 도 node 에 없음. window 도 없음. recent-docs 가 dispatchEvent 호출 시
// 그냥 noop 으로 가게 minimal stub.
class FakeWindow {
  dispatchEvent(_ev: unknown): boolean { return true; }
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  (globalThis as unknown as { window: FakeWindow }).window = new FakeWindow();
  // CustomEvent 는 instantiate 만 가능하면 됨 — 실제 dispatch 안 해도 throw 안 나야 함.
  if (typeof (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
    (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class CustomEvent {
      constructor(public type: string, public init?: unknown) {}
    };
  }
});

afterEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

describe('touchRecentDoc + listRecentDocs', () => {
  it('새 entry — push + lastVisitedAt/openCount 초기화', () => {
    touchRecentDoc({
      kind: 'excel',
      id: 'excel:7_System/PK_HUD/HUD_기본',
      title: 'HUD_기본',
      payload: { type: 'sheet' },
    });
    const list = listRecentDocs();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'excel',
      id: 'excel:7_System/PK_HUD/HUD_기본',
      title: 'HUD_기본',
      openCount: 1,
    });
    expect(typeof list[0]!.lastVisitedAt).toBe('number');
  });

  it('같은 id 다시 touch — openCount 증가 + lastVisitedAt 갱신', () => {
    touchRecentDoc({
      kind: 'excel', id: 'a', title: '시트 A', payload: {},
      lastVisitedAt: 1000,
    });
    touchRecentDoc({
      kind: 'excel', id: 'a', title: '시트 A', payload: {},
      lastVisitedAt: 2000,
    });
    const list = listRecentDocs();
    expect(list).toHaveLength(1);
    expect(list[0]!.openCount).toBe(2);
    expect(list[0]!.lastVisitedAt).toBe(2000);
  });

  it('여러 entry — lastVisitedAt desc 정렬', () => {
    touchRecentDoc({ kind: 'excel', id: 'a', title: 'A', payload: {}, lastVisitedAt: 100 });
    touchRecentDoc({ kind: 'confluence', id: 'b', title: 'B', payload: {}, lastVisitedAt: 300 });
    touchRecentDoc({ kind: 'qna-thread', id: 'c', title: 'C', payload: {}, lastVisitedAt: 200 });
    const list = listRecentDocs();
    expect(list.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('cap 50 — 가장 오래된 entry 부터 제거', () => {
    for (let i = 0; i < 60; i++) {
      touchRecentDoc({
        kind: 'excel', id: `id-${i}`, title: `t${i}`, payload: {},
        lastVisitedAt: i,
      });
    }
    const list = listRecentDocs();
    expect(list).toHaveLength(50);
    // 가장 최신 50: id-10 ~ id-59 (id-0..9 잘림)
    expect(list[0]!.id).toBe('id-59');
    expect(list[49]!.id).toBe('id-10');
  });

  it('removeRecentDoc — 한 entry 만 제거', () => {
    touchRecentDoc({ kind: 'excel', id: 'a', title: 'A', payload: {} });
    touchRecentDoc({ kind: 'excel', id: 'b', title: 'B', payload: {} });
    removeRecentDoc('a');
    const list = listRecentDocs();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('b');
  });

  it('clearRecentDocs — 전부 제거', () => {
    touchRecentDoc({ kind: 'excel', id: 'a', title: 'A', payload: {} });
    clearRecentDocs();
    expect(listRecentDocs()).toEqual([]);
  });

  it('localStorage 손상 — 빈 list 로 graceful', () => {
    localStorage.setItem('klaud.recents', '{not json');
    expect(listRecentDocs()).toEqual([]);
    // 다음 touch 는 정상 동작 (덮어씀)
    touchRecentDoc({ kind: 'excel', id: 'x', title: 'X', payload: {} });
    expect(listRecentDocs()).toHaveLength(1);
  });

  it('schemaVersion 불일치 — 초기화', () => {
    localStorage.setItem(
      'klaud.recents',
      JSON.stringify({ schemaVersion: 999, entries: [{ id: 'old', kind: 'excel', title: 'Old' }] }),
    );
    expect(listRecentDocs()).toEqual([]);
  });
});

describe('relativeVisitTime', () => {
  const NOW = 1_700_000_000_000;
  it('30초 미만 → 방금', () => {
    expect(relativeVisitTime(NOW - 5_000, NOW)).toBe('방금');
  });
  it('1시간 미만 → N분 전', () => {
    expect(relativeVisitTime(NOW - 12 * 60_000, NOW)).toBe('12분 전');
  });
  it('24시간 미만 → N시간 전', () => {
    expect(relativeVisitTime(NOW - 3 * 3600_000, NOW)).toBe('3시간 전');
  });
  it('1일 정확 → 어제', () => {
    expect(relativeVisitTime(NOW - 25 * 3600_000, NOW)).toBe('어제');
  });
  it('7일 미만 → N일 전', () => {
    expect(relativeVisitTime(NOW - 5 * 24 * 3600_000, NOW)).toBe('5일 전');
  });
  it('7일 이상 → 절대 날짜', () => {
    const t = NOW - 30 * 24 * 3600_000;
    const d = new Date(t);
    const expected = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    expect(relativeVisitTime(t, NOW)).toBe(expected);
  });
});
