// Phase 4-4: Confluence REST API 로 변경안 적용.
// GET /wiki/api/v2/pages/{id}?body-format=storage → text replace → PUT.
//
// 텍스트 매칭 전략: change.before 는 webview.executeJavaScript 로 뽑은 innerText 기반.
// storage format 은 XHTML. 단순 문자열 검색으로 before 를 찾아 after 로 교체.
// HTML 태그 안에 before 가 직접 들어있는 경우에만 동작 — 복잡한 인라인 마크업이
// 섞인 경우는 미매칭으로 처리. MVP 허용 범위.

import { getConfluenceCreds } from './auth';

export interface ChangeItem {
  id: string;
  description?: string;
  section?: string;
  before: string;
  after: string;
}

export interface ApplyResult {
  ok: boolean;
  applied: number;
  skipped: number;
  skippedIds: string[];
  pageUrl?: string;
  error?: string;
}

const CONFLUENCE_BASE = 'https://bighitcorp.atlassian.net';

function authHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

// whitespace 정규화: 연속 공백/줄바꿈을 단일 공백으로
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export async function applyEditsToConfluencePage(
  pageId: string,
  changes: ChangeItem[],
): Promise<ApplyResult> {
  const creds = await getConfluenceCreds();
  if (!creds?.apiToken) {
    return { ok: false, applied: 0, skipped: changes.length, skippedIds: changes.map(c => c.id), error: 'Confluence 인증 정보 없음 — SettingsModal 에서 설정' };
  }

  const auth = authHeader(creds.email, creds.apiToken);

  // 1. GET page (storage format)
  let pageData: {
    id: string;
    version: { number: number };
    title: string;
    body: { storage: { value: string } };
  };
  try {
    const res = await fetch(
      `${CONFLUENCE_BASE}/wiki/api/v2/pages/${pageId}?body-format=storage`,
      { headers: { Authorization: auth, Accept: 'application/json' } },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, applied: 0, skipped: changes.length, skippedIds: changes.map(c => c.id), error: `GET page HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    pageData = await res.json() as typeof pageData;
  } catch (e) {
    return { ok: false, applied: 0, skipped: changes.length, skippedIds: changes.map(c => c.id), error: `GET page 실패: ${(e as Error).message}` };
  }

  // 2. before → after 텍스트 교체
  let body = pageData.body.storage.value;
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const change of changes) {
    const before = change.before.trim();
    const after = change.after.trim();
    if (!before || !after) { skipped.push(change.id); continue; }

    if (body.includes(before)) {
      // 첫 번째 매칭만 교체 (동일 문구 중복 시 첫 것만)
      body = body.replace(before, after);
      applied.push(change.id);
    } else {
      // normalized 버전으로 재시도 (줄바꿈/공백 차이)
      const normBefore = normalize(before);
      const normBody = normalize(body);
      const idx = normBody.indexOf(normBefore);
      if (idx !== -1) {
        // normalized 에서 찾았으면 원본 body 에서 approximation 으로 교체
        // (공백 정규화 후 위치가 달라질 수 있어서 단순 replace 재사용)
        body = body.replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'm'), after);
        applied.push(change.id);
      } else {
        skipped.push(change.id);
      }
    }
  }

  if (applied.length === 0) {
    return { ok: false, applied: 0, skipped: skipped.length, skippedIds: skipped, error: '매칭된 변경안이 없습니다. 페이지 본문이 변경됐거나 before 텍스트가 storage 포맷과 다를 수 있습니다.' };
  }

  // 3. PUT updated page
  try {
    const putBody = {
      id: pageData.id,
      version: { number: pageData.version.number + 1 },
      title: pageData.title,
      body: { representation: 'storage', value: body },
    };
    const putRes = await fetch(`${CONFLUENCE_BASE}/wiki/api/v2/pages/${pageId}`, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(putBody),
    });
    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => '');
      return { ok: false, applied: applied.length, skipped: skipped.length, skippedIds: skipped, error: `PUT page HTTP ${putRes.status}: ${errText.slice(0, 200)}` };
    }
    const pageUrl = `${CONFLUENCE_BASE}/wiki/spaces/PK/pages/${pageId}`;
    return { ok: true, applied: applied.length, skipped: skipped.length, skippedIds: skipped, pageUrl };
  } catch (e) {
    return { ok: false, applied: applied.length, skipped: skipped.length, skippedIds: skipped, error: `PUT page 실패: ${(e as Error).message}` };
  }
}
