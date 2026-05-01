import type { SidebarKind } from './types';
import { useWorkbenchStore } from './store';

// VS Code Activity Bar — 좌측 첫 컬럼 (48px).
// 아이콘 4개를 클릭하면 sidebar 컨텐츠가 바뀐다 (PR3에서 SidebarHost 도입).
// PR1 시점: store 의 activeIcon 만 변경되고 sidebar 자체는 아직 분기되지 않음 (no behavior change).

type ActivityItem = {
  kind: SidebarKind;
  // codicons 글리프 이름. 폰트 클래스 `codicon-${name}`.
  // 매핑: P4 → repo, Confluence → book, Quick Find → search, QnA → comment-discussion.
  icon: string;
  title: string;
};

const ITEMS: ActivityItem[] = [
  { kind: 'p4', icon: 'repo', title: 'Perforce' },
  { kind: 'confluence', icon: 'book', title: 'Confluence' },
  { kind: 'find', icon: 'search', title: '빠른 검색' },
  { kind: 'qna', icon: 'comment-discussion', title: 'QnA' },
];

export function ActivityBar() {
  const activeIcon = useWorkbenchStore((s) => s.activeIcon);
  const setActiveIcon = useWorkbenchStore((s) => s.setActiveIcon);

  return (
    <nav className="activity-bar" data-testid="activity-bar" aria-label="Activity Bar">
      {ITEMS.map((item) => {
        const isActive = activeIcon === item.kind;
        return (
          <button
            key={item.kind}
            type="button"
            className={`activity-bar-item${isActive ? ' active' : ''}`}
            data-testid={`activity-${item.kind}`}
            title={item.title}
            aria-label={item.title}
            aria-pressed={isActive}
            onClick={() => setActiveIcon(item.kind)}
          >
            <i className={`codicon codicon-${item.icon}`} aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}
