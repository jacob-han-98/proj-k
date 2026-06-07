// 2026-05-12: 운영 Confluence 트리는 confluence-downloader 의 manifest 기반이라
// 테스트 스페이스(예: PKTEST)는 자동으로 표시되지 않는다. 사본을 만든 뒤 다시 찾기
// 어려운 UX 문제 해결: main 이 부팅/refresh 시점에 Confluence v2 API 로 testSpace
// (또는 testParent 가 설정돼 있으면 그 페이지의 자식들) 를 라이브 fetch 해서 트리
// 최상단에 별도 top-level 노드로 prepend.
//
// 자격 / 설정:
//   - getConfluenceCreds() 의 email + apiToken (Basic auth) — 없으면 null 반환 (silent)
//   - getSettings() 의 confluenceTestSpaceKey (필수), confluenceTestParentPageId (선택)
//
// API 호출:
//   - parent 설정됨 → GET /wiki/api/v2/pages/{parentId}/children?limit=250
//   - parent 미설정 → GET /wiki/api/v2/spaces?keys=KEY → spaceId → GET
//     /wiki/api/v2/spaces/{spaceId}/pages?limit=250 (parentId null 인 root 만 필터)
//
// 250 hard cap — PKTEST 같은 sandbox 는 보통 자식 수십개. 그 이상은 lazy load 단계
// (옵션 C-full) 로 미루고 일단 정적 fetch.

import { getConfluenceCreds } from './auth';
import { getSettings } from './settings';
import type { TreeNode } from '../shared/types';

const CONFLUENCE_BASE = 'https://bighitcorp.atlassian.net';
const FETCH_LIMIT = 250;

interface SpaceInfo { id: string; key: string; name?: string }
interface PageItem { id: string; title: string }

function authHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function resolveSpaceFromKey(auth: string, spaceKey: string): Promise<SpaceInfo | null> {
  const url = `${CONFLUENCE_BASE}/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = (await res.json()) as { results?: Array<{ id: string; key: string; name?: string }> };
  const first = j.results?.[0];
  return first ? { id: first.id, key: first.key, name: first.name } : null;
}

async function fetchChildrenOfPage(auth: string, parentId: string): Promise<PageItem[]> {
  const url = `${CONFLUENCE_BASE}/wiki/api/v2/pages/${encodeURIComponent(parentId)}/children?limit=${FETCH_LIMIT}`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) return [];
  const j = (await res.json()) as { results?: Array<{ id: string; title?: string }> };
  return (j.results || []).map((p) => ({ id: p.id, title: p.title ?? `(id ${p.id})` }));
}

async function fetchRootPagesOfSpace(auth: string, spaceId: string): Promise<PageItem[]> {
  // v2 의 spaces/{id}/pages 는 depth=root 직접 지원 X — parentId 가 null/empty 인 것만
  // root 로 간주해 클라이언트 필터.
  const url = `${CONFLUENCE_BASE}/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?limit=${FETCH_LIMIT}`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) return [];
  const j = (await res.json()) as {
    results?: Array<{ id: string; title?: string; parentId?: string | null }>;
  };
  return (j.results || [])
    .filter((p) => p.parentId == null || p.parentId === '')
    .map((p) => ({ id: p.id, title: p.title ?? `(id ${p.id})` }));
}

export async function fetchTestSpaceTreeNode(): Promise<TreeNode | null> {
  const settings = getSettings();
  const testSpaceKey = settings.confluenceTestSpaceKey?.trim();
  if (!testSpaceKey) return null;
  const creds = await getConfluenceCreds();
  if (!creds?.apiToken || !creds.email) return null;
  const auth = authHeader(creds.email, creds.apiToken);

  const testParentId = settings.confluenceTestParentPageId?.trim();

  try {
    let pages: PageItem[];
    if (testParentId) {
      pages = await fetchChildrenOfPage(auth, testParentId);
    } else {
      const space = await resolveSpaceFromKey(auth, testSpaceKey);
      if (!space) return null;
      pages = await fetchRootPagesOfSpace(auth, space.id);
    }

    const childNodes: TreeNode[] = pages.map((p) => ({
      id: `confluence:${p.id}`,
      type: 'page',
      title: p.title,
      confluencePageId: p.id,
      relPath: `[${testSpaceKey}] ${p.title}`,
    }));

    return {
      id: `testspace:${testSpaceKey}`,
      type: 'space',
      title: `📋 테스트 스페이스 (${testSpaceKey})`,
      children: childNodes,
    };
  } catch (e) {
    console.warn('[confluence-test-space] fetch 실패', e);
    return null;
  }
}
