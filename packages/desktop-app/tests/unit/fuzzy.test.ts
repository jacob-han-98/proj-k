// A2: Command Palette 의 fuzzy 매칭 알고리즘 단위 테스트.

import { describe, expect, it } from 'vitest';
import {
  decomposeHangul,
  fuzzyMatch,
  nsNormalize,
  rankItems,
  type SearchableItem,
} from '../../src/renderer/workbench/fuzzy';

describe('fuzzyMatch', () => {
  it('정확 prefix 매칭 — char 순서대로 등장하는 candidate 만 통과', () => {
    expect(fuzzyMatch('pkhud', 'PK_HUD 시스템')).not.toBeNull();
    expect(fuzzyMatch('hud', 'PK_HUD 시스템')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'PK_HUD 시스템')).toBeNull();
  });

  it('대소문자 무시', () => {
    expect(fuzzyMatch('PKHUD', 'pk_hud 시스템')).not.toBeNull();
    expect(fuzzyMatch('HUD', 'pk_hud 시스템')).not.toBeNull();
  });

  it('한글 매칭 — 부분 substring 도 통과', () => {
    expect(fuzzyMatch('골드', 'PK_골드 밸런스')).not.toBeNull();
    expect(fuzzyMatch('밸런', 'PK_골드 밸런스')).not.toBeNull();
    expect(fuzzyMatch('골밸', 'PK_골드 밸런스')).not.toBeNull(); // subsequence
  });

  it('연속 매칭이 비연속보다 점수 높음', () => {
    const consecutive = fuzzyMatch('hud', 'PK_HUD 시스템');
    const scattered = fuzzyMatch('hud', 'h u d 다른 텍스트');
    expect(consecutive!.score).toBeGreaterThan(scattered!.score);
  });

  it('단어 boundary 시작 매칭 보너스', () => {
    // 'p' 가 단어 시작 (boundary 후) 일 때 더 높은 점수.
    const m1 = fuzzyMatch('p', 'PK_HUD');
    const m2 = fuzzyMatch('p', 'apple');
    expect(m1!.score).toBeGreaterThan(m2!.score);
  });

  it('빈 query → 모두 통과 (score 0)', () => {
    const m = fuzzyMatch('', 'anything');
    expect(m).toEqual({ score: 0, matchedIndices: [] });
  });

  it('separator-insensitive substring — "몬스터 왕" 이 "PK_몬스터_왕" 매칭', () => {
    // subsequence 도 통과하지만 (각 char 가 순서대로 등장), 공백 분리 변형도 잡혀야 의도된 동작.
    expect(fuzzyMatch('몬스터 왕', 'PK_몬스터_왕')).not.toBeNull();
    expect(fuzzyMatch('몬스터왕', 'PK_몬스터 왕')).not.toBeNull();
    expect(fuzzyMatch('가시나무 숲', '가시나무숲')).not.toBeNull();
  });

  it('자모 bigram fuzzy — "르바" → 로바르스 (subsequence 실패해도 통과)', () => {
    // '르바' 의 자모는 ㄹㅡㅂㅏ (4자모, gate 통과). "로바르스" 와 bigram 2/3 = 0.667 ≥ 0.6.
    const m = fuzzyMatch('르바', '로바르스Lobars');
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThan(0);
  });

  it('자모 fuzzy gate — query 자모 길이 < 4 면 매칭 안 됨', () => {
    // '가' = 자모 ㄱㅏ (2자모) — JAMO_MIN_LEN=4 미만 → null.
    expect(fuzzyMatch('가', '관련 없는 단어')).toBeNull();
  });

  it('자모 fuzzy threshold — bigram 일치율 < 0.6 면 매칭 안 됨', () => {
    // '르바' bigram {ㄹㅡ,ㅡㅂ,ㅂㅏ} 가 '시스템' bigram 과 0% overlap.
    expect(fuzzyMatch('르바', '시스템')).toBeNull();
  });

  it('subsequence 매칭이 한국어 매칭보다 점수 높음 (정확도 우선)', () => {
    const subseq = fuzzyMatch('hud', 'PK_HUD');
    const jamo = fuzzyMatch('르바', '로바르스Lobars');
    expect(subseq!.score).toBeGreaterThan(jamo!.score);
  });
});

