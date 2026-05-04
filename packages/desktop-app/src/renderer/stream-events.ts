// agent-sdk-poc 의 NDJSON stream 이벤트 helpers — 여러 endpoint (`/ask_stream`,
// `/review_stream`, `/suggest_edits`) 가 같은 schema 따라간다.
//
// agent 가 보내는 표준 (2026-05 기준):
//   { type: "status",  message: "..." }
//   { type: "stage",   stage: "writing", label: "답변 작성" }
//   { type: "thinking", text: "..." }
//   { type: "tool_start", id, tool, input, label }
//   { type: "tool_end",   id, summary, label, preview }
//   { type: "token",   text: "토큰 chunk" }   ← 신규 (2026-05-03 deploy)
//   { type: "result",  data: { ... } }
//   { type: "error",   message: "..." }
//
// Klaud 의 stream 핸들러는 다음 두 가지 이유로 defensive read:
//   1) 옛 mock 은 token 이벤트의 텍스트를 `payload` 필드로 보냈음 — backwards-compat
//   2) 다른 backend 는 `delta`/`token` 변형을 쓸 수도 있음
// 결과 같은 핸들러가 `text/payload/token/delta` 어느 필드든 정상 동작.

export type StreamEvent = { type: string; [k: string]: unknown };

export function readToken(e: StreamEvent): string | null {
  // 우선순위: 신규 schema (text) > 옛 mock (payload) > 변형 (token/delta).
  const v = e.text ?? e.payload ?? e.token ?? e.delta;
  return typeof v === 'string' ? v : null;
}

export function readResultData(e: StreamEvent): Record<string, unknown> | null {
  // result 이벤트는 `data` (신규/표준) 또는 `payload` (옛 Klaud 핸들러 가정) 둘 다 허용.
  const v = e.data ?? e.payload;
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  return null;
}

export function readErrorMessage(e: StreamEvent): string | null {
  const v = e.error ?? e.message ?? e.payload;
  return typeof v === 'string' ? v : null;
}

// Phase C: status 이벤트 — backend 가 진행 상태를 짧게 알려줌. 예: "📨 분석 중...".
// QnATab 의 progress UI 가 받아 라인으로 표시 — 사용자가 "동작 중인지" 즉시 인지.
export function readStatus(e: StreamEvent): string | null {
  if (e.type !== 'status') return null;
  const v = e.message ?? e.payload;
  return typeof v === 'string' ? v : null;
}

// Phase C: thinking 이벤트 — 모델의 reasoning. 길어서 그대로 보이면 노이즈 — Progress 라인의
// 보조 라벨로만 쓰고 (앞 60자 정도) 펼치지는 않음.
export function readThinking(e: StreamEvent): string | null {
  if (e.type !== 'thinking') return null;
  const v = e.text;
  return typeof v === 'string' ? v : null;
}

// Phase C: tool_start / tool_end — agent 가 도구 호출 중. UI 에 "🔧 grep_summaries..." 식
// 라벨 표시. label 필드는 backend 가 한국어로 미리 만들어 주기도 함.
export interface ToolStartInfo {
  id: string;
  tool: string;
  label: string;
}
export function readToolStart(e: StreamEvent): ToolStartInfo | null {
  if (e.type !== 'tool_start') return null;
  const id = typeof e.id === 'string' ? e.id : null;
  const tool = typeof e.tool === 'string' ? e.tool : null;
  if (!id || !tool) return null;
  const label = typeof e.label === 'string' ? e.label : tool;
  return { id, tool, label };
}

export interface ToolEndInfo {
  id: string;
  summary: string;
}
export function readToolEnd(e: StreamEvent): ToolEndInfo | null {
  if (e.type !== 'tool_end') return null;
  const id = typeof e.id === 'string' ? e.id : null;
  if (!id) return null;
  const summary = typeof e.summary === 'string' ? e.summary : '';
  return { id, summary };
}

// Phase C: result.data 에서 follow_ups (string[]) / sources (QnASource[]) 추출.
// askStream 의 result 이벤트가 도착하면 호출 — 둘 다 옵션 필드라 미존재 시 빈 array.
export function readFollowUps(data: Record<string, unknown> | null): string[] {
  if (!data) return [];
  const v = data.follow_ups;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export function readSources(data: Record<string, unknown> | null): unknown[] {
  if (!data) return [];
  const v = data.sources;
  return Array.isArray(v) ? v : [];
}
