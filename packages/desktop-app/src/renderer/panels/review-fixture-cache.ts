// B2-2 (2026-05-03): review 결과 캐시. localStorage 에 저장 — 다음 리뷰 호출 시 cache hit
// 이면 백엔드 호출 우회하고 즉시 카드 채움. 사용자 (Jacob) 의 의도:
//   1) 개발 중 Apply 코드 iterate 시 매번 review (수십초) 재호출 회피.
//   2) 실제 사용자도 같은 페이지를 다시 보거나 다른 사람과 결과 공유 (export/import 후속) 시 유용.
//
// key 구조: `klaud:review-fixture:<pageId>:<contentHash>`
//   - pageId 만으로 키 잡으면 페이지 본문이 바뀐 후에도 옛 fixture hit → 사용자 혼동.
//   - contentHash 는 ReviewSplitPane 가 props.text (webview 추출 본문) 로 계산 → 본문 바뀌면
//     자동 invalidate. cf. B2-1 의 "테스트로 복사" 후 사본 page 는 별도 pageId → 같은 본문이라도
//     별도 fixture (의도 — 사본 검증 흐름).
//
// 값: { data, savedAt (ms), model } JSON. data 는 ReviewData (partial-review-parser 와 같은 schema).
// model 은 result 이벤트의 e.data.model — 캐시된 fixture 가 어느 모델 산이었는지 사용자에게 표시.

import type { ReviewData } from './ReviewCard';

const KEY_PREFIX = 'klaud:review-fixture:';
const SCHEMA_VERSION = 1;

export interface ReviewFixture {
  data: ReviewData;
  savedAt: number;          // Date.now()
  model?: string;           // sonnet / haiku / 등
  schemaVersion: number;
}

export function fixtureKey(pageId: string, contentHash: string): string {
  return `${KEY_PREFIX}${pageId}:${contentHash}`;
}

// djb2 — 가벼운 deterministic hash. 같은 본문 → 같은 hash.
// 고정밀 collision 방지보단 "본문 변경 detect" 가 목적이라 충분.
export function hashContent(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// P2 보강: 옵션 stable hash. 같은 옵션 → 같은 hash. ReviewSplitPane 의 cache key 가
// content + options 모두로 잡혀서 옵션 변경 시 자동 cache miss → 새 stream 발동.
//
// 회귀: 이전엔 contentHash 만으로 키 잡아 옵션 변경해도 cache hit → 같은 결과 표시.
// 사용자 보고 "카테고리/persona 옵션이 무효" 의 root cause 였음.
export function hashReviewOptions(opts: {
  issueCap: number | string;
  verificationCap: number | string;
  suggestionCap: number | string;
  categories: string[];
  reviewerPersonas: string[];
}): string {
  // 카테고리/페르소나는 정렬 후 직렬화 — insertion order 가 결과에 영향 안 주므로.
  const cats = [...opts.categories].sort().join(',');
  const personas = [...opts.reviewerPersonas].sort().join(',');
  const stable = `${opts.issueCap}|${opts.verificationCap}|${opts.suggestionCap}|${cats}|${personas}`;
  return hashContent(stable);
}

export function loadFixture(pageId: string, contentHash: string): ReviewFixture | null {
  if (!pageId) return null;
  try {
    const raw = localStorage.getItem(fixtureKey(pageId, contentHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReviewFixture>;
    if (!parsed?.data || parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return {
      data: parsed.data as ReviewData,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      schemaVersion: SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}

export function saveFixture(
  pageId: string,
  contentHash: string,
  data: ReviewData,
  model?: string,
): void {
  if (!pageId) return;
  const value: ReviewFixture = {
    data,
    savedAt: Date.now(),
    model,
    schemaVersion: SCHEMA_VERSION,
  };
  try {
    localStorage.setItem(fixtureKey(pageId, contentHash), JSON.stringify(value));
  } catch {
    // localStorage quota or disabled — 무시. 다음 호출은 그냥 새 stream.
  }
}

// 특정 (pageId, contentHash) 만 삭제. "🔁 새 리뷰" 클릭 시 호출.
export function invalidateFixture(pageId: string, contentHash: string): void {
  if (!pageId) return;
  try {
    localStorage.removeItem(fixtureKey(pageId, contentHash));
  } catch {
    /* ignore */
  }
}

// 향후 export/import / "오래된 캐시 정리" 등에서 사용.
export function listAllFixtures(): Array<{ key: string; pageId: string; hash: string; meta: ReviewFixture }> {
  const out: Array<{ key: string; pageId: string; hash: string; meta: ReviewFixture }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      const rest = k.slice(KEY_PREFIX.length);
      const colonIdx = rest.lastIndexOf(':');
      if (colonIdx < 0) continue;
      const pageId = rest.slice(0, colonIdx);
      const hash = rest.slice(colonIdx + 1);
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? '') as ReviewFixture;
        if (parsed?.schemaVersion === SCHEMA_VERSION) {
          out.push({ key: k, pageId, hash, meta: parsed });
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* localStorage 접근 실패 */ }
  return out;
}

// 사람이 읽을 짧은 상대시각 ("5분 전", "1시간 전", "3일 전").
export function relativeTime(savedAt: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (diffSec < 60) return '방금';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}일 전`;
  return `${Math.floor(diffDay / 30)}개월 전`;
}
