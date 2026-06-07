// 2026-05-13: Ctrl+Tab MRU 스위처 + 편집 모드 자동 고정 회귀 방지.
//
// 1. bumpFocusOrder — 가장 최근 사용 탭이 head 로 unshift, dedup.
// 2. tabSwitcherCandidates — openTabs + tabFocusOrder 병합, stale 정리.
// 3. store.openTabSwitcher / move / commit / cancel — cursor 흐름.
// 4. setDocEditing → Confluence/Excel 탭 auto-pin (autoPinOnReview ON).
// 5. docKeyOfNode — confluencePageId 가 있으면 confluence:<pageId> 반환.

import { beforeEach, describe, expect, it } from 'vitest';
import type { DocTab } from '../../src/renderer/workbench/types';
import {
  bumpFocusOrder,
  docKeyOfNode,
  tabSwitcherCandidates,
} from '../../src/renderer/workbench/types';
import { useWorkbenchStore } from '../../src/renderer/workbench/store';
import type { TreeNode } from '../../src/shared/types';

function makeNode(id: string, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    title,
    kind: 'leaf',
    relPath: null,
    children: [],
    ...extra,
  } as unknown as TreeNode;
}

function fakeTab(id: string, kind: 'confluence' | 'excel' = 'confluence'): DocTab {
  return { id, kind, node: makeNode(id, id) } as DocTab;
}

