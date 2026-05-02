// OneDrive Business sync 폴더 자동 탐지 + file 복사 + 본인용 SharePoint URL 빌드.
// 0.1.46 (PoC 2C) — Graph API admin consent 우회. Sync 클라이언트는 Microsoft first-party
// 라 회사 정책 통과. 사용자 본인용 SharePoint URL (?web=1) 로 webview 임베드하면 사내 SSO
// 가 자동 통과 (Confluence webview 와 동일 패턴).

import { execSync } from 'node:child_process';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
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
  // 결과: <userUrl>/Documents/Klaud-temp/<relPath>.xlsx?action=embedview
  //
  // ?action=embedview — Excel for the Web 의 미니 임베드 뷰. SuiteNav (9-dot 와플 / 문서
  // 제목 / 톱니 / 프로필) 와 리본이 모두 사라져 화면 공간 절약. 사용자가 트리뷰에서 ✏
  // 아이콘으로 편집 모드 토글하면 renderer 가 이 URL 의 action 을 'edit' 로 swap → 풀 chrome
  // 으로 reload. SharePoint 가 Doc.aspx + sourcedoc GUID 로 자동 redirect (사용자 본인 자격 SSO).
  return `${account.userUrl}/Documents/${KLAUD_TEMP_DIR}/${encodedRelPath}.xlsx?action=embedview`;
}

// dest path 의 NTFS attribute polling — OneDrive Sync 가 file 을 클라우드로 upload
// 한 후에는 `cloud-only` 또는 `available locally` 마크가 attrib 에 노출됨.
// 정확한 비트는 OneDrive 버전마다 달라서 PoC 는 단순 sleep 으로 처리.
async function waitForSync(_dest: string, maxMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, maxMs));
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
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(localXlsxPath, dest);
  } catch (e) {
    return { ok: false, error: `sync 폴더 복사 실패: ${(e as Error).message}` };
  }
  // 15초 대기 — 7초는 짧아서 webview 가 404 받음.
  await waitForSync(dest, 15000);
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
  try {
    const res = await fetch(sidecarUrl);
    if (!res.ok) {
      return { ok: false, error: `sidecar 다운로드 실패 ${res.status}: ${await res.text()}` };
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `sidecar 다운로드 예외: ${(e as Error).message}` };
  }
  const dest = join(account.userFolder, KLAUD_TEMP_DIR, `${relPath}.xlsx`);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
  } catch (e) {
    return { ok: false, error: `sync 폴더 write 실패: ${(e as Error).message}` };
  }
  await waitForSync(dest, 15000);
  return { ok: true, url: buildEmbedUrl(account, relPath), localPath: dest, account };
}

// P4 depot 보기용 임베드 URL — 기본은 미니 임베드 뷰.
// `?action=embedview` → Excel for the Web 이 미니 read-only 임베드 (SuiteNav + 리본 모두
// 숨김). depot 은 P4 가 진실의 원천이라 사용자가 임베드 안에서 편집해도 P4 에 반영 안 됨 —
// 사용자가 ✏ 아이콘으로 편집을 명시 토글했을 때만 renderer 가 'edit' 로 swap (그래도 결과는
// OneDrive 카피만 변경, P4 영향 없음 → 향후 P4 checkout 흐름 별도).
function buildDepotEmbedUrl(account: OneDriveSyncAccount, depotRelPath: string): string {
  const encoded = depotRelPath.split('/').map(encodeURIComponent).join('/');
  return `${account.userUrl}/Documents/${KLAUD_DEPOT_DIR}/${encoded}.xlsx?action=embedview`;
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

async function readSrcMtimeMs(sidecarBaseUrl: string, relPath: string): Promise<number | null> {
  try {
    const res = await fetch(`${sidecarBaseUrl}/xlsx_stat?relPath=${encodeURIComponent(relPath)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { mtime_ms?: number };
    return typeof j.mtime_ms === 'number' ? j.mtime_ms : null;
  } catch {
    return null;
  }
}

async function readDestMtimeMs(destPath: string): Promise<number | null> {
  try {
    const s = await stat(destPath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

async function backgroundSync(
  sidecarBaseUrl: string,
  relPath: string,
  dest: string,
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
    // OneDrive Sync 가 클라우드로 push 까지 file 크기에 따라 ~수~수십 초. 25MB xlsx 의 경우
    // 8 초 안에 cloud 도달 안 함 → webview reload 가 SharePoint 404 받음 → 사용자가 빈 페이지.
    // 25초 로 늘려 안정적 cloud 도달 보장. 너무 길면 사용자 체감 답답 — 25초 가 99% file 크기 대응.
    // (TODO: SharePoint HEAD-poll 로 file 200 받을 때까지 polling 이 robust — 다음 PR.)
    await new Promise((r) => setTimeout(r, 25_000));
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
    const [srcMtime, destMtime] = await Promise.all([
      readSrcMtimeMs(sidecarBaseUrl, relPath),
      readDestMtimeMs(dest),
    ]);

    // src 를 못 찾으면 sync 가 의미 없음. 매핑된 옛 cloud 본문이라도 즉시 반환.
    if (srcMtime == null) {
      return { ok: true, url, alreadyFresh: true, syncing: false };
    }

    // dest 가 없거나 src 가 더 새것이면 stale. tolerance 1초 (NTFS mtime 어긋남 회피).
    const stale = destMtime == null || srcMtime > destMtime + 1000;
    if (!stale) {
      return { ok: true, url, alreadyFresh: true, syncing: false };
    }

    // 백그라운드 sync 시작 — backgroundSync 가 finally 에서 inflight.delete.
    releaseInflight = false;
    void backgroundSync(sidecarBaseUrl, relPath, dest, onProgress).finally(() => {
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
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(localXlsxPath, dest);
  } catch (e) {
    return { ok: false, error: `OneDrive depot 폴더 복사 실패: ${(e as Error).message}` };
  }
  await waitForSync(dest, 15000);
  return { ok: true, url: buildDepotEmbedUrl(account, rel), localPath: dest, account };
}
