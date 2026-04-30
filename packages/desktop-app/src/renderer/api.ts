// Renderer-side API client. Talks to the local Python sidecar over HTTP using
// the port discovered via IPC, and to the host process via window.projk.

import type { SearchHit, SearchResponse, SidecarStatus } from '../../src/shared/types';

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
): Promise<void> {
  const port = await ensurePort();
  const res = await fetch(`http://127.0.0.1:${port}/ask_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  await readNdjson(res, onLine);
}

// Phase 4-2: Confluence webview body → /review_stream → NDJSON. payload shape는
// chrome-extension/sidebar 와 동일 (title/text/model/review_instruction) 라서
// upstream agent 의 /review_stream 가 그대로 동작한다.
export async function reviewStream(
  payload: { title: string; text: string; model?: string; review_instruction?: string },
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
