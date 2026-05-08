// A2: Command Palette 의 가벼운 fuzzy 매칭. 외부 라이브러리 의존 없이 작성.
//
// 매칭은 3단으로 시도하고, 가장 정확한 매칭 1개의 점수만 반환.
//   1) Subsequence — query 의 모든 char 가 candidate 에 순서대로 등장. 'pkhud' → 'PK_HUD 시스템'.
//   2) Separator-insensitive substring — q_ns(공백/_/-/·/. 제거) 가 c_ns 의 substring.
//      예: '몬스터 왕' → 'PK_몬스터_왕' (q_ns = '몬스터왕', c_ns = 'PK몬스터왕').
//   3) Hangul Jamo bigram fuzzy — query 자모 ≥4 + bigram intersection ratio ≥ 0.6.
//      예: '르바' → '로바르스' (q bigram {ㄹㅡ,ㅡㅂ,ㅂㅏ} ∩ t bigram = 2/3 = 0.667).
//
// 점수는 1) > 2) > 3) 우선순위. 같은 candidate 가 여러 layer 에서 매칭되면 가장 높은 점수만.
// backend `quick_find.py` 의 _ns + jamo bigram 알고리즘을 그대로 포팅 — 두 검색 흐름 (Ctrl+P
// CommandPalette + 사이드바 Quick Find) 의 한국어 매칭 결과 일관성 확보.

export interface FuzzyMatch {
  score: number;
  // matched char indices in candidate — 향후 highlight UI 에 활용 가능.
  // separator/jamo fuzzy 매칭에서는 highlight 의미가 약해 빈 배열.
  matchedIndices: number[];
}

// ── Hangul Jamo decomposition ────────────────────────────────────────────
// 한글 음절 (가나다, U+AC00~U+D7A3) 을 초성/중성/종성 jamo 로 분해. 비-한글 문자는 그대로.

const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const HANGUL_CHO_BASE = 0x1100;
const HANGUL_JUNG_BASE = 0x1161;
const HANGUL_JONG_BASE = 0x11a7; // jong index 0 = 종성 없음

export function decomposeHangul(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code != null && code >= HANGUL_SYLLABLE_START && code <= HANGUL_SYLLABLE_END) {
      const n = code - HANGUL_SYLLABLE_START;
      const cho = Math.floor(n / (21 * 28));
      const jung = Math.floor((n % (21 * 28)) / 28);
      const jong = n % 28;
      out.push(String.fromCodePoint(HANGUL_CHO_BASE + cho));
      out.push(String.fromCodePoint(HANGUL_JUNG_BASE + jung));
      if (jong) out.push(String.fromCodePoint(HANGUL_JONG_BASE + jong));
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

// Separator-insensitive normalize — backend `_NS_SEP_RE` 와 동일.
const NS_SEP_RE = /[\s_\-·.]+/g;
export function nsNormalize(s: string): string {
  return s.replace(NS_SEP_RE, '').replace(/　/g, '');
}

function jamoBigrams(decomposed: string): Set<string> {
  if (decomposed.length < 2) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < decomposed.length - 1; i++) {
    out.add(decomposed.slice(i, i + 2));
  }
  return out;
}

function jamoOverlapRatio(qDecomp: string, tDecomp: string): number {
  const qb = jamoBigrams(qDecomp);
  if (qb.size === 0) return 0;
  const tb = jamoBigrams(tDecomp);
  if (tb.size === 0) return 0;
  let overlap = 0;
  for (const b of qb) if (tb.has(b)) overlap++;
  return overlap / qb.size;
}

// fuzzy gate — backend 와 같은 임계값.
const JAMO_MIN_LEN = 4;
const JAMO_THRESHOLD = 0.6;

