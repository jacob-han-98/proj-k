// A5: 스트리밍 중 도착한 partial JSON 에서 *완결된 항목만* 추출 — chrome-extension/sidebar.js
// 의 _parsePartialReviewJSON TS 포팅. 핵심 사용성: token 이 흘러오는 동안 끝난 `{...}` 들이
// 즉시 화면에 한 개씩 떠오름 → "이쁘게 하나씩" 표현 (사용자 명시 요청).
//
// 동작:
//   1) 우선 markdown fence 제거 + 첫 `{...}` 매치를 통째로 JSON.parse 시도.
//   2) 실패하면 fallback — 각 알려진 필드 (score, issues, verifications, suggestions,
//      qa_checklist, flow, readability) 를 정규식 + brace 카운터로 부분 추출.
//   3) array 필드는 `{}` depth 가 0 으로 닫히는 element 만 collect — 절반쯤 도착한 객체는
//      스킵해서 깨진 채 렌더 X.

import type { ReviewData, ReviewItem } from './ReviewCard';

export function parsePartialReviewJSON(raw: string): ReviewData | null {
  if (!raw) return null;

  // (1) 전체 파싱 시도
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as ReviewData;
      return parsed;
    }
  } catch {
    /* 불완전 — fallback */
  }

  const result: ReviewData = {};

  // score
  const scoreMatch = raw.match(/"score"\s*:\s*(\d+)/);
  if (scoreMatch) result.score = parseInt(scoreMatch[1]!, 10);

  // 객체 array fields — issues / verifications 는 보통 `{text, perspective}` 형태.
  for (const field of ['issues', 'verifications'] as const) {
    const items = extractClosedObjects(raw, field);
    if (items.length > 0) {
      result[field] = items as ReviewItem[];
    }
  }

  // 문자열 또는 객체 mixed array — suggestions, qa_checklist 둘 다 시도.
  for (const field of ['suggestions', 'qa_checklist'] as const) {
    const objs = extractClosedObjects(raw, field);
    if (objs.length > 0) {
      if (field === 'suggestions') result.suggestions = objs as ReviewItem[];
      else result.qa_checklist = objs.map((o) => (typeof o === 'string' ? o : o.text)).filter(Boolean) as string[];
      continue;
    }
    const strs = extractClosedStrings(raw, field);
    if (strs.length > 0) {
      if (field === 'suggestions') result.suggestions = strs;
      else result.qa_checklist = strs;
    }
  }

  // flow — 이스케이프 포함 문자열.
  const flowMatch = raw.match(/"flow"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (flowMatch) {
    try {
      result.flow = JSON.parse('"' + flowMatch[1] + '"') as string;
    } catch {
      result.flow = flowMatch[1];
    }
  }

  // readability — 부분 객체. score 우선, 가능하면 issues 도.
  const readScoreMatch = raw.match(/"readability"\s*:\s*\{[^}]*"score"\s*:\s*(\d+)/);
  if (readScoreMatch) {
    result.readability = { score: parseInt(readScoreMatch[1]!, 10), issues: [] };
    const readSection = raw.match(/"readability"\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
    if (readSection) {
      try {
        result.readability = JSON.parse(readSection[1]!) as ReviewData['readability'];
      } catch {
        /* partial */
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// 해당 array 필드 안의 닫힌 `{...}` 객체만 모음. 안 닫힌 객체는 무시.
function extractClosedObjects(raw: string, field: string): Array<ReviewItem | string> {
  const fieldStart = raw.indexOf(`"${field}"`);
  if (fieldStart === -1) return [];
  const arrStart = raw.indexOf('[', fieldStart);
  if (arrStart === -1) return [];

  const items: Array<ReviewItem | string> = [];
  let depth = 0;
  let inStr = false;
  let escape = false;
  let itemStart = -1;

  for (let i = arrStart + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (ch === '{') {
      if (depth === 0) itemStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && itemStart !== -1) {
        try {
          items.push(JSON.parse(raw.slice(itemStart, i + 1)) as ReviewItem | string);
        } catch {
          /* 파싱 실패 객체는 skip — 다음 token 더 받으면 다시 시도됨 */
        }
        itemStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return items;
}

// 해당 array 필드 안의 닫힌 `"..."` 문자열 모음 (qa_checklist / suggestions 의 string 변형).
function extractClosedStrings(raw: string, field: string): string[] {
  const re = new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)(?:\\]|$)`);
  const m = raw.match(re);
  if (!m) return [];
  const content = m[1] ?? '';
  const out: string[] = [];
  let inStr = false;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '"' && (i === 0 || content[i - 1] !== '\\')) {
      if (!inStr) {
        inStr = true;
        start = i + 1;
      } else {
        out.push(content.slice(start, i));
        inStr = false;
      }
    }
  }
  return out;
}
