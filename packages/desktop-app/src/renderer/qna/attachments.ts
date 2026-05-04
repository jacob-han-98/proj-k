// Phase A1: QnA 액티비티의 컨텍스트 첨부 모델.
//
// 사용자가 문서/리뷰 항목을 "첨부파일처럼" 채팅 입력에 붙여 Agent 와 그 컨텍스트로 대화.
// 진입점 (Phase A2/A3 에서 실제 와이어업):
//   - A2 — 에디터 탭 헤더 "🤖 Agent에 질문" 버튼  → kind:'doc'
//   - A3 — ReviewCard 의 각 item 옆 💬 아이콘   → kind:'review-item'
//
// Lifecycle:
//   1. 진입점 호출 → 새 thread 생성 → store.attachToQnA(threadId, att) 로 push
//   2. Activity Bar = qna 로 스왑, qna-thread 탭 open
//   3. QnATab mount → store.qnaPendingAttachments[threadId] 가져와 입력창 위 칩으로 표시
//   4. 사용자가 첫 질문 send → buildAttachmentPrompt 가 system prefix 로 변환되어
//      question 앞에 prepend, 같은 thread 의 두 번째 메시지부터는 backend conversation
//      이 컨텍스트를 유지하므로 prepend 안 함
//   5. 보낸 시점에 store.clearPendingAttachments(threadId) — 다음 mount 때 다시 안 보이게
//
// 사용자가 ✕ 클릭 → store.detachFromQnA(threadId, attId).
// 첨부 단위는 사용자 결정대로: 리뷰 "전체" 가 아니라 항목 1개씩.

export type ReviewItemCategory = 'issue' | 'verification' | 'suggestion' | 'qa-checklist';

export type QnAAttachment =
  | {
      id: string;
      kind: 'doc';
      title: string; // chip 라벨
      ref: {
        type: 'confluence' | 'excel';
        nodeId: string;
        relPath?: string;
        // Phase A2: 진입점에서 한 번 추출한 본문을 첨부에 캐시. QnATab 의 첫 send 시점에
        // setDocContext(conversationId, {title, content}) 로 backend 에 stash → backend
        // agent 가 read_current_doc tool 로 lazy 인용. text 가 없으면 stash 생략 (메타만
        // 으로 backend 가 알아서 lookup 하는 흐름은 TBD).
        text?: string;
        // Confluence pageId — backend 가 출처 인용 시 라벨/링크 만들 때 사용.
        pageId?: string;
      };
    }
  | {
      id: string;
      kind: 'review-item';
      title: string; // chip 라벨 — 리뷰 본문 30~40자 정도
      ref: {
        docNodeId: string;
        docTitle: string;
        category: ReviewItemCategory;
        text: string;
        perspective?: string; // "프로그래머" / "기획팀장" — 위주 의미 (reviewer_personas 결과)
      };
    };

export function genAttachmentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const CATEGORY_LABEL: Record<ReviewItemCategory, string> = {
  issue: '문제 지적',
  verification: '검증 필요',
  suggestion: '제안',
  'qa-checklist': 'QA 체크',
};

// 첨부 → 첫 메시지 시 question 앞에 prepend 할 system prefix.
// 빈 배열이면 빈 문자열 — 호출자는 그냥 사용자 질문만 보냄.
//
// review-item 첨부가 하나라도 있으면 첫 응답에 (1) 리뷰 의도 요약 (2) 추정 근거 (3) 후속질문
// 행동을 강제. 사용자 결정 (2026-05-04 대화):
//   "agent 에게는 이런 문서를 대상으로 이런 리뷰 항목이 있는데, 사용자는 조금더 상세한
//    정보를 얻고자 한다.. 리뷰의 의도를 요약해주고.. 이어서 사용자의 질문을 받는 형식으로!!"
export function buildAttachmentPrompt(attachments: readonly QnAAttachment[]): string {
  if (attachments.length === 0) return '';

  const parts: string[] = ['[첨부 컨텍스트]'];
  let hasReviewItem = false;

  for (const att of attachments) {
    if (att.kind === 'doc') {
      const refLabel = att.ref.type === 'confluence' ? 'Confluence' : 'Excel';
      const path = att.ref.relPath ? ` — ${att.ref.relPath}` : '';
      parts.push(`- 📄 문서 (${refLabel}): "${att.title}"${path}`);
    } else {
      hasReviewItem = true;
      const persp = att.ref.perspective ? ` (관점: ${att.ref.perspective} 위주)` : '';
      const catLabel = CATEGORY_LABEL[att.ref.category] ?? att.ref.category;
      parts.push(`- 🔍 리뷰 항목 [${catLabel}]${persp} — 대상 문서: "${att.ref.docTitle}"`);
      parts.push(`    리뷰 본문: "${att.ref.text}"`);
    }
  }

  if (hasReviewItem) {
    parts.push('');
    parts.push('[행동 지침]');
    parts.push('첫 응답에서 다음 순서로 답하세요:');
    parts.push(
      '1. 위 리뷰 항목이 무엇을 지적하는지 1-2문장 요약 (사용자가 본문만 보고는 의도가 잘 안 잡힐 수 있음).',
    );
    parts.push(
      '2. 왜 그렇게 판단했을지 추정 — 어떤 근거 또는 일반적 기획 원칙에 비추어 그런 issue/verification/suggestion 인지.',
    );
    parts.push(
      '3. 사용자가 이어서 물어볼 만한 후속 질문 2-3개를 제시 (예: "정말 수정해야 하나?", "다른 시스템과 충돌은?", "수정 시 영향 범위는?").',
    );
    parts.push('이후 사용자의 추가 질문을 받아 자유 대화로 전환하세요.');
  }

  parts.push('');
  parts.push('[사용자 질문]');
  return parts.join('\n');
}
