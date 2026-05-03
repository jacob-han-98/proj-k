// B2-3a: chrome-extension/lib/diff-engine.js 의 LCS 워드-레벨 diff TS 포팅.
// ChangesCard 의 inline diff 표시에 사용 — before / after 의 단어 단위 차이를 빨강(remove)
// / 초록(add) / plain(same) 으로 분해.
//
// 알고리즘: 워드 split (공백 보존) → LCS DP → backtrack → 같은 type 인접 op merge.
// 외부 라이브러리 의존 X — chrome ext 와 동등 동작 보장.

export type DiffOpType = 'same' | 'added' | 'removed';

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

// HTML 내 텍스트만 추출 (chrome ext 의 stripHtml 등가). DOM API 는 renderer 라 사용 가능.
export function stripHtml(html: string): string {
  if (typeof document === 'undefined') {
    // SSR / unit 환경: 매우 단순한 fallback — <...> 태그 제거 + entity 일부.
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

// 워드 + 공백 단위 split — `(\s+)` 캡처로 공백 토큰도 결과에 보존 → join 시 원문 복원.
export function computeWordDiff(before: string, after: string): DiffOp[] {
  const bw = before.split(/(\s+)/);
  const aw = after.split(/(\s+)/);
  const m = bw.length;
  const n = aw.length;

  // LCS dp[i][j] = bw[..i] 와 aw[..j] 의 longest common subsequence 길이.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (bw[i - 1] === aw[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // Backtrack.
  let i = m;
  let j = n;
  const ops: DiffOp[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && bw[i - 1] === aw[j - 1]) {
      ops.unshift({ type: 'same', text: bw[i - 1]! });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.unshift({ type: 'added', text: aw[j - 1]! });
      j--;
    } else {
      ops.unshift({ type: 'removed', text: bw[i - 1]! });
      i--;
    }
  }

  // 같은 type 인접 op merge — 한 word 가 통째로 변경된 경우 한 span 으로 표시.
  const merged: DiffOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ type: op.type, text: op.text });
  }
  return merged;
}

// React 가 directly 사용할 수 있게 ops 만 반환 — chrome 의 renderDiff 처럼 HTML 문자열을
// 만들지 않고 컴포넌트가 op.type 별 className 적용.
export function diffOpsForDisplay(before: string, after: string): DiffOp[] {
  return computeWordDiff(stripHtml(before), stripHtml(after));
}
