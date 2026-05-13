// 2026-05-13 릴리스-B: Google Workspace SSO — token 저장 + identity 노출.
//
// auth.ts (Confluence creds) 패턴과 동일하게 safeStorage 로 암호화해 userData 에 보관.
// 흐름:
//   1. google-oauth.ts 의 interactiveLogin → token + id_token 획득
//   2. id_token 의 email/name/picture 파싱 (JWT base64url 디코딩, 서명 검증은 backend 책임)
//   3. setGoogleCreds 로 영속 저장
//   4. 다음 부팅 → loadGoogleCreds 가 토큰 + 파싱된 profile 반환
//
// renderer 에는 GoogleCredsInfo (token 없음) 만 노출 — token 자체는 main 전용.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

const CREDS_FILE = (): string => join(app.getPath('userData'), 'google-creds.bin');

// 저장 shape — id_token 의 핵심 클레임 + 토큰 자체.
export interface GoogleCreds {
  id_token: string;
  access_token: string;
  refresh_token: string; // Google 이 항상 주지는 않음 — offline_access 시에만.
  expires_at: number; // ms epoch
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  hd?: string; // hosted domain — 워크스페이스 식별
  sub: string; // Google user id
}

// Renderer 에 노출되는 안전한 메타 — token 없음.
export interface GoogleCredsInfo {
  email: string;
  name?: string;
  picture?: string;
  hd?: string;
  hasToken: boolean;
  // id_token 만료까지 남은 초 (음수면 만료됨). renderer 가 ttl 확인용.
  expiresInSeconds: number;
}

let cached: GoogleCreds | null = null;

export async function getGoogleCreds(): Promise<GoogleCreds | null> {
  if (cached) return cached;
  let blob: Buffer;
  try {
    blob = await fs.readFile(CREDS_FILE());
  } catch {
    return null;
  }
  if (blob.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    try {
      cached = JSON.parse(blob.toString('utf-8')) as GoogleCreds;
      return cached;
    } catch {
      return null;
    }
  }
  try {
    const json = safeStorage.decryptString(blob);
    cached = JSON.parse(json) as GoogleCreds;
    return cached;
  } catch {
    // 옛 plain JSON fallback (외부 주입 / migration). 성공 시 재암호화.
    try {
      const fallback = JSON.parse(blob.toString('utf-8')) as GoogleCreds;
      if (fallback?.email && fallback?.id_token) {
        cached = fallback;
        await setGoogleCreds(fallback).catch(() => {
          /* migration 실패해도 in-memory 자격은 살림 */
        });
        return cached;
      }
    } catch {
      /* not even valid */
    }
    return null;
  }
}

export async function setGoogleCreds(creds: GoogleCreds): Promise<void> {
  cached = creds;
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const payload = JSON.stringify(creds);
  if (safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(CREDS_FILE(), safeStorage.encryptString(payload));
  } else {
    await fs.writeFile(CREDS_FILE(), payload, 'utf-8');
  }
}

export async function clearGoogleCreds(): Promise<void> {
  cached = null;
  try {
    await fs.writeFile(CREDS_FILE(), Buffer.alloc(0));
  } catch {
    /* file may not exist — fine */
  }
}

// JWT 의 payload 부분만 base64url 디코딩. 서명 검증은 backend 책임 (Google public keys 로 RS256).
// frontend 는 사용자 email/name 표시 + 만료 시간 체크에만 사용. 위조된 token 으로 backend
// 가 속지 않으므로 frontend 신뢰 boundary 는 안전.
export function parseIdToken(idToken: string): {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  hd?: string;
  sub?: string;
  exp?: number;
  aud?: string;
} {
  const parts = idToken.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = parts[1]!;
    // base64url → base64.
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    // padding 보정.
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export async function getCredsInfo(): Promise<GoogleCredsInfo | null> {
  const c = await getGoogleCreds();
  if (!c) return null;
  return {
    email: c.email,
    name: c.name,
    picture: c.picture,
    hd: c.hd,
    hasToken: c.id_token.length > 0,
    expiresInSeconds: Math.floor((c.expires_at - Date.now()) / 1000),
  };
}

// klaud-log-sink 가 batch / report POST 시 동봉할 현재 id_token. 만료된 경우에도 일단
// 그대로 전달 — backend 가 검증해서 user_email=null 처리. refresh 책임은 후순위.
export async function getCurrentIdToken(): Promise<{ id_token: string; email: string } | null> {
  const c = await getGoogleCreds();
  if (!c || !c.id_token) return null;
  return { id_token: c.id_token, email: c.email };
}
