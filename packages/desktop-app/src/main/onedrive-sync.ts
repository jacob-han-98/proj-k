// OneDrive Business sync 폴더 자동 탐지 + file 복사 + 본인용 SharePoint URL 빌드.
// 0.1.46 (PoC 2C) — Graph API admin consent 우회. Sync 클라이언트는 Microsoft first-party
// 라 회사 정책 통과. 사용자 본인용 SharePoint URL (?web=1) 로 webview 임베드하면 사내 SSO
// 가 자동 통과 (Confluence webview 와 동일 패턴).

import { execSync } from 'node:child_process';
import { copyFile, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const KLAUD_TEMP_DIR = 'Klaud-temp';
// P4 depot 보기용 별도 폴더 — 사용자가 P4 sync 한 local 파일 (`Klaud-temp`) 과 시각·구조적으로
// 분리. 같은 path 라도 depot 의 head revision 이 바뀌면 OneDrive 본문도 갱신.
const KLAUD_DEPOT_DIR = 'Klaud-depot';

export interface OneDriveSyncAccount {
  userFolder: string;     // C:\Users\jacob\OneDrive - BigHit Entertainment Co.,Ltd
  userUrl: string;        // https://bhunion-my.sharepoint.com/personal/jacob_hybecorp_com (URL 빌드용)
  spoResourceId: string;  // GUID — Graph API용. URL 빌드에 사용 X.
  userEmail: string;      // jacob@hybecorp.com
}

function readReg(key: string, value: string): string | null {
  try {
    const out = execSync(`reg query "${key}" /v "${value}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // reg query 출력 포맷: "    UserFolder    REG_SZ    C:\Users\..."
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s+REG_\\w+\\s+(.+)$`, 'm');
    const m = out.match(re);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// HKCU\Software\Microsoft\OneDrive\Accounts\Business1 — 사용자 PC 의 사내 OneDrive 정보.
// 여러 business account 등록 가능하나 PoC 는 Business1 우선 + 못 찾으면 Business2~5 시도.
//
// userUrl 추정 우선순위 (OneDrive 빌드/계정 유형마다 어떤 키가 채워지는지 다름):
//   1) UserUrl       — 가장 직접적. https://<tenant>-my.sharepoint.com/personal/<upn>
//   2) ServiceEndpointUri — UserUrl 이 비어있는 PC 에서 채워짐. 끝의 `/_api` 만 떼면 동일.
//   3) SPOResourceId + UserEmail 조합 — 위 둘 다 없을 때 마지막 fallback. tenant 와 UPN 으로
//      직접 build. UPN 변환: `jacob@hybecorp.com` → `jacob_hybecorp_com` (`@` 와 `.` 를 `_` 로).
export function detectSyncAccount(): OneDriveSyncAccount | null {
  if (process.platform !== 'win32') return null;
  for (let i = 1; i <= 5; i++) {
    const base = `HKCU\\Software\\Microsoft\\OneDrive\\Accounts\\Business${i}`;
    const userFolder = readReg(base, 'UserFolder');
    const userEmail = readReg(base, 'UserEmail');
    const userUrl = resolveUserUrl(base, userEmail);
    // SPOResourceId 는 보통 tenant URL — diagnostic 용.
    const spoResourceId = readReg(base, 'SPOResourceId') ?? '';
    if (userFolder && userUrl && userEmail) {
      return { userFolder, userUrl, spoResourceId, userEmail };
    }
  }
  return null;
}

function resolveUserUrl(base: string, userEmail: string | null): string | null {
  // 1) UserUrl. `:443` 포트 명시는 SharePoint Doc.aspx redirect 가 가끔 깨뜨려서 제거.
  const rawUserUrl = readReg(base, 'UserUrl');
  if (rawUserUrl) {
    return rawUserUrl.replace(/^(https:\/\/[^/:]+):443/, '$1').replace(/\/+$/, '');
  }
  // 2) ServiceEndpointUri 형태: https://<tenant>-my.sharepoint.com/personal/<upn>/_api
  const svc = readReg(base, 'ServiceEndpointUri');
  if (svc) {
    return svc.replace(/\/_api\/?$/i, '').replace(/\/+$/, '');
  }
  // 3) SPOResourceId + UserEmail. SPOResourceId 형태: https://<tenant>-my.sharepoint.com/
  const spo = readReg(base, 'SPOResourceId');
  if (spo && userEmail) {
    const upn = userEmail.replace('@', '_').replace(/\./g, '_');
    return `${spo.replace(/\/+$/, '')}/personal/${upn}`;
  }
  return null;
}

function buildEmbedUrl(account: OneDriveSyncAccount, relPath: string): string {
  const encodedRelPath = relPath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  // userUrl = https://bhunion-my.sharepoint.com/personal/jacob_hybecorp_com
  // 결과: <userUrl>/Documents/Klaud-temp/<relPath>.xlsx?web=1
  //
  // ?web=1 — SharePoint 가 사용자 본인 자격 SSO 로 Doc.aspx + sourcedoc GUID redirect.
  // 0.1.49 까지 정상 동작했던 흐름. ?action=embedview 미니 임베드 시도가 사용자 환경에서
  // file download 응답 받는 회귀 발생해 보류.
  return `${account.userUrl}/Documents/${KLAUD_TEMP_DIR}/${encodedRelPath}.xlsx?web=1`;
}

// SharePoint HEAD-poll — file 이 클라우드 도달했는지 능동 확인. 옛 hardcoded
// sleep (15~25s) 모두 이걸로 대체. 작은 파일은 1~3초 만에 통과, 큰 파일도 정확히 도달
// 시점에 ready → 호출자가 곧바로 webview 띄움. 사용자 체감 빠름.
//
// 동작:
//   1) 초기 1초 대기 (OneDrive Sync 클라이언트가 새 파일 인지하고 upload 시작할 시간).
//   2) persist:onedrive partition session 의 fetch 로 HEAD `${userUrl}/Documents/Klaud-temp/<rel>.xlsx`.
//      cookies 는 webview 와 공유 → SSO 자동 통과 (사용자가 한 번이라도 webview 띄웠다면).
//   3) 1s/1.5s/2s/2.5s/3s 백오프 polling, 3s cap.
//   4) 성공 조건:
//      - status 200: raw file 직접 서빙 (드물지만 가능)
//      - status 3xx + Location 이 *.sharepoint.com (Doc.aspx) — file 존재해서 view URL 로 redirect
//      - 단 login.microsoftonline.com 로의 redirect 는 unauth — file 존재 여부 못 판단, 폴링 계속
//   5) 실패 (404 / 네트워크 에러) — 폴링 계속.
//   6) maxMs 초과 → ready:false 반환. 호출자는 그냥 진행 (사용자 webview 가 어차피 SP 응답 받음).
export interface PollSpReadyResult {
  ready: boolean;
  elapsedMs: number;
  attempts: number;
  lastStatus: number | null;
  reason: 'http-200' | 'sp-redirect' | 'timeout' | 'no-attempts';
}

export interface PollSpReadyOptions {
  // 초기 대기 — OneDrive Sync 가 새 파일 인지하고 upload 시작할 시간. default 1000.
  initialDelayMs?: number;
  // backoff 시작값 (delay = base + (attempts-1)*0.5*base, cap 적용). default 1000.
  baseBackoffMs?: number;
  // backoff 상한. default 3000.
  maxBackoffMs?: number;
  // 전체 최대 대기 시간. default 30000.
  maxMs?: number;
}

// 테스트가 주입하는 timing override. production 에서는 절대 set 안 함.
let pollOptionsOverride: PollSpReadyOptions | null = null;
export function __setPollOptionsForTests(opts: PollSpReadyOptions | null): void {
  pollOptionsOverride = opts;
}

async function pollSharePointReady(
  account: OneDriveSyncAccount,
  folder: string,
  relPath: string,
  options: PollSpReadyOptions = {},
): Promise<PollSpReadyResult> {
  const merged = { ...options, ...(pollOptionsOverride ?? {}) };
  const initialDelayMs = merged.initialDelayMs ?? 1000;
  const baseBackoffMs = merged.baseBackoffMs ?? 1000;
  const maxBackoffMs = merged.maxBackoffMs ?? 3000;
  const maxMs = merged.maxMs ?? 30_000;

  const { session } = await import('electron');
  const onedriveSession = session.fromPartition('persist:onedrive');
  const encodedRelPath = relPath.split('/').map(encodeURIComponent).join('/');
  const checkUrl = `${account.userUrl}/Documents/${folder}/${encodedRelPath}.xlsx`;

  const t0 = Date.now();
  let attempts = 0;
  let lastStatus: number | null = null;

  // 초기 대기 — OneDrive Sync 가 새 파일 감지하고 upload 시작할 시간. 이거 없으면 첫 폴링이
  // 무조건 404 받고 backoff 시작 → 오히려 느려질 수 있음.
  if (initialDelayMs > 0) {
    await new Promise((r) => setTimeout(r, initialDelayMs));
  }

  while (Date.now() - t0 < maxMs) {
    attempts++;
    let location: string | null = null;
    try {
      const res = await onedriveSession.fetch(checkUrl, {
        method: 'HEAD',
        redirect: 'manual',
      });
      lastStatus = res.status;
      location = res.headers.get('location');

      const isAuthRedirect = !!location && (
        location.includes('login.microsoftonline.com') ||
        location.includes('login.live.com') ||
        location.includes('/_layouts/15/Authenticate')
      );

      if (res.status === 200) {
        return { ready: true, elapsedMs: Date.now() - t0, attempts, lastStatus, reason: 'http-200' };
      }
      if (res.status >= 300 && res.status < 400 && !isAuthRedirect) {
        return { ready: true, elapsedMs: Date.now() - t0, attempts, lastStatus, reason: 'sp-redirect' };
      }
      // 404 / auth-redirect / 기타 — 폴링 계속.
    } catch {
      lastStatus = -1;
    }

    const delay = Math.min(baseBackoffMs + (attempts - 1) * (baseBackoffMs / 2), maxBackoffMs);
    if (Date.now() - t0 + delay > maxMs) break;
    await new Promise((r) => setTimeout(r, delay));
  }

  return {
    ready: false,
    elapsedMs: Date.now() - t0,
    attempts,
    lastStatus,
    reason: attempts === 0 ? 'no-attempts' : 'timeout',
  };
}

// PoC 2B 흐름 — 사용자가 file picker 로 직접 .xlsx 선택한 경로.
export async function syncUploadAndUrl(
  localXlsxPath: string,
  relPath: string,
): Promise<
  | { ok: true; url: string; localPath: string; account: OneDriveSyncAccount }
  | { ok: false; error: string }
> {
  const account = detectSyncAccount();
  if (!account) {
    return { ok: false, error: 'OneDrive Business sync 클라이언트 미설정' };
  }
  if (!existsSync(localXlsxPath)) {
    return { ok: false, error: `원본 파일 없음: ${localXlsxPath}` };
  }
  const dest = join(account.userFolder, KLAUD_TEMP_DIR, `${relPath}.xlsx`);
  let srcMtimeMs: number | null = null;
  try {
    const s = await stat(localXlsxPath);
    srcMtimeMs = s?.mtimeMs ?? null;
  } catch { /* fallback to null */ }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(localXlsxPath, dest);
    // mtime 동기화 — copyFile 은 default 로 dest mtime 을 현재 시각으로 셋. 다음번 ensureFresh
    // 의 stale 판정 정확성 위해 src mtime 으로 맞춤.
    if (srcMtimeMs != null) await setDestMtime(dest, srcMtimeMs);
  } catch (e) {
    return { ok: false, error: `sync 폴더 복사 실패: ${(e as Error).message}` };
  }
  const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath);
  console.log(`[onedrive-sync] sp-poll(upload) ${relPath} ready=${poll.ready} ${poll.elapsedMs}ms attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason}`);
  return { ok: true, url: buildEmbedUrl(account, relPath), localPath: dest, account };
}

// 0.1.47 (PoC 2C) — 사용자 클릭 0회. sidecar /xlsx_raw 에서 P4 원본 자동 fetch
// → OneDrive Sync 폴더에 write → 본인용 SharePoint URL.
export async function syncFromSidecarAndUrl(
  sidecarUrl: string,
  relPath: string,
): Promise<
  | { ok: true; url: string; localPath: string; account: OneDriveSyncAccount }
  | { ok: false; error: string }
> {
  const account = detectSyncAccount();
  if (!account) {
    return { ok: false, error: 'OneDrive Business sync 클라이언트 미설정' };
  }
  let buf: Buffer;
  let srcMtimeMs: number | null = null;
  try {
    const res = await fetch(sidecarUrl);
    if (!res.ok) {
      return { ok: false, error: `sidecar 다운로드 실패 ${res.status}: ${await res.text()}` };
    }
    // FileResponse 의 Last-Modified 헤더로 src mtime 회수 — utimes 동기화용.
    const lm = res.headers.get('last-modified');
    if (lm) {
      const t = Date.parse(lm);
      if (!Number.isNaN(t)) srcMtimeMs = t;
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `sidecar 다운로드 예외: ${(e as Error).message}` };
  }
  const dest = join(account.userFolder, KLAUD_TEMP_DIR, `${relPath}.xlsx`);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    if (srcMtimeMs != null) await setDestMtime(dest, srcMtimeMs);
  } catch (e) {
    return { ok: false, error: `sync 폴더 write 실패: ${(e as Error).message}` };
  }
  const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath);
  console.log(`[onedrive-sync] sp-poll(auto) ${relPath} ready=${poll.ready} ${poll.elapsedMs}ms attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason}`);
  return { ok: true, url: buildEmbedUrl(account, relPath), localPath: dest, account };
}

