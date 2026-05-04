import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  attachDocToQnA,
  attachReviewItemToQnA,
} from '../../src/renderer/qna/dispatch';
import { useWorkbenchStore } from '../../src/renderer/workbench/store';
import type { TreeNode } from '../../src/shared/types';

// Phase A2: 진입점 2 dispatch 헬퍼 회귀.
//   - thread 가 만들어지고 그 id 로 첨부 push
//   - activeIcon = 'qna' 로 swap
//   - openTab(qna-thread) — 새 탭 추가, activeTab 도 그것으로
//   - pulse timestamp 갱신 — ActivityBar 가 그걸 보고 시각 피드백
//   - thread create IPC 실패 시 ok:false + 메시지

const NODE_CONFLUENCE: TreeNode = {
  id: 'confluence:1234',
  type: 'page',
  title: 'PVP 시스템 설계',
  relPath: '시스템 디자인 / PVP / PVP 시스템 설계',
  confluencePageId: '1234',
};

beforeEach(() => {
  // store 초기화 — 각 테스트 격리.
  useWorkbenchStore.setState({
    qnaPendingAttachments: {},
    openTabs: [],
    activeTabId: null,
    activeIcon: 'confluence',
    activityIconPulse: null,
  });

  // window.projk.threads.create stub — dispatch 가 호출하는 IPC.
  vi.stubGlobal('window', {
    projk: {
      threads: {
        create: vi.fn(async (p: { id: string; title: string }) => ({
          id: p.id,
          title: p.title,
          created_at: 0,
          updated_at: 0,
          archived: 0,
        })),
      },
    },
  });
});

