// 2026-05-13 Final-3: Atlassian OAuth 3LO — token 저장 + identity 노출.
//
// google-auth.ts 패턴 mirror. Klaud 의 Confluence 접근에 쓰던 email + apiToken 수동
// 입력 (ConfluenceCreds via auth.ts) 을 OAuth access_token + refresh_token 으로 전환.
// 기존 apiToken 흐름은 fallback 유지 — 옛 사용자/dev 환경 호환.
//
// 차이점 vs Google:
//   - id_token 없음 (Atlassian 은 OAuth scope 만, OIDC 아님).
//   - cloudId 별도 조회 (`https://api.atlassian.com/oauth/token/accessible-resources`).
//     이 cloudId 로 Confluence REST 호출의 base URL 도출:
//     https://api.atlassian.com/ex/confluence/<cloudId>/wiki/rest/api/...
//   - email 은 token 으로 직접 얻을 수 없어서 `/me` endpoint 호출 또는
//     accessible-resources 의 url (atlassian.net 도메인) 만 보관.
//
// renderer 에는 AtlassianCredsInfo (token 없음) 만 노출.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

const CREDS_FILE = (): string => join(app.getPath('userData'), 'atlassian-creds.bin');

// 저장 shape — token + 사용자가 액세스 가능한 사이트 정보.
export interface AtlassianCreds {
  access_token: string;
  refresh_token: string; // offline_access scope 시 발급
  expires_at: number; // ms epoch
  // accessible-resources 의 첫 사이트 — 보통 회사 atlassian.net 한 개.
  // 사용자가 여러 사이트 소속이면 첫 site 우선 (PoC scope).
  cloud_id: string;
  site_url: string; // 예: https://bighitcorp.atlassian.net
  site_name: string; // 사이트 표시 이름
  // 사용자가 직접 가질 수 있는 정보가 없음 — display name 은 별도 /me 호출 후 보관.
  display_name?: string;
  email?: string;
  account_id?: string;
}

// Renderer 에 노출되는 안전한 메타.
export interface AtlassianCredsInfo {
  site_url: string;
  site_name: string;
  display_name?: string;
  email?: string;
  hasToken: boolean;
  expiresInSeconds: number;
}

let cached: AtlassianCreds | null = null;

export async function getAtlassianCreds(): Promise<AtlassianCreds | null> {
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
      cached = JSON.parse(blob.toString('utf-8')) as AtlassianCreds;
      return cached;
    } catch {
      return null;
    }
  }
  try {
    const json = safeStorage.decryptString(blob);
    cached = JSON.parse(json) as AtlassianCreds;
    return cached;
  } catch {
    try {
      const fallback = JSON.parse(blob.toString('utf-8')) as AtlassianCreds;
      if (fallback?.access_token && fallback?.cloud_id) {
        cached = fallback;
        await setAtlassianCreds(fallback).catch(() => undefined);
        return cached;
      }
    } catch {
      /* not valid */
    }
    return null;
  }
}

export async function setAtlassianCreds(creds: AtlassianCreds): Promise<void> {
  cached = creds;
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const payload = JSON.stringify(creds);
  if (safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(CREDS_FILE(), safeStorage.encryptString(payload));
  } else {
    await fs.writeFile(CREDS_FILE(), payload, 'utf-8');
  }
}

export async function clearAtlassianCreds(): Promise<void> {
  cached = null;
  try {
    await fs.writeFile(CREDS_FILE(), Buffer.alloc(0));
  } catch {
    /* file may not exist — fine */
  }
}

export async function getCredsInfo(): Promise<AtlassianCredsInfo | null> {
  const c = await getAtlassianCreds();
  if (!c) return null;
  return {
    site_url: c.site_url,
    site_name: c.site_name,
    display_name: c.display_name,
    email: c.email,
    hasToken: c.access_token.length > 0,
    expiresInSeconds: Math.floor((c.expires_at - Date.now()) / 1000),
  };
}

// Confluence API 호출 시 사용. 만료 임박하면 refresh_token 으로 자동 갱신.
// 호출자는 access_token 만 받음 — cloud_id/site_url 은 별도 getCloudConfluenceBaseUrl().
export async function getCurrentAccessToken(): Promise<{ access_token: string; cloud_id: string; site_url: string } | null> {
  const c = await getAtlassianCreds();
  if (!c || !c.access_token) return null;
  // 만료 임박 (60초) 시 refresh 시도. atlassian-oauth.ts 의 refreshAccessToken 사용.
  if (c.expires_at - Date.now() < 60_000 && c.refresh_token) {
    try {
      // 동적 import — circular dep 방지.
      const { refreshAccessToken } = await import('./atlassian-oauth');
      const refreshed = await refreshAccessToken(c);
      if (refreshed) {
        return { access_token: refreshed.access_token, cloud_id: refreshed.cloud_id, site_url: refreshed.site_url };
      }
    } catch {
      /* refresh 실패 → 만료된 token 그대로 반환. 호출자가 401 받으면 사용자에게 재로그인 안내. */
    }
  }
  return { access_token: c.access_token, cloud_id: c.cloud_id, site_url: c.site_url };
}
