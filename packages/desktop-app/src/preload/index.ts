import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppSettings,
  type ConfluenceCreds,
  type ConfluenceTreeResult,
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