// P4 depot 보기용 임베드 URL — 기본은 미니 임베드 뷰.
// `?action=embedview` → Excel for the Web 이 미니 read-only 임베드 (SuiteNav + 리본 모두
// 숨김). depot 은 P4 가 진실의 원천이라 사용자가 임베드 안에서 편집해도 P4 에 반영 안 됨 —
// 사용자가 ✏ 아이콘으로 편집을 명시 토글했을 때만 renderer 가 'edit' 로 swap (그래도 결과는
// OneDrive 카피만 변경, P4 영향 없음 → 향후 P4 checkout 흐름 별도).
function buildDepotEmbedUrl(account: OneDriveSyncAccount, depotRelPath: string): string {
  const encoded = depotRelPath.split('/').map(encodeURIComponent).join('/');
  // ?web=1 — local sheet 와 동일. embedview 회귀 보류.
  return `${account.userUrl}/Documents/${KLAUD_DEPOT_DIR}/${encoded}.xlsx?web=1`;
}

// depot path (예: '//main/ProjectK/Design/7_System/PK_HUD.xlsx') → OneDrive 폴더 안의 상대 경로.
// '//' prefix 와 '.xlsx' 확장자 제거 → 'main/ProjectK/Design/7_System/PK_HUD'. URL 빌더가 다시 .xlsx 붙임.
function depotPathToRel(depotPath: string): string {
  return depotPath.replace(/^\/\//, '').replace(/\.xlsx$/i, '');
}

// 0.1.50 (Step 1+2) — 매 sheet 클릭 시 호출되는 "make-it-fresh" 진입점.
//
// 동작:
//   1) src(P4 워크스페이스) 와 dest(OneDrive sync 폴더) 의 mtime 을 비교.
//   2) dest 가 없거나 src 보다 옛것이면 → 백그라운드 sync 시작 (fire-and-forget).
//   3) 즉시 webview 에 사용할 URL 반환 (alreadyFresh 플래그로 백그라운드 sync 동작 여부 알림).
//   4) 백그라운드 sync 의 시작/완료/실패는 onProgress 콜백으로 push → renderer 가 webview reload.
//
// 사용자 체감: 두 번째부터의 클릭은 즉시 webview 열림. P4 에서 수정한 파일은 자동으로 클라우드에
// 갱신되어 사용자가 따로 챙길 일 없음.
//
// 동시성: 같은 relPath 로 여러 번 빠르게 호출되는 케이스 (사용자가 다른 sheet 갔다가 다시 옴) 는
// 한 번의 sync 만 진행하도록 inflight Set 으로 관리.

const inflight = new Set<string>();

export interface SyncProgressEvent {
  relPath: string;
  state: 'started' | 'completed' | 'failed';
  error?: string;
}

interface SrcStat {
  mtimeMs: number;
  size: number;
}

async function readSrcStat(sidecarBaseUrl: string, relPath: string): Promise<SrcStat | null> {
  try {
    const res = await fetch(`${sidecarBaseUrl}/xlsx_stat?relPath=${encodeURIComponent(relPath)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { mtime_ms?: number; size?: number };
    if (typeof j.mtime_ms !== 'number') return null;
    return { mtimeMs: j.mtime_ms, size: typeof j.size === 'number' ? j.size : -1 };
  } catch {
    return null;
  }
}

interface DestStat {
  mtimeMs: number;
  size: number;
}

async function readDestStat(destPath: string): Promise<DestStat | null> {
  try {
    const s = await stat(destPath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

// dest 의 mtime 을 src 와 동일하게 맞춤. 이 동기화 없이는 다음과 같은 회귀 발생:
// dest mtime = writeFile 시각 (현재 시각) → src mtime (P4 워크스페이스의 P4 commit 시각)
// 보다 항상 더 새것 → ensureFreshSync 가 stale 판정 안 하고 재다운로드 X.
// 만약 옛 dest 가 partial/잘못된 파일이면 영영 그대로 남음 (실측: PK_단축키 시스템 6KB 회귀).
async function setDestMtime(destPath: string, srcMtimeMs: number): Promise<void> {
  const t = new Date(srcMtimeMs);
  try {
    await utimes(destPath, t, t);
  } catch (e) {
    // utimes 실패해도 main 흐름은 성공으로 처리. 다음번 ensureFresh 가 size 비교로 detect 가능.
    console.warn(`[onedrive-sync] utimes 실패 ${destPath}: ${(e as Error).message}`);
  }
}

async function backgroundSync(
  sidecarBaseUrl: string,
  account: OneDriveSyncAccount,
  relPath: string,
  dest: string,
  srcMtimeMs: number,
  onProgress: (e: SyncProgressEvent) => void,
): Promise<void> {
  // inflight 는 ensureFreshSync 진입 시 이미 추가됨 (race 회피). 여기서 중복 add 안 함.
  onProgress({ relPath, state: 'started' });
  try {
    const res = await fetch(`${sidecarBaseUrl}/xlsx_raw?relPath=${encodeURIComponent(relPath)}`);
    if (!res.ok) throw new Error(`sidecar ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    // mtime 동기화 — src(P4 워크스페이스) 의 mtime 으로 dest 를 맞춤. 이게 없으면 다음번
    // ensureFreshSync 가 항상 dest 가 더 새것이라 판정해서 stale=false → 잘못된 파일 영구.
    await setDestMtime(dest, srcMtimeMs);
    console.log(
      `[onedrive-sync] write+mtime-sync ${relPath} bytes=${buf.length} mtime=${new Date(srcMtimeMs).toISOString()}`,
    );
    // SharePoint 능동 polling — 작은 파일은 수초 만에 ready, 큰 파일은 정확히 도달 시점.
    // 옛 hardcoded 25s sleep 대체. timeout (30s) 시점엔 그냥 진행 — webview 는 어차피
    // 사용자 SSO chain 이 끝나면 SharePoint 응답 받음.
    const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath);
    console.log(
      `[onedrive-sync] sp-poll ${relPath} ready=${poll.ready} ${poll.elapsedMs}ms ` +
      `attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason}`,
    );
    onProgress({ relPath, state: 'completed' });
  } catch (e) {
    onProgress({ relPath, state: 'failed', error: (e as Error).message });
  } finally {
    inflight.delete(relPath);
  }
}

export async function ensureFreshSync(
  sidecarBaseUrl: string,
  relPath: string,
  onProgress: (e: SyncProgressEvent) => void,
): Promise<
  | { ok: true; url: string; alreadyFresh: boolean; syncing: boolean }
  | { ok: false; error: string }
> {
  const account = detectSyncAccount();
  if (!account) {
    return { ok: false, error: 'OneDrive Business sync 클라이언트 미설정' };
  }
  const dest = join(account.userFolder, KLAUD_TEMP_DIR, `${relPath}.xlsx`);
  const url = buildEmbedUrl(account, relPath);

  // 이미 sync 중이면 재진입하지 않음. URL 만 반환하고 syncing: true 표시.
  // 진입 즉시 inflight 추가 — React StrictMode (dev) 가 useEffect 를 2번 호출해서 ensureFresh
  // 가 거의 동시에 두 번 들어와도 두 번째는 여기서 빠르게 early-return 한다. mtime 비교 await
  // 이전에 add 해야 두 번째 호출이 비교 단계까지 가지 않음.
  if (inflight.has(relPath)) {
    return { ok: true, url, alreadyFresh: false, syncing: true };
  }
  inflight.add(relPath);
  let releaseInflight = true;

  try {
    const [srcStat, destStat] = await Promise.all([
      readSrcStat(sidecarBaseUrl, relPath),
      readDestStat(dest),
    ]);

    // src 를 못 찾으면 sync 가 의미 없음. 매핑된 옛 cloud 본문이라도 즉시 반환.
    if (srcStat == null) {
      return { ok: true, url, alreadyFresh: true, syncing: false };
    }

    // stale 판정: dest 가 없거나, src 가 더 새것이거나, size 가 다르면.
    // size 비교가 핵심 — 옛 backgroundSync 는 dest mtime 을 *write 시각* 으로 박아서
    // 항상 dest 가 src 보다 새것 → stale=false → 옛 partial 파일 영구. 이번 fix 로 mtime 도
    // src 와 동기화하지만, 기존 OneDrive 에 잘못 들어간 파일을 detect 하려면 size 도 봐야.
    // tolerance 1초 (NTFS mtime 어긋남 회피).
    const stale =
      destStat == null
      || srcStat.mtimeMs > destStat.mtimeMs + 1000
      || (srcStat.size >= 0 && srcStat.size !== destStat.size);
    if (!stale) {
      return { ok: true, url, alreadyFresh: true, syncing: false };
    }

    if (destStat != null) {
      const reason: string[] = [];
      if (srcStat.mtimeMs > destStat.mtimeMs + 1000) reason.push('mtime');
      if (srcStat.size >= 0 && srcStat.size !== destStat.size) reason.push(`size(src=${srcStat.size},dest=${destStat.size})`);
      console.log(`[onedrive-sync] stale ${relPath} → ${reason.join(',')}`);
    }

    // 백그라운드 sync 시작 — backgroundSync 가 finally 에서 inflight.delete.
    releaseInflight = false;
    void backgroundSync(sidecarBaseUrl, account, relPath, dest, srcStat.mtimeMs, onProgress).finally(() => {
      inflight.delete(relPath);
    });
    return { ok: true, url, alreadyFresh: false, syncing: true };
  } finally {
    if (releaseInflight) inflight.delete(relPath);
  }
}

// 한 depot 파일을 OneDrive depot 폴더에 업로드 + 읽기 전용 URL 반환.
// localXlsxPath 는 호출자가 미리 `p4 print -q -o <localXlsxPath> <depotPath>` 로 받아둔 임시 파일.
export async function uploadDepotFileAndUrl(
  depotPath: string,
  localXlsxPath: string,
): Promise<
  | { ok: true; url: string; localPath: string; account: OneDriveSyncAccount }
  | { ok: false; error: string }
> {
  const account = detectSyncAccount();
  if (!account) {
    return { ok: false, error: 'OneDrive Business sync 클라이언트 미설정' };
  }
  if (!existsSync(localXlsxPath)) {
    return { ok: false, error: `다운로드된 임시 파일 없음: ${localXlsxPath}` };
  }
  const rel = depotPathToRel(depotPath);
  const dest = join(account.userFolder, KLAUD_DEPOT_DIR, `${rel}.xlsx`);
  let srcMtimeMs: number | null = null;
  try {
    const s = await stat(localXlsxPath);
    srcMtimeMs = s?.mtimeMs ?? null;
  } catch { /* fallback */ }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(localXlsxPath, dest);
    // depot 흐름의 임시 파일 mtime 은 `p4 print -o` 의 다운로드 시각 — P4 commit 시각이 아님.
    // Phase 2 (다음 PR) 에서 p4 fstat headTime 으로 보강 예정. 현재는 일관성 차원에서만 utimes.
    if (srcMtimeMs != null) await setDestMtime(dest, srcMtimeMs);
  } catch (e) {
    return { ok: false, error: `OneDrive depot 폴더 복사 실패: ${(e as Error).message}` };
  }
  const poll = await pollSharePointReady(account, KLAUD_DEPOT_DIR, rel);
  console.log(`[onedrive-sync] sp-poll(depot) ${rel} ready=${poll.ready} ${poll.elapsedMs}ms attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason}`);
  return { ok: true, url: buildDepotEmbedUrl(account, rel), localPath: dest, account };
}
