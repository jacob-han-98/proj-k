import { useEffect } from 'react';
import type { DocTab, DocTabKind } from '../types';
import { docKeyOfNode } from '../types';
import { useWorkbenchStore } from '../store';

// 2026-05-13: VS Code 스타일 Ctrl+Tab MRU 스위처 overlay.
// - 첫 Ctrl+Tab 시작 시 store.openTabSwitcher 가 호출되며 candidates / cursor 채워짐.
// - 이 컴포넌트는 store.tabSwitcher 가 non-null 일 때만 렌더 — overlay + 후보 list 표시.
// - Ctrl key release → commitTabSwitcher (focusTab 동등). Esc → cancelTabSwitcher.
// - keydown 자체 (Tab / Shift+Tab) 는 App.tsx 의 전역 핸들러에서 moveTabSwitcher 호출.
//
// 디자인: 화면 중앙 둥근 패널, 후보 list 세로 + 현재 cursor 강조. VS Code 의 "Quick Switch"
// 패널 외형과 비슷한 톤. backdrop 없이 작게 — 흐름을 빠르게 끊지 않음.

function titleOf(tab: DocTab): string {
  if (tab.kind === 'qna-thread') return tab.title;
  if (tab.kind === 'agent-web') return 'Agent';
  return tab.node.title;
}

function iconFor(kind: DocTabKind): { icon: string; brand?: string } {
  if (kind === 'confluence') return { icon: 'book', brand: 'confluence' };
  if (kind === 'excel') return { icon: 'table', brand: 'excel' };
  if (kind === 'agent-web') return { icon: 'sparkle' };
  return { icon: 'comment-discussion' };
}

// 2026-05-13: TabBar 와 동일한 mode 판정 — 편집 > 리뷰 우선순위. switcher 후보 옆에 배지
// 표시해서 사용자가 "지금 어느 게 편집중이고 어느 게 리뷰중인지" 한눈에 보고 선택.
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

export function TabSwitcher() {
  const sw = useWorkbenchStore((s) => s.tabSwitcher);
  const openTabs = useWorkbenchStore((s) => s.openTabs);
  const editingDocs = useWorkbenchStore((s) => s.editingDocs);
  const tabSplits = useWorkbenchStore((s) => s.tabSplits);
  const commit = useWorkbenchStore((s) => s.commitTabSwitcher);
  const cancel = useWorkbenchStore((s) => s.cancelTabSwitcher);

  // Ctrl release (commit) — Ctrl 키 자체는 App.tsx 가 들음. 여기선 overlay 가 열린 동안의
  // 추가 키보드 네비게이션:
  //   - Esc       → cancel
  //   - ↑ / ↓     → cursor -1 / +1 (wrap)
  //   - Home/End  → 0 / last
  //   - PgUp/PgDn → -5 / +5 (clamp)
  // capture 단계로 listen 해서 다른 핸들러보다 먼저 가로채 e.preventDefault — Tab 의 기본
  // focus 이동 / PageUp 의 페이지 스크롤 등 의도치 않은 부수효과 차단.
  useEffect(() => {
    if (!sw) return;
    const onKey = (e: KeyboardEvent) => {
      const { moveTabSwitcher, setTabSwitcherCursor } = useWorkbenchStore.getState();
      const swap = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      switch (e.key) {
        case 'Escape':
          return swap(() => cancel());
        case 'ArrowDown':
          return swap(() => moveTabSwitcher(1));
        case 'ArrowUp':
          return swap(() => moveTabSwitcher(-1));
        case 'Home':
          return swap(() => setTabSwitcherCursor(0));
        case 'End': {
          const s = useWorkbenchStore.getState().tabSwitcher;
          if (!s) return;
          return swap(() => setTabSwitcherCursor(s.candidates.length - 1));
        }
        case 'PageDown': {
          const s = useWorkbenchStore.getState().tabSwitcher;
          if (!s) return;
          return swap(() => setTabSwitcherCursor(s.cursor + 5));
        }
        case 'PageUp': {
          const s = useWorkbenchStore.getState().tabSwitcher;
          if (!s) return;
          return swap(() => setTabSwitcherCursor(s.cursor - 5));
        }
        // Enter — VS Code 의 Ctrl+Tab list 에서도 Enter 가 commit. Ctrl 안 떼고 마우스 없이
        // 확정하고 싶을 때 유용.
        case 'Enter':
          return swap(() => commit());
        default:
          // Tab / Shift+Tab / 모든 modifier 키는 App.tsx 의 핸들러에 위임 — 여기서 가로채지 않음.
          return;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [sw, cancel, commit]);

  if (!sw) return null;
  const byId = new Map(openTabs.map((t) => [t.id, t]));

  return (
    <div className="tab-switcher" data-testid="tab-switcher" role="dialog" aria-label="탭 전환">
      <div className="tab-switcher-header">
        <i className="codicon codicon-history" aria-hidden="true" />
        <span>최근 사용 탭</span>
      </div>
      <ul className="tab-switcher-list" role="listbox">
        {sw.candidates.map((id, idx) => {
          const tab = byId.get(id);
          if (!tab) return null;
          const isCursor = idx === sw.cursor;
          const ic = iconFor(tab.kind);
          const mode = pinModeOf(tab, editingDocs, tabSplits);
          return (
            <li
              key={id}
              role="option"
              aria-selected={isCursor}
              data-testid={`tab-switcher-item-${id}`}
              data-pin-mode={mode ?? ''}
              className={`tab-switcher-item${isCursor ? ' active' : ''}`}
              onClick={() => {
                useWorkbenchStore.setState({ tabSwitcher: { ...sw, cursor: idx } });
                // click 은 명시적 commit — Ctrl release 와 동등.
                commit();
              }}
            >
              <i
                className={`codicon codicon-${ic.icon} tab-switcher-icon${ic.brand ? ` icon-${ic.brand}` : ''}`}
                aria-hidden="true"
              />
              <span className="tab-switcher-title">{titleOf(tab)}</span>
              {mode && (
                <span
                  className={`tab-switcher-badge badge-${mode}`}
                  data-testid={`tab-switcher-badge-${id}`}
                >
                  {mode === 'edit' ? '편집중' : '리뷰중'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
