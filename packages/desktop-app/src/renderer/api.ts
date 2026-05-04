// Renderer-side API client. Talks to the local Python sidecar over HTTP using
// the port discovered via IPC, and to the host process via window.projk.

import type {
  QuickFindHit,
  QuickFindResult,
  SearchHit,
  SearchResponse,
  SidecarStatus,
} from '../../src/shared/types';
import type { ReviewOptionsPayload } from './panels/review-options-mapping';

let cachedPort: number | null = null;

async function ensurePort(): Promise<number> {
  if (cachedPort != null) return cachedPort;
  const status = await window.projk.getSidecarStatus();
  if (status.port == null) throw new Error('sidecar not started');
  cachedPort = status.port;
  return cachedPort;
}

window.projk?.onSidecarStatus?.((s: SidecarStatus) => {
  if (s.port != null) cachedPort = s.port;
});

// A3-b: 답변 안 citation 클릭 → content.md 본문 + section range. modal 또는 split 으로 표시.
export interface SourceView {
  path: string;
  section: string;
  content: string;
  section_range?: [number, number] | null;
  origin_label?: string;
  origin_url?: string;
  source?: string;
}
export async function getSourceView(path: string, section = ''): Promise<SourceView | null> {
  try {
    const port = await ensurePort();
    const url = new URL(`http://127.0.0.1:${port}/source_view`);
    url.searchParams.set('path', path);
    if (section) url.searchParams.set('section', section);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return (await res.json()) as SourceView;
  } catch {
    return null;
  }
}

// B3: P4 시트 리뷰 — xlsx-extractor 가 변환한 sheet 별 content.md 들을 워크북 단위로 합쳐
// 반환. ConfluencePane 의 webview innerText 추출에 대응되는 LocalSheetView 의 본문 채널.
//
// 응답: { workbook, sheets: [{name, content, char_count, truncated}], total_chars }
// 호출자는 sheet content 를 markdown header (## <sheet name>) 로 묶어 review_stream 에 보냄.
export interface SheetContentSheet {
  name: string;
  content: string;
  char_count: number;
  truncated?: boolean;
}
export interface SheetContentResult {
  workbook: string;
  source_dir: string;
  sheets: SheetContentSheet[];
  total_chars: number;
}
export async function getSheetContent(
  relPath: string,
  maxChars = 60_000,
): Promise<SheetContentResult | null> {
  try {
    const port = await ensurePort();
    const url = new URL(`http://127.0.0.1:${port}/sheet_content`);
    url.searchParams.set('relPath', relPath);
    url.searchParams.set('max_chars', String(maxChars));
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return (await res.json()) as SheetContentResult;
  } catch {
    return null;
  }
}

// markdown 헤더로 workbook 을 묶어 review_stream 에 보낼 단일 텍스트.
// ConfluencePane 의 innerText 추출과 동등 — review_stream 입력 contract 준수.
export function flattenSheetContent(result: SheetContentResult): string {
  const parts: string[] = [`# ${result.workbook}`, ''];
  for (const s of result.sheets) {
    parts.push(`## ${s.name}`);
    parts.push('');
    parts.push(s.content);
    if (s.truncated) parts.push('\n_(잘림)_');
    parts.push('');
  }
  return parts.join('\n');
}

