import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_OPTIONS,
  setCap,
  toBackendPayload,
  toggleCategory,
  togglePersona,
  type ReviewOptions,
} from '../../src/renderer/panels/review-options-mapping';

// P2: 옵션 → backend payload 매핑 + 옵션 토글 분기.
//
// 회귀 방지:
// - issue_cap=0 / 5 / 'all' 직렬화 (number vs literal "all").
// - categories 빈 배열도 그대로 — backend 는 빈 배열도 명시적 신호로 해석.
// - toggle/setCap 가 immutable (새 객체 반환) — React state 비교 OK.

describe('review-options-mapping', () => {
  describe('DEFAULT_REVIEW_OPTIONS', () => {
    it('caps 5 + 모든 카테고리 + 기획팀장 단독 — 두 번째 스크린샷 default 와 일치', () => {
      expect(DEFAULT_REVIEW_OPTIONS).toEqual({
        issueCap: 5,
        verificationCap: 5,
        suggestionCap: 5,
        categories: ['logic-flow', 'qa-checklist', 'readability'],
        reviewerPersonas: ['planner-lead'],
      });
    });
  });

  describe('toBackendPayload', () => {
    it('camelCase → snake_case 변환', () => {
      const opts: ReviewOptions = {
        issueCap: 10,
        verificationCap: 0,
        suggestionCap: 'all',
        categories: ['logic-flow', 'qa-checklist'],
        reviewerPersonas: ['programmer'],
      };
      const out = toBackendPayload(opts);
      expect(out.issue_cap).toBe(10);
      expect(out.verification_cap).toBe(0);
      expect(out.suggestion_cap).toBe('all');
      expect(out.categories).toEqual(['logic-flow', 'qa-checklist']);
      expect(out.reviewer_personas).toEqual(['programmer']);
      // back-compat: 첫 persona 가 single 필드에도.
      expect(out.reviewer_persona).toBe('programmer');
    });

    it('persona 다중 — array 그대로 + back-compat single 은 첫 요소', () => {
      const out = toBackendPayload({
        ...DEFAULT_REVIEW_OPTIONS,
        reviewerPersonas: ['planner-lead', 'programmer'],
      });
      expect(out.reviewer_personas).toEqual(['planner-lead', 'programmer']);
      expect(out.reviewer_persona).toBe('planner-lead');
    });

    it("'all' literal 그대로 직렬화 — number 로 안 변환", () => {
      const out = toBackendPayload({ ...DEFAULT_REVIEW_OPTIONS, issueCap: 'all' });
      expect(out.issue_cap).toBe('all');
      expect(typeof out.issue_cap).toBe('string');
    });

    it('categories 빈 배열도 그대로 전송 (omit 안 함) — backend 가 빈 배열을 신호로 해석', () => {
      const out = toBackendPayload({ ...DEFAULT_REVIEW_OPTIONS, categories: [] });
      expect(out.categories).toEqual([]);
    });

    it('immutable — array 들이 원본과 분리됨', () => {
      const opts: ReviewOptions = { ...DEFAULT_REVIEW_OPTIONS };
      const out = toBackendPayload(opts);
      out.categories.push('logic-flow');
      out.reviewer_personas.push('programmer');
      // 원본은 그대로
      expect(opts.categories).toEqual(['logic-flow', 'qa-checklist', 'readability']);
      expect(opts.reviewerPersonas).toEqual(['planner-lead']);
    });
  });

  describe('toggleCategory', () => {
    it('포함된 카테고리 → 제거', () => {
      const out = toggleCategory(DEFAULT_REVIEW_OPTIONS, 'qa-checklist');
      expect(out.categories).toEqual(['logic-flow', 'readability']);
    });

    it('미포함 카테고리 → 추가 (insertion order)', () => {
      const start: ReviewOptions = { ...DEFAULT_REVIEW_OPTIONS, categories: [] };
      const a = toggleCategory(start, 'qa-checklist');
      expect(a.categories).toEqual(['qa-checklist']);
      const b = toggleCategory(a, 'logic-flow');
      expect(b.categories).toEqual(['qa-checklist', 'logic-flow']);
    });

    it('immutable — 원본은 안 바뀜', () => {
      const start = { ...DEFAULT_REVIEW_OPTIONS };
      toggleCategory(start, 'qa-checklist');
      expect(start.categories).toEqual(['logic-flow', 'qa-checklist', 'readability']);
    });
  });

  describe('setCap', () => {
    it('각 cap 필드 갱신', () => {
      const out = setCap(DEFAULT_REVIEW_OPTIONS, 'issueCap', 10);
      expect(out.issueCap).toBe(10);
      // 다른 필드는 보존
      expect(out.verificationCap).toBe(5);
      expect(out.suggestionCap).toBe(5);
    });

    it('같은 값으로 호출 시 같은 reference 반환 (React 렌더 skip 가능)', () => {
      const out = setCap(DEFAULT_REVIEW_OPTIONS, 'issueCap', 5);
      expect(out).toBe(DEFAULT_REVIEW_OPTIONS);
    });

    it("0 / 5 / 10 / 'all' 모두 허용", () => {
      expect(setCap(DEFAULT_REVIEW_OPTIONS, 'issueCap', 0).issueCap).toBe(0);
      expect(setCap(DEFAULT_REVIEW_OPTIONS, 'issueCap', 'all').issueCap).toBe('all');
    });
  });

  describe('togglePersona (다중)', () => {
    it('미포함 페르소나 추가 — insertion order', () => {
      const out = togglePersona(DEFAULT_REVIEW_OPTIONS, 'programmer');
      expect(out.reviewerPersonas).toEqual(['planner-lead', 'programmer']);
    });

    it('포함된 페르소나 제거', () => {
      const start: ReviewOptions = {
        ...DEFAULT_REVIEW_OPTIONS,
        reviewerPersonas: ['planner-lead', 'programmer'],
      };
      const out = togglePersona(start, 'planner-lead');
      expect(out.reviewerPersonas).toEqual(['programmer']);
    });

    it('마지막 한 개 끄면 자동으로 default planner-lead — 빈 상태 방지', () => {
      const start: ReviewOptions = {
        ...DEFAULT_REVIEW_OPTIONS,
        reviewerPersonas: ['programmer'],
      };
      const out = togglePersona(start, 'programmer');
      expect(out.reviewerPersonas).toEqual(['planner-lead']);
    });

    it('immutable — 원본은 안 바뀜', () => {
      const start = { ...DEFAULT_REVIEW_OPTIONS };
      togglePersona(start, 'programmer');
      expect(start.reviewerPersonas).toEqual(['planner-lead']);
    });
  });
});
