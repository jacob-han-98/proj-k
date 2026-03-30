// diff-engine.js - Compute and render diffs for edit suggestions

const DiffEngine = {
  // Strip HTML tags for display
  stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  },

  // Simple word-level diff using LCS
  computeWordDiff(before, after) {
    const beforeWords = before.split(/(\s+)/);
    const afterWords = after.split(/(\s+)/);
    const result = [];

    // LCS-based diff
    const m = beforeWords.length;
    const n = afterWords.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (beforeWords[i - 1] === afterWords[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to build diff
    let i = m, j = n;
    const ops = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && beforeWords[i - 1] === afterWords[j - 1]) {
        ops.unshift({ type: 'same', text: beforeWords[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.unshift({ type: 'added', text: afterWords[j - 1] });
        j--;
      } else {
        ops.unshift({ type: 'removed', text: beforeWords[i - 1] });
        i--;
      }
    }

    // Merge consecutive same-type ops
    for (const op of ops) {
      if (result.length > 0 && result[result.length - 1].type === op.type) {
        result[result.length - 1].text += op.text;
      } else {
        result.push({ ...op });
      }
    }

    return result;
  },

  // Render diff as HTML
  renderDiff(before, after) {
    const beforeText = this.stripHtml(before);
    const afterText = this.stripHtml(after);
    const diff = this.computeWordDiff(beforeText, afterText);

    let html = '';
    for (const part of diff) {
      if (part.type === 'removed') {
        html += `<span class="diff-removed">${this._escapeHtml(part.text)}</span>`;
      } else if (part.type === 'added') {
        html += `<span class="diff-added">${this._escapeHtml(part.text)}</span>`;
      } else {
        html += this._escapeHtml(part.text);
      }
    }
    return html;
  },

  // Render side-by-side before/after blocks
  renderSideBySide(before, after) {
    const beforeText = this.stripHtml(before);
    const afterText = this.stripHtml(after);
    return {
      beforeHtml: `<div class="diff-block diff-before"><div class="diff-label">Before</div><pre>${this._escapeHtml(beforeText)}</pre></div>`,
      afterHtml: `<div class="diff-block diff-after"><div class="diff-label">After</div><pre>${this._escapeHtml(afterText)}</pre></div>`,
    };
  },

  _escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
