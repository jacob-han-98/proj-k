// B2-2: review fixture 캐시 (localStorage 기반) 단위 테스트.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureKey,
  hashContent,
  hashReviewOptions,
  invalidateFixture,
  listAllFixtures,
  loadFixture,
  relativeTime,
  saveFixture,
} from '../../src/renderer/panels/review-fixture-cache';

// jsdom default 에 localStorage 가 있지만 vitest 의 happy-dom / node 환경에서는 없을 수 있어
// in-memory shim 으로 강제. 모든 테스트가 같은 store 공유.
class MemoryStorage {
  store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
  getItem(k: string) { return this.store.has(k) ? (this.store.get(k) ?? null) : null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
const mem = new MemoryStorage();
vi.stubGlobal('localStorage', mem as unknown as Storage);

beforeEach(() => {
  mem.clear();
});

afterEach(() => {
  // safety
  mem.clear();
});

describe('hashContent + fixtureKey', () => {
  it('같은 텍스트 → 같은 hash', () => {
    expect(hashContent('hello world')).toBe(hashContent('hello world'));
  });
  it('다른 텍스트 → 다른 hash', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
  it('빈 텍스트도 안전', () => {
    expect(typeof hashContent('')).toBe('string');
  });
  it('한글 텍스트 hash 안정', () => {
    expect(hashContent('안녕하세요 한글입니다')).toBe(hashContent('안녕하세요 한글입니다'));
    expect(hashContent('가')).not.toBe(hashContent('나'));
  });
  it('fixtureKey prefix 와 구조', () => {
    expect(fixtureKey('p123', 'abc')).toBe('klaud:review-fixture:p123:abc');
  });
});

// P2 보강: 옵션 변경 시 cache miss 보장. ReviewSplitPane 의 contentHash 가
// `${hashContent(text)}-${hashReviewOptions(opts)}` 라 옵션 토글마다 새 키.
describe('hashReviewOptions', () => {
  const baseOpts = {
    issueCap: 5 as number | string,
    verificationCap: 5 as number | string,
    suggestionCap: 5 as number | string,
    categories: ['logic-flow', 'qa-checklist', 'readability'],
    reviewerPersonas: ['planner-lead'],
  };

  it('같은 옵션 → 같은 hash', () => {
    expect(hashReviewOptions(baseOpts)).toBe(hashReviewOptions({ ...baseOpts }));
  });

  it('cap 다르면 다른 hash', () => {
    const a = hashReviewOptions(baseOpts);
    const b = hashReviewOptions({ ...baseOpts, issueCap: 10 });
    expect(a).not.toBe(b);
  });

  it('카테고리 추가/제거 시 다른 hash', () => {
    const a = hashReviewOptions(baseOpts);
    const b = hashReviewOptions({ ...baseOpts, categories: ['logic-flow'] });
    expect(a).not.toBe(b);
  });

  it('카테고리 순서 무관 (정렬 후 hash) — 사용자 토글 순서 다른 case 도 같은 결과 인정', () => {
    const a = hashReviewOptions({ ...baseOpts, categories: ['logic-flow', 'qa-checklist'] });
    const b = hashReviewOptions({ ...baseOpts, categories: ['qa-checklist', 'logic-flow'] });
    expect(a).toBe(b);
  });

  it('persona 다중 추가 시 다른 hash — 새 stream 발동 신호', () => {
    const a = hashReviewOptions(baseOpts);
    const b = hashReviewOptions({ ...baseOpts, reviewerPersonas: ['planner-lead', 'programmer'] });
    expect(a).not.toBe(b);
  });

  it("'all' literal cap 도 stable (string vs number 차이 반영)", () => {
    const a = hashReviewOptions({ ...baseOpts, issueCap: 'all' });
    const b = hashReviewOptions({ ...baseOpts, issueCap: 0 });
    expect(a).not.toBe(b);
  });
});

describe('save / load round-trip', () => {
  it('save 후 load → 같은 data + savedAt 근접', () => {
    const data = { score: 80, issues: [{ text: '예시' }] };
    const beforeMs = Date.now();
    saveFixture('page-1', 'h1', data, 'sonnet');
    const got = loadFixture('page-1', 'h1');
    expect(got).not.toBeNull();
    expect(got!.data).toEqual(data);
    expect(got!.model).toBe('sonnet');
    expect(got!.savedAt).toBeGreaterThanOrEqual(beforeMs);
    expect(got!.schemaVersion).toBe(1);
  });

  it('다른 hash → 별도 저장', () => {
    saveFixture('page-1', 'h1', { score: 50 }, 'haiku');
    saveFixture('page-1', 'h2', { score: 90 }, 'sonnet');
    expect(loadFixture('page-1', 'h1')!.data.score).toBe(50);
    expect(loadFixture('page-1', 'h2')!.data.score).toBe(90);
  });

  it('없는 key load → null', () => {
    expect(loadFixture('page-1', 'h1')).toBeNull();
  });

  it('손상된 JSON load → null', () => {
    localStorage.setItem('klaud:review-fixture:p1:h', 'not-json');
    expect(loadFixture('p1', 'h')).toBeNull();
  });

  it('빈 pageId 는 저장/로드 모두 무동작', () => {
    saveFixture('', 'h', { score: 50 });
    expect(localStorage.length).toBe(0);
    expect(loadFixture('', 'h')).toBeNull();
  });

  it('schemaVersion 다른 옛 데이터 → null', () => {
    localStorage.setItem('klaud:review-fixture:p:h', JSON.stringify({
      data: { score: 50 }, savedAt: Date.now(), schemaVersion: 0,
    }));
    expect(loadFixture('p', 'h')).toBeNull();
  });
});

describe('invalidateFixture', () => {
  it('해당 (pageId, hash) 만 삭제', () => {
    saveFixture('page-1', 'h1', { score: 50 });
    saveFixture('page-1', 'h2', { score: 90 });
    saveFixture('page-2', 'h1', { score: 70 });
    invalidateFixture('page-1', 'h1');
    expect(loadFixture('page-1', 'h1')).toBeNull();
    expect(loadFixture('page-1', 'h2')).not.toBeNull();
    expect(loadFixture('page-2', 'h1')).not.toBeNull();
  });
});

describe('listAllFixtures', () => {
  it('저장된 모든 fixture 의 key + meta 반환', () => {
    saveFixture('p1', 'h', { score: 50 }, 'haiku');
    saveFixture('p2', 'h', { score: 80 });
    const all = listAllFixtures();
    expect(all.length).toBe(2);
    const ids = all.map((f) => f.pageId).sort();
    expect(ids).toEqual(['p1', 'p2']);
  });

  it('Klaud prefix 가 아닌 key 는 제외', () => {
    localStorage.setItem('other:thing', 'x');
    saveFixture('p1', 'h', { score: 50 });
    const all = listAllFixtures();
    expect(all.length).toBe(1);
    expect(all[0]!.pageId).toBe('p1');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-05-03T15:00:00Z');
  it('< 60초 → "방금"', () => {
    expect(relativeTime(now - 30 * 1000, now)).toBe('방금');
  });
  it('< 60분 → "X분 전"', () => {
    expect(relativeTime(now - 5 * 60 * 1000, now)).toBe('5분 전');
    expect(relativeTime(now - 59 * 60 * 1000, now)).toBe('59분 전');
  });
  it('< 24시간 → "X시간 전"', () => {
    expect(relativeTime(now - 2 * 60 * 60 * 1000, now)).toBe('2시간 전');
  });
  it('< 30일 → "X일 전"', () => {
    expect(relativeTime(now - 3 * 24 * 60 * 60 * 1000, now)).toBe('3일 전');
  });
  it('미래 시각 (clock skew) → "방금"', () => {
    expect(relativeTime(now + 60 * 1000, now)).toBe('방금');
  });
});
