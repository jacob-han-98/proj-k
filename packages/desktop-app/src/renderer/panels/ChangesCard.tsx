// Phase 4-3.5: ReviewCard 의 "✏️ 원본 수정" 클릭 → /suggest_edits 응답 → 이 카드.
// chrome-extension renderChangesCard 의 minimum 포팅 — 항목별 accept/reject 토글,
// "전체 적용/거부", floating bar 동기화 같은 인터랙션은 4-X 로 미룸. 4-4 의 Apply
// (Confluence REST PUT) 가 이 카드의 changes 를 그대로 소비하기만 하면 된다.

import type { ChangeItem } from '../api';

interface Props {
  changes: ChangeItem[] | null;
  streaming: boolean;
  error?: string;
  // 4-4: 적용 버튼이 눌리면 호출. 지금은 stub — App 이 받아 PUT.
  onApply?: (changes: ChangeItem[]) => void;
}

export function ChangesCard({ changes, streaming, error, onApply }: Props) {
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
        <div className="review-streaming">수정안 생성 중<span className="dots" /></div>
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
      {changes.map((c, i) => (
        <div key={c.id ?? i} className="change-item" data-testid={`change-${c.id ?? i}`}>
          <div className="change-header">
            <span className="change-num">{i + 1}.</span>
            <span className="change-desc">{c.description || c.section || '(설명 없음)'}</span>
          </div>
          <div className="change-diff">
            <div className="change-before">
              <div className="change-label">Before</div>
              <div className="change-text">{c.before}</div>
            </div>
            <div className="change-after">
              <div className="change-label">After</div>
              <div className="change-text">{c.after}</div>
            </div>
          </div>
        </div>
      ))}
      {onApply && (
        <div className="changes-actions">
          <button
            onClick={() => onApply(changes)}
            data-testid="changes-apply"
            className="primary"
          >
            ✓ Confluence 에 반영
          </button>
        </div>
      )}
    </div>
  );
}
