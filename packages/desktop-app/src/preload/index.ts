import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppSettings,
  type ConfluenceCreds,
  type ConfluenceTreeResult,
  type P4DepotResult,
  type P4DepotOpenResult,
  type P4DiscoveryInfo,
  type P4TreeResult,
  type SidecarStatus,
  type ThreadBundle,
  type ThreadCitation,
  type ThreadDocRef,
  type ThreadMessage,
  type ThreadSummary,
  type UpdaterState,
} from '../shared/types';

const api = {
  getP4Tree: (): Promise<P4TreeResult> => ipcRenderer.invoke(IPC.TREE_P4),
  getConfluenceTree: (): Promise<ConfluenceTreeResult> => ipcRenderer.invoke(IPC.TREE_CONFLUENCE),
  refreshTrees: (): Promise<{ p4: P4TreeResult; confluence: ConfluenceTreeResult }> =>
    ipcRenderer.invoke(IPC.TREE_REFRESH),

  getSidecarStatus: (): Promise<SidecarStatus> => ipcRenderer.invoke(IPC.SIDECAR_STATUS),
  getSidecarHealth: (): Promise<{ ok: boolean; body?: unknown; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDECAR_HEALTH),
  onSidecarStatus: (cb: (s: SidecarStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: SidecarStatus) => cb(s);
    ipcRenderer.on(IPC.SIDECAR_STATUS, handler);
    return () => ipcRenderer.off(IPC.SIDECAR_STATUS, handler);
  },

  getConfluenceCreds: (): Promise<{ email: string; baseUrl: string; hasToken: true } | null> =>
    ipcRenderer.invoke(IPC.CONFLUENCE_CREDS_GET),
  setConfluenceCreds: (creds: ConfluenceCreds): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONFLUENCE_CREDS_SET, creds),

  // Phase 4-4: Confluence 변경안 적용
  confluenceApplyEdits: (
    pageId: string,
    changes: Array<{ id: string; before: string; after: string; description?: string; section?: string }>,
  ): Promise<{ ok: boolean; applied: number; skipped: number; skippedIds: string[]; pageUrl?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CONFLUENCE_APPLY_EDITS, pageId, changes),

  // B2-1: 운영 페이지 → 테스트 스페이스 안전 사본. 새 page 생성 후 id/url 반환.
  confluenceCopyToTest: (
    sourcePageId: string,
  ): Promise<
    | { ok: true; newPageId: string; newPageUrl: string; newTitle: string; spaceKey: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.CONFLUENCE_COPY_TO_TEST, sourcePageId),

  // B2-3b: 사전 매칭 체크 — Apply 전 storage 한 번 GET + 각 change.before 매칭 가능 여부 반환.
  confluencePrecheckMatch: (
    pageId: string,
    changes: Array<{ id: string; before: string }>,
  ): Promise<{ ok: boolean; matched: string[]; unmatched: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC.CONFLUENCE_PRECHECK_MATCH, pageId, changes),

  getUpdaterState: (): Promise<{ state: UpdaterState; lastCheckedAt: number | null }> =>
    ipcRenderer.invoke(IPC.UPDATER_STATE),
  onUpdaterState: (cb: (s: UpdaterState) => void): (() => void) => {
    const handler = (_e: unknown, s: UpdaterState) => cb(s);
    ipcRenderer.on(IPC.UPDATER_STATE, handler);
    return () => ipcRenderer.off(IPC.UPDATER_STATE, handler);
  },
  checkForUpdate: (): Promise<{ ok: boolean; lastCheckedAt: number | null }> =>
    ipcRenderer.invoke(IPC.UPDATER_CHECK),
  quitAndInstall: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.UPDATER_QUIT_AND_INSTALL),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, patch),

  // PR9: Perforce 좌표 자동 발견. SettingsModal 의 "자동 발견" 버튼이 호출.
  // ok=true 면 host/user/client 가 채워진다. ok=false 면 diagnostics 한 줄로 사용자에게 안내.
  // PR9b: depot 트리 lazy fetch. P4DepotTree 가 mount 시 root, expand 시 자식.
  p4: {
    discover: (): Promise<P4DiscoveryInfo> => ipcRenderer.invoke(IPC.P4_DISCOVER),
    depotRoots: (): Promise<P4DepotResult> => ipcRenderer.invoke(IPC.P4_DEPOT_LIST),
    depotDirs: (parentPath: string): Promise<P4DepotResult> =>
      ipcRenderer.invoke(IPC.P4_DEPOT_DIRS, parentPath),
    // PR9c: depot 파일 보기 — head revision 캐시 키. fromCache 면 OneDrive 재업로드 skip.
    openDepotFile: (depotPath: string): Promise<P4DepotOpenResult> =>
      ipcRenderer.invoke(IPC.P4_DEPOT_OPEN, depotPath),
    // 트리 표시용 — 캐시되어있는 depot 파일 목록 (manifest read only, p4 호출 없음).
    cachedPaths: (): Promise<Array<{ path: string; revision: number }>> =>
      ipcRenderer.invoke(IPC.P4_DEPOT_CACHE_LIST),
  },

  // ---------- frameless window 컨트롤 ----------
  // OS 기본 title bar 가 사라졌으므로 renderer 의 .topbar 우측 버튼이 호출.
  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
    maximizeToggle: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE_TOGGLE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_e: unknown, m: boolean) => cb(m);
      ipcRenderer.on(IPC.WINDOW_MAXIMIZED, handler);
      return () => ipcRenderer.off(IPC.WINDOW_MAXIMIZED, handler);
    },
  },

  // mcp-bridge 가 보내는 명령을 renderer 가 수신하기 위한 hook.
  // payload = { cmd: McpCommand, replyChannel: string }. renderer 는 cmd 수행 후
  // mcpReply(replyChannel, meta) 로 main 에 결과 회신.
  // (기존 selftestReply / onSelfTestCommand 의 후속 — 0.1.22 부터)
  onMcpCommand: (cb: (payload: { cmd: unknown; replyChannel: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { cmd: unknown; replyChannel: string }) => cb(payload);
    ipcRenderer.on('mcp:cmd', handler);
    return () => ipcRenderer.off('mcp:cmd', handler);
  },
  mcpReply: (replyChannel: string, meta?: unknown): void => {
    ipcRenderer.send(replyChannel, meta ?? {});
  },

  // ---------- OneDrive Graph API (PoC 2B — admin consent 막혀 미사용, 후순위) ----------
  oneDrive: {
    status: (): Promise<{
      authenticated: boolean;
      pollState: 'idle' | 'pending' | 'success' | 'error';
      pollError: string | null;
      challenge: null;
    }> => ipcRenderer.invoke(IPC.ONEDRIVE_STATUS),
    authStart: (): Promise<
      | { ok: true }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.ONEDRIVE_AUTH_START),
    authClear: (): Promise<{ ok: true }> => ipcRenderer.invoke(IPC.ONEDRIVE_AUTH_CLEAR),
    uploadLocal: (relPath: string): Promise<
      | { ok: true; url: string; fileName: string }
      | { ok: false; error?: string; canceled?: boolean }
    > => ipcRenderer.invoke(IPC.ONEDRIVE_UPLOAD_LOCAL, { relPath }),
  },

  // ---------- OneDrive Sync 클라이언트 우회 (PoC 2C — 0.1.46+) ----------
  oneDriveSync: {
    detect: (): Promise<
      | { ok: true; userFolder: string; userUrl: string; spoResourceId: string; userEmail: string }
      | { ok: false }
    > => ipcRenderer.invoke(IPC.ONEDRIVE_SYNC_DETECT),
    upload: (relPath: string): Promise<
      | { ok: true; url: string; localPath: string; account: { userEmail: string } }
      | { ok: false; error?: string; canceled?: boolean }
    > => ipcRenderer.invoke(IPC.ONEDRIVE_SYNC_UPLOAD, { relPath }),
    // 0.1.47 — sidecar /xlsx_raw 에서 자동 fetch. file picker 없음.
    auto: (relPath: string): Promise<
      | { ok: true; url: string; localPath: string; account: { userEmail: string } }
      | { ok: false; error?: string }
    > => ipcRenderer.invoke(IPC.ONEDRIVE_SYNC_AUTO, { relPath }),
    // 0.1.50 (Step 1+2) — 매 sheet 클릭 시 호출. mtime 비교 → stale 이면 백그라운드 sync.
    // 즉시 URL 반환 + 백그라운드 진행은 onProgress 로 push.
    ensureFresh: (relPath: string): Promise<
      | { ok: true; url: string; alreadyFresh: boolean; syncing: boolean }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC.ONEDRIVE_SYNC_ENSURE_FRESH, { relPath }),
    // main → renderer push. 백그라운드 sync 의 시작/완료/실패 통지.
    onProgress: (cb: (ev: { relPath: string; state: 'started' | 'completed' | 'failed'; error?: string }) => void): (() => void) => {
      const handler = (_e: unknown, ev: { relPath: string; state: 'started' | 'completed' | 'failed'; error?: string }) => cb(ev);
      ipcRenderer.on(IPC.ONEDRIVE_SYNC_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.ONEDRIVE_SYNC_PROGRESS, handler);
    },
  },

  // ---------- Threads workspace (Phase 3) ----------
  threads: {
    list: (opts?: { includeArchived?: boolean; limit?: number }): Promise<ThreadSummary[]> =>
      ipcRenderer.invoke(IPC.THREADS_LIST, opts),
    create: (p: { id: string; title: string }): Promise<ThreadSummary> =>
      ipcRenderer.invoke(IPC.THREADS_CREATE, p),
    get: (threadId: string): Promise<ThreadBundle | null> =>
      ipcRenderer.invoke(IPC.THREADS_GET, threadId),
    rename: (p: { id: string; title: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.THREADS_RENAME, p),
    archive: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.THREADS_ARCHIVE, id),
    delete: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.THREADS_DELETE, id),
    appendMessage: (m: {
      id: string;
      thread_id: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      meta_json?: string | null;
      citations?: Omit<ThreadCitation, 'id' | 'message_id'>[];
    }): Promise<ThreadMessage> => ipcRenderer.invoke(IPC.THREADS_APPEND_MESSAGE, m),
    upsertDoc: (d: Omit<ThreadDocRef, 'added_at'>): Promise<ThreadDocRef> =>
      ipcRenderer.invoke(IPC.THREADS_UPSERT_DOC, d),
    pinDoc: (p: {
      thread_id: string;
      doc_id: string;
      doc_type: 'xlsx' | 'confluence';
      pinned: boolean;
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.THREADS_PIN_DOC, p),
  },
};

contextBridge.exposeInMainWorld('projk', api);

export type ProjkApi = typeof api;
