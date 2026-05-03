// 답변 스트림에서 (출처: ...) 패턴을 뽑아내, 그 출처가 검색-우선 결과
// (SearchHit) 중 어디를 가리키는지 판정한다.
//
// qna-output-format 스킬의 인용 규약:
//   (출처: <워크북>.xlsx / <시트> § <섹션>)
//   (출처: Confluence / <공간> / ... / <페이지> § <섹션>)
//   (출처: DataSheet / <테이블명> § Id=<n>)
//   (출처: external/<게임>/...)
//   (출처: web/<도메인>/...)
//
// 매칭 전략 — 단순 substring 우선. 워크북명 / 페이지명이 답변 안에 등장하면
// 해당 hit 을 cited 로 마크. 정밀 매칭은 Phase 2.2 에서 score 기반으로 강화.

import type { SearchHit } from '../shared/types';

const CITATION_RE = /\(출처:\s*([^)]+)\)/g;

export function extractCitationStrings(answer: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // .matchAll 도 가능하지만 RegExp.exec 가 g 플래그와 함께 더 호환 좋음
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(answer)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

// hit 가 답변의 인용에 해당하는지 판정.
// - hit.title 이 인용 텍스트에 substring 으로 들어있거나
// - hit.matched_sheets 의 시트명이 들어있으면 매칭.
function isHitCited(hit: SearchHit, citations: string[]): boolean {
  if (citations.length === 0) return false;
  const lookups: string[] = [hit.title];
  if (hit.matched_sheets) lookups.push(...hit.matched_sheets);
  for (const c of citations) {
    for (const l of lookups) {
      if (l && l.length >= 2 && c.includes(l)) return true;
    }
  }
  return false;
}

export function annotateCitedHits(answer: string, hits: SearchHit[]): SearchHit[] {
  const citations = extractCitationStrings(answer);
  if (citations.length === 0) return hits.map((h) => ({ ...h, cited: false }));
  return hits.map((h) => ({ ...h, cited: isHitCited(h, citations) }));
}

// A3-b: 답변 텍스트를 [text part | citation part] 의 array 로 분해 → React 가 citation
// 만 클릭 가능 link 로 렌더. 매칭 후 path/section 을 분리해서 /source_view 호출에 사용.
//
// citation 안 형식 (qna-output-format 스킬 규약):
//   "<워크북>.xlsx / <시트> § <섹션>"
//   "Confluence / <공간> / ... / <페이지> § <섹션>"
//   "DataSheet / <테이블> § Id=<n>"
// '§' 가 path 와 section 의 경계. 없으면 전체가 path.

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; raw: string; path: string; section: string };

export function splitAnswerWithCitations(answer: string): AnswerSegment[] {
  const out: AnswerSegment[] = [];
  CITATION_RE.lastIndex = 0;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(answer)) !== null) {
    if (m.index > lastIdx) {
      out.push({ kind: 'text', text: answer.slice(lastIdx, m.index) });
    }
    const raw = m[1].trim();
    const { path, section } = splitPathSection(raw);
    out.push({ kind: 'citation', raw, path, section });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < answer.length) {
    out.push({ kind: 'text', text: answer.slice(lastIdx) });
  }
  return out;
}

function splitPathSection(raw: string): { path: string; section: string } {
  // '§' (U+00A7) 가 표준. 일부 답변은 '#' 사용 — 둘 다 허용.
  const sectionMarker = /\s*[§#]\s*/;
  const m = sectionMarker.exec(raw);
  if (!m) return { path: raw.trim(), section: '' };
  return {
    path: raw.slice(0, m.index).trim(),
    section: raw.slice(m.index + m[0].length).trim(),
  };
}
