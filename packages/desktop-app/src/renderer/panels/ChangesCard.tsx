// Phase 4-3.5 → B2-3a (2026-05-03): chrome-extension 의 인터랙티브 수정 UX 마이그레이션.
//
// 사용자 (Jacob) 명시 요청: "수정사항 하나하나에 전후를 보여주고 사용자에게 y/no/skip 을
// 물어보며 굉장히 인터렉티브하게". chrome ext renderChangesCard / _accept_/_reject_/
// _undoChange / _accept_/_rejectAll 의 패턴 그대로:
//   - per-change decision: pending | accepted | rejected
//   - 각 row 에 ✓ 적용 / ✕ 미적용 (pending) 또는 ↩ 되돌리기 (결정됨)
//   - bottom: summary "X 적용 / Y 거부 / Z 대기" + 전체 적용 / 전체 거부
//   - Apply 시 accepted 만 onApply 로 전달 → ReviewSplitPane 가 confluenceApplyEdits 호출
//   - inline 워드 diff (DiffEngine) — 빨강 removed / 초록 added / plain same
//
// 미매칭 사전 체크 (페이지 storage GET 후 매칭 여부 미리 알려줌) 는 B2-3b 로 분리.

import { useEffect, useMemo, useState } from 'react';
import type { ChangeItem } from '../api';
import { StreamingIndicator } from './ReviewCard';
import { diffOpsForDisplay, type DiffOp } from './diff-engine';

type Decision = 'pending' | 'accepted' | 'rejected';
type DecisionMap = Record<string, Decision>;

interface Props {
  changes: ChangeItem[] | null;
  streaming: boolean;
  error?: string;
  streamBuffer?: string;
  status?: string;
  // B2-3a: 적용 버튼이 눌리면 *accepted* 만 필터해서 호출. ReviewSplitPane 가 받아 PUT.
  onApply?: (accepted: ChangeItem[]) => void;
  // B2-3b: confluence page id 가 있으면 mount 시 사전 매칭 체크 → 미매칭 row 에 ⚠ badge.
  // null 이면 사전 체크 skip (Excel 등 다른 source).
  confluencePageId?: string | null;
}

function changeId(c: ChangeItem, fallbackIdx: number): string {
  return c.id ? String(c.id) : `idx-${fallbackIdx}`;
}

