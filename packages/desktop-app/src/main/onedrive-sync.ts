// OneDrive Business sync 폴더 자동 탐지 + file 복사 + 본인용 SharePoint URL 빌드.
// 0.1.46 (PoC 2C) — Graph API admin consent 우회. Sync 클라이언트는 Microsoft first-party
// 라 회사 정책 통과. 사용자 본인용 SharePoint URL (?web=1) 로 webview 임베드하면 사내 SSO
// 가 자동 통과 (Confluence webview 와 동일 패턴).
//
// 0.1.51 hotfix — content readiness 검증 강화.
// 사용자 환경 실측: sidecar 가 local 에 write 한 직후 SP HEAD 가 status=200 을 1초 만에 응답
// 하지만 cloud content/binary 는 아직 전송 안 됨. Excel for Web 의 WOPI fetch 가 empty 받아
// 빈 워크북 렌더링. → HEAD 만으로는 ready 판정 부족. expectedSize 와 비교 + ZIP magic 검증 추가.

import { execSync } from 'node:child_process';
import { copyFile, mkdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// 0.1.51 — buf → OneDrive 폴더 atomic 쓰기. fs.writeFile 로 OneDrive 폴더에 직접 쓰면
// OneDrive Sync 엔진의 file watcher 가 파일 grow 도중에 여러 번 fire 해서 partial state
// 로 인한 conflict resolution 위험. 임시 폴더(%TEMP%) 에 완성 → fs.copyFile (Windows
// 내부적으로 CopyFileExW — Explorer 와 동일 API) 로 atomic copy → OneDrive Sync 가 한 번에
// "complete file appeared" 로 인지 → 정상 업로드.
//
// 사용자 실측: manual 탐색기 복사는 1-2초만에 ✓. Klaud 의 직접 writeFile 은 stuck. 이 함수는
// 두 흐름을 동등하게 맞춤.
async function writeViaTempCopy(destPath: string, buf: Buffer): Promise<void> {
  const tempPath = join(
    tmpdir(),
    `klaud-staging-${Date.now()}-${randomBytes(4).toString('hex')}.xlsx`,
  );
  try {
    await writeFile(tempPath, buf);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(tempPath, destPath);
  } finally {
    // 정리는 best-effort — 실패해도 흐름엔 영향 없음.
    try {
      await unlink(tempPath);
    } catch {
      /* ignore */
    }
  }
}

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
  //
  // 0.1.51 hotfix v3 — URL builder 는 `?web=1` 로 환원. bhunion tenant 가 file URL 의 직접
  // `?action=view` 또는 `?action=embedview` 를 download 응답으로 처리하는 회귀 때문 (사용자
  // 환경 실측: will-download blocked log). `?web=1` 은 SP 가 정상으로 Doc.aspx 로 redirect.
  //
  // view-only 강제는 renderer (CenterPane) 의 webview did-navigate 리스너에서 Doc.aspx URL 의
  // `action=default` → `action=view` swap 으로 처리. 두 단계가 합쳐져 download 회귀 회피 +
  // Excel-for-Web auto-save 차단 동시 달성.
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
  // 'size-mismatch' = HEAD 200 인데 Content-Length 가 expectedSize 와 안 맞음 (stub 의심).
  // 'magic-mismatch' = Range GET 으로 받은 첫 4바이트가 ZIP magic (PK\x03\x04) 아님 — content 미도착.
  reason: 'http-200' | 'sp-redirect' | 'timeout' | 'no-attempts' | 'size-mismatch' | 'magic-mismatch';
  // 0.1.51 — 진단용. 마지막 HEAD 응답의 Content-Length (없으면 null).
  lastContentLength?: number | null;
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
  // 0.1.51 — 기대 파일 크기 (bytes). HEAD 응답의 Content-Length 와 비교해 stub 감지.
  // 미설정이면 size 비교 skip (옛 동작).
  expectedSize?: number;
  // 0.1.51 — true 면 HEAD 통과 후 Range GET 으로 ZIP magic (`PK\x03\x04`) 도 검증.
  // xlsx 는 ZIP container 라 첫 4바이트가 PK 시그니처. content 진짜 도착했는지 가장 확실한 검증.
  verifyZipMagic?: boolean;
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
  const expectedSize = merged.expectedSize;
  const verifyZipMagic = merged.verifyZipMagic ?? false;

  const { session } = await import('electron');
  const onedriveSession = session.fromPartition('persist:onedrive');
  const encodedRelPath = relPath.split('/').map(encodeURIComponent).join('/');
  const checkUrl = `${account.userUrl}/Documents/${folder}/${encodedRelPath}.xlsx`;

  const t0 = Date.now();
  let attempts = 0;
  let lastStatus: number | null = null;
  let lastContentLength: number | null = null;
  let lastInvalidReason: 'size-mismatch' | 'magic-mismatch' | null = null;

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
      const clHeader = res.headers.get('content-length');
      lastContentLength = clHeader != null ? Number(clHeader) : null;
      console.log(
        `[onedrive-sync] sp-poll-attempt ${relPath} #${attempts} status=${res.status} ` +
        `content-length=${lastContentLength ?? '-'} location=${(location ?? '').slice(0, 80)}`,
      );

      const isAuthRedirect = !!location && (
        location.includes('login.microsoftonline.com') ||
        location.includes('login.live.com') ||
        location.includes('/_layouts/15/Authenticate')
      );

      const httpReady =
        res.status === 200
          ? 'http-200'
          : (res.status >= 300 && res.status < 400 && !isAuthRedirect)
            ? 'sp-redirect'
            : null;

      // 0.1.51 — content readiness 추가 검증은 status=200 (raw file 응답) 에만 적용.
      // sp-redirect (302 → Doc.aspx) 는 SP metadata 레이어 응답이라 Range GET 으로 byte 검증
      // 불가능 (Doc.aspx 는 HTML 페이지라 ZIP magic 안 나옴). 302 는 옛 동작대로 trust.
      // 200 path 가 stub 응답을 줄 위험이 있는 케이스 (사용자 실측: 25MB 파일 cloud upload
      // 진행 중에 SP HEAD 200 응답). expectedSize + ZIP magic 으로 진짜 content 도착 검증.
      if (httpReady === 'sp-redirect') {
        return {
          ready: true,
          elapsedMs: Date.now() - t0,
          attempts,
          lastStatus,
          lastContentLength,
          reason: 'sp-redirect',
        };
      }

      if (httpReady === 'http-200') {
        // 검증 1: Content-Length 가 expectedSize 와 일치 (옛 stub 감지). HEAD 가 일반적으로
        // CL 헤더 안 주는 경우도 있어 — null 이면 skip 하고 다음 단계로.
        if (expectedSize != null && lastContentLength != null && lastContentLength > 0) {
          const sizeRatio = lastContentLength / expectedSize;
          // 99% 이상 매치면 ready 판정. 그 외엔 stub/incomplete 의심.
          if (sizeRatio < 0.99 || sizeRatio > 1.01) {
            console.log(
              `[onedrive-sync] sp-poll-attempt ${relPath} #${attempts} size-mismatch ` +
              `cloud=${lastContentLength} expected=${expectedSize} ratio=${sizeRatio.toFixed(3)} → not ready`,
            );
            lastInvalidReason = 'size-mismatch';
            // 폴링 계속 (cloud upload 진행 중일 가능성).
            const delay = Math.min(baseBackoffMs + (attempts - 1) * (baseBackoffMs / 2), maxBackoffMs);
            if (Date.now() - t0 + delay > maxMs) break;
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        // 검증 2: ZIP magic byte 확인. xlsx 는 ZIP container — 첫 4바이트가 `PK\x03\x04`.
        // Range GET 으로 first 4 bytes 받아 검증. content 진짜 도착했는지 가장 직접적 증거.
        if (verifyZipMagic) {
          try {
            const rangeRes = await onedriveSession.fetch(checkUrl, {
              method: 'GET',
              headers: { Range: 'bytes=0-3' },
              redirect: 'manual',
            });
            if (rangeRes.status === 200 || rangeRes.status === 206) {
              const buf = new Uint8Array(await rangeRes.arrayBuffer());
              const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
              console.log(
                `[onedrive-sync] sp-poll-attempt ${relPath} #${attempts} zip-magic ` +
                `bytes=${Array.from(buf.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ')} isZip=${isZip}`,
              );
              if (!isZip) {
                lastInvalidReason = 'magic-mismatch';
                const delay = Math.min(baseBackoffMs + (attempts - 1) * (baseBackoffMs / 2), maxBackoffMs);
                if (Date.now() - t0 + delay > maxMs) break;
                await new Promise((r) => setTimeout(r, delay));
                continue;
              }
            } else {
              console.log(
                `[onedrive-sync] sp-poll-attempt ${relPath} #${attempts} zip-magic ` +
                `range-get status=${rangeRes.status} → continue polling`,
              );
              lastInvalidReason = 'magic-mismatch';
              const delay = Math.min(baseBackoffMs + (attempts - 1) * (baseBackoffMs / 2), maxBackoffMs);
              if (Date.now() - t0 + delay > maxMs) break;
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
          } catch (e) {
            console.log(`[onedrive-sync] sp-poll-attempt ${relPath} #${attempts} zip-magic exception: ${(e as Error).message}`);
            // 예외 시 보수적으로 계속 폴링.
            const delay = Math.min(baseBackoffMs + (attempts - 1) * (baseBackoffMs / 2), maxBackoffMs);
            if (Date.now() - t0 + delay > maxMs) break;
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        return {
          ready: true,
          elapsedMs: Date.now() - t0,
          attempts,
          lastStatus,
          lastContentLength,
          reason: 'http-200',
        };
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
    lastContentLength,
    reason: lastInvalidReason ?? (attempts === 0 ? 'no-attempts' : 'timeout'),
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
    // 0.1.51 hotfix — setDestMtime 제거. mtime 을 src(P4 commit time, 보통 과거) 로 되돌리면
    // OneDrive Sync 엔진이 "local 이 cloud 보다 옛것" 이라고 판정해 cloud 의 stub (6148 byte
    // 빈 xlsx) 을 local 로 다운로드해 우리 25MB 를 덮어씀. mtime=NOW (writeFile 기본값) 으로
    // 두면 OneDrive Sync 가 local 을 cloud 로 정상 업로드. 사용자 manual 탐색기 복사가 즉시
    // ✓ 되는 이유와 동일.
    // 다음 ensureFresh 의 stale 판정은 size 비교만으로 충분 (xlsx 는 거의 항상 size 다름).
    if (srcMtimeMs != null) {
      // srcMtimeMs 는 무시 — OneDrive Sync 와 충돌. 변수 자체는 호환 위해 시그니처에 유지.
    }
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
    // 0.1.51 hotfix — atomic temp+copyFile (CopyFileExW). 직접 writeFile 안 함.
    // setDestMtime 도 제거 — mtime=NOW 로 두면 OneDrive Sync 가 local 을 cloud 로 정상 업로드.
    void srcMtimeMs;
    await writeViaTempCopy(dest, buf);
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
  // 0.1.51 v3 — `?web=1` 환원 (bhunion download 회귀 회피). action=view 강제는 renderer 의
  // Doc.aspx redirect intercept 에서 처리.
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

// 0.1.51 v7 — Set<string> 에서 Map<relPath, Promise> 로 변경. 동일 relPath 동시 호출 (React
// StrictMode dev double-fire / 사용자 rapid double-click) 시 두 번째 호출자가 짧은 verify-only
// poll 을 별도 실행하던 것이 race condition 의 원인. 첫 번째 호출의 sidecar fetch + write +
// poll 이 5s 안에 끝날 수 없는 큰 파일에서 두 번째 호출의 5s verify-only 가 false negative
// (cloud-not-ready) 반환 → renderer 가 카드 노출 → 사용자 본 동작은 정상이었는데 카드만 떠 있음.
// → 두 번째 호출자는 첫 번째의 *동일 Promise 를 await*. 같은 결과 받음.
type EnsureFreshResult =
  | { ok: true; url: string; status: 'ready' }
  | { ok: true; url: string; status: 'cloud-not-ready'; pollAttempts: number; pollLastStatus: number | null }
  | { ok: false; error: string };
const inflight = new Map<string, Promise<EnsureFreshResult>>();

export interface SyncProgressEvent {
  relPath: string;
  // 0.1.51 v6 — operational 신호 only. UX state 변경에 안 쓰임.
  // 'uploading' = sidecar fetch + writeViaTempCopy 중
  // 'verifying' = cloud HEAD polling 중
  // 'completed' = 모든 단계 ready (== ensureFreshSync 가 status:'ready' 반환)
  // 'failed'    = sidecar/write 등 운영 예외
  // renderer 는 이 이벤트로 placeholder 텍스트 갱신 정도만 (mount/unmount 결정 X)
  state: 'uploading' | 'verifying' | 'completed' | 'failed';
  error?: string;
  bytes?: number;
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

// 0.1.51 v6 — backgroundSync 제거됨. ensureFreshSync 가 모든 작업 (writeViaTempCopy +
// pollSharePointReady) 을 직렬로 await. fire-and-forget 흐름이 만들었던 race condition
// (cachedUrl 즉시 mount → BG poll timeout → working webview 죽임) 을 구조적으로 차단.

// 사용자가 inline 에러 카드의 "재시도" 버튼을 누르면 호출. 재업로드는 안 하고 SharePoint
// HEAD 폴링만 다시 한 번. cloud-side 처리가 그 사이 끝났으면 ready:true 반환 → renderer 가
// webview 마운트. 여전히 안 되면 ready:false 반환 → 카드 유지.
export async function repollCloudReady(
  relPath: string,
): Promise<
  | { ok: true; ready: boolean; pollAttempts: number; pollLastStatus: number | null }
  | { ok: false; error: string }
> {
  const account = detectSyncAccount();
  if (!account) {
    return { ok: false, error: 'OneDrive Business sync 클라이언트 미설정' };
  }
  const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath);
  console.log(
    `[onedrive-sync] sp-repoll ${relPath} ready=${poll.ready} ${poll.elapsedMs}ms ` +
    `attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason}`,
  );
  return {
    ok: true,
    ready: poll.ready,
    pollAttempts: poll.attempts,
    pollLastStatus: poll.lastStatus,
  };
}

// 0.1.51 v6 — 단일 직렬 흐름. 모든 클릭이 동일 path:
//   1. local mtime/size vs OneDrive 폴더 stat 비교 → stale 판정
//   2. stale 이면 sidecar fetch + writeViaTempCopy (atomic)
//   3. cloud HEAD polling (60s budget, expectedSize + ZIP magic)
//   4. 결과 return:
//      - poll.ready: { status: 'ready' } → renderer 가 webview mount
//      - poll.timeout: { status: 'cloud-not-ready', pollAttempts, pollLastStatus } → renderer 가 카드
//      - 운영 예외 (sidecar fail / write fail): { ok: false, error } → renderer 가 fallback prompt
//
// 옛 동작 (v5 까지) 은 stale 시 backgroundSync 를 fire-and-forget 으로 띄우고 즉시 return →
// renderer 가 cachedUrl 로 webview 즉시 mount → BG poll timeout 시 cloud-not-ready event 가
// working webview 를 죽임. v6 는 이 race 를 구조적으로 차단.
export async function ensureFreshSync(
  sidecarBaseUrl: string,
  relPath: string,
  onProgress: (e: SyncProgressEvent) => void,
): Promise<EnsureFreshResult> {
  const account = detectSyncAccount();
  if (!account) {
    return { ok: false, error: 'OneDrive Business sync 클라이언트 미설정' };
  }

  // 0.1.51 v7 — 동일 relPath 동시 호출 처리. 두 번째 호출자는 첫 번째의 promise 를 그대로 await.
  // 옛 verify-only 5s poll 분기는 race 만들어서 false cloud-not-ready 발생 (StrictMode dev
  // 더블파이어 + 큰 파일 cold-start). progress event 는 첫 호출자의 onProgress 로 main console
  // 에 떨어지고, IPC handler 가 main window 에 broadcast — 두 번째 caller 도 동일 channel 에서
  // 받음 (filter by relPath in renderer).
  const existing = inflight.get(relPath);
  if (existing) {
    console.log(`[onedrive-sync] inflight ${relPath} — share existing promise`);
    return existing;
  }

  const promise = doEnsureFreshSync(sidecarBaseUrl, relPath, account, onProgress);
  inflight.set(relPath, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(relPath);
  }
}

async function doEnsureFreshSync(
  sidecarBaseUrl: string,
  relPath: string,
  account: OneDriveSyncAccount,
  onProgress: (e: SyncProgressEvent) => void,
): Promise<EnsureFreshResult> {
  const dest = join(account.userFolder, KLAUD_TEMP_DIR, `${relPath}.xlsx`);
  const url = buildEmbedUrl(account, relPath);

    // Step 1: stat 비교 → stale 판정
    const [srcStat, destStat] = await Promise.all([
      readSrcStat(sidecarBaseUrl, relPath),
      readDestStat(dest),
    ]);

    console.log(
      `[onedrive-sync] ensureFresh ${relPath}: ` +
      `src=${srcStat ? `mtime=${new Date(srcStat.mtimeMs).toISOString()},size=${srcStat.size}` : 'null'} ` +
      `dest=${destStat ? `mtime=${new Date(destStat.mtimeMs).toISOString()},size=${destStat.size}` : 'null'}`,
    );

    // src 못 찾으면 (sidecar 404) — 옛 cloud 본문이라도 검증해서 ready 면 mount.
    if (srcStat == null) {
      console.log(`[onedrive-sync] ${relPath}: srcStat=null → cloud verify-only`);
      onProgress({ relPath, state: 'verifying' });
      const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath, {
        initialDelayMs: 0,
        baseBackoffMs: 500,
        maxBackoffMs: 1500,
        maxMs: 5000,
      });
      if (poll.ready) {
        onProgress({ relPath, state: 'completed' });
        return { ok: true, url, status: 'ready' };
      }
      return {
        ok: true, url, status: 'cloud-not-ready',
        pollAttempts: poll.attempts, pollLastStatus: poll.lastStatus,
      };
    }

    // stale 판정 — size 매치가 핵심. mtime tolerance 1s (NTFS 어긋남).
    const stale =
      destStat == null
      || srcStat.mtimeMs > destStat.mtimeMs + 1000
      || (srcStat.size >= 0 && srcStat.size !== destStat.size);

    let expectedSize = srcStat.size;

    // Step 2: stale 이면 upload (writeViaTempCopy). 운영 예외 시 ok:false 반환.
    if (stale) {
      const reason: string[] = [];
      if (destStat == null) reason.push('dest=null');
      if (destStat != null && srcStat.mtimeMs > destStat.mtimeMs + 1000) reason.push('mtime');
      if (destStat != null && srcStat.size >= 0 && srcStat.size !== destStat.size) {
        reason.push(`size(src=${srcStat.size},dest=${destStat.size})`);
      }
      console.log(`[onedrive-sync] stale ${relPath} → ${reason.join(',')}`);
      onProgress({ relPath, state: 'uploading' });
      try {
        const res = await fetch(`${sidecarBaseUrl}/xlsx_raw?relPath=${encodeURIComponent(relPath)}`);
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: `sidecar ${res.status}: ${text.slice(0, 200)}` };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        await writeViaTempCopy(dest, buf);
        console.log(
          `[onedrive-sync] write-via-temp ${relPath} bytes=${buf.length} (mtime=NOW, atomic copyFile)`,
        );
        expectedSize = buf.length;
      } catch (e) {
        const error = `upload 실패: ${(e as Error).message}`;
        onProgress({ relPath, state: 'failed', error });
        return { ok: false, error };
      }
    }

    // Step 3: cloud HEAD polling. 큰 파일 (236MB → 14초) 여유 있게 60s budget.
    onProgress({ relPath, state: 'verifying' });
    const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath, {
      expectedSize: expectedSize > 0 ? expectedSize : undefined,
      verifyZipMagic: true,
      initialDelayMs: stale ? 1000 : 0, // upload 직후엔 OneDrive Sync 가 인지할 시간 1s
      maxMs: 60_000,
    });
    console.log(
      `[onedrive-sync] sp-poll ${relPath} ready=${poll.ready} ${poll.elapsedMs}ms ` +
      `attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason} ` +
      `cl=${poll.lastContentLength ?? '-'}`,
    );

    if (poll.ready) {
      onProgress({ relPath, state: 'completed' });
      return { ok: true, url, status: 'ready' };
    }
    return {
      ok: true, url, status: 'cloud-not-ready',
      pollAttempts: poll.attempts, pollLastStatus: poll.lastStatus,
    };
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
    // 0.1.51 hotfix — setDestMtime 제거. mtime 을 src(P4 commit time, 보통 과거) 로 되돌리면
    // OneDrive Sync 엔진이 "local 이 cloud 보다 옛것" 이라고 판정해 cloud 의 stub (6148 byte
    // 빈 xlsx) 을 local 로 다운로드해 우리 25MB 를 덮어씀. mtime=NOW (writeFile 기본값) 으로
    // 두면 OneDrive Sync 가 local 을 cloud 로 정상 업로드. 사용자 manual 탐색기 복사가 즉시
    // ✓ 되는 이유와 동일.
    // 다음 ensureFresh 의 stale 판정은 size 비교만으로 충분 (xlsx 는 거의 항상 size 다름).
    if (srcMtimeMs != null) {
      // srcMtimeMs 는 무시 — OneDrive Sync 와 충돌. 변수 자체는 호환 위해 시그니처에 유지.
    }
  } catch (e) {
    return { ok: false, error: `OneDrive depot 폴더 복사 실패: ${(e as Error).message}` };
  }
  const poll = await pollSharePointReady(account, KLAUD_DEPOT_DIR, rel);
  console.log(`[onedrive-sync] sp-poll(depot) ${rel} ready=${poll.ready} ${poll.elapsedMs}ms attempts=${poll.attempts} status=${poll.lastStatus} reason=${poll.reason}`);
  return { ok: true, url: buildDepotEmbedUrl(account, rel), localPath: dest, account };
}
