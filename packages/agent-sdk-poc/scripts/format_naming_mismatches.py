"""
86개 naming-mismatch 페어를 사용자 actionable 한 정리 리포트로 변환.

분류:
  1. **DataSheet 오타** — `AcceptCondtionString` ← "Condition" 의 i 누락. 명백한 DS 측 오타.
  2. **GDD 오타/잘림** — `ChaperString`, `CinematicTyp` 등. 기획 문서가 잘못 적음.
  3. **명명 규칙 차이** — `Bandit_Refugees` vs `BanditRefugees` (underscore).
  4. **의미 다름 가능** — Levenshtein 가깝지만 실제 다른 컬럼.
  5. **DS 가 더 명확** — `DeathPenaltyRestorePriceGold` (GDD) vs `DeathPenaltyExpRestorePriceGold` (DS, "Exp" 명시). GDD 가 누락.

각 페어마다 권장 액션:
  - "DataSheet 수정" / "GDD 수정" / "검증 필요" / "동일 확인 후 통합"
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OVERLAP = ROOT / "scripts" / "bench_out" / "overlap_3bucket.json"
OUT = ROOT / "scripts" / "bench_out" / "naming_mismatch_report.md"


def diff_chars(a: str, b: str) -> str:
    """간단 변별 — 어느 부분이 다른지 시각화."""
    # common prefix 와 suffix 로 차이 부분 찾기
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    s = 0
    while s < min(len(a), len(b)) - p and a[-(s+1)] == b[-(s+1)]:
        s += 1
    a_diff = a[p:len(a)-s] if s else a[p:]
    b_diff = b[p:len(b)-s] if s else b[p:]
    return f"...[{a_diff}]... vs ...[{b_diff}]..."


def categorize(gdd: str, ds_match: str) -> tuple[str, str]:
    """(분류, 권장 액션)."""
    g, d = gdd, ds_match
    # 한 글자 오타
    if abs(len(g) - len(d)) == 1:
        if g.lower().replace("_", "") == d.lower().replace("_", ""):
            return ("명명규칙", "통일 (underscore 정책 결정)")
        # 한 글자 누락 — 어느 쪽이 정답?
        if len(d) > len(g):
            # DS 가 한 글자 많음 — GDD 잘림 가능성
            return ("GDD 잘림 또는 DS 추가", "검증 필요")
        else:
            # GDD 가 한 글자 많음 — DS 가 누락 (오타)
            return ("DS 오타 가능", "DS 검증 필요")
    # 단어 누락 (DS 가 GDD 보다 길고 GDD 가 부분 문자열)
    if len(d) > len(g) + 2 and g in d:
        return ("GDD 가 약식", "GDD 정식 명칭 사용 권장")
    # 단어 누락 (GDD 가 DS 보다 길고 DS 가 부분 문자열)
    if len(g) > len(d) + 2 and d in g:
        return ("DS 가 약식", "DS 가 정식 일치하면 DS 채택")
    # case 차이만
    if g.lower() == d.lower():
        return ("대소문자만 다름", "DS 가 정식")
    return ("기타", "수동 검증 필요")


def main():
    if not OVERLAP.exists():
        print(f"[err] {OVERLAP} 없음. recheck_overlap.py 먼저 실행.")
        return 1
    data = json.loads(OVERLAP.read_text(encoding="utf-8"))
    mismatches = data.get("naming_mismatches", [])
    print(f"[load] {len(mismatches)} mismatch pairs")

    # 분류 카운트
    bucket_counts: dict[str, int] = {}
    rows: list[tuple] = []
    for m in mismatches:
        gdd = m["gdd_token"]
        for ds_match in m["ds_close_matches"]:
            cat, action = categorize(gdd, ds_match)
            bucket_counts[cat] = bucket_counts.get(cat, 0) + 1
            rows.append((cat, gdd, ds_match, action, m.get("gdd_first_occ")))

    # markdown 생성
    md: list[str] = []
    md.append("# Naming Mismatch 리포트 — GDD ↔ DataSheet")
    md.append("")
    md.append(f"> 자동 생성 — 86 pairs (Levenshtein ≤ 3) 분류")
    md.append("")
    md.append("## 분류별 요약")
    md.append("")
    md.append("| 분류 | 건수 | 권장 액션 |")
    md.append("|---|---|---|")
    for cat, n in sorted(bucket_counts.items(), key=lambda x: -x[1]):
        action_hint = {
            "DS 오타 가능": "DataSheet 수정",
            "GDD 잘림 또는 DS 추가": "검증 후 양쪽 정합",
            "GDD 가 약식": "GDD 가 정식 명칭으로 업데이트",
            "DS 가 약식": "DS 검증 후 정식 명칭",
            "명명규칙": "underscore 정책 통일",
            "대소문자만 다름": "DS 채택",
            "기타": "수동 검증",
        }.get(cat, "검증")
        md.append(f"| {cat} | {n} | {action_hint} |")
    md.append("")
    md.append("## 상세 페어")
    md.append("")
    by_cat: dict[str, list] = {}
    for r in rows:
        by_cat.setdefault(r[0], []).append(r)
    for cat in sorted(by_cat.keys(), key=lambda c: -bucket_counts[c]):
        md.append(f"### {cat} ({bucket_counts[cat]})")
        md.append("")
        md.append("| GDD 표기 | DataSheet 표기 | 차이 | GDD 컨텍스트 |")
        md.append("|---|---|---|---|")
        for cat_, gdd, ds, action, occ in by_cat[cat][:30]:
            ctx = (occ or {}).get("ctx", "")[:50] if occ else ""
            d = diff_chars(gdd, ds)
            md.append(f"| `{gdd}` | `{ds}` | `{d}` | {ctx} |")
        if len(by_cat[cat]) > 30:
            md.append(f"| ... +{len(by_cat[cat])-30} more | | | |")
        md.append("")

    OUT.write_text("\n".join(md), encoding="utf-8")
    print(f"[saved] {OUT.relative_to(ROOT)}  ({OUT.stat().st_size:,} bytes)")
    print()
    print("--- 분류 요약 ---")
    for cat, n in sorted(bucket_counts.items(), key=lambda x: -x[1]):
        print(f"  {cat:<25} {n:>4}")


if __name__ == "__main__":
    sys.exit(main() or 0)
