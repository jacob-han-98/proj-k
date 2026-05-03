import { useEffect, useState } from 'react';
import type { TreeNode, ThreadSummary } from '../../../shared/types';
import {
  listRecentDocs,
  removeRecentDoc,
  clearRecentDocs,
  relativeVisitTime,
  touchRecentDoc,
  type RecentDocEntry,
} from '../../recent-docs';

// A4: 최근 작업 문서 패널 — 활동바 5번. localStorage history 기반.
// 클릭 → 같은 OpenTabSpec 으로 reopen. ✕ 클릭 → 항목만 제거.

interface Props {
  onOpenSheet: (node: TreeNode) => void;
  onOpenConfluencePage: (node: TreeNode) => void;
  onOpenThreadInEditor: (thread: ThreadSummary) => void;
}

export function RecentDocsPanel({
  onOpenSheet,
  onOpenConfluencePage,
  onOpenThreadInEditor,
}: Props) {
  const [entries, setEntries] = useState<RecentDocEntry[]>(() => listRecentDocs());

  // 다른 곳에서 touchRecentDoc 이 dispatch 한 'klaud:recents-changed' 이벤트로 갱신.
  useEffect(() => {
    const refresh = () => setEntries(listRecentDocs());
    window.addEventListener('klaud:recents-changed', refresh);
    // 다른 탭/창의 localStorage 갱신도 반영 (드물지만 multi-window 시나리오).
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('klaud:recents-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const onClick = (entry: RecentDocEntry) => {
    // 같은 탭이 이미 active 면 App.tsx 의 useEffect 가 store.openTab 호출을 skip 한다
    // (선택 동일 dedupe). 그 경우 store 의 touchRecentDocFromSpec 도 안 호출됨 → openCount
    // 안 증가. recent 패널의 클릭은 명시적 재방문 의도이므로 여기서 직접 touch 한다.
    touchRecentDoc({
      kind: entry.kind,
      id: entry.id,
      title: entry.title,
      subtitle: entry.subtitle,
      payload: entry.payload,
    });
    if (entry.kind === 'excel') {
      onOpenSheet(entry.payload as unknown as TreeNode);
    } else if (entry.kind === 'confluence') {
      onOpenConfluencePage(entry.payload as unknown as TreeNode);
    } else {
      // qna-thread payload: { threadId, title } — ThreadSummary 형태에 맞춰 minimal stub.
      const p = entry.payload as { threadId?: string; title?: string };
      const stub: ThreadSummary = {
        id: p.threadId ?? entry.id.replace(/^qna:/, ''),
        title: entry.title,
        created_at: 0,
        updated_at: entry.lastVisitedAt,
        archived: 0,
      };
      onOpenThreadInEditor(stub);
    }
  };

  const onRemove = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeRecentDoc(id);
  };

  const onClearAll = () => {
    if (entries.length === 0) return;
    if (confirm('최근 작업 기록을 모두 지울까요?')) {
      clearRecentDocs();
    }
  };

  return (
    <div className="recent-docs-panel" data-testid="recent-docs-panel">
      <div className="recent-docs-toolbar">
        <span className="recent-docs-count">{entries.length}건</span>
        {entries.length > 0 && (
          <button
            type="button"
            className="recent-docs-clear"
            onClick={onClearAll}
            title="기록 모두 지우기"
            data-testid="recent-docs-clear"
          >지우기</button>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="recent-docs-empty" data-testid="recent-docs-empty">
          아직 연 문서가 없어요. 다른 패널에서 문서를 열면 이곳에 누적됩니다.
        </div>
      ) : (
        <ul className="recent-docs-list">
          {entries.map((entry) => (
            <li key={entry.id} className={`recent-doc-row ${entry.kind}`}>
              <button
                type="button"
                className="recent-doc-main"
                onClick={() => onClick(entry)}
                title={entry.subtitle ?? entry.title}
                data-testid={`recent-doc-${entry.id}`}
              >
                <span className="recent-doc-icon" aria-hidden="true">
                  {entry.kind === 'excel' ? '📄' : entry.kind === 'confluence' ? '📘' : '💬'}
                </span>
                <span className="recent-doc-body">
                  <span className="recent-doc-title">{entry.title}</span>
                  {entry.subtitle && <span className="recent-doc-subtitle">{entry.subtitle}</span>}
                  <span className="recent-doc-meta">
                    {relativeVisitTime(entry.lastVisitedAt)}
                    {entry.openCount > 1 && <span> · {entry.openCount}회</span>}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="recent-doc-remove"
                onClick={(e) => onRemove(e, entry.id)}
                title="이 항목만 제거"
                aria-label="제거"
                data-testid={`recent-doc-remove-${entry.id}`}
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