export function ChangesCard({ changes, streaming, error, streamBuffer, status, onApply, confluencePageId }: Props) {
  const [decisions, setDecisions] = useState<DecisionMap>({});
  // B2-3b: 사전 매칭 체크 결과 — Set<changeId> = unmatched ids. 'pending' 동안엔 null.
  const [unmatchedIds, setUnmatchedIds] = useState<Set<string> | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);

  // changes 가 새로 도착하면 decisions 리셋 (옛 stale state 제거 — 새 suggest_edits 결과는
  // 새 의사결정 사이클).
  useEffect(() => {
    setDecisions({});
    setUnmatchedIds(null);
    setPrecheckError(null);
  }, [changes]);

  // B2-3b: 새 changes 도착 + confluencePageId 있으면 사전 매칭 체크. 부담 적음 — storage GET 1회.
  useEffect(() => {
    if (!changes || changes.length === 0 || !confluencePageId) {
      setUnmatchedIds(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const items = changes.map((c, i) => ({ id: changeId(c, i), before: c.before ?? '' }));
      try {
        const r = await window.projk.confluencePrecheckMatch(confluencePageId, items);
        if (cancelled) return;
        if (r.ok) {
          setUnmatchedIds(new Set(r.unmatched));
          setPrecheckError(null);
        } else {
          setUnmatchedIds(new Set()); // 체크 자체 실패 시 — Apply 시 시도해보게 비워둠
          setPrecheckError(r.error ?? '사전 체크 실패');
        }
      } catch (e) {
        if (cancelled) return;
        setUnmatchedIds(new Set());
        setPrecheckError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [changes, confluencePageId]);

  const setDecision = (id: string, d: Decision) => {
    setDecisions((prev) => ({ ...prev, [id]: d }));
  };
  const undo = (id: string) => {
    setDecisions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const counts = useMemo(() => {
    if (!changes) return { accepted: 0, rejected: 0, pending: 0 };
    let a = 0;
    let r = 0;
    for (let i = 0; i < changes.length; i++) {
      const id = changeId(changes[i]!, i);
      const d = decisions[id] ?? 'pending';
      if (d === 'accepted') a++;
      else if (d === 'rejected') r++;
    }
    return { accepted: a, rejected: r, pending: changes.length - a - r };
  }, [changes, decisions]);

  const acceptAll = () => {
    if (!changes) return;
    const next: DecisionMap = { ...decisions };
    // B2-3b: 미매칭 항목은 자동 제외 — 어차피 PUT 시 fail. 사용자가 명시적으로 액션 안 하게.
    changes.forEach((c, i) => {
      const id = changeId(c, i);
      if (unmatchedIds?.has(id)) return;
      next[id] = 'accepted';
    });
    setDecisions(next);
  };
  const rejectAll = () => {
    if (!changes) return;
    const next: DecisionMap = { ...decisions };
    changes.forEach((c, i) => { next[changeId(c, i)] = 'rejected'; });
    setDecisions(next);
  };

  const applyAccepted = () => {
    if (!changes || !onApply) return;
    // B2-3b: accepted + matched 만 — 미매칭은 어차피 PUT 시 skip 되므로 미리 거름.
    const accepted = changes.filter((c, i) => {
      const id = changeId(c, i);
      if ((decisions[id] ?? 'pending') !== 'accepted') return false;
      if (unmatchedIds?.has(id)) return false;
      return true;
    });
    onApply(accepted);
  };

  // B2-3b: counts 의 accepted 도 미매칭 제외해서 — Apply 버튼 disabled / count 정확.
  const applicableAccepted = useMemo(() => {
    if (!changes) return 0;
    let n = 0;
    for (let i = 0; i < changes.length; i++) {
      const id = changeId(changes[i]!, i);
      if ((decisions[id] ?? 'pending') === 'accepted' && !unmatchedIds?.has(id)) n++;
    }
    return n;
  }, [changes, decisions, unmatchedIds]);

  if (error) {
    return (
      <div className="changes-card error" data-testid="changes-card">
        <div className="changes-card-header">✏️ 변경안</div>
        <div className="review-error">[수정안 오류] {error}</div>
      </div>
    );
  }

  if (streaming) {
    return (
      <div className="changes-card" data-testid="changes-card">
        <div className="changes-card-header">✏️ 변경안</div>
        <StreamingIndicator status={status ?? '수정안 생성 중'} buffer={streamBuffer} />
      </div>
    );
  }

  if (!changes || changes.length === 0) {
    return (
      <div className="changes-card" data-testid="changes-card">
        <div className="changes-card-header">✏️ 변경안</div>
        <div className="review-streaming">생성된 변경안 없음</div>
      </div>
    );
  }

  const unmatchedCount = unmatchedIds?.size ?? 0;

  return (
    <div className="changes-card" data-testid="changes-card">
      <div className="changes-card-header">
        ✏️ 변경안 ({changes.length}건)
        {unmatchedCount > 0 && (
          <span className="changes-unmatched-hint" data-testid="changes-unmatched-hint">
            {' '}· ⚠ {unmatchedCount}건 미매칭
          </span>
        )}
      </div>

      {precheckError && (
        <div className="changes-precheck-error" data-testid="changes-precheck-error">
          사전 매칭 체크 실패: {precheckError} (Apply 시 다시 시도)
        </div>
      )}

      {changes.map((c, i) => {
        const id = changeId(c, i);
        const decision: Decision = decisions[id] ?? 'pending';
        const unmatched = !!unmatchedIds?.has(id);
        return (
          <ChangeRow
            key={id}
            id={id}
            num={i + 1}
            change={c}
            decision={decision}
            unmatched={unmatched}
            onAccept={() => setDecision(id, 'accepted')}
            onReject={() => setDecision(id, 'rejected')}
            onUndo={() => undo(id)}
          />
        );
      })}

      <div className="changes-bottom">
        <div className="changes-summary" data-testid="changes-summary">
          <span className="cs-acc">✓ {counts.accepted}건 적용</span>
          {' / '}
          <span className="cs-rej">✕ {counts.rejected}건 거부</span>
          {' / '}
          <span className="cs-pend">… {counts.pending}건 대기</span>
        </div>
        <div className="changes-bulk">
          <button
            type="button"
            className="btn-sm"
            onClick={acceptAll}
            data-testid="changes-accept-all"
            title={unmatchedCount > 0 ? `미매칭 ${unmatchedCount}건 제외하고 모두 적용` : '모든 항목을 적용으로 표시'}
          >전체 적용</button>
          <button
            type="button"
            className="btn-sm"
            onClick={rejectAll}
            data-testid="changes-reject-all"
            title="모든 항목을 거부로 표시"
          >전체 거부</button>
        </div>
        {onApply && (
          <div className="changes-actions">
            <button
              type="button"
              className="primary"
              onClick={applyAccepted}
              disabled={applicableAccepted === 0}
              data-testid="changes-apply"
              title={applicableAccepted === 0 ? '적용 항목 없음 — 위에서 ✓ 적용 선택' : `${applicableAccepted}건 Confluence 에 반영`}
            >
              ✓ Confluence 에 반영 ({applicableAccepted}건)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface ChangeRowProps {
  id: string;
  num: number;
  change: ChangeItem;
  decision: Decision;
  // B2-3b: 사전 매칭 체크 결과 미매칭 — ⚠ badge + per-row tint + Apply 시 자동 skip.
  unmatched?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onUndo: () => void;
}

function ChangeRow({ id, num, change, decision, unmatched, onAccept, onReject, onUndo }: ChangeRowProps) {
  // diff ops — change 가 바뀌지 않으면 같은 결과 재계산 회피.
  const ops = useMemo(() => diffOpsForDisplay(change.before ?? '', change.after ?? ''), [change.before, change.after]);

  return (
    <div
      className={`change-item ${decision}${unmatched ? ' unmatched' : ''}`}
      data-testid={`change-${id}`}
      data-decision={decision}
    >
      <div className="change-header">
        <span className="change-num">{num}.</span>
        <span className="change-desc">{change.description || change.section || '(설명 없음)'}</span>
        {unmatched && (
          <span className="change-badge unmatched" data-testid={`change-unmatched-${id}`} title="페이지 본문에서 before 텍스트 매칭 실패 — Apply 시 자동 skip">
            ⚠ 미매칭
          </span>
        )}
        <span className={`change-badge ${decision}`} data-testid={`change-badge-${id}`}>
          {decision === 'accepted' ? '적용' : decision === 'rejected' ? '거부' : '대기'}
        </span>
      </div>

      <DiffView ops={ops} />

      <div className="change-actions">
        {decision === 'pending' ? (
          <>
            <button
              type="button"
              className="btn-sm btn-accept"
              onClick={onAccept}
              data-testid={`change-accept-${id}`}
              title="이 변경을 적용 대상으로"
            >✓ 적용</button>
            <button
              type="button"
              className="btn-sm btn-reject"
              onClick={onReject}
              data-testid={`change-reject-${id}`}
              title="이 변경 무시"
            >✕ 미적용</button>
          </>
        ) : (
          <button
            type="button"
            className="btn-sm btn-undo"
            onClick={onUndo}
            data-testid={`change-undo-${id}`}
            title="결정 취소 (대기 상태로)"
          >↩ 되돌리기</button>
        )}
      </div>
    </div>
  );
}

function DiffView({ ops }: { ops: DiffOp[] }) {
  return (
    <div className="change-diff" data-testid="change-diff">
      {ops.map((op, i) => {
        if (op.type === 'same') return <span key={i}>{op.text}</span>;
        if (op.type === 'added') return <span key={i} className="diff-added">{op.text}</span>;
        return <span key={i} className="diff-removed">{op.text}</span>;
      })}
    </div>
  );
}
