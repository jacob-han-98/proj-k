import { useEffect, useState } from 'react';
import type { SearchHit, SidecarStatus, ThreadBundle, TreeNode } from '../shared/types';
import { TreeSidebar } from './panels/TreeSidebar';
import { ThreadList } from './panels/ThreadList';
import { CenterPane } from './panels/CenterPane';
import { ChatPanel, type ReviewTrigger } from './panels/ChatPanel';
import { SettingsModal } from './panels/SettingsModal';
import { UpdateToast } from './panels/UpdateToast';
import { UpdateIndicator } from './panels/UpdateIndicator';

type Selection = { kind: 'sheet' | 'confluence'; node: TreeNode } | null;

export function App() {
  const [selection, setSelection] = useState<Selection>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: 'starting', port: null, pid: null });
  const [credsInfo, setCredsInfo] = useState<{ email: string; baseUrl: string; hasToken: boolean } | null>(null);
  const [showCreds, setShowCreds] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadBundle, setThreadBundle] = useState<ThreadBundle | null>(null);
  const [threadListKey, setThreadListKey] = useState(0); // refresh trigger
  const [sheetMappings, setSheetMappings] = useState<Record<string, string>>({});
  // Phase 4-2: CenterPane 의 "리뷰" 버튼 → ChatPanel 의 review stream 으로 dispatch.
  // id 는 같은 페이지 재요청도 useEffect 재발동시키는 dedupe key.
  const [reviewTrigger, setReviewTrigger] = useState<ReviewTrigger | null>(null);

  // 부팅 시 settings 의 sheetMappings load.
  useEffect(() => {
    window.projk.getSettings().then((s) => {
      setSheetMappings(s.sheetMappings ?? {});
    });
  }, []);

  const onUpsertSheetMapping = (relPath: string, url: string) => {
    const next = { ...sheetMappings, [relPath]: url };
    setSheetMappings(next);
    void window.projk.setSettings({ sheetMappings: next });
  };

  useEffect(() => {
    window.projk.getSidecarStatus().then(setSidecar);
    const off = window.projk.onSidecarStatus(setSidecar);
    return off;
  }, []);

  useEffect(() => {
    void refreshCreds();
  }, []);

  // Phase 3.5: 부팅 시 마지막으로 보던 thread 자동 select.
  useEffect(() => {
    window.projk.getSettings().then((s) => {
      if (s.lastThreadId) setSelectedThreadId(s.lastThreadId);
    });
  }, []);

  // selectedThreadId 변경 시 settings 에 저장 — 다음 부팅 복원 위해.
  useEffect(() => {
    if (selectedThreadId) {
      window.projk.setSettings({ lastThreadId: selectedThreadId }).catch(() => {});
    }
  }, [selectedThreadId]);

  // selectedThreadId 가 변경되면 bundle 을 main process 에서 fetch.
  useEffect(() => {
    if (!selectedThreadId) {
      setThreadBundle(null);
      return;
    }
    let cancelled = false;
    window.projk.threads
      .get(selectedThreadId)
      .then((b) => {
        if (!cancelled) setThreadBundle(b);
      })
      .catch((e) => console.warn('threads.get', e));
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  // 4개 핵심 설정 (repoRoot / updateFeedUrl / retrieverUrl / agentUrl) 중 하나라도
  // 비어있으면 ⚙ 설정 모달을 자동으로 띄움. 새 키가 추가된 직후 자동 업데이트 받은
  // 사용자도 "어디서 설정하지?" 헤매지 않고 화면 한 번만 따라가면 끝나도록.
  useEffect(() => {
    window.projk.getSettings().then((s) => {
      // 4개 핵심 설정 (repoRoot / updateFeedUrl / retrieverUrl / agentUrl) 중 하나라도
      // 비어있으면 모달 자동 오픈. mcpBridgeUrl 은 dev 전용이라 강제 안 함.
      const missing = !s.repoRoot || !s.updateFeedUrl || !s.retrieverUrl || !s.agentUrl;
      if (missing) setShowCreds(true);
    });
  }, []);

  // mcp-bridge 명령 수신 — Claude Code 가 MCP tool 호출 시 main 이 renderer 로 forward.
  // 0.1.22 부터 self-test 인프라는 폐기, 모든 명령은 mcp-bridge 통해서.
  // 각 cmd 별 동작:
  //   open-settings           → setShowCreds(true)
  //   close-modal             → setShowCreds(false)
  //   type-and-send           → chat input 에 텍스트 넣고 보내기 버튼 클릭
  //   click-update-indicator  → toolbar update indicator 클릭
  //   assert-tree-non-empty   → 트리 두 개 모두 채워졌는지 + sidecar /health debug
  //   mcp-state               → DOM 종합 상태 응답
  useEffect(() => {
    const off = window.projk.onMcpCommand(async ({ cmd, replyChannel }) => {
      const c = cmd as { kind: string; text?: string; testid?: string; nth?: number };
      try {
        if (c.kind === 'click-testid') {
          // DOM primitive — Playwright locator(...).click() 등가.
          // 워크북 클릭처럼 좌표 추정 없이 React 요소를 직접 활성화.
          const t = c.testid ?? '';
          const n = c.nth ?? 0;
          const all = document.querySelectorAll<HTMLElement>(`[data-testid="${CSS.escape(t)}"]`);
          if (!all[n]) {
            window.projk.mcpReply(replyChannel, {
              ok: false,
              kind: c.kind,
              testid: t,
              error: `not found: testid=${t} nth=${n} (count=${all.length})`,
              count: all.length,
            });
            return;
          }
          all[n].click();
          window.projk.mcpReply(replyChannel, {
            ok: true,
            kind: c.kind,
            testid: t,
            count: all.length,
            clicked: n,
          });
          return;
        } else if (c.kind === 'query-testid') {
          // DOM 상태 read-only 조회 — assertion / 검증용.
          const t = c.testid ?? '';
          const all = document.querySelectorAll<HTMLElement>(`[data-testid="${CSS.escape(t)}"]`);
          const items = Array.from(all).map((el) => ({
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            text: (el.innerText ?? '').slice(0, 200),
            value: (el as HTMLInputElement | HTMLTextAreaElement).value,
            tag: el.tagName,
            classList: Array.from(el.classList),
          }));
          window.projk.mcpReply(replyChannel, {
            ok: true,
            kind: c.kind,
            testid: t,
            count: items.length,
            items,
          });
          return;
        } else if (c.kind === 'open-settings') {
          setShowCreds(true);
        } else if (c.kind === 'close-modal') {
          setShowCreds(false);
        } else if (c.kind === 'type-and-send' && c.text) {
          const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
          const button = document.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
          if (input && button) {
            // Native setter — React controlled input 에 값을 넣고 input 이벤트 발화
            const proto = Object.getPrototypeOf(input) as object;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            setter?.call(input, c.text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // 잠깐 후 버튼 클릭 (state update 반영)
            setTimeout(() => button.click(), 100);
          }
        } else if (c.kind === 'click-update-indicator') {
          document.querySelector<HTMLButtonElement>('[data-testid="update-indicator"]')?.click();
        } else if (c.kind === 'assert-tree-non-empty') {
          // 트리 두 개 모두 노드 수 > 0 이어야 통과.
          // health 도 같이 dump 해서 events.log 에 진단 정보 박음 (회귀 시 어디서
          // 막혔는지 — repo_root_listable / listdir_error / sample 로 즉시 식별).
          const [p4, conf, health] = await Promise.all([
            window.projk.getP4Tree(),
            window.projk.getConfluenceTree(),
            window.projk.getSidecarHealth(),
          ]);
          const p4Count = p4?.nodes?.length ?? 0;
          const confCount = conf?.nodes?.length ?? 0;
          const ok = p4Count > 0 && confCount > 0;
          window.projk.mcpReply(replyChannel, {
            ok,
            kind: c.kind,
            p4Count,
            confCount,
            p4RootDir: p4?.rootDir,
            confRootDir: conf?.rootDir,
            p4Debug: p4?.debug,
            confDebug: conf?.debug,
            health,
          });
          return;
        } else if (c.kind === 'mcp-state') {
          // MCP bridge 가 query 하는 종합 상태. DOM 으로부터 직접 읽음.
          const [p4, conf] = await Promise.all([
            window.projk.getP4Tree(),
            window.projk.getConfluenceTree(),
          ]);
          const sidecar = await window.projk.getSidecarStatus();
          const userMsgs = document.querySelectorAll('.msg.user');
          const assistantMsgs = document.querySelectorAll('.msg.assistant');
          const lastAssistant = assistantMsgs[assistantMsgs.length - 1] as HTMLElement | undefined;
          const hits = document.querySelectorAll('.hit-card');
          const updaterStatus = await window.projk.getUpdaterState();
          window.projk.mcpReply(replyChannel, {
            ok: true,
            kind: c.kind,
            tree: {
              p4: { count: p4?.nodes?.length ?? 0, rootDir: p4?.rootDir },
              confluence: { count: conf?.nodes?.length ?? 0, rootDir: conf?.rootDir },
            },
            chat: {
              userMessages: userMsgs.length,
              assistantMessages: assistantMsgs.length,
              lastAssistantText: (lastAssistant?.innerText ?? '').slice(0, 500),
            },
            search: {
              hitCount: hits.length,
              titles: Array.from(hits)
                .map((h) => h.querySelector('.hit-title')?.textContent?.trim() ?? '')
                .filter(Boolean),
            },
            sidecar: sidecar.state,
            updater: updaterStatus?.state,
            ts: Date.now(),
          });
          return;
        }
        window.projk.mcpReply(replyChannel, { ok: true, kind: c.kind });
      } catch (e) {
        window.projk.mcpReply(replyChannel, { ok: false, error: String(e) });
      }
    });
    return off;
  }, []);

  async function refreshCreds() {
    const info = await window.projk.getConfluenceCreds();
    setCredsInfo(info);
  }

  const onOpenHit = (hit: SearchHit) => {
    // Phase 1: just log. In Phase 2 we'll resolve the hit to the matching tree
    // node and select it in the sidebar.
    console.log('open hit', hit);
  };

  return (
    <div className="shell" data-testid="app-shell">
      <header className="topbar">
        <span className="title" data-testid="app-version">
          Klaud <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 11 }}>v{__APP_VERSION__}</span>
        </span>
        <span className="breadcrumb" style={{ color: 'var(--text-dim)' }}>
          {selection ? selection.node.title : '시작하려면 좌측 트리에서 문서를 선택하세요'}
        </span>
        <UpdateIndicator />
        <span
          className={`status-pill ${sidecar.state === 'ready' ? 'ready' : sidecar.state === 'error' ? 'error' : ''}`}
          title={sidecar.message ?? ''}
          data-testid="sidecar-pill"
        >
          sidecar {sidecar.state}
          {sidecar.port ? ` :${sidecar.port}` : ''}
          {sidecar.message && sidecar.state !== 'ready' ? ` — ${sidecar.message}` : ''}
        </span>
        <button
          onClick={() => setShowCreds(true)}
          style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}
        >
          ⚙ 설정
        </button>
      </header>

      <aside className="left-sidebar" data-testid="left-sidebar">
        <ThreadList
          selectedId={selectedThreadId}
          onSelect={setSelectedThreadId}
          refreshKey={threadListKey}
        />
        <TreeSidebar
          selectedId={selection?.node.id ?? null}
          onOpenSheet={(node) => setSelection({ kind: 'sheet', node })}
          onOpenConfluencePage={(node) => setSelection({ kind: 'confluence', node })}
        />
      </aside>

      <CenterPane
        selection={selection}
        confluenceConfigured={!!credsInfo?.hasToken}
        onPromptCreds={() => setShowCreds(true)}
        sheetMappings={sheetMappings}
        onUpsertSheetMapping={onUpsertSheetMapping}
        onRequestReview={(title, text) => setReviewTrigger({ id: Date.now(), title, text })}
      />

      <ChatPanel
        onOpenHit={onOpenHit}
        threadId={selectedThreadId}
        initialMessages={threadBundle?.messages ?? []}
        initialDocs={threadBundle?.docs ?? []}
        reviewTrigger={reviewTrigger}
        onReviewConsumed={() => setReviewTrigger(null)}
        confluencePageId={selection?.kind === 'confluence' ? selection.node.confluencePageId ?? null : null}
        onThreadCreated={(id) => {
          setSelectedThreadId(id);
          setThreadListKey((k) => k + 1);
        }}
        onMessagesChanged={() => {
          setThreadListKey((k) => k + 1);
          if (selectedThreadId) {
            window.projk.threads.get(selectedThreadId).then(setThreadBundle).catch(() => {});
          }
        }}
        onOpenDoc={(d) => {
          // Phase 4-1: thread 누적 doc 클릭 → CenterPane 에 미리보기.
          // doc_id 가 트리 id 와 다르므로 가짜 TreeNode 생성 (CenterPane 이 이해할 수 있는 shape).
          const node: TreeNode = {
            id: `${d.doc_type}:${d.doc_id}`,
            type: d.doc_type === 'confluence' ? 'page' : 'sheet',
            title: d.doc_title ?? d.doc_id,
            confluencePageId: d.doc_type === 'confluence' ? d.doc_id : undefined,
            relPath: d.doc_type === 'xlsx' ? d.doc_id : undefined,
          };
          setSelection({
            kind: d.doc_type === 'confluence' ? 'confluence' : 'sheet',
            node,
          });
        }}
      />

      {showCreds && (
        <SettingsModal
          initialEmail={credsInfo?.email}
          initialBaseUrl={credsInfo?.baseUrl}
          onClose={() => setShowCreds(false)}
          onSaved={async () => {
            await refreshCreds();
            setShowCreds(false);
          }}
        />
      )}

      <UpdateToast />
    </div>
  );
}
