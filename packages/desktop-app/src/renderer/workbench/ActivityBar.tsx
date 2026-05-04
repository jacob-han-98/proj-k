import { useEffect, type ReactNode } from 'react';
import type { SidebarKind } from './types';
import { useWorkbenchStore } from './store';

// VS Code Activity Bar — 좌측 첫 컬럼 (48px). 클릭하면 sidebar 컨텐츠가 swap.
// 아이콘은 monochrome — `currentColor` 로 색을 받아 active/inactive 상태에 맞게 변환.
//
// P4 / Confluence 는 codicons 에 브랜드 마크가 없어서 inline SVG 로 직접 그림:
//   - Perforce: 굵은 "P4" 글리프 (Perforce CLI 의 universal 식별자, 실 사용자 100% 인지).
//   - Confluence: Atlassian 공식 2-chevron 마크 (https://atlassian.design — public brand asset).
// 둘 다 24×24 viewBox 로 codicons 24px font-size 와 시각적 무게 일치.

// brand 아이콘은 CommandPalette / EditorHost 등 다른 곳도 같은 시각 언어로 사용 → export.
export function PerforceIcon({ size = 24 }: { size?: number } = {}) {
  // Bold "P4" — Perforce 의 universal 텍스트 마크. 실제 P4V 도 동일한 letterform 사용.
  // SVG <text> 로 렌더 — 시스템 폰트 기반이라 어떤 환경에서도 깔끔.
  return (
    <svg
      width={size}
      height={size}
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

export function ConfluenceIcon({ size = 24 }: { size?: number } = {}) {
  // 두 개의 opposing curve — Atlassian Confluence brand mark.
  // 24×24 grid, fill currentColor 로 monochrome 처리.
  return (
    <svg
      width={size}
      height={size}
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
  // Ctrl/Cmd + 이 키로 패널 활성화. order = ITEMS 인덱스+1.
  shortcutDigit: '1' | '2' | '3' | '4' | '5';
}

const ITEMS: ActivityItem[] = [
  { kind: 'p4', icon: { type: 'svg', render: () => <PerforceIcon /> }, title: 'Perforce', shortcutDigit: '1' },
  { kind: 'confluence', icon: { type: 'svg', render: () => <ConfluenceIcon /> }, title: 'Confluence', shortcutDigit: '2' },
  { kind: 'find', icon: { type: 'codicon', name: 'search' }, title: '빠른 검색', shortcutDigit: '3' },
  { kind: 'qna', icon: { type: 'codicon', name: 'comment-discussion' }, title: 'QnA', shortcutDigit: '4' },
  { kind: 'recent', icon: { type: 'codicon', name: 'history' }, title: '최근 작업 문서', shortcutDigit: '5' },
];

// Ctrl/Cmd+숫자 → 해당 activity 패널로 전환. VS Code 의 Ctrl+Shift+E/F 등가물 — 4 개라
// 그냥 숫자 키. input/textarea/contenteditable 에 focus 있을 땐 단축키 무시 — 사용자가
// 텍스트 입력 중 충돌 회피.
function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function ActivityBar() {
  const activeIcon = useWorkbenchStore((s) => s.activeIcon);
  const setActiveIcon = useWorkbenchStore((s) => s.setActiveIcon);

  // Ctrl/Cmd+1~4 단축키 — window 레벨 keydown listener.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ctrl 또는 cmd 만 — shift/alt 함께면 충돌 가능 (VS Code 의 Ctrl+Shift+P 등) → 무시.
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (shouldIgnoreShortcut(e.target)) return;
      const item = ITEMS.find((it) => it.shortcutDigit === e.key);
      if (!item) return;
      e.preventDefault();
      setActiveIcon(item.kind);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveIcon]);

  return (
    <nav className="activity-bar" data-testid="activity-bar" aria-label="Activity Bar">
      {ITEMS.map((item) => {
        const isActive = activeIcon === item.kind;
        const shortcutLabel = `Ctrl+${item.shortcutDigit}`;
        return (
          <button
            key={item.kind}
            type="button"
            className={`activity-bar-item${isActive ? ' active' : ''}`}
            data-testid={`activity-${item.kind}`}
            title={`${item.title} (${shortcutLabel})`}
            aria-label={`${item.title} (${shortcutLabel})`}
            aria-keyshortcuts={`Control+${item.shortcutDigit}`}
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
