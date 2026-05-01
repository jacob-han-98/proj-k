import { create } from 'zustand';
import type { DocTab, OpenTabSpec, SidebarKind } from './types';
import { tabIdOf } from './types';

// PR1: activeIcon (Activity Bar 토글).
// PR2: openTabs / activeTabId / openTab / focusTab / closeTab.
// PR3+: 사이드바 토글 routing, qna-thread 탭, split state.

// PR4: 탭별 review split. tabId → 그 탭이 split 켜졌을 때 ReviewSplitPane 에 넘길 payload.
// trigger 는 같은 페이지를 다시 리뷰 요청해도 useEffect 가 재발동되도록 dedupe key.
export interface SplitPayload {
  title: string;
  text: string;
  trigger: number;
}

type WorkbenchState = {
  activeIcon: SidebarKind;
  setActiveIcon: (kind: SidebarKind) => void;

  openTabs: DocTab[];
  activeTabId: string | null;
  // openTab: 같은 ID 가 이미 있으면 focus 만, 없으면 push + activate.
  openTab: (spec: OpenTabSpec) => void;
  focusTab: (id: string) => void;
  // closeTab: 활성 탭이 닫히면 인접한 탭 (오른쪽 우선, 없으면 왼쪽) 활성화. 모두 닫히면 null.
  // 탭이 닫히면 그 탭의 split payload 도 같이 정리.
  closeTab: (id: string) => void;

  // PR4: editor 영역의 우측 split (리뷰/변경안). 탭별 isolated.
  tabSplits: Record<string, SplitPayload | undefined>;
  openSplit: (tabId: string, title: string, text: string) => void;
  closeSplit: (tabId: string) => void;
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  // 부팅 시 기본은 Confluence — 현재 사용자가 가장 자주 여는 영역.
  activeIcon: 'confluence',
  setActiveIcon: (kind) => set({ activeIcon: kind }),

  openTabs: [],
  activeTabId: null,

  openTab: (spec) => set((state) => {
    const id = tabIdOf(spec);
    const existing = state.openTabs.find((t) => t.id === id);
    if (existing) {
      // qna-thread title 이 RENAME 등으로 바뀐 경우 기존 탭의 title 도 갱신해줌.
      if (spec.kind === 'qna-thread' && existing.kind === 'qna-thread' && existing.title !== spec.title) {
        const updated: DocTab[] = state.openTabs.map((t) =>
          t.id === id && t.kind === 'qna-thread' ? { ...t, title: spec.title } : t,
        );
        return { ...state, openTabs: updated, activeTabId: id };
      }
      return state.activeTabId === id ? state : { ...state, activeTabId: id };
    }
    let tab: DocTab;
    if (spec.kind === 'qna-thread') {
      tab = { id, kind: 'qna-thread', threadId: spec.threadId, title: spec.title };
    } else {
      tab = { id, kind: spec.kind, node: spec.node };
    }
    return {
      ...state,
      openTabs: [...state.openTabs, tab],
      activeTabId: id,
    };
  }),

  focusTab: (id) => set((state) => {
    if (!state.openTabs.find((t) => t.id === id)) return state;
    return state.activeTabId === id ? state : { ...state, activeTabId: id };
  }),

  closeTab: (id) => set((state) => {
    const idx = state.openTabs.findIndex((t) => t.id === id);
    if (idx < 0) return state;
    const next = state.openTabs.filter((t) => t.id !== id);
    let nextActive = state.activeTabId;
    if (state.activeTabId === id) {
      // 오른쪽 우선, 없으면 왼쪽. 모두 닫혔으면 null.
      const neighbor = state.openTabs[idx + 1] ?? state.openTabs[idx - 1] ?? null;
      nextActive = neighbor ? neighbor.id : null;
    }
    // 탭 닫히면 그 탭의 split payload 도 정리.
    const splits = { ...state.tabSplits };
    delete splits[id];
    return { ...state, openTabs: next, activeTabId: nextActive, tabSplits: splits };
  }),

  tabSplits: {},

  openSplit: (tabId, title, text) => set((state) => ({
    ...state,
    tabSplits: { ...state.tabSplits, [tabId]: { title, text, trigger: Date.now() } },
  })),

  closeSplit: (tabId) => set((state) => {
    if (!state.tabSplits[tabId]) return state;
    const splits = { ...state.tabSplits };
    delete splits[tabId];
    return { ...state, tabSplits: splits };
  }),
}));
