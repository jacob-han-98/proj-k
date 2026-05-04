import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_OPTIONS,
  setCap,
  setPersona,
  toBackendPayload,
  toggleCategory,
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
    it('caps 5 + 모든 카테고리 + 기획팀장 — 두 번째 스크린샷 default 와 일치', () => {
      expect(DEFAULT_REVIEW_OPTIONS).toEqual({
        issueCap: 5,
        verificationCap: 5,
        suggestionCap: 5,
        categories: ['logic-flow', 'qa-checklist', 'readability'],
        reviewerPersona: 'planner-lead',
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
        reviewerPersona: 'programmer',
      };
      expect(toBackendPayload(opts)).toEqual({
        issue_cap: 10,
        verification_cap: 0,
        suggestion_cap: 'all',
        categories: ['logic-flow', 'qa-checklist'],
        reviewer_persona: 'programmer',
      });
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

    it('categories 배열은 새 인스턴스 반환 (mutation 안 함)', () => {
      const opts = { ...DEFAULT_REVIEW_OPTIONS };
      const out = toBackendPayload(opts);
      out.categories.push('logic-flow');
      // 원본은 그대로
      expect(opts.categories).toEqual(['logic-flow', 'qa-checklist', 'readability']);
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

  describe('setPersona', () => {
    it('페르소나 변경', () => {
      const out = setPersona(DEFAULT_REVIEW_OPTIONS, 'programmer');
      expect(out.reviewerPersona).toBe('programmer');
    });

    it('같은 값이면 같은 reference', () => {
      const out = setPersona(DEFAULT_REVIEW_OPTIONS, 'planner-lead');
      expect(out).toBe(DEFAULT_REVIEW_OPTIONS);
    });
  });
});
