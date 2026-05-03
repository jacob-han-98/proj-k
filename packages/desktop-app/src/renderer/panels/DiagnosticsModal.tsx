import { useEffect, useState } from 'react';
import { runAllDiagnostics, type DiagResult, type DiagStatus } from '../diagnostics';

// C1: 사용자 환경 진단 — 9 개 항목을 한 화면에 보여 설치 후 무엇이 안 되는지 즉시 파악.
// 각 항목 상태: ✅ ok / ⚠ warn / ❌ error / … pending. action 단축키 포함.
//
// 트리거: TitleBar 의 🩺 버튼. 부팅 직후 자동 노출 X — 사용자가 명시 클릭.

interface Props {
  onClose: () => void;
  onOpenSettings: () => void;
}

export function DiagnosticsModal({ onClose, onOpenSettings }: Props) {
  const [results, setResults] = useState<DiagResult[]>([]);
  const [running, setRunning] = useState(true);
  const [showDetail, setShowDetail] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    setRunning(true);
    try {
      const r = await runAllDiagnostics(window.projk as unknown as Parameters<typeof runAllDiagnostics>[0]);
      setResults(r);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onAction = async (r: DiagResult) => {
    if (!r.action) return;
    switch (r.action.kind) {
      case 'open-settings':
        onOpenSettings();
        return;
      case 'reload-trees':
        try { await window.projk.refreshTrees(); } catch { /* ignore */ }
        await refresh();
        return;
      case 'detect-onedrive':
        try { await window.projk.oneDriveSync.detect(); } catch { /* ignore */ }
        await refresh();
        return;
      case 'discover-p4':
        try { await window.projk.p4.discover(); } catch { /* ignore */ }
        await refresh();
        return;
    }
  };

  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    error: results.filter((r) => r.status === 'error').length,
    pending: results.filter((r) => r.status === 'pending').length,
  };

  return (
    <div
      className="diag-modal-backdrop"
      data-testid="diag-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="diag-modal"
        data-testid="diag-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="diag-modal-header">
          <span className="diag-modal-icon" aria-hidden="true">🩺</span>
          <span className="diag-modal-title">환경 진단</span>
          <span className="diag-modal-summary" data-testid="diag-summary">
            {running
              ? '검사 중…'
              : `✅ ${counts.ok} · ⚠ ${counts.warn} · ❌ ${counts.error}${counts.pending ? ` · ⏳ ${counts.pending}` : ''}`}
          </span>
          <button
            type="button"
            className="diag-modal-refresh"
            onClick={() => void refresh()}
            disabled={running}
            data-testid="diag-refresh"
            title="다시 검사"
          >🔄</button>
          <button
            type="button"
            className="diag-modal-close"
            onClick={onClose}
            aria-label="닫기"
            data-testid="diag-modal-close"
          >×</button>
        </header>
        <div className="diag-modal-body">
          {results.length === 0 && running && (
            <div className="diag-loading" data-testid="diag-loading">검사 중…</div>
          )}
          <ul className="diag-list">
            {results.map((r) => (
              <li
                key={r.id}
                className={`diag-row ${r.status}`}
                data-testid={`diag-row-${r.id}`}
                data-status={r.status}
              >
                <div className="diag-row-head">
                  <span className="diag-row-status" aria-hidden="true">
                    {iconFor(r.status)}
                  </span>
                  <span className="diag-row-label">{r.label}</span>
                  {r.action && (
                    <button
                      type="button"
                      className="diag-row-action"
                      onClick={() => void onAction(r)}
                      data-testid={`diag-action-${r.id}`}
                    >{r.action.label}</button>
                  )}
                  {r.detail && (
                    <button
                      type="button"
                      className="diag-row-detail-toggle"
                      onClick={() => setShowDetail((s) => ({ ...s, [r.id]: !s[r.id] }))}
                      title="상세 보기"
                    >{showDetail[r.id] ? '▾' : '▸'}</button>
                  )}
                </div>
                <div className="diag-row-message">{r.message}</div>
                {r.detail && showDetail[r.id] && (
                  <pre className="diag-row-detail" data-testid={`diag-detail-${r.id}`}>{r.detail}</pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function iconFor(s: DiagStatus): string {
  if (s === 'ok') return '✅';
  if (s === 'warn') return '⚠';
  if (s === 'error') return '❌';
  return '⏳';
}
