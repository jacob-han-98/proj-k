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
import {
  discoverP4Info,
  listDepotRoots,
  listDepotChildren,
  getDepotHeadRevision,
  printDepotFile,
} from './p4-discovery';
import { lookupDepotCache, setDepotCache, listCachedPaths } from './depot-cache';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createHash } from 'node:crypto';
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
  // ---------- frameless window 컨트롤 ----------
  // OS 기본 title bar 를 제거(`frame:false`)했으므로 renderer 의 .topbar 우측에
  // 직접 그린 min/max/close 버튼이 이 IPC 를 호출. invoke 가 아니라 send/on 으로 처리해도
  // 되지만, 결과(예: isMaximized)를 같이 돌려줄 수 있게 invoke 로 통일.
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => {
    getWindow()?.minimize();
  });
  ipcMain.handle(IPC.WINDOW_MAXIMIZE_TOGGLE, () => {
    const w = getWindow();
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => {
    getWindow()?.close();
  });
  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, () => {
    return getWindow()?.isMaximized() ?? false;
  });

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

  // 0.1.50 (Step 1+2) — 매 sheet 클릭 시 호출. mtime 비교 → stale 이면 백그라운드 sync 시작 +
  // 즉시 URL 반환. fresh 면 그냥 URL 반환. 백그라운드 진행상황은 ONEDRIVE_SYNC_PROGRESS 채널로
  // renderer 에 push → renderer 가 자기 webview 에 reload.
  ipcMain.handle(IPC.ONEDRIVE_SYNC_ENSURE_FRESH, async (_e, p: { relPath: string }) => {
    const t0 = Date.now();
    console.log(`[onedrive-sync] ensureFresh request: ${p.relPath}`);
    const sc = getSidecarStatus();
    if (sc.state !== 'ready' || sc.port == null) {
      console.log(`[onedrive-sync] ensureFresh fail: sidecar not ready (state=${sc.state})`);
      return { ok: false, error: `sidecar not ready (state=${sc.state})` };
    }
    const sidecarBase = `http://127.0.0.1:${sc.port}`;
    const r = await onedriveSync.ensureFreshSync(sidecarBase, p.relPath, (ev) => {
      console.log(`[onedrive-sync] progress ${ev.relPath} state=${ev.state}${ev.error ? ' err=' + ev.error : ''}`);
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.ONEDRIVE_SYNC_PROGRESS, ev);
      }
    });
    if (r.ok) {
      console.log(`[onedrive-sync] ensureFresh ok ${Date.now() - t0}ms alreadyFresh=${r.alreadyFresh} syncing=${r.syncing} url=${r.url.slice(0, 80)}...`);
    } else {
      console.log(`[onedrive-sync] ensureFresh fail ${Date.now() - t0}ms: ${r.error}`);
    }
    return r;
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

  // 트리 표시용 — 캐시되어있는 depot path 목록. 트리가 mount/refresh 시 1회 호출 + 파일 클릭 후
  // 1회 (cache 갱신 반영). main 이 manifest 만 읽으므로 p4 호출 없음 → 비용 거의 0.
  ipcMain.handle(IPC.P4_DEPOT_CACHE_LIST, async () => listCachedPaths());

  // PR9c: depot 파일 보기 — `p4 print` 로 download → OneDrive depot 폴더에 upload →
  // 읽기 전용 임베드 URL 반환. revision 캐시 hit 이면 재업로드 skip.
  ipcMain.handle(IPC.P4_DEPOT_OPEN, async (_e, depotPath: string) => {
    const s = getSettings();
    const host = s.p4Host ?? '';
    const user = s.p4User ?? '';
    const client = s.p4Client ?? '';
    if (!host || !user || !client) {
      return { ok: false, error: 'P4 좌표 미설정 — 사이드바의 🔍 자동 발견 먼저 실행하세요.' };
    }
    if (!depotPath) {
      return { ok: false, error: 'depot path 누락' };
    }

    // 1) head revision 조회 — 캐시 키.
    const revision = getDepotHeadRevision(host, user, client, depotPath);
    if (revision == null) {
      return { ok: false, error: `head revision 조회 실패: ${depotPath}` };
    }

    // 2) cache lookup — 같은 (path, revision) 이면 OneDrive 재업로드 skip.
    const cached = lookupDepotCache(depotPath, revision);
    if (cached) {
      return { ok: true, url: cached.url, revision, fromCache: true };
    }

    // 3) cache miss — `p4 print -q -o <tmp>` 로 다운로드 후 OneDrive 폴더 upload.
    const tmpDir = pathJoin(tmpdir(), 'klaud-depot-fetch');
    try {
      mkdirSync(tmpDir, { recursive: true });
    } catch {
      /* 이미 있으면 OK */
    }
    // 임시 파일명: ASCII-only — Korean/공백 chars 가 -o arg 에 들어가면 Windows spawn argv
    // 처리에서 깨져서 p4 가 "Missing/wrong number of arguments" 로 reject. md5 hash 로 deterministic
    // ASCII 파일명 생성 (path → 동일 hash → 같은 tmp 재사용 가능).
    const hash = createHash('md5').update(depotPath).digest('hex').slice(0, 12);
    const tmpLocal = pathJoin(tmpDir, `dep_${hash}_r${revision}.xlsx`);
    console.log(
      `[p4-depot-open] cache miss path=${depotPath} rev=${revision} → printing to ${tmpLocal}`,
    );
    const printR = printDepotFile(host, user, client, depotPath, tmpLocal);
    if (!printR.ok) {
      console.error(`[p4-depot-open] p4 print 실패 path=${depotPath} dest=${tmpLocal}: ${printR.error}`);
      return { ok: false, error: `p4 print 실패: ${printR.error ?? 'unknown'}` };
    }

    console.log(`[p4-depot-open] p4 print OK → uploading to OneDrive (Klaud-depot)…`);
    const upR = await onedriveSync.uploadDepotFileAndUrl(depotPath, tmpLocal);
    if (!upR.ok) {
      console.error(`[p4-depot-open] OneDrive upload 실패 path=${depotPath}: ${upR.error}`);
      return { ok: false, error: `OneDrive 업로드 실패: ${upR.error}` };
    }
    console.log(`[p4-depot-open] OK url=${upR.url}`);

    setDepotCache(depotPath, {
      revision,
      url: upR.url,
      localPath: upR.localPath,
      uploadedAt: Date.now(),
    });
    return { ok: true, url: upR.url, revision, fromCache: false };
  });

  ipcMain.handle(IPC.SETTINGS_GET, async () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<AppSettings>) => {
    const before = getSettings();
    const next = setSettings(patch);
    const sc = getSidecarStatus();
    // sidecar 가 부팅 시 환경변수로 repoRoot / p4WorkspaceRoot 를 읽어 /xlsx_raw 가 사용한다.
    // 정상 ready 상태라도 이 두 값이 바뀌면 재시작해야 새 값이 반영됨.
    const rootChanged =
      (patch.repoRoot !== undefined && before.repoRoot !== next.repoRoot) ||
      (patch.p4WorkspaceRoot !== undefined && before.p4WorkspaceRoot !== next.p4WorkspaceRoot);
    if (sc.state === 'error' || sc.state === 'stopped' || rootChanged) {
      startSidecar().catch((e) => console.error('[settings] restart sidecar failed', e));
    }
    return next;
  });
}