describe('bumpFocusOrder', () => {
  it('새 id 면 head 에 push', () => {
    expect(bumpFocusOrder([], 'a')).toEqual(['a']);
    expect(bumpFocusOrder(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });
  it('이미 head 면 변경 안 함 (참조 동일 — set 불필요)', () => {
    const before = ['a', 'b'];
    const after = bumpFocusOrder(before, 'a');
    expect(after).toBe(before);
  });
  it('중간/끝에 있으면 빼서 head 로 이동', () => {
    expect(bumpFocusOrder(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(bumpFocusOrder(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });
});

describe('tabSwitcherCandidates', () => {
  it('focusOrder 그대로 — stale 없음', () => {
    const tabs = [fakeTab('a'), fakeTab('b'), fakeTab('c')];
    expect(tabSwitcherCandidates(tabs, ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
  });
  it('focusOrder 에 없는 탭은 끝에 append', () => {
    const tabs = [fakeTab('a'), fakeTab('b'), fakeTab('c')];
    expect(tabSwitcherCandidates(tabs, ['b'])).toEqual(['b', 'a', 'c']);
  });
  it('focusOrder 의 stale id 는 제외 — closeTab 청소 누락 방어', () => {
    const tabs = [fakeTab('a'), fakeTab('b')];
    expect(tabSwitcherCandidates(tabs, ['b', 'GHOST', 'a'])).toEqual(['b', 'a']);
  });
  it('openTabs 비어있으면 []', () => {
    expect(tabSwitcherCandidates([], ['a', 'b'])).toEqual([]);
  });
});

describe('docKeyOfNode', () => {
  it('confluencePageId 있으면 confluence:<id> — relPath 무시', () => {
    expect(
      docKeyOfNode({ id: 'confluence:12345', confluencePageId: '12345', relPath: 'X' }),
    ).toBe('confluence:12345');
  });
  it('depot 노드 — revision suffix 제거', () => {
    expect(
      docKeyOfNode({ id: 'depot://main/foo.xlsx#rev42', oneDriveUrl: 'https://x' }),
    ).toBe('depot://main/foo.xlsx');
  });
  it('local 노드 — relPath 기반', () => {
    expect(docKeyOfNode({ id: 'local:7_System/X.xlsx', relPath: '7_System/X.xlsx' }))
      .toBe('local:7_System/X.xlsx');
  });
  it('아무것도 매칭 안 되면 null', () => {
    expect(docKeyOfNode({ id: 'qna:abc' })).toBeNull();
  });
});

describe('store: focusTab / openTab → tabFocusOrder 갱신', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openTabs: [],
      activeTabId: null,
      pinnedTabIds: [],
      tabSplits: {},
      editingDocs: {},
      qnaPendingAttachments: {},
      autoPinOnReview: true,
      tabFocusOrder: [],
      tabSwitcher: null,
    });
  });

  it('openTab 마다 tabFocusOrder head 에 unshift', () => {
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    s.openTab({ kind: 'confluence', node: makeNode('B', 'B') });
    expect(useWorkbenchStore.getState().tabFocusOrder).toEqual(['confluence:B', 'confluence:A']);
  });

  it('focusTab 호출 시 그 id 가 head 로 이동', () => {
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    s.openTab({ kind: 'confluence', node: makeNode('B', 'B') });
    useWorkbenchStore.getState().focusTab('confluence:A');
    expect(useWorkbenchStore.getState().tabFocusOrder).toEqual(['confluence:A', 'confluence:B']);
  });

  it('closeTab 시 tabFocusOrder 에서 제거 — leak 방어', () => {
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    s.openTab({ kind: 'confluence', node: makeNode('B', 'B') });
    useWorkbenchStore.getState().closeTab('confluence:A');
    expect(useWorkbenchStore.getState().tabFocusOrder).toEqual(['confluence:B']);
  });
});

describe('store: Ctrl+Tab switcher 액션', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openTabs: [],
      activeTabId: null,
      pinnedTabIds: [],
      tabSplits: {},
      editingDocs: {},
      qnaPendingAttachments: {},
      autoPinOnReview: true,
      tabFocusOrder: [],
      tabSwitcher: null,
    });
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    s.openTab({ kind: 'confluence', node: makeNode('B', 'B') });
    s.openTab({ kind: 'confluence', node: makeNode('C', 'C') });
    // 최종 MRU: C(head), B, A.
  });

  it('openTabSwitcher(+1) → cursor=1 (현재 다음 MRU)', () => {
    useWorkbenchStore.getState().openTabSwitcher(1);
    const sw = useWorkbenchStore.getState().tabSwitcher;
    expect(sw).not.toBeNull();
    expect(sw!.candidates).toEqual(['confluence:C', 'confluence:B', 'confluence:A']);
    expect(sw!.cursor).toBe(1);
  });

  it('openTabSwitcher(-1) → cursor=last (가장 오래된)', () => {
    useWorkbenchStore.getState().openTabSwitcher(-1);
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(2);
  });

  it('moveTabSwitcher 가 cursor 를 wrap', () => {
    const s = useWorkbenchStore.getState();
    s.openTabSwitcher(1); // cursor=1
    s.moveTabSwitcher(1); // 2
    s.moveTabSwitcher(1); // wrap → 0
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(0);
    s.moveTabSwitcher(-1); // wrap → 2
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(2);
  });

  it('commitTabSwitcher → cursor 의 탭이 활성 + overlay 닫힘', () => {
    useWorkbenchStore.getState().openTabSwitcher(1);
    // cursor=1 → confluence:B
    useWorkbenchStore.getState().commitTabSwitcher();
    expect(useWorkbenchStore.getState().tabSwitcher).toBeNull();
    expect(useWorkbenchStore.getState().activeTabId).toBe('confluence:B');
    // focus order 도 갱신 — B 가 head 로.
    expect(useWorkbenchStore.getState().tabFocusOrder[0]).toBe('confluence:B');
  });

  it('cancelTabSwitcher → overlay 만 닫고 activeTabId 안 바뀜', () => {
    const before = useWorkbenchStore.getState().activeTabId;
    useWorkbenchStore.getState().openTabSwitcher(1);
    useWorkbenchStore.getState().cancelTabSwitcher();
    expect(useWorkbenchStore.getState().tabSwitcher).toBeNull();
    expect(useWorkbenchStore.getState().activeTabId).toBe(before);
  });

  it('setTabSwitcherCursor — Home/End/PageUp/PageDown 용 absolute set. clamp 됨.', () => {
    useWorkbenchStore.getState().openTabSwitcher(1);
    const s = useWorkbenchStore.getState();
    s.setTabSwitcherCursor(0);
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(0);
    s.setTabSwitcherCursor(999);
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(2); // clamp to last
    s.setTabSwitcherCursor(-5);
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(0); // clamp to first
    s.setTabSwitcherCursor(1);
    expect(useWorkbenchStore.getState().tabSwitcher!.cursor).toBe(1);
  });

  it('setTabSwitcherCursor — switcher 닫혀있으면 no-op (race 방어)', () => {
    expect(useWorkbenchStore.getState().tabSwitcher).toBeNull();
    useWorkbenchStore.getState().setTabSwitcherCursor(0);
    expect(useWorkbenchStore.getState().tabSwitcher).toBeNull();
  });

  it('탭 1개면 openTabSwitcher 가 no-op', () => {
    useWorkbenchStore.setState({
      openTabs: [],
      activeTabId: null,
      tabFocusOrder: [],
      tabSwitcher: null,
    });
    useWorkbenchStore.getState().openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    useWorkbenchStore.getState().openTabSwitcher(1);
    expect(useWorkbenchStore.getState().tabSwitcher).toBeNull();
  });
});

