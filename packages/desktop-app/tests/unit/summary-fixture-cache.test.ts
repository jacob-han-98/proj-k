import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashContent,
  invalidateSummaryFixture,
  loadSummaryFixture,
  saveSummaryFixture,
  summaryFixtureKey,
} from '../../src/renderer/panels/summary-fixture-cache';

// P1: review-fixture-cache 패턴을 따라가는 캐시 헬퍼. 핵심:
// - 다른 prefix (klaud:summary-fixture:) 라 review 결과와 충돌 X.
// - schemaVersion 안 맞으면 silent null (향후 schema 진화 시 자동 invalidate).
// - hashContent 는 review-fixture-cache 의 export 그대로 — 둘이 갈라지지 않게.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
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
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('summary-fixture-cache', () => {
  it('summaryFixtureKey 가 review key 와 다른 prefix — 충돌 안 함', () => {
    const key = summaryFixtureKey('page1', 'h1');
    expect(key).toBe('klaud:summary-fixture:page1:h1');
    expect(key.startsWith('klaud:review-fixture:')).toBe(false);
  });

  it('save → load 라운드트립', () => {
    saveSummaryFixture('page1', 'h1', '## 결론\n요약 내용', 'opus');
    const got = loadSummaryFixture('page1', 'h1');
    expect(got).not.toBeNull();
    expect(got!.summary).toBe('## 결론\n요약 내용');
    expect(got!.model).toBe('opus');
    expect(got!.schemaVersion).toBe(1);
    expect(typeof got!.savedAt).toBe('number');
  });

  it('미존재 fixture → null', () => {
    expect(loadSummaryFixture('page-x', 'h-x')).toBeNull();
  });

  it('schemaVersion 안 맞으면 null (자동 invalidate)', () => {
    storage.setItem(
      summaryFixtureKey('page1', 'h1'),
      JSON.stringify({ summary: 'old', savedAt: 0, schemaVersion: 999 }),
    );
    expect(loadSummaryFixture('page1', 'h1')).toBeNull();
  });

  it('summary 가 string 아니면 null (방어)', () => {
    storage.setItem(
      summaryFixtureKey('page1', 'h1'),
      JSON.stringify({ summary: 123, savedAt: 0, schemaVersion: 1 }),
    );
    expect(loadSummaryFixture('page1', 'h1')).toBeNull();
  });

  it('invalidate 후 load 는 null', () => {
    saveSummaryFixture('page1', 'h1', 'x', 'opus');
    expect(loadSummaryFixture('page1', 'h1')).not.toBeNull();
    invalidateSummaryFixture('page1', 'h1');
    expect(loadSummaryFixture('page1', 'h1')).toBeNull();
  });

  it('pageId 빈 문자열 → save/load no-op (Excel 시트 시나리오)', () => {
    saveSummaryFixture('', 'h1', 'should not save', 'opus');
    expect(loadSummaryFixture('', 'h1')).toBeNull();
  });

  it('hashContent 는 review-fixture-cache 와 같은 함수 (둘이 갈라지지 않게 재export)', () => {
    // 같은 본문 → 같은 hash. 결정성 보장.
    const a = hashContent('동일한 본문');
    const b = hashContent('동일한 본문');
    expect(a).toBe(b);
    // 다른 본문 → 다른 hash.
    const c = hashContent('다른 본문');
    expect(a).not.toBe(c);
  });
});
