// 2026-05-12 PD 피드백 1b: Chrome 스타일 고정 탭.
//
// 회귀 방지:
// - getDisplayedTabs: pinned 우선 (pinnedTabIds 순서) + 나머지 unpinned (openTabs 순서)
// - stale pin id (openTabs 에 없음) 는 무시 — leak 방어
// - store 의 pin/unpin/togglePin 액션 idempotent + 존재 안 하는 id 는 no-op
// - closeTab 시 pinned 목록에서도 자동 정리

import { describe, expect, it } from 'vitest';
import { getDisplayedTabs, type DocTab } from '../../src/renderer/workbench/types';

function confluenceTab(id: string, title: string): DocTab {
  return {
    id,
    kind: 'confluence',
    node: {
      id,
      title,
      kind: 'leaf',
      relPath: null,
      children: [],
    } as unknown as DocTab extends { kind: 'confluence'; node: infer N } ? N : never,
  };
}

describe('getDisplayedTabs', () => {
  const tabA = confluenceTab('confluence:A', 'A');
  const tabB = confluenceTab('confluence:B', 'B');
  const tabC = confluenceTab('confluence:C', 'C');

  it('pinnedTabIds 빈 배열 → openTabs 원본 그대로', () => {
    const out = getDisplayedTabs([tabA, tabB, tabC], []);
    expect(out).toEqual([tabA, tabB, tabC]);
  });

  it('pinned 가 좌측에, pinnedTabIds 순서대로', () => {
    const out = getDisplayedTabs([tabA, tabB, tabC], ['confluence:C', 'confluence:A']);
    expect(out.map((t) => t.id)).toEqual(['confluence:C', 'confluence:A', 'confluence:B']);
  });

  it('모든 탭이 pinned 면 unpinned 영역 빔', () => {
    const out = getDisplayedTabs([tabA, tabB], ['confluence:B', 'confluence:A']);
    expect(out.map((t) => t.id)).toEqual(['confluence:B', 'confluence:A']);
  });

  it('stale pinned id (openTabs 에 없음) 는 결과에서 제외 — leak 방어', () => {
    const out = getDisplayedTabs([tabA, tabB], ['confluence:GHOST', 'confluence:B']);
    expect(out.map((t) => t.id)).toEqual(['confluence:B', 'confluence:A']);
  });

  it('unpinned 영역은 openTabs 의 원래 순서 보존', () => {
    const out = getDisplayedTabs([tabC, tabA, tabB], ['confluence:A']);
    expect(out.map((t) => t.id)).toEqual(['confluence:A', 'confluence:C', 'confluence:B']);
  });
});
