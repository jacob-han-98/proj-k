// A2: Command Palette 의 fuzzy 매칭 알고리즘 단위 테스트.

import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rankItems, type SearchableItem } from '../../src/renderer/workbench/fuzzy';

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
});
