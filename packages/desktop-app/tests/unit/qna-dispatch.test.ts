import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attachDocToQnA } from '../../src/renderer/qna/dispatch';
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
      type: 'file',
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
