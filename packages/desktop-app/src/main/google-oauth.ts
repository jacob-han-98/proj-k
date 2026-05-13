// 2026-05-13 릴리스-B: Google Workspace SSO — Authorization Code + PKCE flow.
//
// Google 의 installed-app 권장 흐름:
//   1. PKCE verifier/challenge 생성
//   2. 임시 loopback HTTP 서버 (127.0.0.1:<random-port>) 시작
//   3. BrowserWindow 안에서 Google authorize URL 로드
//   4. 사용자 로그인/동의 → Google 이 loopback 으로 redirect (?code=...&state=...)
//   5. loopback 서버가 code 캡처 후 "성공" HTML 응답 + 자체 종료
//   6. POST oauth2/token 으로 code 교환 → access_token + id_token + refresh_token
//   7. id_token 의 payload (email/hd) 파싱 → google-auth 의 setGoogleCreds 로 영속
//
// 사용자 PC 제약: loopback 서버는 localhost 127.0.0.1 의 짧은 임시 포트. 외부 접근 X.
// HD 제한: settings.googleWorkspaceDomain 이 채워져 있으면 authorize URL 에 hd 파라미터 + post-flow
// 검증 (id_token.hd 일치). 미설정 시 hd 제한 없이 dev 환경 (gmail.com) 도 OK.

import { BrowserWindow } from 'electron';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import {
  setGoogleCreds,
  parseIdToken,
  type GoogleCreds,
} from './google-auth';
import { getSettings } from './settings';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'openid email profile';

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
  port: number;
  redirectUri: string;
  // Promise resolves with code/state when captured, rejects on timeout/abort.
  done: Promise<{ code: string; state: string }>;
  close: () => void;
}

// 임시 HTTP 서버. 첫 요청에서 code/state 캡처 후 즉시 종료. 60초 안에 안 오면 reject.
function startLoopback(): LoopbackCapture {
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
      res.end(`<html><body style="font-family:sans-serif;padding:40px;"><h2>Google 로그인 실패</h2><p>${error}</p><p>이 창을 닫고 Klaud 로 돌아가세요.</p></body></html>`);
      rejectFn(new Error(`Google OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.statusCode = 400;
      res.end('missing code or state');
      return;
    }
    if (captured) {
      // 두 번째 호출 (favicon 등) 은 단순 응답.
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    captured = { code, state };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>✓ Google 로그인 완료</h2><p>이 창을 닫고 Klaud 로 돌아가세요.</p><script>setTimeout(()=>window.close(),500);</script></body></html>`);
    resolveFn(captured);
  });

  server.listen(0, '127.0.0.1');
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const timeout = setTimeout(
    () => {
      rejectFn(new Error('Google OAuth 응답 시간 초과 (60s)'));
    },
    60 * 1000,
  );

  return {
    server,
    port,
    redirectUri,
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
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string; id_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string' || typeof data.id_token !== 'string') {
    throw new Error(
      `token 교환 실패: ${data.error ?? res.status} ${data.error_description ?? ''}`,
    );
  }
  return {
    access_token: data.access_token as string,
    refresh_token: typeof data.refresh_token === 'string' ? (data.refresh_token as string) : undefined,
    id_token: data.id_token as string,
    expires_in: (data.expires_in as number) ?? 3600,
  };
}

export interface InteractiveLoginResult {
  ok: boolean;
  reason?: string;
  email?: string;
  name?: string;
}

// SettingsModal 의 "Google 로그인" 버튼이 호출. parent 가 있으면 modal 로 띄움.
export async function interactiveLogin(
  parent: BrowserWindow | null,
): Promise<InteractiveLoginResult> {
  const settings = getSettings();
  const clientId = (settings.googleOAuthClientId ?? process.env.PROJK_GOOGLE_CLIENT_ID ?? '').trim();
  if (!clientId) {
    return {
      ok: false,
      reason:
        'Google OAuth client_id 가 설정되지 않았습니다. SettingsModal 또는 PROJK_GOOGLE_CLIENT_ID env 에 값을 입력해주세요.',
    };
  }
  const hd = (settings.googleWorkspaceDomain ?? '').trim();

  const { verifier, challenge } = generatePkce();
  const state = base64Url(randomBytes(16));
  const loopback = startLoopback();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: loopback.redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // refresh_token 발급
    prompt: 'select_account',
  });
  if (hd) params.set('hd', hd);
  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  const authWin = new BrowserWindow({
    width: 540,
    height: 740,
    parent: parent ?? undefined,
    modal: !!parent,
    autoHideMenuBar: true,
    title: 'Google 로그인',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:google-oauth', // 다음 부팅 silent SSO 가능
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
    const tokenSet = await exchangeCode(code, verifier, clientId, loopback.redirectUri);
    const claims = parseIdToken(tokenSet.id_token);
    if (!claims.email) {
      throw new Error('id_token 에 email 클레임이 없습니다.');
    }
    if (hd && claims.hd !== hd) {
      throw new Error(
        `허용된 워크스페이스(${hd}) 외 계정입니다: ${claims.email} (hd=${claims.hd ?? '없음'})`,
      );
    }
    const creds: GoogleCreds = {
      id_token: tokenSet.id_token,
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token ?? '',
      expires_at: Date.now() + tokenSet.expires_in * 1000 - 60_000,
      email: claims.email,
      email_verified: !!claims.email_verified,
      name: claims.name,
      picture: claims.picture,
      hd: claims.hd,
      sub: claims.sub ?? '',
    };
    await setGoogleCreds(creds);
    aborted = true; // success → close auth window cleanly
    if (!authWin.isDestroyed()) authWin.close();
    return { ok: true, email: claims.email, name: claims.name };
  } catch (e) {
    aborted = true;
    if (!authWin.isDestroyed()) authWin.close();
    loopback.close();
    return { ok: false, reason: (e as Error).message };
  }
}
