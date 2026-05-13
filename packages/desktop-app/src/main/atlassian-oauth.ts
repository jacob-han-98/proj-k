// 2026-05-13 Final-3: Atlassian OAuth 2.0 (3LO) — Authorization Code + PKCE.
//
// google-oauth.ts 패턴 mirror. 차이점:
//   1. Authorize URL: https://auth.atlassian.com/authorize?audience=api.atlassian.com&...
//      audience 파라미터 필수.
//   2. Token URL: https://auth.atlassian.com/oauth/token
//   3. redirect_uri 가 **고정** — Atlassian Console 에 사전 등록 필수. loopback 임의
//      포트 자동 허용 X. 우리는 53682 사용 (사용자가 Atlassian Console 에 그대로 등록).
//   4. id_token 없음 — accessible-resources endpoint 로 cloudId/site_url 받아오기.
//   5. client_secret 발급되지만 PKCE 흐름은 secret 없이도 OK (Atlassian 의 public client 흐름).
//      그러나 Atlassian 은 confidential client 가 default 라 secret 요구 가능 — 둘 다 지원.

import { BrowserWindow } from 'electron';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { setAtlassianCreds, type AtlassianCreds } from './atlassian-auth';
import { getSettings } from './settings';

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const ME_URL = 'https://api.atlassian.com/me';
// Atlassian Console 에 사용자가 등록할 callback. 고정. 8000 이상 잘 안 쓰는 번호.
const FIXED_REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${FIXED_REDIRECT_PORT}/oauth2callback`;
const DEFAULT_SCOPE = 'read:confluence-content.all write:confluence-content read:confluence-space.summary offline_access';

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

interface LoopbackCapture {
  server: Server;
  done: Promise<{ code: string; state: string }>;
  close: () => void;
}

async function startLoopback(): Promise<LoopbackCapture> {
  let captured: { code: string; state: string } | null = null;
  let resolveFn: (v: { code: string; state: string }) => void = () => undefined;
  let rejectFn: (e: Error) => void = () => undefined;
  const done = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('bad request');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (error) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><body style="font-family:sans-serif;padding:40px;"><h2>Atlassian 로그인 실패</h2><p>${error}</p><p>이 창을 닫고 Klaud 로 돌아가세요.</p></body></html>`);
      rejectFn(new Error(`Atlassian OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.statusCode = 400;
      res.end('missing code or state');
      return;
    }
    if (captured) {
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    captured = { code, state };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>✓ Atlassian 로그인 완료</h2><p>이 창을 닫고 Klaud 로 돌아가세요.</p><script>setTimeout(()=>window.close(),500);</script></body></html>`);
    resolveFn(captured);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) => {
      // EADDRINUSE — Atlassian 의 redirect_uri 가 고정이라 충돌 시 사용자에게 명확히 알려야.
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(
          new Error(
            `포트 ${FIXED_REDIRECT_PORT} 가 다른 프로세스에 사용 중입니다. Klaud 중복 실행 또는 다른 OAuth 흐름 점검 후 재시도.`,
          ),
        );
      } else {
        reject(e);
      }
    });
    server.listen(FIXED_REDIRECT_PORT, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('loopback 서버 binding 실패');
  }

  const timeout = setTimeout(
    () => rejectFn(new Error('Atlassian OAuth 응답 시간 초과 (60s)')),
    60 * 1000,
  );

  return {
    server,
    done: done.finally(() => {
      clearTimeout(timeout);
      server.close();
    }),
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}

async function exchangeCode(
  code: string,
  verifier: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  };
  // client_secret 은 confidential client 시에만 필요. Atlassian Desktop app 권장은 PKCE만.
  if (clientSecret) body.client_secret = clientSecret;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    throw new Error(`token 교환 실패: ${data.error ?? res.status} ${data.error_description ?? ''}`);
  }
  return {
    access_token: data.access_token as string,
    refresh_token: typeof data.refresh_token === 'string' ? (data.refresh_token as string) : undefined,
    expires_in: (data.expires_in as number) ?? 3600,
    scope: typeof data.scope === 'string' ? (data.scope as string) : undefined,
  };
}

interface AccessibleResource {
  id: string; // cloud ID
  url: string; // 예: https://bighitcorp.atlassian.net
  name: string;
  scopes: string[];
}

async function fetchAccessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  const res = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`accessible-resources fetch 실패: ${res.status}`);
  }
  return (await res.json()) as AccessibleResource[];
}

