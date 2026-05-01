import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../shared/types';
import type {
  AppSettings,
  ConfluenceCreds,
  ThreadBundle,
  ThreadCitation,
  ThreadDocRef,
  ThreadMessage,
  ThreadSummary,
} from '../shared/types';
import { getP4Tree, getConfluenceTree } from './tree';
import { discoverP4Info, listDepotRoots, listDepotChildren } from './p4-discovery';
import { getSidecarStatus, onSidecarStatus, startSidecar } from './sidecar';
import { getConfluenceCreds, setConfluenceCreds } from './auth';
import { applyEditsToConfluencePage, type ChangeItem as ConfluenceChangeItem } from './confluence-apply';
import { getUpdaterState, onUpdaterState, quitAndInstall, checkForUpdate, getLastCheckedAt } from './updater';
import { getSettings, setSettings } from './settings';
import { tryDb } from './db';
import * as threads from './db/threads-db';
import * as onedrive from './onedrive';
import * as onedriveSync from './onedrive-sync';
import { dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.TREE_P4, async () => getP4Tree());
  ipcMain.handle(IPC.TREE_CONFLUENCE, async () => getConfluenceTree());

  ipcMain.handle(IPC.TREE_REFRESH, async () => {
    // Phase 1: just rebuild on demand. chokidar watcher comes later.
    return { p4: await getP4Tree(), confluence: await getConfluenceTree() };
  });

  ipcMain.handle(IPC.SIDECAR_STATUS, async () => getSidecarStatus());

  // /health 를 main 에서 fetch — renderer 에서 직접 fetch 하면 CORS 걸림.
  // 자가테스트 진단용 (assert-tree 회귀 시 어떤 fs 신호가 fail 했는지 보기).
  ipcMain.handle(IPC.SIDECAR_HEALTH, async () => {
    const sc = getSidecarStatus();
    if (sc.state !== 'ready' || sc.port == null) {
      return { ok: false, error: `sidecar not ready (state=${sc.state})` };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${sc.port}/health`, { method: 'GET' });
      if (!res.ok) return { ok: false, error: `http ${res.status}` };
      return { ok: true, body: await res.json() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.CONFLUENCE_CREDS_GET, async () => {
    const creds = await getConfluenceCreds();
    // Don't return the token to the renderer; only signal whether configured.
    return creds ? { email: creds.email, baseUrl: creds.baseUrl, hasToken: true } : null;
  });

  ipcMain.handle(IPC.CONFLUENCE_CREDS_SET, async (_e, creds: ConfluenceCreds) => {
    await setConfluenceCreds(creds);
    return { ok: true };
  });

  // Phase 4-4: Confluence 변경안 적용 (storage format GET → text replace → PUT)
  ipcMain.handle(IPC.CONFLUENCE_APPLY_EDITS, async (_e, pageId: string, changes: ConfluenceChangeItem[]) => {
    return applyEditsToConfluencePage(pageId, changes);
  });

  // Push sidecar status updates to the renderer
  onSidecarStatus((s) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.SIDECAR_STATUS, s);
    }
  });

  // Updater
  ipcMain.handle(IPC.UPDATER_STATE, async () => ({
    state: getUpdaterState(),
    lastCheckedAt: getLastCheckedAt(),
  }));
  ipcMain.handle(IPC.UPDATER_CHECK, async () => {
    await checkForUpdate();
    return { ok: true, lastCheckedAt: getLastCheckedAt() };
  });
  ipcMain.handle(IPC.UPDATER_QUIT_AND_INSTALL, async () => {
    quitAndInstall();
    return { ok: true };
  });
  onUpdaterState((s) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.UPDATER_STATE, s);
    }
  });

  // Settings — 사용자가 SettingsModal 에서 데이터 경로/피드 URL 을 변경하면
  // 즉시 paths/updater 가 새 값을 보고, sidecar 가 fail 상태였다면 재시작.
  // ---------- Threads workspace (Phase 3) ----------
  // DB 가 init 못한 상태면 모든 핸들러가 명확한 error 반환.
  function db() {
    const d = tryDb();
    if (!d) throw new Error('threads-db not ready');
    return d;
  }

  ipcMain.handle(IPC.THREADS_LIST, async (_e, opts?: { includeArchived?: boolean; limit?: number }) => {
    return threads.listThreads(db(), opts ?? {}) as ThreadSummary[];
  });

  ipcMain.handle(IPC.THREADS_CREATE, async (_e, p: { id: string; title: string }) => {
    return threads.createThread(db(), p) as ThreadSummary;
  });

  ipcMain.handle(IPC.THREADS_GET, async (_e, threadId: string): Promise<ThreadBundle | null> => {
    const d = db();
    const thread = threads.getThread(d, threadId) as ThreadSummary | null;
    if (!thread) return null;
    const messages = threads.listMessages(d, threadId) as ThreadMessage[];
    const citations: Record<string, ThreadCitation[]> = {};
    for (const m of messages) {
      citations[m.id] = threads.listCitations(d, m.id) as ThreadCitation[];
    }
    const docs = threads.listThreadDocs(d, threadId) as ThreadDocRef[];
    return { thread, messages, citations, docs };
  });

  ipcMain.handle(IPC.THREADS_RENAME, async (_e, p: { id: string; title: string }) => {
    threads.renameThread(db(), p.id, p.title);
    db().save();
    return { ok: true };
  });

  ipcMain.handle(IPC.THREADS_ARCHIVE, async (_e, id: string) => {
    threads.archiveThread(db(), id);
    db().save();
    return { ok: true };
  });

  ipcMain.handle(IPC.THREADS_DELETE, async (_e, id: string) => {
    threads.deleteThread(db(), id);
    db().save();
    return { ok: true };
  });

  ipcMain.handle(
    IPC.THREADS_APPEND_MESSAGE,
    async (
      _e,
      m: {
        id: string;
        thread_id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        meta_json?: string | null;
        citations?: Omit<ThreadCitation, 'id' | 'message_id'>[];
      },
    ) => {
      const out = threads.appendMessage(db(), {
        ...m,
        meta_json: m.meta_json ?? null,
      });
      db().save();
      return out as ThreadMessage;
    },
  );

  ipcMain.handle(IPC.THREADS_UPSERT_DOC, async (_e, d: Omit<ThreadDocRef, 'added_at'>) => {
    const out = threads.upsertThreadDoc(db(), d);
    db().save();
    return out as ThreadDocRef;
  });

  ipcMain.handle(
    IPC.THREADS_PIN_DOC,
    async (
      _e,
      p: { thread_id: string; doc_id: string; doc_type: 'xlsx' | 'confluence'; pinned: boolean },
    ) => {
      threads.setThreadDocPinned(db(), p.thread_id, p.doc_id, p.doc_type, p.pinned);
      db().save();
      return { ok: true };
    },
  );

  // ---------- OneDrive (PoC 2B — 0.1.45 PKCE) ----------
  // Authorization Code + PKCE: BrowserWindow 안에서 사용자가 로그인 → redirect 캡처 → token.
  // device code flow 가 HYBE Conditional Access 에 막혀 변경됨 (0.1.45).
  let authInFlight = false;
  let lastAuthError: string | null = null;

  ipcMain.handle(IPC.ONEDRIVE_STATUS, async () => {
    return {
      authenticated: await onedrive.isAuthenticated(),
      pollState: authInFlight ? 'pending' : (lastAuthError ? 'error' : 'idle'),
      pollError: lastAuthError,
      challenge: null, // PKCE 흐름은 challenge UI 가 필요 없음 — BrowserWindow 가 직접 띄움.
    };
  });

  ipcMain.handle(IPC.ONEDRIVE_AUTH_START, async () => {
    if (authInFlight) return { ok: false, error: '이미 로그인 진행 중' };
    authInFlight = true;
    lastAuthError = null;
    try {
      await onedrive.interactiveLogin(getWindow());
      authInFlight = false;
      return { ok: true };
    } catch (e) {
      authInFlight = false;
      lastAuthError = (e as Error).message;
      return { ok: false, error: lastAuthError };
    }
  });

  ipcMain.handle(IPC.ONEDRIVE_AUTH_CLEAR, async () => {
    onedrive.clearToken();
    authInFlight = false;
    lastAuthError = null;
    return { ok: true };
  });

  // 사용자 PC 의 .xlsx 1개 file picker 로 선택 → OneDrive upload + share link.
  // PoC 2B (Graph API) — admin consent 막혀 사실상 미사용. PoC 2C 의 sync-folder 우회로 대체.
  ipcMain.handle(IPC.ONEDRIVE_UPLOAD_LOCAL, async (_e, p: { relPath: string }) => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'no window' };
    const result = await dialog.showOpenDialog(win, {
      title: `OneDrive 에 upload 할 .xlsx 선택 — ${p.relPath}`,
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const localPath = result.filePaths[0];
    const buf = readFileSync(localPath);
    try {
      const url = await onedrive.ensureSharedLink(p.relPath, buf);
      return { ok: true, url, fileName: basename(localPath) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ---------- OneDrive Sync 클라이언트 우회 (PoC 2C — 0.1.46+) ----------
  // 사용자 PC 에 깔린 OneDrive Sync 클라이언트가 first-party 라 회사 정책 자동 통과.
  // Klaud 가 sync 폴더에 file 떨어뜨림 → Sync 가 클라우드 upload → 본인용 SharePoint
  // URL (?web=1) 로 webview 임베드. admin consent 불필요.
  ipcMain.handle(IPC.ONEDRIVE_SYNC_DETECT, async () => {
    const account = onedriveSync.detectSyncAccount();
    return account ? { ok: true, ...account } : { ok: false };
  });

  ipcMain.handle(IPC.ONEDRIVE_SYNC_UPLOAD, async (_e, p: { relPath: string }) => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'no window' };
    const result = await dialog.showOpenDialog(win, {
      title: `OneDrive 에 자동 매핑할 .xlsx 선택 — ${p.relPath}`,
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const picked = result.filePaths[0];
    // 0.1.48 — picker path 의 끝부분이 relPath 와 일치하면 그 앞부분이 P4 워크스페이스 root.
    // 예: D:\ProjectK\Design\7_System\PK_HUD 시스템.xlsx + relPath=7_System/PK_HUD 시스템
    //  → P4 root = D:\ProjectK\Design. 한 번만 자동 저장 + sidecar 재시작 → 그 후 모든
    // sheet 가 sidecar /xlsx_raw 로 자동 fetch (file picker X).
    const tail = `${p.relPath.replace(/\//g, '\\')}.xlsx`;
    if (picked.endsWith(tail)) {
      const guessedP4Root = picked.slice(0, picked.length - tail.length).replace(/[\\/]+$/, '');
      const cur = getSettings().p4WorkspaceRoot;
      if (guessedP4Root && cur !== guessedP4Root) {
        setSettings({ p4WorkspaceRoot: guessedP4Root });
        startSidecar().catch((e) => console.error('[settings] sidecar restart failed', e));
      }
    }
    return await onedriveSync.syncUploadAndUrl(picked, p.relPath);
  });

  // 0.1.47 — 사용자 클릭 0회. sidecar 가 P4 원본 .xlsx 보유한다는 가정 하에 자동 fetch.
  ipcMain.handle(IPC.ONEDRIVE_SYNC_AUTO, async (_e, p: { relPath: string }) => {
    const sc = getSidecarStatus();
    if (sc.state !== 'ready' || sc.port == null) {
      return { ok: false, error: `sidecar not ready (state=${sc.state})` };
    }
    const url = `http://127.0.0.1:${sc.port}/xlsx_raw?relPath=${encodeURIComponent(p.relPath)}`;
    return await onedriveSync.syncFromSidecarAndUrl(url, p.relPath);
  });

  // PR9: P4 자동 발견 — p4tickets.txt + login -s + clients 매칭으로 host/user/client 추출.
  // SettingsModal 의 "자동 발견" 버튼이 호출. 실패 시 P4DiscoveryInfo.diagnostics 로 한 줄 안내.
  ipcMain.handle(IPC.P4_DISCOVER, async () => discoverP4Info());

  // PR9b: depot 트리 lazy fetch. P4DepotTree 가 mount 시 root 1회, expand 시 자식 fetch.
  // 둘 다 settings 의 p4Host/p4User/p4Client 사용 — 미설정 시 diagnostics 로 안내.
  ipcMain.handle(IPC.P4_DEPOT_LIST, async () => {
    const s = getSettings();
    return listDepotRoots(s.p4Host ?? '', s.p4User ?? '', s.p4Client ?? '');
  });
  ipcMain.handle(IPC.P4_DEPOT_DIRS, async (_e, parentPath: string) => {
    const s = getSettings();
    return listDepotChildren(s.p4Host ?? '', s.p4User ?? '', s.p4Client ?? '', parentPath);
  });

  ipcMain.handle(IPC.SETTINGS_GET, async () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<AppSettings>) => {
    const next = setSettings(patch);
    // sidecar 가 error 상태이거나 repoRoot 가 새로 들어왔다면 재시작 시도
    const sc = getSidecarStatus();
    if (sc.state === 'error' || sc.state === 'stopped') {
      startSidecar().catch((e) => console.error('[settings] restart sidecar failed', e));
    }
    return next;
  });
}
