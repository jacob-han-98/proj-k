// 좌측 사이드바 위쪽의 스레드 list. Phase 3.3.
// 한 thread = (Q&A + 누적 doc + Confluence 편집 ←Phase 4) 의 워크스페이스.
//
// Look & feel: agent-sdk-poc 의 web frontend "Project K QnA" 와 비슷하게 ―
// 상단에 큰 "+ 새 대화" CTA, 그 아래 "히스토리" 라벨, 행은 제목만 보여주고
// hover 시 ✎ 이름 변경 / × 삭제 액션을 노출.

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
      const t = await window.projk.threads.create({ id: genId(), title: '새 대화' });
      await refresh();
      onSelect(t.id);
      // PR5: 새 thread 만들면 자동으로 editor 탭도 open. 기존엔 우측 ChatPanel 이 즉시 활성됐지만
      // 이제 editor 탭 안의 QnATab 이 실제 채팅 UI 라 탭을 안 열면 사용자가 어디서 입력해야 할지 모름.
      onOpenInEditor?.(t);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onRename = async (e: React.MouseEvent, t: ThreadSummary) => {
    e.stopPropagation();
    const next = window.prompt('스레드 이름', t.title || '새 대화');
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === t.title) return;
    try {
      await window.projk.threads.rename({ id: t.id, title: trimmed });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onDelete = async (e: React.MouseEvent, t: ThreadSummary) => {
    e.stopPropagation();
    const ok = window.confirm(`"${t.title || '(제목 없음)'}" 스레드를 삭제할까요?`);
    if (!ok) return;
    try {
      await window.projk.threads.delete(t.id);
      if (selectedId === t.id) onSelect(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="thread-list" data-testid="thread-list">
      <button
        className="thread-new-cta"
        onClick={onCreate}
        data-testid="thread-new"
        aria-label="새 대화 추가"
      >
        <span className="thread-new-cta-plus" aria-hidden>+</span>
        <span>새 대화</span>
      </button>
      <div className="section-header">
        <span>히스토리</span>
      </div>
      {error && (
        <div className="thread-error" data-testid="thread-error">
          DB 미준비 — {error}
        </div>
      )}
      {threads && threads.length === 0 && !error && (
        <div className="thread-empty" data-testid="thread-empty">
          아직 스레드가 없어요. 위의 <strong>+ 새 대화</strong> 를 눌러 시작하세요.
        </div>
      )}
      {threads &&
        threads.map((t) => (
          <div
            key={t.id}
            className={`thread-row${selectedId === t.id ? ' active' : ''}`}
            onClick={() => {
              onSelect(t.id);
              onOpenInEditor?.(t);
            }}
            data-testid={`thread-row-${t.id}`}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(t.id);
                onOpenInEditor?.(t);
              }
            }}
            title={`${t.title || '(제목 없음)'} · ${relativeTime(t.updated_at)}`}
          >
            <div className="thread-row-title">{t.title || '(제목 없음)'}</div>
            <div className="thread-row-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="thread-row-action"
                onClick={(e) => onRename(e, t)}
                data-testid={`thread-rename-${t.id}`}
                aria-label="이름 변경"
                title="이름 변경"
              >
                <span aria-hidden>✎</span>
              </button>
              <button
                type="button"
                className="thread-row-action thread-row-action-danger"
                onClick={(e) => onDelete(e, t)}
                data-testid={`thread-delete-${t.id}`}
                aria-label="삭제"
                title="삭제"
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