// 한국어 보조 매칭 — subsequence 실패 시 시도. separator-insensitive 우선, 그 다음 자모 fuzzy.
// 점수는 subsequence 매칭보다 항상 낮게 둠 (추가 hit 만 줍는 fallback).
function koreanMatch(query: string, candidate: string): FuzzyMatch | null {
  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  // (a) separator-insensitive substring — '몬스터 왕' ↔ 'PK_몬스터_왕'.
  const qNs = nsNormalize(qLower);
  if (qNs.length > 0) {
    const cNs = nsNormalize(cLower);
    if (cNs.includes(qNs)) {
      // base 5 + length bonus (subsequence 의 5 + consecutive 보너스 분포보다 약간 낮게).
      const score = 5 + Math.max(0, 30 - candidate.length);
      return { score, matchedIndices: [] };
    }
  }

  // (b) 자모 bigram fuzzy — '르바' ↔ '로바르스'.
  const qDecomp = decomposeHangul(qLower);
  if (qDecomp.length < JAMO_MIN_LEN) return null;
  const cDecomp = decomposeHangul(cLower);
  const ratio = jamoOverlapRatio(qDecomp, cDecomp);
  if (ratio < JAMO_THRESHOLD) return null;
  // ratio 0.6 → 1, 1.0 → 5. 자모 fuzzy 는 가장 약한 매칭이라 점수 낮게.
  const score = 1 + (ratio - JAMO_THRESHOLD) * 10 + Math.max(0, 30 - candidate.length);
  return { score, matchedIndices: [] };
}

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (!query) return { score: 0, matchedIndices: [] };
  const subseq = subsequenceMatch(query, candidate);
  if (subseq) return subseq;
  return koreanMatch(query, candidate);
}

// 기존 subsequence 매칭 — 영문/한글 mix 검색 ('pkhud', 'pk몬스터' 등) 정확도 우선.
function subsequenceMatch(query: string, candidate: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  let score = 0;
  let lastMatchIdx = -1;
  let consecutive = 0;
  const matchedIndices: number[] = [];

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    // candidate 안에서 lastMatchIdx 이후 첫 매칭.
    for (let ci = lastMatchIdx + 1; ci < c.length; ci++) {
      if (c[ci] === ch) {
        found = ci;
        break;
      }
    }
    if (found < 0) return null; // 한 char 라도 없으면 fail.

    // 보너스 계산.
    if (lastMatchIdx >= 0 && found === lastMatchIdx + 1) {
      // 연속 매칭 — 큰 보너스.
      consecutive++;
      score += 5 + consecutive * 2;
    } else {
      consecutive = 0;
      score += 1;
    }
    // 단어 시작 (이전 char 가 separator) 매칭 보너스.
    if (found === 0 || /[\s/_\-.\\]/.test(c[found - 1])) {
      score += 4;
    }
    matchedIndices.push(found);
    lastMatchIdx = found;
  }

  // 짧은 candidate 보너스 — 같은 점수면 짧은 게 위.
  score += Math.max(0, 30 - candidate.length);

  return { score, matchedIndices };
}

export interface SearchableItem {
  // 매칭 대상 — title (basename) 과 path (full) 두 form 다 시도해서 최고 점수 사용.
  title: string;
  path: string;
  // 결과 클릭 시 사용할 source-specific payload. CommandPalette 가 source 별로 처리.
  source: 'p4-local' | 'p4-depot' | 'confluence';
  // 원본 식별자 — local: relPath, depot: depot path, confluence: pageId.
  refId: string;
  // confluence 만 — 재구성에 필요할 수 있음.
  confluencePageId?: string;
}

export interface ScoredItem extends SearchableItem {
  score: number;
  matchedIndices: number[];
}

export function rankItems(items: SearchableItem[], query: string, limit = 50): ScoredItem[] {
  if (!query.trim()) return [];
  const out: ScoredItem[] = [];
  for (const it of items) {
    // title 과 path 둘 다 시도, 더 높은 점수 채택. title 매칭이 우선이라 +10 보너스.
    const titleM = fuzzyMatch(query, it.title);
    const pathM = fuzzyMatch(query, it.path);
    const titleScore = titleM ? titleM.score + 10 : -Infinity;
    const pathScore = pathM ? pathM.score : -Infinity;
    if (titleM == null && pathM == null) continue;
    if (titleScore >= pathScore && titleM) {
      out.push({ ...it, score: titleScore, matchedIndices: titleM.matchedIndices });
    } else if (pathM) {
      out.push({ ...it, score: pathScore, matchedIndices: pathM.matchedIndices });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
