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
  printDepotFile,
  listMyOpenedFiles,
} from './p4-discovery';
import { listMyConfluenceDrafts, invalidateConfluenceDraftsCache } from './confluence-drafts';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createHash } from 'node:crypto';
import { getSidecarStatus, onSidecarStatus, startSidecar } from './sidecar';
import { getConfluenceCreds, setConfluenceCreds } from './auth';
import { applyEditsToConfluencePage, preCheckChangesMatch, type ChangeItem as ConfluenceChangeItem } from './confluence-apply';
import { copyPageToTestSpace } from './confluence-copy';
import { getUpdaterState, onUpdaterState, quitAndInstall, checkForUpdate, getLastCheckedAt } from './updater';
import { getSettings, setSettings } from './settings';
import { tryDb } from './db';
import * as threads from './db/threads-db';
import * as onedrive from './onedrive';
import * as onedriveSync from './onedrive-sync';
import { prepareOnlyOfficeViewer } from './onlyoffice-host';
import { recordLog, submitReport } from './klaud-log-sink';
import type { KlaudLogEntry, KlaudReportPayload } from '../shared/types';
import { getCredsInfo as getGoogleCredsInfo, clearGoogleCreds } from './google-auth';
import { interactiveLogin as interactiveGoogleLogin } from './google-oauth';
import { getCredsInfo as getAtlassianCredsInfo, clearAtlassianCreds } from './atlassian-auth';
import { interactiveLogin as interactiveAtlassianLogin } from './atlassian-oauth';
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
    // 자격이 바뀌면 accountId/space-id 캐시 무효화 — 다음 폴링에 새 자격으로 재조회.
    invalidateConfluenceDraftsCache();
    return { ok: true };
  });

  // Phase 4-4: Confluence 변경안 적용 (storage format GET → text replace → PUT)
  ipcMain.handle(IPC.CONFLUENCE_APPLY_EDITS, async (_e, pageId: string, changes: ConfluenceChangeItem[]) => {
    return applyEditsToConfluencePage(pageId, changes);
  });

  // B2-1 (2026-05-03): 운영 페이지 → 테스트 스페이스로 안전 사본. SettingsModal 의
  // confluenceTestSpaceKey 가 설정되어 있어야. 사본은 새 page id 부여 + 자동 탭 open 흐름은
  // renderer 가 처리.
  ipcMain.handle(IPC.CONFLUENCE_COPY_TO_TEST, async (_e, sourcePageId: string) => {
    return copyPageToTestSpace(sourcePageId);
  });

  // B2-3b: 사전 매칭 체크 — Apply 전 ChangesCard 가 호출. storage GET 1회 + 각 change.before
  // 매칭 가능 여부만 반환. 미매칭 row 에 ⚠ badge 표시 + Apply 시 자동 skip.
  ipcMain.handle(IPC.CONFLUENCE_PRECHECK_MATCH, async (_e, pageId: string, changes: Array<{ id: string; before: string }>) => {
    return preCheckChangesMatch(pageId, changes);
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
    console.log(`[onedrive-sync] UPLOAD invoked (file picker open) relPath=${p.relPath}`);
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
    console.log(`[onedrive-sync] AUTO invoked relPath=${p.relPath}`);
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
  ipcMain.handle(IPC.ONEDRIVE_SYNC_ENSURE_FRESH, async (_e, p: { relPath: string; sheetName?: string }) => {
    const t0 = Date.now();
    console.log(`[onedrive-sync] ensureFresh request: ${p.relPath}${p.sheetName ? ` sheet="${p.sheetName}"` : ''}`);
    const sc = getSidecarStatus();
    if (sc.state !== 'ready' || sc.port == null) {
      console.log(`[onedrive-sync] ensureFresh fail: sidecar not ready (state=${sc.state})`);
      return { ok: false, error: `sidecar not ready (state=${sc.state})` };
    }
    const sidecarBase = `http://127.0.0.1:${sc.port}`;
    const r = await onedriveSync.ensureFreshSync(
      sidecarBase,
      p.relPath,
      (ev) => {
        console.log(`[onedrive-sync] progress ${ev.relPath} state=${ev.state}${ev.error ? ' err=' + ev.error : ''}`);
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.ONEDRIVE_SYNC_PROGRESS, ev);
        }
      },
      { sheetName: p.sheetName },
    );
    if (r.ok) {
      const meta = r.status === 'ready' ? '' : ` attempts=${r.pollAttempts} lastStatus=${r.pollLastStatus}`;
      console.log(`[onedrive-sync] ensureFresh ${r.status} ${Date.now() - t0}ms${meta} url=${r.url.slice(0, 80)}...`);
    } else {
      console.log(`[onedrive-sync] ensureFresh fail ${Date.now() - t0}ms: ${r.error}`);
    }
    return r;
  });

  // 0.1.51 — 사용자가 cloud-not-ready 카드의 "재시도" 누르면 호출. 재업로드 없이 SharePoint
  // HEAD 폴링만 다시 한 번. ready:true 면 renderer 가 webview 마운트.
  ipcMain.handle(IPC.ONEDRIVE_SYNC_REPOLL, async (_e, p: { relPath: string }) => {
    const t0 = Date.now();
    console.log(`[onedrive-sync] repoll request: ${p.relPath}`);
    const r = await onedriveSync.repollCloudReady(p.relPath);
    if (r.ok) {
      console.log(`[onedrive-sync] repoll done ${Date.now() - t0}ms ready=${r.ready} attempts=${r.pollAttempts} status=${r.pollLastStatus}`);
    } else {
      console.log(`[onedrive-sync] repoll fail ${Date.now() - t0}ms: ${r.error}`);
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

  // 0.1.52 — depot 파일 보기. 옛 manifest 기반 cache (revision 추적 + listCachedPaths) 모두
  // 제거. 사내 P4 다운로드는 sub-second 라 매번 다시 받아도 비용 거의 없음. OneDrive Sync 가
  // 같은 content 재업로드 skip 처리 — cloud upload 도 첫 번째만 실제로 발생.
  // 흐름: p4 print → 임시 파일 → uploadDepotFileAndUrl (writeViaTempCopy + 강화 poll) → URL.
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

    // 임시 파일명: ASCII-only — Korean/공백 chars 가 -o arg 에 들어가면 Windows spawn argv
    // 처리에서 깨져서 p4 가 "Missing/wrong number of arguments" 로 reject. md5 hash 로
    // deterministic ASCII 파일명 (같은 path → 같은 tmp 재사용 OK).
    const tmpDir = pathJoin(tmpdir(), 'klaud-depot-fetch');
    try {
      mkdirSync(tmpDir, { recursive: true });
    } catch {
      /* 이미 있으면 OK */
    }
    const hash = createHash('md5').update(depotPath).digest('hex').slice(0, 12);
    const tmpLocal = pathJoin(tmpDir, `dep_${hash}.xlsx`);
    console.log(`[p4-depot-open] path=${depotPath} → printing to ${tmpLocal}`);
    const printR = printDepotFile(host, user, client, depotPath, tmpLocal);
    if (!printR.ok) {
      console.error(`[p4-depot-open] p4 print 실패 path=${depotPath} dest=${tmpLocal}: ${printR.error}`);
      return { ok: false, error: `p4 print 실패: ${printR.error ?? 'unknown'}` };
    }

    // PoC 0.1.54: viewerMode='onlyoffice' 면 OneDrive 우회 — p4 print 한 임시파일을 그대로
    // serve.py 에 넘김. 사용자 체감: SharePoint cloud verify-poll (수 초) 도 제거 → 즉시 표시.
    // viewerMode='sp' (또는 미설정 호환) 이면 기존 OneDrive 업로드 흐름.
    if (s.viewerMode === 'onlyoffice') {
      const onlyOfficeUrl = (s.onlyOfficeUrl ?? '').trim();
      if (!onlyOfficeUrl) {
        return { ok: false, error: 'viewerMode=onlyoffice 인데 onlyOfficeUrl 미설정 — Settings 에서 입력' };
      }
      console.log(`[p4-depot-open] OnlyOffice 흐름 — serve.py 에 windows path 직접 전달`);
      const r = await prepareOnlyOfficeViewer({
        windowsXlsxPath: tmpLocal,
        relPath: depotPath.replace(/^\/\//, ''),
        onlyOfficeUrl,
      });
      if (!r.ok) {
        console.error(`[p4-depot-open] OnlyOffice prepare 실패 path=${depotPath}: ${r.error}`);
        return { ok: false, error: `OnlyOffice 준비 실패: ${r.error}` };
      }
      console.log(`[p4-depot-open] OnlyOffice OK url=${r.viewerUrl}`);
      return { ok: true, url: r.viewerUrl, viewerKind: 'onlyoffice' };
    }

    console.log(`[p4-depot-open] p4 print OK → uploading to OneDrive (Klaud-depot)…`);
    const upR = await onedriveSync.uploadDepotFileAndUrl(depotPath, tmpLocal);
    if (!upR.ok) {
      console.error(`[p4-depot-open] OneDrive upload 실패 path=${depotPath}: ${upR.error}`);
      return { ok: false, error: `OneDrive 업로드 실패: ${upR.error}` };
    }
    if (upR.status === 'cloud-not-ready') {
      console.warn(
        `[p4-depot-open] cloud-not-ready path=${depotPath} ` +
        `attempts=${upR.pollAttempts} status=${upR.pollLastStatus} reason=${upR.pollReason ?? '?'}` +
        (upR.pollLastFetchError ? ` lastErr="${upR.pollLastFetchError}"` : ''),
      );
      // 사용자 UI 카드용 메시지에 진단정보 포함 — silent 회귀 방지. attempts/status/reason 모두
      // 한 줄에 노출해 "왜 안 됐나" 즉시 좁힐 수 있게.
      const diag = [
        `${upR.pollAttempts}회 폴링`,
        `status=${upR.pollLastStatus}`,
        `reason=${upR.pollReason ?? '?'}`,
      ];
      if (upR.pollLastFetchError) diag.push(`err=${upR.pollLastFetchError}`);
      return {
        ok: false,
        error: `OneDrive 클라우드 도달 실패 — ${diag.join(', ')}. 잠시 후 재시도.`,
      };
    }
    console.log(`[p4-depot-open] OK url=${upR.url}`);
    return { ok: true, url: upR.url, viewerKind: 'sp' };
  });

  // 액티비티 바 5번 ("내 작업 중 문서") — P4 체크아웃 / Confluence draft.
  // 패널이 보일 때 30s 마다 폴링. 자격이 없으면 ok:false + diagnostics 반환 (UI 안내).
  ipcMain.handle(IPC.ACTIVE_DOCS_P4, async () => {
    const s = getSettings();
    return listMyOpenedFiles(s.p4Host ?? '', s.p4User ?? '', s.p4Client ?? '');
  });
  ipcMain.handle(IPC.ACTIVE_DOCS_CONFLUENCE, async () => {
    const s = getSettings();
    return listMyConfluenceDrafts(s.confluenceDraftSpaceKeys);
  });

  // PoC 0.1.53+ — OnlyOffice viewer prepare. main 이 WSL serve.py 를 spawn/restart 후
  // 임베드 HTML URL 반환 (renderer 가 webview src 에 사용). settings 의 viewerMode='onlyoffice'
  // 일 때만 호출됨. relPath 가 바뀌면 매번 restart (serve.py 단일 인스턴스 — PoC scope).
  ipcMain.handle(IPC.ONLYOFFICE_PREPARE, async (_e, p: { relPath: string; sheetName?: string }) => {
    const t0 = Date.now();
    console.log(`[onlyoffice] prepare request: ${p.relPath}${p.sheetName ? ` sheet="${p.sheetName}"` : ''}`);
    // 사용자가 직접 고칠 수 있는 settings 결함을 먼저 알려준 다음 sidecar 상태 검사.
    const settings = getSettings();
    const onlyOfficeUrl = (settings.onlyOfficeUrl ?? '').trim();
    if (!onlyOfficeUrl) {
      return { ok: false, error: 'onlyOfficeUrl 설정이 비어있음 — Settings 에서 입력' };
    }
    const sc = getSidecarStatus();
    if (sc.state !== 'ready' || sc.port == null) {
      return { ok: false, error: `sidecar not ready (state=${sc.state})` };
    }
    const r = await prepareOnlyOfficeViewer({
      sidecarBaseUrl: `http://127.0.0.1:${sc.port}`,
      relPath: p.relPath,
      sheetName: p.sheetName,
      onlyOfficeUrl,
    });
    // 로컬 sheet 흐름 (sidecar /xlsx_stat 로 windows path 해석) — depot 분기와 함수만 공유.
    if (r.ok) {
      console.log(`[onlyoffice] prepare ok ${Date.now() - t0}ms url=${r.viewerUrl}`);
    } else {
      console.warn(`[onlyoffice] prepare fail ${Date.now() - t0}ms: ${r.error}`);
    }
    return r;
  });

  // 2026-05-13 릴리스-A2: 통합 로그 sink + 제보.
  // renderer 측 console.* / window.error / unhandledrejection / 명시 호출이 모두
  // 이 한 채널로 push. main 의 console 은 log-push.ts 가 mirrorToSink 로 보냄.
  ipcMain.handle(IPC.KLAUD_LOG_PUSH, async (_e, entry: KlaudLogEntry) => {
    // 신뢰 boundary — renderer 에서 들어오는 임의 payload. 최소한의 shape 가드.
    if (!entry || typeof entry !== 'object') return { ok: false };
    if (typeof entry.message !== 'string') return { ok: false };
    const safe: KlaudLogEntry = {
      ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
      source: entry.source === 'sidecar' ? 'sidecar' : entry.source === 'main' ? 'main' : 'renderer',
      level: ['log', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'log',
      tag: typeof entry.tag === 'string' ? entry.tag : '',
      message: entry.message.slice(0, 8192), // 대형 payload 방어.
      extra: entry.extra && typeof entry.extra === 'object' ? entry.extra : undefined,
    };
    recordLog(safe);
    return { ok: true };
  });
  ipcMain.handle(IPC.KLAUD_REPORT_SUBMIT, async (_e, payload: KlaudReportPayload) => {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid payload' };
    const note = typeof payload.note === 'string' ? payload.note : '';
    const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
    const screenshot = typeof payload.screenshotB64 === 'string' ? payload.screenshotB64 : undefined;
    return submitReport({ note, context, screenshotB64: screenshot });
  });
  // 2026-05-13 릴리스-B: Google Workspace SSO.
  ipcMain.handle(IPC.GOOGLE_AUTH_START, async () => {
    const w = getWindow();
    return interactiveGoogleLogin(w);
  });
  ipcMain.handle(IPC.GOOGLE_CREDS_GET, async () => {
    return getGoogleCredsInfo();
  });
  ipcMain.handle(IPC.GOOGLE_SIGN_OUT, async () => {
    await clearGoogleCreds();
    return { ok: true };
  });
  // 2026-05-13 Final-3: Atlassian OAuth 3LO.
  ipcMain.handle(IPC.ATLASSIAN_AUTH_START, async () => {
    const w = getWindow();
    return interactiveAtlassianLogin(w);
  });
  ipcMain.handle(IPC.ATLASSIAN_CREDS_GET, async () => {
    return getAtlassianCredsInfo();
  });
  ipcMain.handle(IPC.ATLASSIAN_SIGN_OUT, async () => {
    await clearAtlassianCreds();
    return { ok: true };
  });

  // 제보 모달이 첨부 체크 시 호출. 1MB 초과 PNG 는 backend storage 부담 + b64 인플레이션
  // 고려해 빈 문자열로 응답 (frontend 가 silent skip — 사용자에게 별도 알림 X).
  ipcMain.handle(IPC.KLAUD_CAPTURE_SCREENSHOT, async () => {
    const w = getWindow();
    if (!w) return { ok: false, reason: 'window unavailable' };
    try {
      const image = await w.webContents.capturePage();
      const png = image.toPNG();
      if (png.length > 1024 * 1024) {
        // 1MB 이상 — backend 권장 한도 초과. 빈 문자열로 반환 (silent skip).
        return { ok: true, screenshotB64: '', bytes: png.length, skipped: true };
      }
      return { ok: true, screenshotB64: png.toString('base64'), bytes: png.length, skipped: false };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
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
