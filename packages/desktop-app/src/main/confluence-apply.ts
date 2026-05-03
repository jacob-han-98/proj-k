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

// HTML 태그 제거 + entity decode 일부 — storage format 의 inline 마크업 (<custom>, <ac:>,
// <strong> 등) 안 텍스트만 추출. 사용자 본문 (webview innerText) 와 매칭 가능하게 함.
function stripHtmlForMatch(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// B2-3b: 매칭 시도 — body 안에서 before 를 찾아 after 로 교체. 단계적 fallback:
//   1) exact substring (가장 안전)
//   2) whitespace normalize 후 indexOf — 줄바꿈/공백 차이만 다른 경우 회복
//   3) HTML 태그 strip + normalize — storage 의 inline 마크업이 끼어 있어 본문 텍스트만으로
//      match 안 되는 경우 (예: <custom>...</custom> 같은 emoji/mention 사이 텍스트)
//
// 반환: { ok: true, newBody, strategy } 또는 { ok: false, reason } — UI 진단용.
export type MatchStrategy = 'exact' | 'normalize' | 'html-strip';
export interface MatchResult {
  ok: true;
  newBody: string;
  strategy: MatchStrategy;
}
export interface NoMatchResult {
  ok: false;
  reason: string;
}

export function tryFindAndReplace(
  body: string,
  before: string,
  after: string,
): MatchResult | NoMatchResult {
  const trimmedBefore = before.trim();
  const trimmedAfter = after.trim();
  if (!trimmedBefore || !trimmedAfter) {
    return { ok: false, reason: '빈 before/after' };
  }

  // 1) Exact
  if (body.includes(trimmedBefore)) {
    return { ok: true, newBody: body.replace(trimmedBefore, trimmedAfter), strategy: 'exact' };
  }

  // 2) Whitespace normalize
  const normBefore = normalize(trimmedBefore);
  const normBody = normalize(body);
  if (normBody.includes(normBefore)) {
    // 원본 body 에서 \s+ tolerant regex 로 교체 시도.
    const escaped = trimmedBefore
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const reBody = body.replace(new RegExp(escaped, 'm'), trimmedAfter);
    if (reBody !== body) return { ok: true, newBody: reBody, strategy: 'normalize' };
  }

  // 3) HTML strip + 워드 subsequence — storage 의 inline 마크업 (<custom>, emoji 등) 이
  //    before 단어 사이에 끼어 있어 exact / normalize 다 fail 하는 경우.
  //    전략: before 의 모든 단어가 raw body 안에 *순서대로* 등장하면 매칭으로 봄.
  //    교체 범위 = body 의 first 단어 시작 ~ last 단어 끝. 이 범위에는 inline 마크업도
  //    함께 swap 됨 (의도 — passage 전체 재작성이라 사용자가 storage 마크업 잃는 것 OK).
  const strippedBefore = stripHtmlForMatch(trimmedBefore);
  const beforeWords = strippedBefore.split(/\s+/).filter((w) => w.length > 0);
  if (beforeWords.length >= 2) {
    // 단어 subsequence — body 안에서 순차적으로 find.
    let cursor = 0;
    let firstStart = -1;
    let lastEnd = -1;
    let allFound = true;
    for (let i = 0; i < beforeWords.length; i++) {
      const w = beforeWords[i]!;
      const found = body.indexOf(w, cursor);
      if (found < 0) { allFound = false; break; }
      if (i === 0) firstStart = found;
      if (i === beforeWords.length - 1) lastEnd = found + w.length;
      cursor = found + w.length;
    }
    if (allFound && firstStart >= 0 && lastEnd > firstStart) {
      const newBody = body.slice(0, firstStart) + trimmedAfter + body.slice(lastEnd);
      return { ok: true, newBody, strategy: 'html-strip' };
    }
  }

  return { ok: false, reason: '매칭 실패 — exact / normalize / html-strip 모두' };
}

// B2-3b: 사전 매칭 체크 — 페이지 storage 한 번 GET 후 각 change 가 매칭 가능한지만 확인.
// Apply 전에 ChangesCard 가 호출 → 미매칭 row 에 ⚠ badge 표시.
export interface PreCheckResult {
  ok: boolean;
  matched: string[];
  unmatched: string[];
  error?: string;
}

export async function preCheckChangesMatch(
  pageId: string,
  changes: Array<{ id: string; before: string }>,
): Promise<PreCheckResult> {
  const creds = await getConfluenceCreds();
  if (!creds?.apiToken) {
    return { ok: false, matched: [], unmatched: changes.map((c) => c.id), error: 'Confluence 자격 미설정' };
  }
  const auth = authHeader(creds.email, creds.apiToken);
  let body: string;
  try {
    const res = await fetch(
      `${CONFLUENCE_BASE}/wiki/api/v2/pages/${pageId}?body-format=storage`,
      { headers: { Authorization: auth, Accept: 'application/json' } },
    );
    if (!res.ok) {
      return {
        ok: false,
        matched: [],
        unmatched: changes.map((c) => c.id),
        error: `GET page HTTP ${res.status}`,
      };
    }
    const j = (await res.json()) as { body?: { storage?: { value?: string } } };
    body = j.body?.storage?.value ?? '';
  } catch (e) {
    return {
      ok: false,
      matched: [],
      unmatched: changes.map((c) => c.id),
      error: `GET page 예외: ${(e as Error).message}`,
    };
  }
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const c of changes) {
    // after='' 로 dummy — match 여부만 본다.
    const r = tryFindAndReplace(body, c.before, 'X');
    if (r.ok) matched.push(c.id);
    else unmatched.push(c.id);
  }
  return { ok: true, matched, unmatched };
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

  // 2. before → after 텍스트 교체 — B2-3b: tryFindAndReplace 단계적 fallback 사용.
  let body = pageData.body.storage.value;
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const change of changes) {
    const r = tryFindAndReplace(body, change.before, change.after);
    if (r.ok) {
      body = r.newBody;
      applied.push(change.id);
    } else {
      skipped.push(change.id);
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
