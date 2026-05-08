"""
86 naming mismatch 를 self-contained HTML 페이지로 렌더 — 정렬/필터/검색 가능.

기획자/개발자가 브라우저에서 열어서 검토 → DS 또는 GDD 측 정정 결정.

Usage:
    python scripts/build_mismatch_webpage.py
    → bench_out/naming_mismatches.html
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from html import escape

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OVERLAP = ROOT / "scripts" / "bench_out" / "overlap_3bucket.json"
OUT = ROOT / "scripts" / "bench_out" / "naming_mismatches.html"


def diff_visualize(a: str, b: str) -> tuple[str, str]:
    """공통 prefix/suffix 제외하고 차이 부분만 highlight 한 HTML."""
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    s = 0
    while s < min(len(a), len(b)) - p and a[-(s + 1)] == b[-(s + 1)]:
        s += 1
    a_pre = escape(a[:p]); a_diff = escape(a[p:len(a) - s] if s else a[p:]); a_suf = escape(a[len(a) - s:] if s else "")
    b_pre = escape(b[:p]); b_diff = escape(b[p:len(b) - s] if s else b[p:]); b_suf = escape(b[len(b) - s:] if s else "")
    a_html = f'{a_pre}<mark class="diff">{a_diff}</mark>{a_suf}' if a_diff else escape(a)
    b_html = f'{b_pre}<mark class="diff">{b_diff}</mark>{b_suf}' if b_diff else escape(b)
    return a_html, b_html


def categorize(gdd: str, ds: str) -> tuple[str, str]:
    if abs(len(gdd) - len(ds)) == 1:
        if gdd.lower().replace("_", "") == ds.lower().replace("_", ""):
            return ("명명규칙", "underscore 정책 통일")
        if len(ds) > len(gdd):
            return ("GDD 잘림", "검증 — DS 가 정식이면 GDD 업데이트")
        return ("DS 오타 가능", "DS 검증 후 정정")
    if len(ds) > len(gdd) + 2 and gdd in ds:
        return ("GDD 약식", "GDD 가 정식 명칭으로 업데이트")
    if len(gdd) > len(ds) + 2 and ds in gdd:
        return ("DS 약식", "DS 가 정식이면 채택")
    if gdd.lower() == ds.lower():
        return ("대소문자만 다름", "DS 채택")
    return ("기타", "수동 검증 필요")


def cat_color(cat: str) -> str:
    return {
        "DS 오타 가능": "#ff7676",
        "GDD 잘림": "#ffae42",
        "GDD 약식": "#a87dff",
        "DS 약식": "#7db8ff",
        "명명규칙": "#7dd3a8",
        "대소문자만 다름": "#ffd47d",
        "기타": "#aaa",
    }.get(cat, "#888")


HTML_TEMPLATE = r"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Naming Mismatch — GDD ↔ DataSheet</title>
<style>
* { box-sizing: border-box; }
body {
    font-family: 'Pretendard', -apple-system, 'Segoe UI', sans-serif;
    margin: 0; padding: 24px 32px; color: #1f2937;
    background: linear-gradient(180deg, #f9fafb 0%, #eef2f7 100%);
    min-height: 100vh;
}
h1 { font-size: 24px; margin: 0 0 8px; font-weight: 700; }
.subtitle { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
.summary {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 20px;
}
.summary .card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.summary .card .n { font-size: 22px; font-weight: 700; }
.summary .card .label { font-size: 12px; color: #6b7280; margin-top: 4px; }
.controls {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    margin-bottom: 16px; padding: 12px 16px; background: #fff;
    border: 1px solid #e5e7eb; border-radius: 10px;
    position: sticky; top: 0; z-index: 10;
}
.controls input[type="text"] {
    flex: 1; min-width: 200px; padding: 8px 12px; font-size: 14px;
    border: 1px solid #d1d5db; border-radius: 6px;
}
.controls select {
    padding: 8px 10px; font-size: 14px; border: 1px solid #d1d5db; border-radius: 6px;
    background: #fff;
}
.controls button {
    padding: 8px 14px; font-size: 13px; border: 1px solid #d1d5db;
    background: #fff; border-radius: 6px; cursor: pointer;
}
.controls button:hover { background: #f3f4f6; }
.count { color: #6b7280; font-size: 13px; margin-left: auto; }
table {
    width: 100%; background: #fff; border-collapse: collapse;
    border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
thead th {
    text-align: left; padding: 11px 14px; font-size: 12px; font-weight: 600;
    color: #6b7280; background: #f9fafb; border-bottom: 1px solid #e5e7eb;
    cursor: pointer; user-select: none; white-space: nowrap;
}
thead th:hover { background: #f3f4f6; }
thead th.sorted { color: #1f2937; }
thead th.sorted::after { content: ""; }
thead th.sorted-asc::after { content: " ↑"; }
thead th.sorted-desc::after { content: " ↓"; }
tbody td {
    padding: 12px 14px; border-bottom: 1px solid #f3f4f6;
    font-size: 13px; vertical-align: top;
}
tbody tr:hover { background: #fafbfc; }
.cat-pill {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap;
}
.tok {
    font-family: 'JetBrains Mono', Consolas, Monaco, monospace;
    font-size: 12.5px; padding: 2px 5px; background: #f3f4f6;
    border-radius: 3px; word-break: break-all;
}
mark.diff {
    background: #fff2a8; padding: 0 2px; border-radius: 2px; font-weight: 700;
    color: #92400e;
}
.ctx { color: #6b7280; font-size: 12px; max-width: 320px; }
.action { color: #4b5563; font-size: 12px; max-width: 220px; }
.sheet { color: #059669; font-size: 12px; }
.no-results { padding: 40px; text-align: center; color: #9ca3af; }
@media (max-width: 720px) {
    .summary { grid-template-columns: repeat(2, 1fr); }
    .ctx, .action { max-width: 180px; }
}
</style>
</head>
<body>

<h1>Naming Mismatch — GDD ↔ DataSheet</h1>
<p class="subtitle">86 페어 (Levenshtein ≤ 3). GDD 식별자가 DataSheet 와 미세하게 다름. <strong>정정 기준</strong> 결정 필요.</p>

<div class="summary" id="summary"></div>

<div class="controls">
    <input type="text" id="search" placeholder="🔍 식별자 / 시트 / 컨텍스트 검색...">
    <select id="catFilter">
        <option value="">전체 분류</option>
    </select>
    <button onclick="resetFilter()">리셋</button>
    <span class="count" id="count">86 / 86</span>
</div>

<table id="tbl">
    <thead>
    <tr>
        <th data-key="cat">분류</th>
        <th data-key="gdd">GDD 표기</th>
        <th data-key="ds">DataSheet 표기</th>
        <th data-key="action">권장 액션</th>
        <th data-key="sheet">GDD 시트</th>
        <th data-key="ctx">GDD 컨텍스트</th>
    </tr>
    </thead>
    <tbody id="tbody"></tbody>
</table>
<div id="noResults" class="no-results" style="display:none;">검색 결과 없음</div>

<script>
const DATA = __DATA__;
const tbody = document.getElementById('tbody');
const summary = document.getElementById('summary');
const search = document.getElementById('search');
const catFilter = document.getElementById('catFilter');
const countEl = document.getElementById('count');
const noResults = document.getElementById('noResults');

// 분류 카운트
const catCounts = {};
DATA.forEach(r => { catCounts[r.cat] = (catCounts[r.cat] || 0) + 1; });
const cats = Object.keys(catCounts).sort((a, b) => catCounts[b] - catCounts[a]);

// 요약 카드
summary.innerHTML = '';
const totalCard = document.createElement('div');
totalCard.className = 'card';
totalCard.innerHTML = `<div class="n">${DATA.length}</div><div class="label">전체 mismatch 페어</div>`;
summary.appendChild(totalCard);
cats.forEach(c => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cursor = 'pointer';
    card.onclick = () => { catFilter.value = c; render(); };
    card.innerHTML = `
        <div class="n" style="color:${DATA.find(r => r.cat === c).cat_color}">${catCounts[c]}</div>
        <div class="label">${escapeHtml(c)}</div>
    `;
    summary.appendChild(card);
});

// 분류 select
cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = `${c} (${catCounts[c]})`;
    catFilter.appendChild(opt);
});

// 정렬
let sortKey = null;
let sortAsc = true;
document.querySelectorAll('thead th').forEach(th => {
    th.addEventListener('click', () => {
        const k = th.dataset.key;
        if (sortKey === k) sortAsc = !sortAsc;
        else { sortKey = k; sortAsc = true; }
        document.querySelectorAll('thead th').forEach(t => {
            t.classList.remove('sorted', 'sorted-asc', 'sorted-desc');
        });
        th.classList.add('sorted', sortAsc ? 'sorted-asc' : 'sorted-desc');
        render();
    });
});

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function render() {
    const q = search.value.trim().toLowerCase();
    const cf = catFilter.value;
    let rows = DATA.filter(r => {
        if (cf && r.cat !== cf) return false;
        if (!q) return true;
        return [r.gdd, r.ds, r.sheet, r.ctx].some(v =>
            String(v || '').toLowerCase().includes(q)
        );
    });
    if (sortKey) {
        rows = [...rows].sort((a, b) => {
            const va = String(a[sortKey] || '').toLowerCase();
            const vb = String(b[sortKey] || '').toLowerCase();
            return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        });
    }
    tbody.innerHTML = '';
    if (rows.length === 0) {
        noResults.style.display = 'block';
    } else {
        noResults.style.display = 'none';
        rows.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="cat-pill" style="background:${r.cat_color}">${escapeHtml(r.cat)}</span></td>
                <td><span class="tok">${r.gdd_html}</span></td>
                <td><span class="tok">${r.ds_html}</span></td>
                <td class="action">${escapeHtml(r.action)}</td>
                <td class="sheet">${escapeHtml(r.sheet)}</td>
                <td class="ctx">${escapeHtml(r.ctx)}</td>
            `;
            tbody.appendChild(tr);
        });
    }
    countEl.textContent = `${rows.length} / ${DATA.length}`;
}

function resetFilter() {
    search.value = ''; catFilter.value = ''; sortKey = null; sortAsc = true;
    document.querySelectorAll('thead th').forEach(t =>
        t.classList.remove('sorted', 'sorted-asc', 'sorted-desc'));
    render();
}

search.addEventListener('input', render);
catFilter.addEventListener('change', render);
render();
</script>

</body>
</html>
"""


def main():
    d = json.loads(OVERLAP.read_text(encoding="utf-8"))
    rows = []
    for m in d.get("naming_mismatches", []):
        gdd = m["gdd_token"]
        for ds in m["ds_close_matches"]:
            cat, action = categorize(gdd, ds)
            gdd_html, ds_html = diff_visualize(gdd, ds)
            occ = m.get("gdd_first_occ") or {}
            rows.append({
                "cat": cat,
                "cat_color": cat_color(cat),
                "gdd": gdd,
                "ds": ds,
                "gdd_html": gdd_html,
                "ds_html": ds_html,
                "action": action,
                "sheet": occ.get("sheet", ""),
                "ctx": (occ.get("ctx", "") or "")[:120],
            })
    print(f"[build] {len(rows)} 페어 → HTML 생성 중...")
    html = HTML_TEMPLATE.replace("__DATA__", json.dumps(rows, ensure_ascii=False))
    OUT.write_text(html, encoding="utf-8")
    print(f"[saved] {OUT.relative_to(ROOT)}  ({OUT.stat().st_size:,} bytes)")
    print()
    print(f"브라우저에서 열기: file:///{OUT.as_posix()}")


if __name__ == "__main__":
    sys.exit(main() or 0)
