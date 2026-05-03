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
