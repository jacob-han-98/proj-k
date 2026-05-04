// P2: 사용자가 ReviewOptionsPanel 에서 고른 6개 옵션 → backend `/review_stream` 의
// `review_options` 페이로드 객체 변환. 순수 함수라 vitest 단위 테스트로 분기 검증.
//
// 회귀 방지 핵심:
// - cap 0 / 5 / 10 / 'all' 의 직렬화 (number vs literal "all").
// - categories 빈 배열 = "모든 관점" (필드 자체 omit 도 동등).
// - reviewer_persona default 'planner-lead'.
// - DEFAULT_OPTIONS 가 backend 동작에 영향 안 주는 값으로 시작 — 사용자가 명시적으로
//   바꾼 항목만 backend 가 인지.

export type ReviewIssueCap = 0 | 5 | 10 | 'all';
export type ReviewCategory = 'logic-flow' | 'qa-checklist' | 'readability';
export type ReviewerPersona = 'planner-lead' | 'programmer';

export interface ReviewOptions {
  issueCap: ReviewIssueCap;
  verificationCap: ReviewIssueCap;
  suggestionCap: ReviewIssueCap;
  categories: ReviewCategory[];
  reviewerPersona: ReviewerPersona;
}

// 옵션 패널 첫 진입 시 default — 두 번째 스크린샷에서 5 / 5 / 5 + 모든 카테고리 +
// 기획팀장이 highlight 된 상태.
export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = {
  issueCap: 5,
  verificationCap: 5,
  suggestionCap: 5,
  categories: ['logic-flow', 'qa-checklist', 'readability'],
  reviewerPersona: 'planner-lead',
};

// backend payload — server.py 가 받는 snake_case 키.
export interface ReviewOptionsPayload {
  issue_cap: number | 'all';
  verification_cap: number | 'all';
  suggestion_cap: number | 'all';
  categories: ReviewCategory[];
  reviewer_persona: ReviewerPersona;
}

export function toBackendPayload(opts: ReviewOptions): ReviewOptionsPayload {
  return {
    issue_cap: opts.issueCap,
    verification_cap: opts.verificationCap,
    suggestion_cap: opts.suggestionCap,
    // 빈 배열도 그대로 전송 — backend 가 "모든 관점" 로 해석. 명시적 신호라 omit 안 함.
    categories: [...opts.categories],
    reviewer_persona: opts.reviewerPersona,
  };
}

// 카테고리 chip 토글. 이미 있으면 빼고, 없으면 추가. 정렬은 stable (insertion order
// 유지) — 사용자가 클릭한 순서가 그대로 남음 (UI 의 active 표시와 일치).
export function toggleCategory(opts: ReviewOptions, cat: ReviewCategory): ReviewOptions {
  if (opts.categories.includes(cat)) {
    return { ...opts, categories: opts.categories.filter((c) => c !== cat) };
  }
  return { ...opts, categories: [...opts.categories, cat] };
}

// cap 칩 (0 / 5 / 10 / 'all') 단일 선택.
export function setCap(
  opts: ReviewOptions,
  field: 'issueCap' | 'verificationCap' | 'suggestionCap',
  value: ReviewIssueCap,
): ReviewOptions {
  if (opts[field] === value) return opts;
  return { ...opts, [field]: value };
}

// 페르소나 단일 선택.
export function setPersona(opts: ReviewOptions, persona: ReviewerPersona): ReviewOptions {
  if (opts.reviewerPersona === persona) return opts;
  return { ...opts, reviewerPersona: persona };
}
