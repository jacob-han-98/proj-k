import type { DocTab, DocTabKind } from '../types';
import { useWorkbenchStore } from '../store';

// VS Code 스타일 탭바 — editor 영역 상단 35px.
// 활성 탭은 editor 배경과 같은 색 + 상단 2px accent. 닫기 X 는 hover 시 등장.

function iconFor(kind: DocTabKind): string {
  // codicons. confluence = book, excel = table, qna-thread = comment-discussion.
  if (kind === 'confluence') return 'book';
  if (kind === 'excel') return 'table';
  return 'comment-discussion';
}

function titleOf(tab: DocTab): string {
  return tab.kind === 'qna-thread' ? tab.title : tab.node.title;
}

export function TabBar() {
  const openTabs = useWorkbenchStore((s) => s.openTabs);
  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const focusTab = useWorkbenchStore((s) => s.focusTab);
  const closeTab = useWorkbenchStore((s) => s.closeTab);

  if (openTabs.length === 0) return null;

  return (
    <div className="tab-bar" data-testid="tab-bar" role="tablist">
      {openTabs.map((tab: DocTab) => {
        const isActive = tab.id === activeTabId;
        const title = titleOf(tab);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`tab${isActive ? ' active' : ''}`}
            data-testid={`tab-${tab.id}`}
            title={title}
            onClick={() => focusTab(tab.id)}
            // mouse-middle close — VS Code 와 동일한 단축
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(tab.id);
            }}
          >
            <i className={`codicon codicon-${iconFor(tab.kind)} tab-icon`} aria-hidden="true" />
            <span className="tab-title">{title}</span>
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
          </div>
        );
      })}
    </div>
  );
}