describe('attachDocToQnA — 진입점 2', () => {
  it('thread 생성 + 첨부 push + activity swap + qna-thread 탭 open', async () => {
    const r = await attachDocToQnA({
      node: NODE_CONFLUENCE,
      text: '본문 텍스트 (webview innerText)',
      type: 'confluence',
    });

    expect(r.ok).toBe(true);
    expect(r.threadId).toBeTruthy();

    const s = useWorkbenchStore.getState();

    // 첨부가 그 thread 에 정확히 push 되었는지.
    const atts = s.qnaPendingAttachments[r.threadId!];
    expect(atts).toHaveLength(1);
    expect(atts![0]!.kind).toBe('doc');
    if (atts![0]!.kind === 'doc') {
      expect(atts![0]!.title).toBe('PVP 시스템 설계');
      expect(atts![0]!.ref.type).toBe('confluence');
      expect(atts![0]!.ref.text).toBe('본문 텍스트 (webview innerText)');
      expect(atts![0]!.ref.pageId).toBe('1234');
      expect(atts![0]!.ref.relPath).toContain('PVP');
    }

    // activity 가 qna 로 swap.
    expect(s.activeIcon).toBe('qna');

    // pulse — kind=qna 에 timestamp 가 set.
    expect(s.activityIconPulse?.kind).toBe('qna');
    expect(typeof s.activityIconPulse?.ts).toBe('number');

    // qna-thread 탭이 open + activeTab.
    expect(s.openTabs).toHaveLength(1);
    expect(s.openTabs[0]!.kind).toBe('qna-thread');
    if (s.openTabs[0]!.kind === 'qna-thread') {
      expect(s.openTabs[0]!.threadId).toBe(r.threadId);
      expect(s.openTabs[0]!.title).toContain('Agent: PVP');
    }
    expect(s.activeTabId).toBe(s.openTabs[0]!.id);
  });

  it('Excel(시트) 첨부도 동일하게 동작 — type=excel', async () => {
    const sheetNode: TreeNode = {
      id: 'local:7_System/PK_변신.xlsx',
      type: 'workbook',
      title: 'PK_변신',
      relPath: '7_System/PK_변신.xlsx',
    };
    const r = await attachDocToQnA({
      node: sheetNode,
      text: '## 변신 시스템\n...',
      type: 'excel',
    });

    expect(r.ok).toBe(true);
    const atts = useWorkbenchStore.getState().qnaPendingAttachments[r.threadId!];
    expect(atts).toHaveLength(1);
    if (atts![0]!.kind === 'doc') {
      expect(atts![0]!.ref.type).toBe('excel');
      // Excel 노드에 confluencePageId 가 없으니 pageId 도 undefined.
      expect(atts![0]!.ref.pageId).toBeUndefined();
    }
  });

  describe('attachReviewItemToQnA — 진입점 3', () => {
    it('리뷰 항목 단위 첨부 — review-item kind, category/perspective 보존', async () => {
      const r = await attachReviewItemToQnA({
        docNode: NODE_CONFLUENCE,
        docTitle: 'PVP 시스템 설계',
        itemText: '회복 쿨타임 처리가 클라/서버 비대칭 — Boss 전투에서 어긋남',
        category: 'issue',
        perspective: '프로그래머',
      });

      expect(r.ok).toBe(true);
      const s = useWorkbenchStore.getState();
      const atts = s.qnaPendingAttachments[r.threadId!];
      expect(atts).toHaveLength(1);
      expect(atts![0]!.kind).toBe('review-item');
      if (atts![0]!.kind === 'review-item') {
        // 사용자 결정: 리뷰 "전체" 가 아니라 항목 1개. 본문/카테고리/perspective 모두 정확히 박힘.
        expect(atts![0]!.ref.category).toBe('issue');
        expect(atts![0]!.ref.text).toContain('회복 쿨타임');
        expect(atts![0]!.ref.docTitle).toBe('PVP 시스템 설계');
        expect(atts![0]!.ref.docNodeId).toBe('confluence:1234');
        expect(atts![0]!.ref.perspective).toBe('프로그래머');
      }

      // 사용자 결정: split 닫지 않음 — activity 만 swap. 따라서 도큐먼트 탭은 그대로.
      expect(s.activeIcon).toBe('qna');
      expect(s.activityIconPulse?.kind).toBe('qna');

      // qna-thread 탭 추가 + 제목은 항목 본문 30자.
      const qnaTab = s.openTabs.find((t) => t.kind === 'qna-thread');
      expect(qnaTab).toBeDefined();
      if (qnaTab?.kind === 'qna-thread') {
        expect(qnaTab.title).toContain('리뷰:');
      }
    });

    it('perspective 미지정 — undefined 그대로 저장 (강제 default 안 잡음)', async () => {
      const r = await attachReviewItemToQnA({
        docNode: NODE_CONFLUENCE,
        docTitle: 'PVP 시스템 설계',
        itemText: '검증 필요한 항목',
        category: 'verification',
      });
      expect(r.ok).toBe(true);
      const atts = useWorkbenchStore.getState().qnaPendingAttachments[r.threadId!];
      if (atts![0]!.kind === 'review-item') {
        expect(atts![0]!.ref.perspective).toBeUndefined();
      }
    });

    it('thread create 실패 시 ok:false, store 상태 변화 X', async () => {
      vi.stubGlobal('window', {
        projk: {
          threads: { create: vi.fn(async () => { throw new Error('IPC 단절'); }) },
        },
      });
      const r = await attachReviewItemToQnA({
        docNode: NODE_CONFLUENCE,
        docTitle: 'X',
        itemText: 'X',
        category: 'issue',
      });
      expect(r.ok).toBe(false);
      expect(useWorkbenchStore.getState().openTabs).toHaveLength(0);
      expect(useWorkbenchStore.getState().activeIcon).toBe('confluence');
    });
  });

  it('thread create 실패 시 ok:false + error 메시지, store 상태 변화 X', async () => {
    vi.stubGlobal('window', {
      projk: {
        threads: {
          create: vi.fn(async () => {
            throw new Error('IPC 단절');
          }),
        },
      },
    });

    const r = await attachDocToQnA({
      node: NODE_CONFLUENCE,
      text: '본문',
      type: 'confluence',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('IPC 단절');

    // 실패 시 store 안 만짐 — partial state 방지.
    const s = useWorkbenchStore.getState();
    expect(Object.keys(s.qnaPendingAttachments)).toHaveLength(0);
    expect(s.openTabs).toHaveLength(0);
    expect(s.activeIcon).toBe('confluence'); // 원상태 유지
  });
});
