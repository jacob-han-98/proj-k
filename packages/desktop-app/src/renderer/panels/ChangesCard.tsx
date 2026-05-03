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
}

function changeId(c: ChangeItem, fallbackIdx: number): string {
  return c.id ? String(c.id) : `idx-${fallbackIdx}`;
}

export function ChangesCard({ changes, streaming, error, streamBuffer, status, onApply }: Props) {
  const [decisions, setDecisions] = useState<DecisionMap>({});

  // changes 가 새로 도착하면 decisions 리셋 (옛 stale state 제거 — 새 suggest_edits 결과는
  // 새 의사결정 사이클).
  useEffect(() => {
    setDecisions({});
  }, [changes]);

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
    changes.forEach((c, i) => { next[changeId(c, i)] = 'accepted'; });
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
    const accepted = changes.filter((c, i) => (decisions[changeId(c, i)] ?? 'pending') === 'accepted');
    onApply(accepted);
  };

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

  return (
    <div className="changes-card" data-testid="changes-card">
      <div className="changes-card-header">✏️ 변경안 ({changes.length}건)</div>

      {changes.map((c, i) => {
        const id = changeId(c, i);
        const decision: Decision = decisions[id] ?? 'pending';
        return (
          <ChangeRow
            key={id}
            id={id}
            num={i + 1}
            change={c}
            decision={decision}
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
            title="모든 항목을 적용으로 표시"
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
              disabled={counts.accepted === 0}
              data-testid="changes-apply"
              title={counts.accepted === 0 ? '적용 항목 없음 — 위에서 ✓ 적용 선택' : `${counts.accepted}건 Confluence 에 반영`}
            >
              ✓ Confluence 에 반영 ({counts.accepted}건)
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
  onAccept: () => void;
  onReject: () => void;
  onUndo: () => void;
}

function ChangeRow({ id, num, change, decision, onAccept, onReject, onUndo }: ChangeRowProps) {
  // diff ops — change 가 바뀌지 않으면 같은 결과 재계산 회피.
  const ops = useMemo(() => diffOpsForDisplay(change.before ?? '', change.after ?? ''), [change.before, change.after]);

  return (
    <div
      className={`change-item ${decision}`}
      data-testid={`change-${id}`}
      data-decision={decision}
    >
      <div className="change-header">
        <span className="change-num">{num}.</span>
        <span className="change-desc">{change.description || change.section || '(설명 없음)'}</span>
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
