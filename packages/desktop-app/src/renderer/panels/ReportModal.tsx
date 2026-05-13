import { useEffect, useState } from 'react';
import { useWorkbenchStore } from '../workbench/store';
import { getLogContext } from '../klaud-log-capture';

// 2026-05-13 릴리스-A2: 제보 모달.
//
// 사용자가 TitleBar 의 🚨 버튼 누르면 등장. 메모 + 현재 컨텍스트 (active tab, mode 등) 를
// 묶어서 main 으로 보내고, main 의 klaud-log-sink.submitReport 가 backend /klaud/report 로
// POST. backend 는 (machine_id, session_id, ts) 로 직전 로그 묶음과 cross-reference 가능.
//
// PD 피드백 1b 의 자매격 기능 — "현재 무엇을 하고 있었는지" 가 화면에 동시 표시되어
// 사용자가 정확한 시점에 제보할 수 있게.

interface Props {
  onClose: () => void;
}

export function ReportModal({ onClose }: Props) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const openTabs = useWorkbenchStore((s) => s.openTabs);
  const tabSplits = useWorkbenchStore((s) => s.tabSplits);
  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;
  const splitMode = activeTabId ? tabSplits[activeTabId]?.mode : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const buildContext = (): Record<string, unknown> => {
    const ctx: Record<string, unknown> = { ...getLogContext() };
    if (activeTab) {
      ctx.activeTab = {
        id: activeTab.id,
        kind: activeTab.kind,
        title:
          activeTab.kind === 'qna-thread'
            ? activeTab.title
            : activeTab.kind === 'agent-web'
              ? 'Agent'
              : activeTab.node.title,
      };
    }
    if (splitMode) ctx.splitMode = splitMode;
    ctx.url = typeof window !== 'undefined' ? window.location.href : '';
    ctx.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return ctx;
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmed = note.trim();
    if (!trimmed) {
      setResult({ ok: false, reason: '메모를 한 줄이라도 적어주세요.' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const r = await window.projk.klaudLog.submitReport({
        note: trimmed,
        context: buildContext(),
      });
      setResult(r);
      if (r.ok) {
        // 짧게 머문 뒤 자동 닫기.
        window.setTimeout(onClose, 1500);
      }
    } catch (e) {
      setResult({ ok: false, reason: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="report-modal-backdrop" data-testid="report-modal-backdrop" onClick={() => !submitting && onClose()}>
      <div
        className="report-modal"
        data-testid="report-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="report-modal-header">
          <span className="report-modal-title">
            <span aria-hidden="true">🚨</span> 이상해요 / 제보
          </span>
          <button
            type="button"
            className="report-modal-close"
            data-testid="report-modal-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="닫기"
          >
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>

        <div className="report-modal-body">
          <p className="report-modal-intro">
            지금 무엇이 이상한지 한 줄 적어주세요. 이 시점 이전의 로그가 함께 묶여서
            관리자에게 전달됩니다.
          </p>

          <textarea
            className="report-modal-note"
            data-testid="report-modal-note"
            placeholder="예: 리뷰 결과가 텅 비어있어요 / 검색하면 같은 결과만 나옴 / 저장 후 새로고침하니 사라짐"
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            autoFocus
          />

          <div className="report-modal-context" data-testid="report-modal-context">
            <div className="report-modal-context-title">현재 컨텍스트 (자동 첨부)</div>
            <ul className="report-modal-context-list">
              <li>
                <span>활성 문서</span>
                <code>
                  {activeTab
                    ? activeTab.kind === 'qna-thread'
                      ? activeTab.title
                      : activeTab.kind === 'agent-web'
                        ? 'Agent'
                        : activeTab.node.title
                    : '없음'}
                </code>
              </li>
              <li>
                <span>모드</span>
                <code>{splitMode ?? '없음'}</code>
              </li>
            </ul>
          </div>

          {result && (
            <div
              className={`report-modal-result ${result.ok ? 'ok' : 'err'}`}
              data-testid="report-modal-result"
            >
              {result.ok
                ? '제보가 전송되었습니다. 감사합니다.'
                : `전송 실패: ${result.reason ?? '알 수 없는 오류'}`}
            </div>
          )}
        </div>

        <footer className="report-modal-footer">
          <button
            type="button"
            className="report-modal-cancel-btn"
            onClick={onClose}
            disabled={submitting}
            data-testid="report-modal-cancel"
          >
            취소
          </button>
          <button
            type="button"
            className="report-modal-submit-btn"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            data-testid="report-modal-submit"
          >
            {submitting ? '전송 중...' : '전송'}
          </button>
        </footer>
      </div>
    </div>
  );
}