describe('한국어 normalize / decompose 헬퍼', () => {
  it('nsNormalize — 공백/_/-/·/. 모두 제거', () => {
    expect(nsNormalize('PK_몬스터 왕')).toBe('PK몬스터왕');
    expect(nsNormalize('가-시·나무.숲')).toBe('가시나무숲');
    expect(nsNormalize('이중　공백')).toBe('이중공백'); // ideographic space
  });

  it('decomposeHangul — 음절을 초성/중성/종성 jamo 로 분해', () => {
    const r = decomposeHangul('르바');
    // '르' = ㄹㅡ (종성 없음), '바' = ㅂㅏ (종성 없음) → 4 jamo.
    expect(r.length).toBe(4);
    expect(r).toBe('르바');
  });

  it('decomposeHangul — 종성 있는 음절 (예: "산" = ㅅㅏㄴ → 3 jamo)', () => {
    const r = decomposeHangul('산');
    expect(r.length).toBe(3);
  });

  it('decomposeHangul — 비-한글 문자는 그대로', () => {
    expect(decomposeHangul('hello')).toBe('hello');
    expect(decomposeHangul('PK_가')).toBe('PK_가');
  });
});

describe('rankItems', () => {
  const items: SearchableItem[] = [
    { source: 'p4-local', refId: '7_System/PK_HUD 시스템', title: 'PK_HUD 시스템', path: '7_System/PK_HUD 시스템' },
    { source: 'p4-local', refId: '7_System/PK_NPC 시스템', title: 'PK_NPC 시스템', path: '7_System/PK_NPC 시스템' },
    { source: 'p4-local', refId: '7_System/경제밸런스/PK_골드 밸런스', title: 'PK_골드 밸런스', path: '7_System/경제밸런스/PK_골드 밸런스' },
    { source: 'confluence', refId: 'p123', title: '전투 시스템 디자인', path: 'Design/시스템/전투 시스템 디자인' },
    { source: 'p4-depot', refId: '//main/x/y.xlsx', title: 'y.xlsx', path: '//main/x/y.xlsx' },
  ];

  it('빈 query → 빈 결과', () => {
    expect(rankItems(items, '').length).toBe(0);
    expect(rankItems(items, '   ').length).toBe(0);
  });

  it('"hud" 로 검색 → PK_HUD 가 top', () => {
    const r = rankItems(items, 'hud');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.refId).toBe('7_System/PK_HUD 시스템');
  });

  it('"골드" 로 검색 → PK_골드 밸런스 가 top', () => {
    const r = rankItems(items, '골드');
    expect(r[0]!.refId).toBe('7_System/경제밸런스/PK_골드 밸런스');
  });

  it('"전투" → Confluence 의 전투 시스템 매칭', () => {
    const r = rankItems(items, '전투');
    expect(r[0]!.source).toBe('confluence');
    expect(r[0]!.title).toContain('전투');
  });

  it('매칭 안 되는 query → 빈 결과', () => {
    expect(rankItems(items, 'zxqv가나').length).toBe(0);
  });

  it('limit 적용', () => {
    const r = rankItems(items, '시스템', 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('한국어 fuzzy — "르바" 검색 시 로바르스 워크북 매칭', () => {
    const koreanItems: SearchableItem[] = [
      ...items,
      { source: 'p4-local', refId: '8_Contents/PK_레벨_필드_로바르스_생명의 땅', title: 'PK_레벨_필드_로바르스_생명의 땅', path: '8_Contents/PK_레벨_필드_로바르스_생명의 땅' },
    ];
    const r = rankItems(koreanItems, '르바');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.title).toContain('로바르스');
  });

  it('한국어 separator-insensitive — "몬스터 왕" 검색 시 PK_몬스터_왕 매칭', () => {
    const koreanItems: SearchableItem[] = [
      ...items,
      { source: 'p4-local', refId: '8_Contents/PK_몬스터_왕', title: 'PK_몬스터_왕', path: '8_Contents/PK_몬스터_왕' },
    ];
    const r = rankItems(koreanItems, '몬스터 왕');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.title).toBe('PK_몬스터_왕');
  });
});
