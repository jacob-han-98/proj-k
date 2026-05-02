import type { ReactNode } from 'react';
import type { SidebarKind } from './types';
import { useWorkbenchStore } from './store';

// VS Code Activity Bar — 좌측 첫 컬럼 (48px). 클릭하면 sidebar 컨텐츠가 swap.
// 아이콘은 monochrome — `currentColor` 로 색을 받아 active/inactive 상태에 맞게 변환.
//
// P4 / Confluence 는 codicons 에 브랜드 마크가 없어서 inline SVG 로 직접 그림:
//   - Perforce: 굵은 "P4" 글리프 (Perforce CLI 의 universal 식별자, 실 사용자 100% 인지).
//   - Confluence: Atlassian 공식 2-chevron 마크 (https://atlassian.design — public brand asset).
// 둘 다 24×24 viewBox 로 codicons 24px font-size 와 시각적 무게 일치.

function PerforceIcon() {
  // Bold "P4" — Perforce 의 universal 텍스트 마크. 실제 P4V 도 동일한 letterform 사용.
  // SVG <text> 로 렌더 — 시스템 폰트 기반이라 어떤 환경에서도 깔끔.
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <text
        x="12"
        y="17.5"
        textAnchor="middle"
        fill="currentColor"
        fontSize="14"
        fontWeight={900}
        fontFamily="'Segoe UI', system-ui, sans-serif"
        letterSpacing="-0.6"
      >
        P4
      </text>
    </svg>
  );
}

function ConfluenceIcon() {
  // 두 개의 opposing curve — Atlassian Confluence brand mark.
  // 24×24 grid, fill currentColor 로 monochrome 처리.
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path d="M2.55 17.16c-.18.3-.39.65-.57.93-.16.27-.07.62.2.79l3.7 2.27c.27.17.63.07.79-.2.16-.27.36-.6.55-.92 1.32-2.18 2.66-1.92 5.06-.78l3.66 1.74c.31.15.69-.02.84-.34l1.76-3.99c.13-.3-.01-.65-.32-.79-.77-.36-2.31-1.09-3.7-1.75-4.99-2.42-9.23-2.27-11.97 3.04z" />
      <path d="M21.45 6.84c.18-.3.39-.65.57-.93.16-.27.07-.62-.2-.79l-3.7-2.27c-.27-.17-.63-.07-.79.2-.16.27-.36.6-.55.92-1.32 2.18-2.66 1.92-5.06.78L8.06 2.96c-.31-.15-.69.02-.84.34L5.46 7.29c-.13.3.01.65.32.79.77.36 2.31 1.09 3.7 1.75 4.99 2.42 9.23 2.27 11.97-3z" />
    </svg>
  );
}

type ActivityIconSpec =
  | { type: 'codicon'; name: string }
  | { type: 'svg'; render: () => ReactNode };

interface ActivityItem {
  kind: SidebarKind;
  icon: ActivityIconSpec;
  title: string;
}

const ITEMS: ActivityItem[] = [
  { kind: 'p4', icon: { type: 'svg', render: () => <PerforceIcon /> }, title: 'Perforce' },
  { kind: 'confluence', icon: { type: 'svg', render: () => <ConfluenceIcon /> }, title: 'Confluence' },
  { kind: 'find', icon: { type: 'codicon', name: 'search' }, title: '빠른 검색' },
  { kind: 'qna', icon: { type: 'codicon', name: 'comment-discussion' }, title: 'QnA' },
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
            {item.icon.type === 'codicon' ? (
              <i className={`codicon codicon-${item.icon.name}`} aria-hidden="true" />
            ) : (
              item.icon.render()
            )}
          </button>
        );
      })}
    </nav>
  );
}
