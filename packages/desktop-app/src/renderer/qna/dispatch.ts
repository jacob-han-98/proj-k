// Phase A2: 진입점 2 (문서 → qna) 의 공통 dispatcher. CenterPane 의 Confluence/Excel
// 버튼이 본문을 추출한 다음 이 함수를 호출해 다음을 한꺼번에 처리:
//   1. 새 thread 를 SQLite 에 생성 (window.projk.threads.create)
//   2. doc 첨부를 store.qnaPendingAttachments[threadId] 에 push
//   3. activity bar 를 qna 로 swap + 0.6s pulse (사용자 시각 피드백)
//   4. qna-thread 탭을 에디터에 open
//
// 호출 후 사용자가 보는 화면: 에디터에 새 qna-thread 탭이 열려있고, 입력창 위에 첨부
// 칩이 떠 있으며, 사이드바는 qna 액티비티로 전환되어 ThreadList 에 새 thread 가 활성.
// 사용자가 질문을 치고 Enter — QnATab.send() 가 첨부에 text 가 있으면 setDocContext
// 로 backend 에 stash 후 askStream.

import type { TreeNode } from '../../shared/types';
import { useWorkbenchStore } from '../workbench/store';
import { genAttachmentId, type QnAAttachment } from './attachments';

interface DispatchInput {
  node: TreeNode;
  // 추출된 문서 본문. Confluence webview innerText 또는 Excel sheet flattened markdown.
  // 빈 문자열이면 backend 가 lookup 못 하므로 호출 전 alert 권장 (호출자 책임).
  text: string;
  // 'confluence' 또는 'excel' — backend 의 doc_type 분기에 사용.
  type: 'confluence' | 'excel';
}

// 호출 결과 — 호출자가 추가 처리 (예: 분석/로그) 하고 싶을 때. 실패 시 false.
export interface DispatchResult {
  ok: boolean;
  threadId?: string;
  error?: string;
}

const TITLE_MAX = 40; // thread 제목 너무 길면 ThreadList 에 잘림. 사용자 작성한 첫 질문이
//                      도착하면 QnATab 이 그 질문 30자로 다시 rename — 여긴 임시 라벨.

export async function attachDocToQnA(input: DispatchInput): Promise<DispatchResult> {
  const { node, text, type } = input;

  // 1. thread 생성 — IPC 가 SQLite 에 row 추가 후 ThreadSummary 반환.
  let threadId: string;
  let title: string;
  try {
    const tempTitle = `Agent: ${node.title}`.slice(0, TITLE_MAX);
    const created = await window.projk.threads.create({ id: genThreadId(), title: tempTitle });
    threadId = created.id;
    title = created.title;
  } catch (e) {
    return { ok: false, error: `thread 생성 실패: ${(e as Error).message}` };
  }

  // 2. doc 첨부 push — 이 시점부터 store 의 pending 에 들어가고 QnATab mount 시 칩 표시.
  const att: QnAAttachment = {
    id: genAttachmentId(),
    kind: 'doc',
    title: node.title,
    ref: {
      type,
      nodeId: node.id,
      relPath: node.relPath,
      text, // setDocContext 의 content 로 그대로 사용 — 첫 send 시점.
      pageId: node.confluencePageId,
    },
  };
  useWorkbenchStore.getState().attachToQnA(threadId, att);

  // 3. activity bar 를 qna 로 swap + pulse — 사용자가 "어디로 갔지?" 헤매지 않게 시각 피드백.
  // pulse 는 CSS 애니메이션 (0.6s) — store 에 timestamp 만 두고 ActivityBar 가 그걸 보고
  // class 적용. setTimeout 으로 자동 클리어해 다음 호출도 다시 발동.
  useWorkbenchStore.getState().setActiveIcon('qna');
  useWorkbenchStore.getState().pulseActivityIcon('qna');

  // 4. qna-thread 탭 open — 같은 threadId 로 이미 열려있으면 focus 만, 없으면 push.
  useWorkbenchStore.getState().openTab({ kind: 'qna-thread', threadId, title });

  return { ok: true, threadId };
}

function genThreadId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
