// 액티비티 바 5번 ("내 작업 중 문서") 의 Confluence draft 폴링.
//
// "지금 편집 중인 페이지" 를 Atlassian API 로 직접 조회하는 endpoint 는 없다 — 대신
// `status=draft` 페이지가 실질적으로 "사용자가 작성 중이거나 자동저장된 미발행본" 으로
// 동작한다. 사용자별로는 `owner-id` 로 필터.
//
// 흐름 (per poll):
//   1. (cache) 사용자 accountId — `/wiki/rest/api/user/current`
//   2. (cache) space key → space id — `/wiki/api/v2/spaces?keys=<keys csv>`
//   3. drafts — space id 별로 `/wiki/api/v2/pages?status=draft&owner-id=<me>&space-id=<sid>`
//
// 캐시는 모듈 레벨 — 같은 자격으로 한번 풀어두면 재호출 안함. 자격이 바뀌면 외부에서
// invalidateConfluenceDraftsCache() 호출해야 (현재는 SettingsModal save 시 호출).

import { getConfluenceCreds } from './auth';
import { getConfluenceAuth, type ConfluenceAuthContext } from './confluence-rest';
import type { ActiveConfluenceDraft, ActiveConfluenceResult } from '../shared/types';

let cachedAccountId: string | null = null;
let cachedSpaceIdByKey: Map<string, string> | null = null;

export function invalidateConfluenceDraftsCache(): void {
  cachedAccountId = null;
  cachedSpaceIdByKey = null;
}

async function getCurrentAccountId(auth: ConfluenceAuthContext): Promise<string | null> {
  if (cachedAccountId) return cachedAccountId;
  try {
    const res = await fetch(`${auth.baseUrl}/rest/api/user/current`, {
      headers: auth.headers,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { accountId?: string };
    if (!j.accountId) return null;
    cachedAccountId = j.accountId;
    return cachedAccountId;
  } catch {
    return null;
  }
}

// 한 번에 여러 key 를 ?keys= 로 lookup. 응답 results[].id 가 string id.
async function getSpaceIdsByKeys(
  auth: ConfluenceAuthContext,
  keys: string[],
): Promise<Map<string, string>> {
  if (cachedSpaceIdByKey) {
    const allCached = keys.every((k) => cachedSpaceIdByKey!.has(k));
    if (allCached) return cachedSpaceIdByKey;
  }
  const out = new Map<string, string>();
  if (keys.length === 0) {
    cachedSpaceIdByKey = out;
    return out;
  }
  try {
    const qs = keys.map((k) => `keys=${encodeURIComponent(k)}`).join('&');
    const res = await fetch(`${auth.baseUrl}/api/v2/spaces?${qs}`, {
      headers: auth.headers,
    });
    if (!res.ok) {
      cachedSpaceIdByKey = out;
      return out;
    }
    const j = (await res.json()) as { results?: Array<{ id: string; key: string }> };
    for (const sp of j.results ?? []) {
      if (sp.id && sp.key) out.set(sp.key, sp.id);
    }
    cachedSpaceIdByKey = out;
    return out;
  } catch {
    cachedSpaceIdByKey = out;
    return out;
  }
}

async function listDraftsForSpace(
  auth: ConfluenceAuthContext,
  spaceId: string,
  spaceKey: string,
  ownerId: string,
): Promise<ActiveConfluenceDraft[]> {
  const url = new URL(`${auth.baseUrl}/api/v2/pages`);
  url.searchParams.set('status', 'draft');
  url.searchParams.set('space-id', spaceId);
  url.searchParams.set('owner-id', ownerId);
  url.searchParams.set('limit', '50');
  try {
    const res = await fetch(url.toString(), {
      headers: auth.headers,
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      results?: Array<{
        id: string;
        title?: string;
        version?: { createdAt?: string };
      }>;
    };
    return (j.results ?? []).map((p) => ({
      pageId: String(p.id),
      title: p.title ?? '(제목 없음)',
      spaceKey,
      lastModified: p.version?.createdAt,
    }));
  } catch {
    return [];
  }
}

// 메인 entrypoint — IPC handler 가 호출. spaceKeys 가 비면 ['PK'] fallback.
export async function listMyConfluenceDrafts(
  spaceKeys: string[] | undefined,
): Promise<ActiveConfluenceResult> {
  const creds = await getConfluenceCreds();
  const fallback: typeof creds = creds ?? { email: '', apiToken: '', baseUrl: '' };
  const auth = await getConfluenceAuth(fallback);
  if (!auth.isOAuth && (!creds?.email || !creds?.apiToken)) {
    return {
      ok: false,
      drafts: [],
      diagnostics: 'Confluence 자격 미설정 — Atlassian 로그인 또는 SettingsModal apiToken.',
    };
  }
  const keys = spaceKeys && spaceKeys.length > 0 ? spaceKeys : ['PK'];

  const accountId = await getCurrentAccountId(auth);
  if (!accountId) {
    return {
      ok: false,
      drafts: [],
      diagnostics: 'Confluence 사용자 정보 조회 실패 — 자격이 만료됐거나 token 권한 부족.',
    };
  }

  const spaceIds = await getSpaceIdsByKeys(auth, keys);
  if (spaceIds.size === 0) {
    return {
      ok: false,
      drafts: [],
      diagnostics: `Confluence 스페이스 lookup 실패: ${keys.join(', ')}`,
    };
  }

  // 각 space 병렬 fetch. 50 페이지 cap × space 수 — PK + 임시 공간 정도면 충분.
  const perSpace = await Promise.all(
    Array.from(spaceIds.entries()).map(([key, id]) =>
      listDraftsForSpace(auth, id, key, accountId),
    ),
  );

  const drafts = perSpace.flat();
  // lastModified desc 정렬. 없으면 뒤로.
  drafts.sort((a, b) => {
    const ta = a.lastModified ? Date.parse(a.lastModified) : 0;
    const tb = b.lastModified ? Date.parse(b.lastModified) : 0;
    return tb - ta;
  });

  return { ok: true, drafts };
}
