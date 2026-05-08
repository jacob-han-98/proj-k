import { create } from 'zustand';
import type { DocTab, OpenTabSpec, SidebarKind } from './types';
import { tabIdOf, docKeyOfNode } from './types';
import type { ReviewOptions } from '../panels/review-options-mapping';
import type { QnAAttachment } from '../qna/attachments';

// 마지막으로 선택했던 액티비티바 아이콘을 localStorage 에 영속.
// App.tsx 의 sidebar width 와 같은 패턴 — 인스톨/계정 무관, 부팅 직후 즉시 복원.
// export 는 vitest 단위 테스트용 (jsdom 환경 없이도 mock localStorage 로 분기 검증 가능).
export const ACTIVE_ICON_STORAGE_KEY = 'klaud.activeIcon';
const VALID_ICONS: ReadonlySet<SidebarKind> = new Set(['p4', 'confluence', 'find', 'qna', 'active']);

export function loadActiveIcon(): SidebarKind {
  if (typeof localStorage === 'undefined') return 'confluence';
  try {
    const raw = localStorage.getItem(ACTIVE_ICON_STORAGE_KEY);
    if (raw && VALID_ICONS.has(raw as SidebarKind)) return raw as SidebarKind;
  } catch {
    /* localStorage 접근 실패 — 기본값 사용 */
  }
  return 'confluence';
}

export function saveActiveIcon(kind: SidebarKind): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ACTIVE_ICON_STORAGE_KEY, kind);
  } catch {
    /* quota 초과 등 — silently 무시 */
  }
}

// PR1: activeIcon (Activity Bar 토글).
// PR2: openTabs / activeTabId / openTab / focusTab / closeTab.
// PR3+: 사이드바 토글 routing, qna-thread 탭, split state.

// PR4: 탭별 review split. tabId → 그 탭이 split 켜졌을 때 DocAssistantPane 에 넘길 payload.
// trigger 는 같은 페이지를 다시 요청해도 useEffect 가 재발동되도록 dedupe key.
//
// P0: 단일 "리뷰" → 3-mode 어시스턴트로 확장. mode='pick' 은 사용자가 모드 칩을
// 아직 안 골랐다는 빈 상태 (수동 시작) — DocAssistantPane 이 ModePickerEmpty 노출.
// 'summary' / 'review' / 'agent' 는 각 모드 컴포넌트로 라우팅.
export type SplitMode = 'pick' | 'summary' | 'review' | 'agent';
export interface SplitPayload {
  title: string;
  text: string;
  trigger: number;
  mode: SplitMode;
  // P2: review 모드의 옵션 패널 — 사용자가 "리뷰 시작" 누르기 전엔 undefined.
  // 채워지는 시점에 trigger 가 갱신돼 ReviewSplitPane 의 reviewStream 이 시작.
  reviewOptions?: ReviewOptions;
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

  // PR4: editor 영역의 우측 split (어시스턴트). 탭별 isolated.
  tabSplits: Record<string, SplitPayload | undefined>;
  // mode 미지정 = 'pick' (수동 시작 빈 상태). 기존 호출자는 mode 인자 생략 가능.
  // P2: reviewOptions 까지 명시되면 review 모드의 옵션 panel 도 skip — Excel sheet
  // 의 즉시 review 시작 흐름이 이 형태.
  openSplit: (
    tabId: string,
    title: string,
    text: string,
    mode?: SplitMode,
    reviewOptions?: ReviewOptions,
  ) => void;
  // 모드 칩 클릭 / 빈 상태에서 모드 선택. trigger 갱신해 effect 재발동.
  setSplitMode: (tabId: string, mode: SplitMode) => void;
  // P2: 리뷰 옵션 패널의 "리뷰 시작" 버튼이 호출. 옵션 채워지면서 trigger 도 갱신 →
  // DocAssistantPane 의 review 분기가 ReviewOptionsPanel → ReviewSplitPane 으로 swap +
  // ReviewSplitPane 의 trigger-deps useEffect 가 reviewStream 시작.
  setReviewOptions: (tabId: string, options: ReviewOptions) => void;
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

  // Phase A1: QnA 액티비티의 컨텍스트 첨부 (체부 모델). thread 단위로 격리 — 한 thread 의
  // 첨부가 다른 thread 에 새지 않도록. lifecycle 은 renderer/qna/attachments.ts 헤더 참조.
  // Phase A2/A3 에서 진입점 (에디터 헤더 / 리뷰 항목 옆 아이콘) 가 attachToQnA 를 호출.
  // QnATab 이 mount 시 자기 threadId 의 pending 을 읽어 칩 표시 + 첫 메시지 prepend.
  // closeTab(qna-thread) 시 같이 정리 — leak 방지.
  qnaPendingAttachments: Record<string, QnAAttachment[]>;
  attachToQnA: (threadId: string, att: QnAAttachment) => void;
  detachFromQnA: (threadId: string, attId: string) => void;
  clearPendingAttachments: (threadId: string) => void;

