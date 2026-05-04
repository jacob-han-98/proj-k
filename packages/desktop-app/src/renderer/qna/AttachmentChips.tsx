import type { QnAAttachment } from './attachments';

// Phase A1: QnATab 입력창 위에 표시되는 첨부 칩 라인.
// VS Code chat input 위 file pill 패턴 — 사용자가 무엇을 컨텍스트로 보낼지 항상 가시화.
//
// 클릭 X 버튼 → store.detachFromQnA(threadId, att.id). 빈 array 면 자체적으로 null 반환
// (호출자는 conditional rendering 안 해도 됨).
//
// kind:'doc' = 📄, kind:'review-item' = 🔍 (사용자 결정대로 doc != review-item 다른 시각).
// review-item 칩의 tooltip 은 본문 + perspective 표시 — 칩 라벨이 짧아도 hover 로 전체 확인.

interface Props {
  attachments: readonly QnAAttachment[];
  onDetach: (id: string) => void;
}

export function AttachmentChips({ attachments, onDetach }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className="qna-attachment-chips" data-testid="qna-attachment-chips">
      {attachments.map((att) => {
        const icon = att.kind === 'doc' ? '📄' : '🔍';
        const tooltip = describeTooltip(att);
        return (
          <span
            key={att.id}
            className={`qna-attachment-chip qna-attachment-chip-${att.kind}`}
            data-testid={`qna-attachment-chip-${att.id}`}
            title={tooltip}
          >
            <span className="qna-attachment-icon" aria-hidden="true">
              {icon}
            </span>
            <span className="qna-attachment-title">{att.title}</span>
            <button
              type="button"
              className="qna-attachment-detach"
              onClick={() => onDetach(att.id)}
              aria-label={`${att.title} 첨부 제거`}
              data-testid={`qna-attachment-detach-${att.id}`}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

function describeTooltip(att: QnAAttachment): string {
  if (att.kind === 'doc') {
    const refLabel = att.ref.type === 'confluence' ? 'Confluence 페이지' : 'Excel 시트';
    return `${refLabel}: ${att.title}${att.ref.relPath ? ` (${att.ref.relPath})` : ''}`;
  }
  const persp = att.ref.perspective ? ` (관점: ${att.ref.perspective} 위주)` : '';
  return `리뷰 ${att.ref.category}${persp}\n대상: ${att.ref.docTitle}\n본문: ${att.ref.text}`;
}
