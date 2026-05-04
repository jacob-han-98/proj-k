import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildAttachmentPrompt,
  genAttachmentId,
  type QnAAttachment,
} from '../../src/renderer/qna/attachments';
import { useWorkbenchStore } from '../../src/renderer/workbench/store';

// Phase A1 회귀 보장:
//   - buildAttachmentPrompt 의 분기 (빈 / doc-only / review-item)
//   - store 의 attach/detach/clear 이 thread 단위 격리 + idempotent
//   - closeTab 이 qna-thread 의 pending 까지 정리 (leak 방지)

const DOC_ATT: QnAAttachment = {
  id: 'doc-1',
  kind: 'doc',
  title: 'PK_변신',
  ref: { type: 'excel', nodeId: 'n1', relPath: '7_System/PK_변신.xlsx' },
};

const REVIEW_ATT: QnAAttachment = {
  id: 'rev-1',
  kind: 'review-item',
  title: '회복 시스템 쿨타임...',
  ref: {
    docNodeId: 'n2',
    docTitle: 'PK_변신 시스템',
    category: 'issue',
    text: '회복 쿨타임 처리가 클라/서버 비대칭',
    perspective: '프로그래머',
  },
};

describe('buildAttachmentPrompt', () => {
  it('빈 array 면 빈 문자열', () => {
    expect(buildAttachmentPrompt([])).toBe('');
  });

  it('doc 첨부만 있으면 행동 지침 prefix 안 붙음', () => {
    const out = buildAttachmentPrompt([DOC_ATT]);
    expect(out).toContain('[첨부 컨텍스트]');
    expect(out).toContain('"PK_변신"');
    expect(out).toContain('Excel');
    expect(out).toContain('7_System/PK_변신.xlsx');
    expect(out).not.toContain('[행동 지침]');
    expect(out).toContain('[사용자 질문]');
  });

  it('review-item 첨부 있으면 행동 지침 + 위주 표현 + 본문 인용', () => {
    const out = buildAttachmentPrompt([REVIEW_ATT]);
    expect(out).toContain('[행동 지침]');
    // persona 표현 — backend 의 "Prioritize" 가이드와 일치하는 "위주" 단어 (inbox 정정).
    expect(out).toContain('관점: 프로그래머 위주');
    // 카테고리 한글 라벨.
    expect(out).toContain('[문제 지적]');
    expect(out).toContain('대상 문서: "PK_변신 시스템"');
    expect(out).toContain('"회복 쿨타임 처리가 클라/서버 비대칭"');
    expect(out).toContain('1. 위 리뷰 항목이');
    expect(out).toContain('2. 왜 그렇게 판단');
    expect(out).toContain('3. 사용자가 이어서 물어볼');
  });

  it('doc + review-item 혼합 — 둘 다 컨텍스트, 행동 지침은 review-item 때문에 붙음', () => {
    const out = buildAttachmentPrompt([DOC_ATT, REVIEW_ATT]);
    expect(out).toContain('"PK_변신"');
    expect(out).toContain('"회복 쿨타임 처리가 클라/서버 비대칭"');
    expect(out).toContain('[행동 지침]');
  });
});

describe('genAttachmentId', () => {
  it('호출마다 다른 ID', () => {
    const a = genAttachmentId();
    const b = genAttachmentId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('store: qnaPendingAttachments', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ qnaPendingAttachments: {}, openTabs: [], activeTabId: null });
  });

  it('attachToQnA 가 thread 단위로 push, 빈 키는 자동 생성', () => {
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    const map = useWorkbenchStore.getState().qnaPendingAttachments;
    expect(map['thread-A']).toEqual([DOC_ATT]);
    expect(map['thread-B']).toBeUndefined();
  });

  it('같은 id 두 번 push 는 무시 (idempotent)', () => {
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    expect(useWorkbenchStore.getState().qnaPendingAttachments['thread-A']).toHaveLength(1);
  });

  it('서로 다른 thread 격리 — A 의 첨부가 B 에 안 새어들어감', () => {
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    useWorkbenchStore.getState().attachToQnA('thread-B', REVIEW_ATT);
    const map = useWorkbenchStore.getState().qnaPendingAttachments;
    expect(map['thread-A']).toEqual([DOC_ATT]);
    expect(map['thread-B']).toEqual([REVIEW_ATT]);
  });

  it('detachFromQnA 가 해당 id 만 제거, 마지막 첨부 떼면 키 자체 삭제', () => {
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    useWorkbenchStore.getState().attachToQnA('thread-A', REVIEW_ATT);
    useWorkbenchStore.getState().detachFromQnA('thread-A', DOC_ATT.id);
    expect(useWorkbenchStore.getState().qnaPendingAttachments['thread-A']).toEqual([REVIEW_ATT]);
    useWorkbenchStore.getState().detachFromQnA('thread-A', REVIEW_ATT.id);
    expect(useWorkbenchStore.getState().qnaPendingAttachments['thread-A']).toBeUndefined();
  });

  it('clearPendingAttachments — send 직후 호출되어 해당 thread 의 모든 첨부 한 번에 제거', () => {
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    useWorkbenchStore.getState().attachToQnA('thread-A', REVIEW_ATT);
    useWorkbenchStore.getState().clearPendingAttachments('thread-A');
    expect(useWorkbenchStore.getState().qnaPendingAttachments['thread-A']).toBeUndefined();
  });

  it('closeTab(qna-thread) 가 그 thread 의 pending 도 정리 — leak 방지', () => {
    // qna-thread 탭 열어두고 첨부 push.
    useWorkbenchStore.getState().openTab({
      kind: 'qna-thread',
      threadId: 'thread-A',
      title: 'test',
    });
    useWorkbenchStore.getState().attachToQnA('thread-A', DOC_ATT);
    expect(useWorkbenchStore.getState().qnaPendingAttachments['thread-A']).toBeDefined();

    // 탭 닫음 — pending 도 같이 비워져야 함.
    const tabId = useWorkbenchStore.getState().openTabs[0]!.id;
    useWorkbenchStore.getState().closeTab(tabId);
    expect(useWorkbenchStore.getState().qnaPendingAttachments['thread-A']).toBeUndefined();
  });
});
