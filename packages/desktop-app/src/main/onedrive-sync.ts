// OneDrive Business sync 폴더 자동 탐지 + file 복사 + 본인용 SharePoint URL 빌드.
// 0.1.46 (PoC 2C) — Graph API admin consent 우회. Sync 클라이언트는 Microsoft first-party
// 라 회사 정책 통과. 사용자 본인용 SharePoint URL (?web=1) 로 webview 임베드하면 사내 SSO
// 가 자동 통과 (Confluence webview 와 동일 패턴).

import { execSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const KLAUD_TEMP_DIR = 'Klaud-temp';

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
export function detectSyncAccount(): OneDriveSyncAccount | null {
  if (process.platform !== 'win32') return null;
  for (let i = 1; i <= 5; i++) {
    const base = `HKCU\\Software\\Microsoft\\OneDrive\\Accounts\\Business${i}`;
    const userFolder = readReg(base, 'UserFolder');
    const userEmail = readReg(base, 'UserEmail');
    // UserUrl 형태: https://bhunion-my.sharepoint.com:443/personal/jacob_hybecorp_com
    // → Doc.aspx redirect 가 :443 포트 명시 시 깨질 수 있어 제거.
    const rawUserUrl = readReg(base, 'UserUrl');
    const userUrl = rawUserUrl
      ? rawUserUrl.replace(/^(https:\/\/[^/:]+):443/, '$1').replace(/\/+$/, '')
      : null;
    // SPOResourceId 는 보통 tenant GUID — diagnostic 용.
    const spoResourceId = readReg(base, 'SPOResourceId') ?? '';
    if (userFolder && userUrl && userEmail) {
      return { userFolder, userUrl, spoResourceId, userEmail };
    }
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
  // SharePoint 가 Doc.aspx + sourcedoc GUID 로 자동 redirect (사용자 본인 자격 SSO).
  return `${account.userUrl}/Documents/${KLAUD_TEMP_DIR}/${encodedRelPath}.xlsx?web=1`;
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