interface MeResponse {
  account_id?: string;
  email?: string;
  name?: string;
  display_name?: string;
}

async function fetchMe(accessToken: string): Promise<MeResponse | null> {
  try {
    const res = await fetch(ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}

export interface InteractiveLoginResult {
  ok: boolean;
  reason?: string;
  site_url?: string;
  display_name?: string;
  email?: string;
}

export async function interactiveLogin(
  parent: BrowserWindow | null,
): Promise<InteractiveLoginResult> {
  const settings = getSettings();
  const clientId = (settings.atlassianOAuthClientId ?? process.env.PROJK_ATLASSIAN_CLIENT_ID ?? '').trim();
  if (!clientId) {
    return {
      ok: false,
      reason: 'Atlassian OAuth client_id 가 설정되지 않았습니다. SettingsModal 또는 PROJK_ATLASSIAN_CLIENT_ID env.',
    };
  }
  // client_secret 은 optional — PKCE 만으로 안전. Atlassian 의 일부 dev app 타입은 secret 강제.
  const clientSecret = (process.env.PROJK_ATLASSIAN_CLIENT_SECRET ?? '').trim() || undefined;

  const { verifier, challenge } = generatePkce();
  const state = base64Url(randomBytes(16));

  let loopback: LoopbackCapture;
  try {
    loopback = await startLoopback();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: DEFAULT_SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
    response_type: 'code',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  const authWin = new BrowserWindow({
    width: 540,
    height: 740,
    parent: parent ?? undefined,
    modal: !!parent,
    autoHideMenuBar: true,
    title: 'Atlassian 로그인',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:atlassian-oauth', // 다음 부팅 silent SSO 가능
    },
  });

  let aborted = false;
  authWin.on('closed', () => {
    if (!aborted) loopback.close();
  });

  await authWin.loadURL(authUrl);

  try {
    const { code, state: returnedState } = await loopback.done;
    if (returnedState !== state) {
      throw new Error('state 불일치 — CSRF 가능성. 다시 시도해주세요.');
    }
    const tokenSet = await exchangeCode(code, verifier, clientId, clientSecret);

    // accessible-resources → cloudId/site_url 결정.
    const resources = await fetchAccessibleResources(tokenSet.access_token);
    if (resources.length === 0) {
      throw new Error('Atlassian 계정에 액세스 가능한 사이트가 없습니다.');
    }
    // 사용자가 회사 사이트 1개만 가지는 게 일반적. 여러 개면 첫 site.
    const site = resources[0]!;

    // /me — display_name / email 보강 (실패해도 진행).
    const me = await fetchMe(tokenSet.access_token);

    const creds: AtlassianCreds = {
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token ?? '',
      expires_at: Date.now() + tokenSet.expires_in * 1000 - 60_000,
      cloud_id: site.id,
      site_url: site.url,
      site_name: site.name,
      display_name: me?.display_name ?? me?.name,
      email: me?.email,
      account_id: me?.account_id,
    };
    await setAtlassianCreds(creds);
    aborted = true;
    if (!authWin.isDestroyed()) authWin.close();
    return {
      ok: true,
      site_url: site.url,
      display_name: creds.display_name,
      email: creds.email,
    };
  } catch (e) {
    aborted = true;
    if (!authWin.isDestroyed()) authWin.close();
    loopback.close();
    return { ok: false, reason: (e as Error).message };
  }
}

// 만료된 access_token 을 refresh_token 으로 갱신. atlassian-auth.ts 의 getCurrentAccessToken
// 가 자동 호출. refresh 실패 시 null — 호출자가 사용자에게 재로그인 안내.
export async function refreshAccessToken(cur: AtlassianCreds): Promise<AtlassianCreds | null> {
  if (!cur.refresh_token) return null;
  const settings = getSettings();
  const clientId = (settings.atlassianOAuthClientId ?? process.env.PROJK_ATLASSIAN_CLIENT_ID ?? '').trim();
  if (!clientId) return null;
  const clientSecret = (process.env.PROJK_ATLASSIAN_CLIENT_SECRET ?? '').trim() || undefined;
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: cur.refresh_token,
  };
  if (clientSecret) body.client_secret = clientSecret;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') return null;
    const refreshed: AtlassianCreds = {
      ...cur,
      access_token: data.access_token as string,
      refresh_token: typeof data.refresh_token === 'string' ? (data.refresh_token as string) : cur.refresh_token,
      expires_at: Date.now() + ((data.expires_in as number) ?? 3600) * 1000 - 60_000,
    };
    await setAtlassianCreds(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}
