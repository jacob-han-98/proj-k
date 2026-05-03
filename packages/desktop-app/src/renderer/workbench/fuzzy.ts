// A2: Command Palette 의 가벼운 fuzzy 매칭. 외부 라이브러리 의존 없이 작성.
//
// 알고리즘 (subsequence + score):
//   1) query 의 모든 char 가 candidate 안에 *순서대로* 등장하면 매칭. 즉 'pkhud' → 'PK_HUD 시스템'.
//   2) 점수 = consecutive char 보너스 + 단어 boundary 시작 보너스 + 짧은 candidate 보너스.
//   3) 결과는 점수 내림차순.
//
// 한국어 친화 — 대소문자 무시 (toLowerCase). 한글 자음/모음 분해는 안 함 — 사용자가
// "PK_몬스터 어그로" 같이 가끔 영문/한글 mix 검색하는 패턴 우선.

export interface FuzzyMatch {
  score: number;
  // matched char indices in candidate — 향후 highlight UI 에 활용 가능.
  matchedIndices: number[];
}

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (!query) return { score: 0, matchedIndices: [] };
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
