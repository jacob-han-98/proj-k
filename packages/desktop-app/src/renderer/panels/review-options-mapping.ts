// P2: 사용자가 ReviewOptionsPanel 에서 고른 6개 옵션 → backend `/review_stream` 의
// `review_options` 페이로드 객체 변환. 순수 함수라 vitest 단위 테스트로 분기 검증.
//
// 회귀 방지 핵심:
// - cap 은 number — 0 = 없음, N = N 개. 2026-05-12 PD 피드백으로 4-chip (0/5/10/all)
//   에서 자유 입력 textbox 로 전환 + 'all' 의미 제거. backend ReviewOptionsModel 의
//   issue_cap 은 int | str 그대로지만 frontend 는 int 만 송신.
// - categories 빈 배열 = "모든 관점" (필드 자체 omit 도 동등).
// - reviewer_persona default 'planner-lead'.
// - DEFAULT_OPTIONS 가 backend 동작에 영향 안 주는 값으로 시작 — 사용자가 명시적으로
//   바꾼 항목만 backend 가 인지.

// 사용자 입력 textbox 의 정수값. 0 = 없음, N(>=1) = 최대 N 개.
// 음수/소수/NaN 은 입력 단계에서 사니타이즈 — 컴포넌트가 0 으로 가드.
export type ReviewIssueCap = number;
export type ReviewCategory = 'logic-flow' | 'qa-checklist' | 'readability';
export type ReviewerPersona = 'planner-lead' | 'programmer';

export interface ReviewOptions {
  issueCap: ReviewIssueCap;
  verificationCap: ReviewIssueCap;
  suggestionCap: ReviewIssueCap;
  categories: ReviewCategory[];
  // P2 보강: 다중 페르소나 (체크박스). 빈 배열은 default ('planner-lead' 단독) 와 동일
  // 효과 — backend 가 그렇게 해석. 사용자는 둘 다 토글하면 두 톤이 결합된 검토 받음.
  reviewerPersonas: ReviewerPersona[];
}

// 옵션 패널 첫 진입 시 default — 두 번째 스크린샷의 highlight 와 일치.
// 5 / 5 / 5 + 모든 카테고리 + 기획팀장 단독 (사용자가 명시적으로 추가 토글 가능).
export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = {
  issueCap: 5,
  verificationCap: 5,
  suggestionCap: 5,
  categories: ['logic-flow', 'qa-checklist', 'readability'],
  reviewerPersonas: ['planner-lead'],
};

// backend payload — server.py 가 받는 snake_case 키.
// P2 보강 — reviewer_personas (array) 신규 + reviewer_persona (single) back-compat.
export interface ReviewOptionsPayload {
  issue_cap: number;
  verification_cap: number;
  suggestion_cap: number;
  categories: ReviewCategory[];
  reviewer_personas: ReviewerPersona[];
  // backend 가 personas 우선 처리하지만, single 만 처리하는 구버전 호환을 위해 첫
  // persona 를 single 필드에도 함께 전송. backend 가 array 받으면 이건 무시됨.
  reviewer_persona?: ReviewerPersona;
}

export function toBackendPayload(opts: ReviewOptions): ReviewOptionsPayload {
  return {
    issue_cap: opts.issueCap,
    verification_cap: opts.verificationCap,
    suggestion_cap: opts.suggestionCap,
    // 빈 배열도 그대로 전송 — backend 가 "모든 관점" 로 해석. 명시적 신호라 omit 안 함.
    categories: [...opts.categories],
    reviewer_personas: [...opts.reviewerPersonas],
    // back-compat: 첫 persona (또는 default 'planner-lead') 를 single 필드에도.
    reviewer_persona: opts.reviewerPersonas[0] ?? 'planner-lead',
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

// cap textbox 입력 갱신. 음수/NaN 은 0 으로 클램프 (없음 의미). 정수만 허용.
export function setCap(
  opts: ReviewOptions,
  field: 'issueCap' | 'verificationCap' | 'suggestionCap',
  value: ReviewIssueCap,
): ReviewOptions {
  const sanitized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (opts[field] === sanitized) return opts;
  return { ...opts, [field]: sanitized };
}

// 페르소나 다중 토글. 이미 있으면 빼고, 없으면 추가. insertion order 유지.
// 단, 마지막 하나를 끄면 자동으로 default ('planner-lead') 로 — 빈 상태 방지.
export function togglePersona(opts: ReviewOptions, persona: ReviewerPersona): ReviewOptions {
  if (opts.reviewerPersonas.includes(persona)) {
    const next = opts.reviewerPersonas.filter((p) => p !== persona);
    if (next.length === 0) return { ...opts, reviewerPersonas: ['planner-lead'] };
    return { ...opts, reviewerPersonas: next };
  }
  return { ...opts, reviewerPersonas: [...opts.reviewerPersonas, persona] };
}
