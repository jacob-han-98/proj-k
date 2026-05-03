import type { TreeNode, ThreadSummary } from '../../../shared/types';
import { useWorkbenchStore } from '../store';
import { P4Panel } from './P4Panel';
import { ConfluencePanel } from './ConfluencePanel';
import { QuickFindPanel } from './QuickFindPanel';
import { QnAThreadsPanel } from './QnAThreadsPanel';
import { RecentDocsPanel } from './RecentDocsPanel';

// PR3: Activity Bar 의 activeIcon 에 따라 4 개 사이드바 패널을 swap.
// 핵심: 모든 패널을 동시 mount + display:none 토글 — fetch 중복 / 트리 expanded state /
// ThreadList 캐시 등을 보존. EditorHost 와 같은 패턴.

interface Props {
  // P4 / Confluence 트리에서 클릭한 노드의 id (selection.node.id) — 트리 active highlight 용.
  selectedTreeId: string | null;
  onOpenSheet: (node: TreeNode) => void;
  onOpenConfluencePage: (node: TreeNode) => void;
  // QnA threads
  selectedThreadId: string | null;
  onSelectThread: (id: string | null) => void;
  onOpenThreadInEditor: (thread: ThreadSummary) => void;
  threadsRefreshKey: number;
}

export function SidebarHost(props: Props) {
  const activeIcon = useWorkbenchStore((s) => s.activeIcon);

  return (
    <div className="sidebar-host" data-testid="sidebar-host">
      <SectionHeader activeIcon={activeIcon} />
      <div
        className={`sidebar-pane${activeIcon === 'p4' ? '' : ' hidden'}`}
        data-testid="sidebar-pane-p4"
        aria-hidden={activeIcon !== 'p4'}
      >
        <P4Panel selectedId={props.selectedTreeId} onOpenSheet={props.onOpenSheet} />
      </div>
      <div
        className={`sidebar-pane${activeIcon === 'confluence' ? '' : ' hidden'}`}
        data-testid="sidebar-pane-confluence"
        aria-hidden={activeIcon !== 'confluence'}
      >
        <ConfluencePanel
          selectedId={props.selectedTreeId}
          onOpenConfluencePage={props.onOpenConfluencePage}
        />
      </div>
      <div
        className={`sidebar-pane${activeIcon === 'find' ? '' : ' hidden'}`}
        data-testid="sidebar-pane-find"
        aria-hidden={activeIcon !== 'find'}
      >
        <QuickFindPanel />
      </div>
      <div
        className={`sidebar-pane${activeIcon === 'qna' ? '' : ' hidden'}`}
        data-testid="sidebar-pane-qna"
        aria-hidden={activeIcon !== 'qna'}
      >
        <QnAThreadsPanel
          selectedId={props.selectedThreadId}
          onSelect={props.onSelectThread}
          onOpenInEditor={props.onOpenThreadInEditor}
          refreshKey={props.threadsRefreshKey}
        />
      </div>
      <div
        className={`sidebar-pane${activeIcon === 'recent' ? '' : ' hidden'}`}
        data-testid="sidebar-pane-recent"
        aria-hidden={activeIcon !== 'recent'}
      >
        <RecentDocsPanel
          onOpenSheet={props.onOpenSheet}
          onOpenConfluencePage={props.onOpenConfluencePage}
          onOpenThreadInEditor={props.onOpenThreadInEditor}
        />
      </div>
    </div>
  );
}

function SectionHeader({ activeIcon }: { activeIcon: 'p4' | 'confluence' | 'find' | 'qna' | 'recent' }) {
  const label =
    activeIcon === 'p4'
      ? 'PERFORCE'
      : activeIcon === 'confluence'
      ? 'CONFLUENCE'
      : activeIcon === 'find'
      ? '빠른 검색'
      : activeIcon === 'qna'
      ? 'QnA 스레드'
      : '최근 작업 문서';
  return (
    <div className="sidebar-section-header" data-testid={`sidebar-section-header-${activeIcon}`}>
      {label}
    </div>
  );
}
