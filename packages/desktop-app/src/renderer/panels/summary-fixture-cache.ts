// P1: 요약 결과 캐시. review-fixture-cache 와 동일 패턴이지만 키 prefix 와 schema 가
// 다름 — 같은 pageId 의 review/summary 결과가 충돌 안 하게.
//
// 값: { summary: markdown 문자열, savedAt, model } JSON.
// review-fixture 와 달리 summary 는 markdown 문자열 한 덩어리라 schema 단순.
//
// 회귀 방지:
// - pageId + contentHash 로 키 잡아 본문 변경 시 자동 cache miss.
// - schemaVersion 안 맞으면 null 반환 — 향후 schema 진화 시 자동 invalidate.

import { hashContent, relativeTime } from './review-fixture-cache';

const KEY_PREFIX = 'klaud:summary-fixture:';
const SCHEMA_VERSION = 1;

export interface SummaryFixture {
  summary: string;
  savedAt: number;
  model?: string;
  schemaVersion: number;
}

export function summaryFixtureKey(pageId: string, contentHash: string): string {
  return `${KEY_PREFIX}${pageId}:${contentHash}`;
}

export function loadSummaryFixture(pageId: string, contentHash: string): SummaryFixture | null {
  if (!pageId) return null;
  try {
    const raw = localStorage.getItem(summaryFixtureKey(pageId, contentHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SummaryFixture>;
    if (typeof parsed?.summary !== 'string' || parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return {
      summary: parsed.summary,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      schemaVersion: SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}

export function saveSummaryFixture(
  pageId: string,
  contentHash: string,
  summary: string,
  model?: string,
): void {
  if (!pageId) return;
  const value: SummaryFixture = {
    summary,
    savedAt: Date.now(),
    model,
    schemaVersion: SCHEMA_VERSION,
  };
  try {
    localStorage.setItem(summaryFixtureKey(pageId, contentHash), JSON.stringify(value));
  } catch {
    /* quota / disabled — 무시 */
  }
}

export function invalidateSummaryFixture(pageId: string, contentHash: string): void {
  if (!pageId) return;
  try {
    localStorage.removeItem(summaryFixtureKey(pageId, contentHash));
  } catch {
    /* ignore */
  }
}

// hashContent / relativeTime 은 review-fixture-cache 의 export 그대로 재사용 — 별도
// 구현하면 두 곳이 갈라질 위험 (사용자가 hashContent 를 review 와 summary 에서 동일하게
// 보장해야 의미 있음).
export { hashContent, relativeTime };
