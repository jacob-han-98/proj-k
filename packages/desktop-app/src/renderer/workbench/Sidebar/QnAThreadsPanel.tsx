import type { ThreadSummary } from '../../../shared/types';
import { ThreadList } from '../../panels/ThreadList';

// PR3: QnA 스레드 사이드바 — 기존 ThreadList 를 패널로 wrap.
// max-height:40% 였던 ThreadList 를 풀 영역으로 늘리는 건 styles.css 의
// `.sidebar-pane .thread-list` override 로 처리.

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenInEditor?: (thread: ThreadSummary) => void;
  refreshKey?: number;
}

export function QnAThreadsPanel({ selectedId, onSelect, onOpenInEditor, refreshKey }: Props) {
  return (
    <div className="qna-threads-panel" data-testid="qna-threads-panel">
      <ThreadList
        selectedId={selectedId}
        onSelect={onSelect}
        onOpenInEditor={onOpenInEditor}
        refreshKey={refreshKey}
      />
    </div>
  );
}
