// 2026-05-12 PD 피드백 1b: 고정 탭 store 액션 분기.
//
// 회귀 방지:
// - pinTab / unpinTab / togglePinTab idempotent
// - 존재하지 않는 탭 id 는 pin/toggle 모두 no-op (race 방어)
// - closeTab 시 pinnedTabIds 자동 정리

import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkbenchStore } from '../../src/renderer/workbench/store';
import type { TreeNode } from '../../src/shared/types';

function makeNode(id: string, title: string): TreeNode {
  return {
    id,
    title,
    kind: 'leaf',
    relPath: null,
    children: [],
  } as unknown as TreeNode;
}

describe('store: pin/unpin/togglePin', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openTabs: [],
      activeTabId: null,
      pinnedTabIds: [],
      tabSplits: {},
      editingDocs: {},
      qnaPendingAttachments: {},
      autoPinOnReview: true,
    });
  });

  function openTwoTabs() {
    const store = useWorkbenchStore.getState();
    store.openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    store.openTab({ kind: 'confluence', node: makeNode('B', 'B') });
  }

  it('pinTab 는 pinnedTabIds 에 push (insertion order)', () => {
    openTwoTabs();
    const store = useWorkbenchStore.getState();
    store.pinTab('confluence:A');
    store.pinTab('confluence:B');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:A', 'confluence:B']);
  });

  it('pinTab idempotent — 이미 pinned 면 no-op', () => {
    openTwoTabs();
    const store = useWorkbenchStore.getState();
    store.pinTab('confluence:A');
    store.pinTab('confluence:A');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:A']);
  });

  it('존재하지 않는 탭 id 의 pin 은 no-op — race 방어', () => {
    openTwoTabs();
    useWorkbenchStore.getState().pinTab('confluence:GHOST');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
  });

  it('unpinTab 는 해당 id 제거, 나머지는 순서 보존', () => {
    openTwoTabs();
    const store = useWorkbenchStore.getState();
    store.pinTab('confluence:A');
    store.pinTab('confluence:B');
    store.unpinTab('confluence:A');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:B']);
  });

  it('togglePinTab — 없으면 추가, 있으면 제거', () => {
    openTwoTabs();
    const store = useWorkbenchStore.getState();
    store.togglePinTab('confluence:A');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:A']);
    store.togglePinTab('confluence:A');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
  });

  it('closeTab 시 pinnedTabIds 도 자동 정리 — leak 방어', () => {
    openTwoTabs();
    const store = useWorkbenchStore.getState();
    store.pinTab('confluence:A');
    store.pinTab('confluence:B');
    store.closeTab('confluence:A');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:B']);
  });
});

// 2026-05-13: 리뷰 모드 진입 시 자동 고정 (autoPinOnReview).
describe('store: auto-pin on review', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      openTabs: [],
      activeTabId: null,
      pinnedTabIds: [],
      tabSplits: {},
      editingDocs: {},
      qnaPendingAttachments: {},
      autoPinOnReview: true,
    });
  });

  function setupTab(): void {
    useWorkbenchStore.getState().openTab({ kind: 'confluence', node: makeNode('A', 'A') });
    useWorkbenchStore.getState().openSplit('confluence:A', '전투', '본문'); // mode='pick'
  }

  it('setSplitMode("review") → 그 탭이 자동 pin', () => {
    setupTab();
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
    useWorkbenchStore.getState().setSplitMode('confluence:A', 'review');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:A']);
  });

  it('autoPinOnReview=false 면 setSplitMode("review") 해도 pin 안 됨', () => {
    setupTab();
    useWorkbenchStore.setState({ autoPinOnReview: false });
    useWorkbenchStore.getState().setSplitMode('confluence:A', 'review');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
  });

  it('summary / agent 모드는 auto-pin 안 됨', () => {
    setupTab();
    useWorkbenchStore.getState().setSplitMode('confluence:A', 'summary');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
    useWorkbenchStore.getState().setSplitMode('confluence:A', 'agent');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
  });

  it('openSplit(mode="review") → 직접 review 모드 시작 시 자동 pin (Excel 즉시 리뷰 흐름)', () => {
    useWorkbenchStore.getState().openTab({ kind: 'excel', node: makeNode('s1', 'sheet') });
    useWorkbenchStore.getState().openSplit('excel:s1', '시트', '본문', 'review');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['excel:s1']);
  });

  it('이미 pinned 인 탭은 setSplitMode("review") 가 중복 안 만듦', () => {
    setupTab();
    useWorkbenchStore.getState().pinTab('confluence:A');
    useWorkbenchStore.getState().setSplitMode('confluence:A', 'review');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual(['confluence:A']);
  });

  it('존재하지 않는 탭 id 의 setSplitMode → state 안 바뀜 (no auto-pin race)', () => {
    useWorkbenchStore.getState().openSplit('confluence:GHOST', '제목', '본문', 'pick');
    // openSplit 은 tabSplits 만 채우고 openTabs 는 안 건드림. setSplitMode 로 review 전환.
    useWorkbenchStore.getState().setSplitMode('confluence:GHOST', 'review');
    expect(useWorkbenchStore.getState().pinnedTabIds).toEqual([]);
  });
});
