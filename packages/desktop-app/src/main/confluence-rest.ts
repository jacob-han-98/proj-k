// 2026-05-13 Final-3 Step 2: Confluence REST 호출 인증 흐름 통합.
//
// 사용자가 Atlassian OAuth 로그인 했으면 access_token 우선 사용, 아니면 기존 ConfluenceCreds
// (email + apiToken) Basic auth fallback. confluence-apply / -drafts / -copy 등 4-5 파일
// 의 fetch 호출이 모두 이 helper 사용.
//
// URL shape 차이:
//   OAuth: https://api.atlassian.com/ex/confluence/<cloudId>/wiki/<endpoint>
//   Basic: https://<site>.atlassian.net/wiki/<endpoint>
// 두 경우 모두 /wiki/api/v2/... + /wiki/rest/api/... 의 endpoint 그대로 forward.

import { getCurrentAccessToken } from './atlassian-auth';
import type { ConfluenceCreds } from '../shared/types';

export interface ConfluenceAuthContext {
  // 호출자가 + `/api/v2/pages/${id}` 등 endpoint 만 append.
  // 끝에 슬래시 없음.
  baseUrl: string;
  headers: Record<string, string>;
  // 운영 진단 + 로깅 + 401 시 사용자 안내용. true 면 OAuth.
  isOAuth: boolean;
  // OAuth 일 때 backend 가 비교/디버그 가능하게 인용. Basic 일 때 undefined.
  cloudId?: string;
  siteUrl?: string;
}

function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

export async function getConfluenceAuth(creds: ConfluenceCreds): Promise<ConfluenceAuthContext> {
  // 1순위: Atlassian OAuth access_token. 만료 임박이면 atlassian-auth 의
  // getCurrentAccessToken 가 refresh_token 으로 자동 갱신 후 반환.
  const oauth = await getCurrentAccessToken();
  if (oauth) {
    return {
      baseUrl: `https://api.atlassian.com/ex/confluence/${oauth.cloud_id}/wiki`,
      headers: {
        Authorization: `Bearer ${oauth.access_token}`,
        Accept: 'application/json',
      },
      isOAuth: true,
      cloudId: oauth.cloud_id,
      siteUrl: oauth.site_url,
    };
  }
  // 2순위: 기존 Basic auth. 옛 사용자 / dev 환경 fallback.
  // creds.baseUrl 의 trailing slash 안 떨어트림 — 호출자가 명시 endpoint 추가 시 / 부착.
  // 빈 string 이면 사내 default — 옛 사용자 호환.
  const rawBase = (creds.baseUrl || 'https://bighitcorp.atlassian.net').replace(/\/+$/, '');
  return {
    baseUrl: `${rawBase}/wiki`,
    headers: {
      Authorization: basicAuth(creds.email, creds.apiToken),
      Accept: 'application/json',
    },
    isOAuth: false,
  };
}
