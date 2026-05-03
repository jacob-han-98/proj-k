import { create } from 'zustand';
import type { DocTab, OpenTabSpec, SidebarKind } from './types';
import { tabIdOf, docKeyOfNode } from './types';
import { touchRecentDoc } from '../recent-docs';

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

  // Excel 시트의 편집 모드 추적. docKey (`local:<relPath>` / `depot:<path>`) → editing.
  // 기본은 view (action=embedview, SuiteNav/리본 사라진 미니 뷰). 트리뷰의 ✏ 아이콘 클릭으로
  // editing=true 토글 → CenterPane 의 webview src 가 ?action=edit 으로 swap + reload.
  // 같은 depot 파일의 여러 revision 탭은 한 docKey 를 공유 — 사용자 멘탈모델("이 파일 편집중")
  // 에 맞춤.
  editingDocs: Record<string, boolean>;
  setDocEditing: (docKey: string, editing: boolean) => void;
  toggleDocEditing: (docKey: string) => void;

  // A2: Command Palette (VS Code Ctrl+P 등가물). open=true 면 modal overlay 표시.
  // P4 local + P4 depot + Confluence 트리 데이터 통합 fuzzy 매칭.
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  // 부팅 시 기본은 Confluence — 현재 사용자가 가장 자주 여는 영역.
  activeIcon: 'confluence',
  setActiveIcon: (kind) => set({ activeIcon: kind }),

  openTabs: [],
  activeTabId: null,

  openTab: (spec) => set((state) => {
    const id = tabIdOf(spec);
    // A4: 최근 작업 문서 history 갱신 — open 시점마다 touch (lastVisitedAt 갱신, openCount++).
    // 같은 탭을 focus 만 하는 경우도 "다시 봤다" = 작업중 신호로 카운트.
    touchRecentDocFromSpec(spec, id);
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
    const closing = state.openTabs[idx];
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
    // 같은 docKey 의 다른 탭이 남아있지 않으면 editing 상태도 함께 정리.
    // depot 파일은 revision 별로 별도 탭이지만 docKey 는 공유 → 마지막 revision 탭이 닫혀야 정리.
    let editingDocs = state.editingDocs;
    if (closing && (closing.kind === 'excel' || closing.kind === 'confluence')) {
      const closingKey = docKeyOfNode(closing.node);
      if (closingKey) {
        const stillOpen = next.some((t) => {
          if (t.kind !== 'excel' && t.kind !== 'confluence') return false;
          return docKeyOfNode(t.node) === closingKey;
        });
        if (!stillOpen && editingDocs[closingKey]) {
          const e = { ...editingDocs };
          delete e[closingKey];
          editingDocs = e;
        }
      }
    }
    return { ...state, openTabs: next, activeTabId: nextActive, tabSplits: splits, editingDocs };
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

  editingDocs: {},
  setDocEditing: (docKey, editing) => set((state) => {
    const cur = !!state.editingDocs[docKey];
    if (cur === editing) return state;
    const next = { ...state.editingDocs };
    if (editing) next[docKey] = true;
    else delete next[docKey];
    return { ...state, editingDocs: next };
  }),
  toggleDocEditing: (docKey) => set((state) => {
    const next = { ...state.editingDocs };
    if (next[docKey]) delete next[docKey];
    else next[docKey] = true;
    return { ...state, editingDocs: next };
  }),

  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
}));

// A4: OpenTabSpec → RecentDocEntry 변환. payload 는 RecentDocsPanel 이 reopen 시 그대로
// onOpenSheet/onOpenConfluencePage/onOpenThreadInEditor 에 넘기는 데 쓴다.
function touchRecentDocFromSpec(spec: OpenTabSpec, id: string): void {
  if (spec.kind === 'excel' || spec.kind === 'confluence') {
    const node = spec.node;
    touchRecentDoc({
      kind: spec.kind,
      id,
      title: node.title,
      subtitle: node.relPath ?? undefined,
      payload: { ...node },
    });
    return;
  }
  // qna-thread
  touchRecentDoc({
    kind: 'qna-thread',
    id,
    title: spec.title,
    payload: { threadId: spec.threadId, title: spec.title },
  });
}
