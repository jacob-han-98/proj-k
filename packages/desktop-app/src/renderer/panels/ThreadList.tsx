// 좌측 사이드바 위쪽의 스레드 list. Phase 3.3.
// 한 thread = (Q&A + 누적 doc + Confluence 편집 ←Phase 4) 의 워크스페이스.

import { useEffect, useState } from 'react';
import type { ThreadSummary } from '../../shared/types';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  refreshKey?: number; // App 이 increment 하면 list 다시 fetch.
  // PR3: editor 영역에 그 스레드를 탭으로 open 할 때 호출. onSelect 와 함께 발동.
  // 옵셔널이라 미설정 환경(테스트 등)에선 기존 동작 그대로.
  onOpenInEditor?: (thread: ThreadSummary) => void;
}

function relativeTime(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return '방금';
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}분 전`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}시간 전`;
  return `${Math.floor(dt / 86_400_000)}일 전`;
}

function genId(): string {
  // 사용자 PC 별 충돌 위험 거의 없음. crypto.randomUUID 가 secure context 필요 — file://
  // 환경에서 사용 가능 여부 보고 fallback.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ThreadList({ selectedId, onSelect, refreshKey, onOpenInEditor }: Props) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await window.projk.threads.list();
      setThreads(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setThreads([]);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refreshKey]);

  const onCreate = async () => {
    try {
      const t = await window.projk.threads.create({ id: genId(), title: '새 스레드' });
      await refresh();
      onSelect(t.id);
      // PR5: 새 thread 만들면 자동으로 editor 탭도 open. 기존엔 우측 ChatPanel 이 즉시 활성됐지만
      // 이제 editor 탭 안의 QnATab 이 실제 채팅 UI 라 탭을 안 열면 사용자가 어디서 입력해야 할지 모름.
      onOpenInEditor?.(t);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="thread-list" data-testid="thread-list">
      <div className="section-header">
        <span>스레드</span>
        <button
          className="thread-new-btn"
          onClick={onCreate}
          data-testid="thread-new"
          aria-label="새 스레드 추가"
        >
          + 새
        </button>
      </div>
      {error && (
        <div className="thread-error" data-testid="thread-error">
          DB 미준비 — {error}
        </div>
      )}
      {threads && threads.length === 0 && !error && (
        <div className="thread-empty" data-testid="thread-empty">
          스레드 없음. <strong>+ 새</strong> 클릭.
        </div>
      )}
      {threads &&
        threads.map((t) => (
          <button
            key={t.id}
            className={`thread-row${selectedId === t.id ? ' active' : ''}`}
            onClick={() => {
              onSelect(t.id);
              onOpenInEditor?.(t);
            }}
            data-testid={`thread-row-${t.id}`}
          >
            <div className="thread-row-title">{t.title || '(제목 없음)'}</div>
            <div className="thread-row-meta">{relativeTime(t.updated_at)}</div>
          </button>
        ))}
    </div>
  );
}