// 2026-05-13: TabSwitcher 가 후보 옆에 표시하는 mode 배지 — TabBar 와 동일한 분기 로직을
// 단위 테스트로 굳혀서 두 컴포넌트가 갈라지지 않게.
function pinModeOf(
  tab: DocTab,
  editingDocs: Record<string, boolean>,
  tabSplits: Record<string, { mode: string } | undefined>,
): 'edit' | 'review' | null {
  if (tab.kind === 'confluence' || tab.kind === 'excel') {
    const dk = docKeyOfNode(tab.node);
    if (dk && editingDocs[dk]) return 'edit';
  }
  if (tabSplits[tab.id]?.mode === 'review') return 'review';
  return null;
}

describe('TabSwitcher 배지 — pinModeOf 분기', () => {
  it('편집중인 Confluence 탭 → edit', () => {
    const tab = {
      id: 'confluence:p1',
      kind: 'confluence',
      node: makeNode('confluence:p1', 'P1', { confluencePageId: 'p1' }),
    } as DocTab;
    expect(pinModeOf(tab, { 'confluence:p1': true }, {})).toBe('edit');
  });
  it('리뷰 split active 인 탭 → review', () => {
    const tab = fakeTab('a', 'confluence');
    expect(pinModeOf(tab, {}, { a: { mode: 'review' } })).toBe('review');
  });
  it('편집 + 리뷰 동시 → edit 우선 (현재 행동 우선)', () => {
    const tab = {
      id: 'confluence:p1',
      kind: 'confluence',
      node: makeNode('confluence:p1', 'P1', { confluencePageId: 'p1' }),
    } as DocTab;
    expect(
      pinModeOf(tab, { 'confluence:p1': true }, { 'confluence:p1': { mode: 'review' } }),
    ).toBe('edit');
  });
  it('아무 모드도 아니면 null', () => {
    const tab = fakeTab('x');
    expect(pinModeOf(tab, {}, {})).toBeNull();
  });
  it('qna-thread 탭은 편집 docKey 없음 — review 모드만 잡음', () => {
    const qna = { id: 'qna:t1', kind: 'qna-thread', threadId: 't1', title: 'T1' } as DocTab;
    expect(pinModeOf(qna, { 'qna:t1': true }, {})).toBeNull();
    expect(pinModeOf(qna, {}, { 'qna:t1': { mode: 'review' } })).toBe('review');
  });
});

describe('store: setDocEditing → auto-pin (편집 모드 진입 시)', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openTabs: [],
      activeTabId: null,
      pinnedTabIds: [],
      tabSplits: {},
      editingDocs: {},
      qnaPendingAttachments: {},
      autoPinOnReview: true,
      tabFocusOrder: [],
      tabSwitcher: null,
    });
  });

  it('Confluence 편집 진입 → 그 탭 auto-pin', () => {
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('p1', 'P1', { confluencePageId: 'p1' }) });
    useWorkbenchStore.getState().setDocEditing('confluence:p1', true);
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:p1']);
    expect(useWorkbenchStore.getState().editingDocs['confluence:p1']).toBe(true);
  });

  it('편집 종료(false) → editing 만 false, pin 은 유지 (사용자 명시 unpin 만 신뢰)', () => {
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('p1', 'P1', { confluencePageId: 'p1' }) });
    useWorkbenchStore.getState().setDocEditing('confluence:p1', true);
    useWorkbenchStore.getState().setDocEditing('confluence:p1', false);
    expect(useWorkbenchStore.getState().editingDocs['confluence:p1']).toBeUndefined();
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:p1']);
  });

  it('autoPinOnReview=false 면 setDocEditing(true) 해도 pin 안 됨', () => {
    useWorkbenchStore.setState({ autoPinOnReview: false });
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('p1', 'P1', { confluencePageId: 'p1' }) });
    useWorkbenchStore.getState().setDocEditing('confluence:p1', true);
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
  });

  it('docKey 매칭되는 탭이 없으면 editingDocs 만 채우고 pin 안 함 — leak 방어', () => {
    useWorkbenchStore.getState().setDocEditing('confluence:GHOST', true);
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
    expect(useWorkbenchStore.getState().editingDocs['confluence:GHOST']).toBe(true);
  });

  it('toggleDocEditing(true 방향) 도 동일하게 auto-pin', () => {
    const s = useWorkbenchStore.getState();
    s.openTab({ kind: 'confluence', node: makeNode('p1', 'P1', { confluencePageId: 'p1' }) });
    useWorkbenchStore.getState().toggleDocEditing('confluence:p1');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:p1']);
  });
});
