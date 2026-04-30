// Microsoft Graph (OneDrive) 통합 — Authorization Code + PKCE Flow.
// 0.1.45 부터: device code flow 가 회사 (HYBE) Conditional Access 에 막혀
// BrowserWindow 안 redirect 기반 OAuth 로 전환.
//
// 흐름:
//   1. PKCE verifier/challenge 생성
//   2. BrowserWindow 안에서 authorize URL 로드 → 사용자가 사내 SSO 로 로그인 + 동의
//   3. redirect_uri (nativeclient) 도착 시 main 이 will-redirect 캡처 → code 추출
//   4. POST /token (code + verifier) → access_token + refresh_token
//   5. token 영속 (electron safeStorage)
//   6. 다음 부팅 — refresh_token 으로 access_token 자동 갱신
//
// Client ID — Microsoft Graph PowerShell public app (PoC 단계). production 은 자체 등록.

import { app, safeStorage, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Microsoft Graph PowerShell
const TENANT = 'common';
const SCOPE = 'Files.ReadWrite.All offline_access';
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms
}

let cached: TokenSet | null = null;

function tokenFile(): string {
  return join(app.getPath('userData'), 'onedrive.token');
}

function loadToken(): TokenSet | null {
  if (cached) return cached;
  try {
    if (!existsSync(tokenFile())) return null;
    const enc = readFileSync(tokenFile());
    const json = safeStorage.decryptString(enc);
    cached = JSON.parse(json) as TokenSet;
    return cached;
  } catch (e) {
    console.warn('[onedrive] token load 실패', (e as Error).message);
    return null;
  }
}

function saveToken(t: TokenSet): void {
  cached = t;
  try {
    const enc = safeStorage.encryptString(JSON.stringify(t));
    writeFileSync(tokenFile(), enc);
  } catch (e) {
    console.warn('[onedrive] token save 실패', (e as Error).message);
  }
}

export function clearToken(): void {
  cached = null;
  try {
    if (existsSync(tokenFile())) writeFileSync(tokenFile(), Buffer.alloc(0));
  } catch { /* ignore */ }
}

// ---------- Authorization Code + PKCE Flow ----------

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function exchangeCodeForToken(code: string, verifier: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPE,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    throw new Error(`token 교환 실패: ${data.error ?? res.status} ${data.error_description ?? ''}`);
  }
  const tok: TokenSet = {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string) ?? '',
    expires_at: Date.now() + ((data.expires_in as number) ?? 3600) * 1000 - 60_000,
  };
  saveToken(tok);
  return tok;
}

// BrowserWindow 안에서 사용자가 Microsoft 로그인 + 동의 → redirect 캡처 → token 교환.
// parent 가 있으면 modal 로 띄움 (사용자가 다른 곳 못 누르게).
export async function interactiveLogin(parent: BrowserWindow | null): Promise<void> {
  const { verifier, challenge } = generatePkce();
  const state = base64Url(randomBytes(16));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  const authWin = new BrowserWindow({
    width: 520,
    height: 720,
    parent: parent ?? undefined,
    modal: !!parent,
    autoHideMenuBar: true,
    title: 'Microsoft 로그인 — OneDrive 액세스',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // partition 공유 — Confluence webview 와 분리. 두 번째부터 silent SSO 가능.
      partition: 'persist:onedrive',
    },
  });

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const handleNav = async (url: string): Promise<void> => {
      if (settled) return;
      if (!url.startsWith(REDIRECT_URI)) return;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      const errorDesc = parsed.searchParams.get('error_description');

      settled = true;
      try {
        if (!authWin.isDestroyed()) authWin.destroy();
      } catch { /* ignore */ }

      if (error) {
        return reject(new Error(`${error}: ${errorDesc ?? ''}`));
      }
      if (!code) {
        return reject(new Error('redirect 에 code 없음'));
      }
      if (returnedState !== state) {
        return reject(new Error('OAuth state mismatch — 보안 검증 실패'));
      }
      try {
        await exchangeCodeForToken(code, verifier);
        resolve();
      } catch (e) {
        reject(e);
      }
    };

    authWin.webContents.on('will-redirect', (_e, url) => { void handleNav(url); });
    authWin.webContents.on('will-navigate', (_e, url) => { void handleNav(url); });

    authWin.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(new Error('user canceled'));
      }
    });

    authWin.loadURL(authUrl).catch((e) => {
      if (!settled) {
        settled = true;
        try { if (!authWin.isDestroyed()) authWin.destroy(); } catch { /* ignore */ }
        reject(e);
      }
    });
  });
}

async function refresh(): Promise<TokenSet | null> {
  const cur = loadToken();
  if (!cur || !cur.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: cur.refresh_token,
    scope: SCOPE,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    console.warn('[onedrive] refresh 실패', res.status);
    return null;
  }
  const data = (await res.json()) as Record<string, unknown>;
  const tok: TokenSet = {
    access_token: data.access_token as string,
    refresh_token: ((data.refresh_token as string) ?? cur.refresh_token),
    expires_at: Date.now() + ((data.expires_in as number) ?? 3600) * 1000 - 60_000,
  };
  saveToken(tok);
  return tok;
}

async function getValidToken(): Promise<string | null> {
  let tok = loadToken();
  if (!tok) return null;
  if (Date.now() >= tok.expires_at) {
    tok = await refresh();
    if (!tok) return null;
  }
  return tok.access_token;
}

// ---------- Graph operations ----------

async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidToken();
  if (!token) throw new Error('OneDrive 인증 필요 — 먼저 device code flow 로 로그인');
  return fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getValidToken()) !== null;
}

// /Klaud-temp/<relPath>.xlsx 위치에 파일 upload (PUT). 4MB 이하 small file.
// 큰 file 은 createUploadSession 으로 chunk upload 가 필요하나 PoC 는 small.
export async function uploadFile(relPath: string, content: Buffer): Promise<{ id: string; webUrl: string }> {
  const escaped = encodeURIComponent(`/Klaud-temp/${relPath}`);
  const res = await graphFetch(`/me/drive/root:${escaped}:/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`upload 실패 ${res.status}: ${await res.text()}`);
  }
  const item = (await res.json()) as { id: string; webUrl: string };
  return item;
}

// 파일에 anonymous edit/view link 생성. embed URL 로 webview 에 사용.
export async function createShareLink(itemId: string, scope: 'edit' | 'view' = 'edit'): Promise<string> {
  const res = await graphFetch(`/me/drive/items/${itemId}/createLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: scope, scope: 'organization' }),
  });
  if (!res.ok) {
    throw new Error(`createLink 실패 ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { link: { webUrl: string } };
  return data.link.webUrl;
}

// 이미 매핑 있으면 lookup, 없으면 upload + createLink.
export async function ensureSharedLink(relPath: string, content: Buffer): Promise<string> {
  // 기존 file 있는지 확인 (upload 는 idempotent — 같은 path 면 update).
  const item = await uploadFile(`${relPath}.xlsx`, content);
  return await createShareLink(item.id, 'edit');
}