// A3-c: agent server-side conversation 관리 — admin 목록 / 상세 / fork / shared 읽기.
// agent-sdk-poc 가 자체 storage 에 conversation 별 turns 를 저장. Klaud thread (SQLite)
// 와는 별개 — 추후 conversation_id ↔ thread 매핑이 들어가야 UI 통합 가능.
export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  last_elapsed_s?: number | null;
  last_cost_usd?: number | null;
}
export interface ConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: Array<Record<string, unknown>>;
  // agent 가 추가 필드 붙일 수 있음 — passthrough.
  [k: string]: unknown;
}
export interface ForkResult {
  conversation_id: string;
  title: string;
  turn_count: number;
}
export async function listConversations(): Promise<ConversationSummary[]> {
  try {
    const port = await ensurePort();
    const res = await fetch(`http://127.0.0.1:${port}/admin/conversations`);
    if (!res.ok) return [];
    const data = (await res.json()) as { conversations?: ConversationSummary[] };
    return Array.isArray(data?.conversations) ? data.conversations : [];
  } catch {
    return [];
  }
}
export async function getConversation(convId: string): Promise<ConversationDetail | null> {
  try {
    const port = await ensurePort();
    const res = await fetch(
      `http://127.0.0.1:${port}/admin/conversations/${encodeURIComponent(convId)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as ConversationDetail;
  } catch {
    return null;
  }
}
export async function forkConversation(convId: string): Promise<ForkResult | null> {
  try {
    const port = await ensurePort();
    const res = await fetch(
      `http://127.0.0.1:${port}/conversations/${encodeURIComponent(convId)}/fork`,
      { method: 'POST' },
    );
    if (!res.ok) return null;
    return (await res.json()) as ForkResult;
  } catch {
    return null;
  }
}
export async function getSharedConversation(convId: string): Promise<ConversationDetail | null> {
  try {
    const port = await ensurePort();
    const res = await fetch(
      `http://127.0.0.1:${port}/shared/${encodeURIComponent(convId)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as ConversationDetail;
  } catch {
    return null;
  }
}

// A3-a: agent-sdk-poc 의 큐레이션된 추천 prompt — sidecar /preset_prompts proxy 통해.
// QnATab 의 입력란 위에 카테고리별 chips 로 노출. agent 미설정 또는 fail 시 빈 list →
// UI 가 chips 자체를 hide.
export interface PresetPrompt {
  label: string;
  prompt: string;
  category?: string;
}
export async function getPresetPrompts(): Promise<PresetPrompt[]> {
  try {
    const port = await ensurePort();
    const res = await fetch(`http://127.0.0.1:${port}/preset_prompts`);
    if (!res.ok) return [];
    const data = (await res.json()) as { presets?: PresetPrompt[] };
    return Array.isArray(data?.presets) ? data.presets : [];
  } catch {
    return [];
  }
}

export async function searchDocs(query: string, limit = 20): Promise<SearchResponse> {
  const port = await ensurePort();
  const res = await fetch(`http://127.0.0.1:${port}/search_docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`search_docs HTTP ${res.status}`);
  return (await res.json()) as SearchResponse;
}

export async function askStream(
  question: string,
  onLine: (event: { type: string; payload: unknown }) => void,
  // P3: 일반 Agent 모드는 conversation_id 와 함께 호출 — backend 가 같은 conv 의
  // doc_context (read_current_doc tool) 를 hint 로 system prompt 에 주입.
  // 미지정 시 기존 QnA 동작.
  conversationId?: string,
): Promise<void> {
  const port = await ensurePort();
  const body: Record<string, unknown> = { question };
  if (conversationId) body.conversation_id = conversationId;
  const res = await fetch(`http://127.0.0.1:${port}/ask_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await readNdjson(res, onLine);
}

// P3: 일반 Agent 모드 — doc_context stash/clear.
// 같은 conv_id 재호출 시 backend 가 덮어씀. 모드 닫을 때 clear 로 정리해 메모리 절약.
export interface DocContextResult {
  ok: boolean;
  conversation_id?: string;
  content_chars?: number;
  truncated?: boolean;
  cleared?: boolean;
  error?: string;
}

export async function setDocContext(
  conversationId: string,
  payload: { title?: string; page_id?: string; doc_type?: string; content: string },
): Promise<DocContextResult> {
  const port = await ensurePort();
  const res = await fetch(
    `http://127.0.0.1:${port}/conversations/${encodeURIComponent(conversationId)}/doc_context`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return (await res.json()) as DocContextResult;
}

export async function clearDocContext(conversationId: string): Promise<DocContextResult> {
  const port = await ensurePort();
  const res = await fetch(
    `http://127.0.0.1:${port}/conversations/${encodeURIComponent(conversationId)}/doc_context`,
    { method: 'DELETE' },
  );
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return (await res.json()) as DocContextResult;
}

// P1: 요약 모드. /summary_stream 도 review 와 동일한 NDJSON 패턴. backend default
// 는 model=opus / max_tokens=8194 — frontend 가 안 보내면 그대로 적용.
// result.data.summary 가 markdown 문자열 (review 와 다른 점 — review 는 JSON 문자열).
export async function summaryStream(
  payload: {
    title: string;
    text: string;
    model?: string;
    summary_style?: string;
    max_tokens?: number;
  },
  onLine: (event: { type: string; payload: unknown }) => void,
): Promise<void> {
  const port = await ensurePort();
  const res = await fetch(`http://127.0.0.1:${port}/summary_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await readNdjson(res, onLine);
}

// Phase 4-2: Confluence webview body → /review_stream → NDJSON. payload shape는
// chrome-extension/sidebar 와 동일 (title/text/model/review_instruction) 라서
// upstream agent 의 /review_stream 가 그대로 동작한다.
export async function reviewStream(
  payload: {
    title: string;
    text: string;
    model?: string;
    review_instruction?: string;
    // P2: 옵션 패널에서 고른 6개 컨트롤. backend 가 옵셔널로 받음 — 미지정 시 기존 동작.
    review_options?: ReviewOptionsPayload;
  },
  onLine: (event: { type: string; payload: unknown }) => void,
): Promise<void> {
  const port = await ensurePort();
  const res = await fetch(`http://127.0.0.1:${port}/review_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await readNdjson(res, onLine);
}

// Phase 4-3.5: review 결과 + 사용자 instruction → 변경안 (changes 배열).
// WSL agent (agent-sdk-poc) 가 NDJSON 스트림으로 status/token/result 흘림 — review 와
// 동일한 패턴. result.data.changes 에 [{id, section, description, before, after}].
export interface ChangeItem {
  id: string;
  description?: string;
  section?: string;
  before: string;
  after: string;
}

export async function suggestEditsStream(
  payload: {
    title: string;
    text: string;
    instruction: string;
    maxChanges?: number;
    html?: string;
    model?: string;
  },
  onLine: (event: { type: string; payload: unknown }) => void,
): Promise<void> {
  const port = await ensurePort();
  const res = await fetch(`http://127.0.0.1:${port}/suggest_edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await readNdjson(res, onLine);
}

// PR10: Quick Find — 사이드바 input → debounced 호출. NDJSON 스트림으로 hits 점진 yield.
//   fast=true  : ~50ms L1 only  (typing-as-you-search)
//   fast=false : auto v2.1      (Enter / 검색 클릭, 풀 quality)
// API contract: 20260501-163017-0292b5 (backend reply). 다른 필드 (strategy 등) 는 ignored.
//
// onEvent 핸들러 책임:
//   - {type:"status", message} : 진행 라벨
//   - {type:"hit", data}        : 점진 hit (UI 에 즉시 추가)
//   - {type:"result", data}     : 종료 + total/latency/expanded 메타
//   - {type:"error", message}   : 실패
//
// AbortSignal 받음 — 사용자가 빠르게 다음 query 입력하면 이전 stream cancel.
export async function quickFind(
  query: string,
  opts: { limit?: number; kinds?: ('xlsx' | 'confluence')[]; fast?: boolean; signal?: AbortSignal } = {},
  onEvent: (event: { type: string; [k: string]: unknown }) => void,
): Promise<void> {
  const port = await ensurePort();
  const body: Record<string, unknown> = { query };
  if (opts.limit != null) body.limit = opts.limit;
  if (opts.kinds && opts.kinds.length > 0) body.kinds = opts.kinds;
  if (opts.fast) body.fast = true;
  const res = await fetch(`http://127.0.0.1:${port}/quick_find`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`quick_find HTTP ${res.status}`);
  await readNdjson(res, onEvent as (e: { type: string; payload: unknown }) => void);
}

export type { QuickFindHit, QuickFindResult };

async function readNdjson(
  res: Response,
  onLine: (event: { type: string; payload: unknown }) => void,
): Promise<void> {
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        onLine(obj);
      } catch {
        // ignore parse errors on partial chunks
      }
    }
  }
}

export type { SearchHit };
