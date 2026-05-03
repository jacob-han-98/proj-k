// B2-1 (2026-05-03): 운영 Confluence 페이지를 테스트 스페이스로 사본 만드는 main process
// 헬퍼. 사용자가 실 운영 페이지를 직접 수정하지 않고 안전하게 review/Apply 검증할 수 있도록.
//
// 흐름:
//   1) GET /wiki/api/v2/pages/{sourceId}?body-format=storage&include-version=true
//   2) 새 title = `<원본 title> (테스트 사본 YYYY-MM-DD HH:MM)` — timestamp 로 충돌 회피.
//   3) POST /wiki/api/v2/pages with { spaceId, parentId?, title, body: { value: storage, representation: 'storage' } }
//   4) 새 page 의 id + url 반환.
//
// 자격 / 설정:
//   - getConfluenceCreds() 의 email + apiToken (Basic auth)
//   - getSettings() 의 confluenceTestSpaceKey (필수), confluenceTestParentPageId (선택)
//   - testSpaceKey 로부터 spaceId 조회 (v2 API 는 numeric spaceId 요구).

import { getConfluenceCreds } from './auth';
import { getSettings } from './settings';

const CONFLUENCE_BASE = 'https://bighitcorp.atlassian.net';

export interface CopyResult {
  ok: true;
  newPageId: string;
  newPageUrl: string;
  newTitle: string;
  spaceKey: string;
}

export interface CopyError {
  ok: false;
  error: string;
}

function authHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

// 한국 시간대 ish — 사용자가 사본을 한국 환경에서 보니. ISO 의 끝 Z 제거 + 분 단위 절단.
function timestampLabel(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

interface SpaceInfo {
  id: string;
  key: string;
}

async function resolveSpaceIdFromKey(auth: string, spaceKey: string): Promise<SpaceInfo | null> {
  // v2 API 는 numeric spaceId 사용. key 는 v1/v2 양쪽에서 받지만 v2 spaces?keys=KEY 가 가장 공식.
  const url = `${CONFLUENCE_BASE}/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = (await res.json()) as { results?: Array<{ id: string; key: string }> };
  const first = j.results?.[0];
  return first ? { id: first.id, key: first.key } : null;
}

interface SourcePage {
  title: string;
  storage: string;
}

async function fetchSourcePage(auth: string, sourceId: string): Promise<SourcePage | null> {
  const url = `${CONFLUENCE_BASE}/wiki/api/v2/pages/${encodeURIComponent(sourceId)}?body-format=storage`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    title?: string;
    body?: { storage?: { value?: string } };
  };
  if (!j.title || j.body?.storage?.value == null) return null;
  return { title: j.title, storage: j.body.storage.value };
}

export async function copyPageToTestSpace(sourcePageId: string): Promise<CopyResult | CopyError> {
  const creds = await getConfluenceCreds();
  if (!creds?.apiToken || !creds.email) {
    return { ok: false, error: 'Confluence 자격 미설정 — SettingsModal 에서 email + apiToken 입력 필요' };
  }
  const settings = getSettings();
  const testSpaceKey = settings.confluenceTestSpaceKey;
  if (!testSpaceKey) {
    return { ok: false, error: '테스트 스페이스 미설정 — SettingsModal 의 confluenceTestSpaceKey 입력 필요' };
  }
  const testParentId = settings.confluenceTestParentPageId;

  const auth = authHeader(creds.email, creds.apiToken);

  // 1) 원본 페이지 fetch
  let src: SourcePage | null;
  try {
    src = await fetchSourcePage(auth, sourcePageId);
  } catch (e) {
    return { ok: false, error: `원본 페이지 fetch 예외: ${(e as Error).message}` };
  }
  if (!src) {
    return { ok: false, error: `원본 페이지 fetch 실패 (id=${sourcePageId}) — page 없거나 권한 부족` };
  }

  // 2) 테스트 스페이스 id 조회
  let space: SpaceInfo | null;
  try {
    space = await resolveSpaceIdFromKey(auth, testSpaceKey);
  } catch (e) {
    return { ok: false, error: `테스트 스페이스 조회 예외: ${(e as Error).message}` };
  }
  if (!space) {
    return { ok: false, error: `테스트 스페이스 '${testSpaceKey}' 못 찾음 — key 확인` };
  }

  // 3) 새 title + 본문으로 페이지 생성
  const newTitle = `${src.title} (테스트 사본 ${timestampLabel()})`;
  const createBody: Record<string, unknown> = {
    spaceId: space.id,
    status: 'current',
    title: newTitle,
    body: {
      representation: 'storage',
      value: src.storage,
    },
  };
  if (testParentId) createBody.parentId = testParentId;

  let createResp: Response;
  try {
    createResp = await fetch(`${CONFLUENCE_BASE}/wiki/api/v2/pages`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(createBody),
    });
  } catch (e) {
    return { ok: false, error: `페이지 생성 예외: ${(e as Error).message}` };
  }

  if (!createResp.ok) {
    const errText = await createResp.text().catch(() => '');
    return { ok: false, error: `페이지 생성 실패 HTTP ${createResp.status}: ${errText.slice(0, 300)}` };
  }

  const created = (await createResp.json()) as {
    id: string;
    _links?: { webui?: string; base?: string };
  };
  const webui = created._links?.webui ?? `/spaces/${testSpaceKey}/pages/${created.id}`;
  const base = created._links?.base ?? `${CONFLUENCE_BASE}/wiki`;
  return {
    ok: true,
    newPageId: created.id,
    newPageUrl: `${base}${webui}`,
    newTitle,
    spaceKey: testSpaceKey,
  };
}