  // Phase A2: 진입점 2/3 가 setActiveIcon 으로 자동 전환할 때 사용자가 "어디로 갔지?"
  // 헤매지 않게 해당 아이콘에 0.6s pulse. timestamp 를 두고 ActivityBar 가 그 값 변화를
  // 감지해 className 적용 → CSS keyframes 로 펄스 → 자동 종료. timestamp 마다 다른 값이라
  // 같은 아이콘으로 연달아 dispatch 해도 매번 새로 발동 (값이 같으면 React 가 변화 X 로 간주).
  activityIconPulse: { kind: SidebarKind; ts: number } | null;
  pulseActivityIcon: (kind: SidebarKind) => void;
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  // 마지막으로 선택했던 아이콘 복원. 처음 부팅이면 Confluence.
  activeIcon: loadActiveIcon(),
  setActiveIcon: (kind) => {
    saveActiveIcon(kind);
    set({ activeIcon: kind });
  },

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
    } else if (spec.kind === 'agent-web') {
      tab = { id, kind: 'agent-web' };
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
    // qna-thread 탭이 닫히면 그 thread 의 미발송 첨부도 같이 정리. 다음에 같은 thread 가
    // 재오픈 (사이드바 ThreadList row 클릭) 되어도 사용자가 의식하지 않은 옛 첨부가
    // 부활하지 않게 — leak 방지 + UX 단순.
    let qnaPendingAttachments = state.qnaPendingAttachments;
    if (closing && closing.kind === 'qna-thread' && qnaPendingAttachments[closing.threadId]) {
      const a = { ...qnaPendingAttachments };
      delete a[closing.threadId];
      qnaPendingAttachments = a;
    }
    return {
      ...state,
      openTabs: next,
      activeTabId: nextActive,
      tabSplits: splits,
      editingDocs,
      qnaPendingAttachments,
    };
  }),

  tabSplits: {},

  openSplit: (tabId, title, text, mode = 'pick', reviewOptions) => set((state) => ({
    ...state,
    tabSplits: {
      ...state.tabSplits,
      [tabId]: { title, text, trigger: Date.now(), mode, reviewOptions },
    },
  })),

  setSplitMode: (tabId, mode) => set((state) => {
    const cur = state.tabSplits[tabId];
    if (!cur) return state;
    if (cur.mode === mode) return state;
    // 모드 전환 시 reviewOptions 도 reset — 사용자가 리뷰 → 다른 모드 → 리뷰 다시 가면
    // 옵션 패널 새로 보이는 게 자연스러움.
    return {
      ...state,
      tabSplits: {
        ...state.tabSplits,
        [tabId]: { ...cur, mode, trigger: Date.now(), reviewOptions: undefined },
      },
    };
  }),

  setReviewOptions: (tabId, options) => set((state) => {
    const cur = state.tabSplits[tabId];
    if (!cur) return state;
    return {
      ...state,
      tabSplits: {
        ...state.tabSplits,
        [tabId]: { ...cur, reviewOptions: options, trigger: Date.now() },
      },
    };
  }),

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

  qnaPendingAttachments: {},
  attachToQnA: (threadId, att) => set((state) => {
    const cur = state.qnaPendingAttachments[threadId] ?? [];
    // 같은 id 중복 push 는 무시 — idempotent. 진입점이 재호출돼도 안전.
    if (cur.some((a) => a.id === att.id)) return state;
    return {
      ...state,
      qnaPendingAttachments: { ...state.qnaPendingAttachments, [threadId]: [...cur, att] },
    };
  }),
  detachFromQnA: (threadId, attId) => set((state) => {
    const cur = state.qnaPendingAttachments[threadId];
    if (!cur || cur.length === 0) return state;
    const next = cur.filter((a) => a.id !== attId);
    if (next.length === cur.length) return state;
    const map = { ...state.qnaPendingAttachments };
    if (next.length === 0) delete map[threadId];
    else map[threadId] = next;
    return { ...state, qnaPendingAttachments: map };
  }),
  clearPendingAttachments: (threadId) => set((state) => {
    if (!state.qnaPendingAttachments[threadId]) return state;
    const map = { ...state.qnaPendingAttachments };
    delete map[threadId];
    return { ...state, qnaPendingAttachments: map };
  }),

  activityIconPulse: null,
  pulseActivityIcon: (kind) => set({ activityIconPulse: { kind, ts: Date.now() } }),
}));
