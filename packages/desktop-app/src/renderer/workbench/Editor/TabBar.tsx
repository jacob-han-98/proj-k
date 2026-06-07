import { useEffect, useMemo, useState } from 'react';
import type { DocTab, DocTabKind } from '../types';
import { getDisplayedTabs, docKeyOfNode } from '../types';
import { useWorkbenchStore } from '../store';

// VS Code 스타일 탭바 — editor 영역 상단 35px.
// 활성 탭은 editor 배경과 같은 색 + 상단 2px accent. 닫기 X 는 hover 시 등장.
//
// 2026-05-12 PD 피드백 1b: Chrome 스타일 고정 탭. 우클릭 → "고정/고정 해제" 메뉴.
// 고정 탭은 좌측 정렬 + accent left-border 하이라이트 + close X 숨김 (middle-click 또는
// 메뉴로만 닫음 — 실수 방지). 사용자는 "리뷰 중인 문서" 를 고정해 두면 컨텍스트 스위칭
// 후에도 명확히 알 수 있음.
//
// 2026-05-13: 고정 탭 색을 모드별로 분리 — 리뷰 = 파랑, 편집 = 주황. data-pin-mode 부여
// 해서 CSS variant 적용. Confluence/Excel 아이콘에 브랜드색 (Atlassian / Office).
// 탭 너비 180px 로 고정 — 사용자가 PD 피드백으로 요청한 일관된 가로폭.

function iconFor(kind: DocTabKind): { icon: string; brand?: 'confluence' | 'excel' } {
  // codicons. confluence = book, excel = table, qna-thread = comment-discussion, agent-web = sparkle.
  if (kind === 'confluence') return { icon: 'book', brand: 'confluence' };
  if (kind === 'excel') return { icon: 'table', brand: 'excel' };
  if (kind === 'agent-web') return { icon: 'sparkle' };
  return { icon: 'comment-discussion' };
}

function titleOf(tab: DocTab): string {
  if (tab.kind === 'qna-thread') return tab.title;
  if (tab.kind === 'agent-web') return 'Agent';
  return tab.node.title;
}

interface MenuState {
  tabId: string;
  pinned: boolean;
  x: number;
  y: number;
}

export function TabBar() {
  const openTabs = useWorkbenchStore((s) => s.openTabs);
  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const pinnedTabIds = useWorkbenchStore((s) => s.pinnedTabIds);
  const focusTab = useWorkbenchStore((s) => s.focusTab);
  const closeTab = useWorkbenchStore((s) => s.closeTab);
  const togglePinTab = useWorkbenchStore((s) => s.togglePinTab);
  // 2026-05-13: 모드별 pin 색 분리 — 리뷰 모드(tabSplits[id].mode='review') 와 편집 모드
  // (editingDocs[docKeyOfNode(tab.node)]) 둘 다 추적. 둘 중 하나라도 켜져 있고 pinned 면
  // 해당 색 입힘. 둘 다 켜진 드문 케이스는 편집 우선 (사용자의 현재 행동에 가까움).
  const tabSplits = useWorkbenchStore((s) => s.tabSplits);
  const editingDocs = useWorkbenchStore((s) => s.editingDocs);

  const [menu, setMenu] = useState<MenuState | null>(null);

  // 메뉴 외부 클릭/ESC 로 닫기.
  useEffect(() => {
    if (!menu) return;
    const onDocClick = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const displayed = useMemo(
    () => getDisplayedTabs(openTabs, pinnedTabIds),
    [openTabs, pinnedTabIds],
  );

  if (openTabs.length === 0) return null;

  const pinnedSet = new Set(pinnedTabIds);

  return (
    <div className="tab-bar" data-testid="tab-bar" role="tablist">
      {displayed.map((tab: DocTab) => {
        const isActive = tab.id === activeTabId;
        const isPinned = pinnedSet.has(tab.id);
        const title = titleOf(tab);
        const ic = iconFor(tab.kind);
        // 2026-05-13: pin mode 결정 — 편집이 리뷰보다 우선 (사용자의 현재 행동에 가까운 신호).
        let pinMode: 'edit' | 'review' | null = null;
        if (isPinned) {
          if (tab.kind === 'confluence' || tab.kind === 'excel') {
            const dk = docKeyOfNode(tab.node);
            if (dk && editingDocs[dk]) pinMode = 'edit';
          }
          if (!pinMode && tabSplits[tab.id]?.mode === 'review') pinMode = 'review';
        }
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`tab${isActive ? ' active' : ''}${isPinned ? ' pinned' : ''}`}
            data-testid={`tab-${tab.id}`}
            data-pinned={isPinned ? 'true' : 'false'}
            data-pin-mode={pinMode ?? ''}
            title={title}
            onClick={() => focusTab(tab.id)}
            // mouse-middle close — VS Code 와 동일한 단축
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: tab.id, pinned: isPinned, x: e.clientX, y: e.clientY });
            }}
          >
            {isPinned && (
              <i
                className="codicon codicon-pinned tab-pin-marker"
                aria-hidden="true"
                data-testid={`tab-pin-marker-${tab.id}`}
              />
            )}
            <i
              className={`codicon codicon-${ic.icon} tab-icon${ic.brand ? ` icon-${ic.brand}` : ''}`}
              aria-hidden="true"
            />
            <span className="tab-title">{title}</span>
            {!isPinned && (
              <button
                type="button"
                className="tab-close"
                data-testid={`tab-close-${tab.id}`}
                aria-label="탭 닫기"
                title="탭 닫기"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      {menu && (
        <div
          className="tab-context-menu"
          role="menu"
          data-testid="tab-context-menu"
          style={{ left: menu.x, top: menu.y }}
          // 메뉴 내부 mousedown 으로 인한 자체 닫힘 방지.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="tab-context-menu-item"
            data-testid="tab-context-menu-toggle-pin"
            onClick={() => {
              togglePinTab(menu.tabId);
              setMenu(null);
            }}
          >
            <i
              className={`codicon codicon-${menu.pinned ? 'pinned-dirty' : 'pin'} tab-context-menu-icon`}
              aria-hidden="true"
            />
            {menu.pinned ? '고정 해제' : '고정'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="tab-context-menu-item"
            data-testid="tab-context-menu-close"
            onClick={() => {
              closeTab(menu.tabId);
              setMenu(null);
            }}
          >
            <i className="codicon codicon-close tab-context-menu-icon" aria-hidden="true" />
            탭 닫기
          </button>
        </div>
      )}
    </div>
  );
}
