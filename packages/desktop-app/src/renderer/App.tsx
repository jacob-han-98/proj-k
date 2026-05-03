import { useEffect, useRef, useState } from 'react';
import type { SearchHit, SidecarStatus, TreeNode } from '../shared/types';
import { SettingsModal } from './panels/SettingsModal';
import { DiagnosticsModal } from './panels/DiagnosticsModal';
import { UpdateToast } from './panels/UpdateToast';
import { ActivityBar } from './workbench/ActivityBar';
import { TitleBar } from './panels/TitleBar';
import { EditorHost } from './workbench/Editor/EditorHost';
import { SidebarHost } from './workbench/Sidebar/SidebarHost';
import { CommandPalette } from './workbench/CommandPalette';
import { useWorkbenchStore } from './workbench/store';
import { tabIdOf } from './workbench/types';

type Selection = { kind: 'sheet' | 'confluence'; node: TreeNode } | null;

export function App() {
  const [selection, setSelection] = useState<Selection>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: 'starting', port: null, pid: null });
  const [credsInfo, setCredsInfo] = useState<{ email: string; baseUrl: string; hasToken: boolean } | null>(null);
  const [showCreds, setShowCreds] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadListKey, setThreadListKey] = useState(0); // refresh trigger
  const [sheetMappings, setSheetMappings] = useState<Record<string, string>>({});
  // 사이드바 너비 — VS Code 처럼 사용자 drag 로 가로폭 조절. 기본 312px (기존 240 의 +30%).
  // localStorage 에 영속 — 다음 부팅에 같은 너비로 복원.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('klaud_sidebar_width');
      if (stored) {
        const n = parseInt(stored, 10);
        if (Number.isFinite(n)) return Math.max(200, Math.min(600, n));
      }
    } catch {
      /* localStorage 접근 실패 — 기본값 유지 */
    }
    return 312;
  });
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
    try {
      localStorage.setItem('klaud_sidebar_width', String(sidebarWidth));
    } catch {
      /* persistence 실패는 무시 */
    }
  }, [sidebarWidth]);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidthRef.current;
    setSidebarDragging(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(200, Math.min(600, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarDragging(false);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

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

  // Phase 3.5 + PR6: 부팅 시 마지막으로 보던 thread 자동 select + editor 탭 자동 복원.
  // M1 까지는 selectedThreadId 만 set 해서 사이드바 highlight 만 됐는데, ChatPanel 이 사라진
  // 후로는 그것만으로는 사용자가 그 thread 의 대화를 볼 수 없다. lastThreadId 의 thread
  // bundle 을 fetch 해서 title 을 알아낸 뒤 editor 탭으로 자동 open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await window.projk.getSettings();
      if (cancelled || !s.lastThreadId) return;
      setSelectedThreadId(s.lastThreadId);
      try {
        const bundle = await window.projk.threads.get(s.lastThreadId);
        if (cancelled || !bundle) return;
        useWorkbenchStore.getState().openTab({
          kind: 'qna-thread',
          threadId: s.lastThreadId,
          title: bundle.thread.title || '(제목 없음)',
        });
      } catch (e) {
        console.warn('lastThreadId 탭 복원 실패', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // selectedThreadId 변경 시 settings 에 저장 — 다음 부팅 복원 위해.
  useEffect(() => {
    if (selectedThreadId) {
      window.projk.setSettings({ lastThreadId: selectedThreadId }).catch(() => {});
    }
  }, [selectedThreadId]);

  // PR5: threadBundle fetch 는 QnATab 이 자체적으로 (mount 시 자기 thread 만 get) 수행하므로
  // App level 에서 더 이상 필요 없음.

  // A2: Ctrl/Cmd+P → Command Palette toggle. 전역 단축키 — input/contenteditable 에서도
  // 동작 (palette 자체가 input 을 capture). 단 Ctrl+Shift+P (다른 의도) 는 무시.
  useEffect(() => {
    const togglePalette = useWorkbenchStore.getState().togglePalette;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'p') return;
      e.preventDefault();
      togglePalette();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // PR2: selection ↔ workbench tabs 양방향 sync.
  // selection 은 진실 소스를 유지 (트리 active highlight + ChatPanel confluencePageId 추출).
  // store.openTabs/activeTabId 는 EditorHost 가 사용. 두 useEffect 가 한 방향씩 sync.
  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const openTabs = useWorkbenchStore((s) => s.openTabs);

  // 트리 클릭 → setSelection → 이 effect 가 store 에 openTab 호출.
  // 이미 activeTabId 가 같은 ID 면 store call skip (no-op).
  useEffect(() => {
    if (!selection) return;
    const kind = selection.kind === 'confluence' ? 'confluence' : 'excel';
    const id = tabIdOf({ kind, node: selection.node });
    if (id === useWorkbenchStore.getState().activeTabId) return;
    useWorkbenchStore.getState().openTab({ kind, node: selection.node });
  }, [selection]);

  // 탭 클릭/닫기 → activeTabId 변경 → 이 effect 가 selection 을 sync (트리 highlight + ChatPanel sync).
  // 같은 (kind, node.id) 면 setSelection skip 으로 무한루프 차단.
  // qna-thread 탭은 트리 selection 과 무관 — selection 그대로 두고 우측 ChatPanel 만 selectedThreadId 로 sync.
  useEffect(() => {
    if (!activeTabId) {
      setSelection((prev) => (prev === null ? prev : null));
      return;
    }
    const tab = openTabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tab.kind === 'qna-thread') {
      // qna-thread 탭이 활성이면 사이드바 ThreadList active highlight 도 그 thread 로 sync.
      // 트리 selection 은 그대로 유지 (이전에 보던 문서 위치를 잃지 않음).
      setSelectedThreadId((prev) => (prev === tab.threadId ? prev : tab.threadId));
      return;
    }
    const kind: 'sheet' | 'confluence' = tab.kind === 'confluence' ? 'confluence' : 'sheet';
    setSelection((prev) => {
      if (prev && prev.node.id === tab.node.id && prev.kind === kind) return prev;
      return { kind, node: tab.node };
    });
  }, [activeTabId, openTabs]);

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
            // 진단용 — webview/iframe 의 src, button 의 type, input 의 placeholder 등 실제 attributes.
            // 0.1.50 — webview 의 실제 src 가 set 됐는지 확인 (key/src race 디버깅).
            attrs: Object.fromEntries(
              Array.from(el.attributes)
                .filter((a) => ['src', 'href', 'partition', 'key', 'title', 'data-testid'].includes(a.name) || a.name.startsWith('data-') || a.name.startsWith('aria-'))
                .map((a) => [a.name, a.value.slice(0, 200)]),
            ),
          }));
          window.projk.mcpReply(replyChannel, {
            ok: true,
            kind: c.kind,
            testid: t,
            count: items.length,
            items,
          });
          return;
        } else if (c.kind === 'webview-reload-src') {
          // webview 가 mount 됐지만 background spawn paint deferral 로 navigate 시작 못 한 케이스.
          // src attribute 의 URL 로 명시 loadURL 또는 attribute 토글 → 진짜 navigate 트리거.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const wv = document.querySelector<any>('webview[data-testid="onedrive-webview"]');
          if (!wv) {
            window.projk.mcpReply(replyChannel, { ok: false, kind: c.kind, error: 'no webview mounted' });
            return;
          }
          const src = wv.getAttribute('src');
          if (!src) {
            window.projk.mcpReply(replyChannel, { ok: false, kind: c.kind, error: 'webview has no src attribute' });
            return;
          }
          let method = 'unknown';
          if (typeof wv.loadURL === 'function') {
            try { await wv.loadURL(src); method = 'loadURL'; }
            catch (e) {
              // loadURL fail → attribute 토글로 fallback.
              wv.removeAttribute('src');
              setTimeout(() => wv.setAttribute('src', src), 50);
              method = `attr-toggle-after-loadURL-fail:${(e as Error).message.slice(0, 60)}`;
            }
          } else {
            wv.removeAttribute('src');
            setTimeout(() => wv.setAttribute('src', src), 50);
            method = 'attr-toggle';
          }
          window.projk.mcpReply(replyChannel, { ok: true, kind: c.kind, src: src.slice(0, 100), method });
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
    <div
      className="shell"
      data-testid="app-shell"
      style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` } as React.CSSProperties}
    >
      <TitleBar
        sidecar={sidecar}
        breadcrumb={selection ? selection.node.title : '시작하려면 좌측 트리에서 문서를 선택하세요'}
        onOpenSettings={() => setShowCreds(true)}
        onOpenDiagnostics={() => setShowDiagnostics(true)}
      />

      <ActivityBar />

      <aside className="left-sidebar" data-testid="left-sidebar">
        <SidebarHost
          selectedTreeId={selection?.node.id ?? null}
          onOpenSheet={(node) => setSelection({ kind: 'sheet', node })}
          onOpenConfluencePage={(node) => setSelection({ kind: 'confluence', node })}
          selectedThreadId={selectedThreadId}
          onSelectThread={setSelectedThreadId}
          onOpenThreadInEditor={(t) =>
            useWorkbenchStore.getState().openTab({
              kind: 'qna-thread',
              threadId: t.id,
              title: t.title || '(제목 없음)',
            })
          }
          threadsRefreshKey={threadListKey}
        />
        <div
          className={`sidebar-resize-handle${sidebarDragging ? ' dragging' : ''}`}
          data-testid="sidebar-resize-handle"
          onMouseDown={startSidebarResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="사이드바 크기 조절"
        />
      </aside>

      <EditorHost
        confluenceConfigured={!!credsInfo?.hasToken}
        onPromptCreds={() => setShowCreds(true)}
        sheetMappings={sheetMappings}
        onUpsertSheetMapping={onUpsertSheetMapping}
        onMessagesChanged={() => setThreadListKey((k) => k + 1)}
        onOpenHit={onOpenHit}
        onOpenDoc={(d) => {
          // 누적 doc chip 클릭 → 그 문서 탭 추가/focus. selection 갱신만 하면 PR2 sync 가
          // store.openTab 까지 알아서 수행한다 (트리 id 와 doc_id 가 다를 수 있어 가짜 TreeNode 생성).
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

      {showDiagnostics && (
        <DiagnosticsModal
          onClose={() => setShowDiagnostics(false)}
          onOpenSettings={() => {
            setShowDiagnostics(false);
            setShowCreds(true);
          }}
        />
      )}

      <UpdateToast />
      <CommandPalette />
    </div>
  );
}
