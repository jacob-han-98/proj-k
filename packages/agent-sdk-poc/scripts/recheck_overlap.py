"""
전수 스캔 결과로 GDD↔DataSheet overlap 재계산.

변경:
  - DataSheet 식별자: scan_datasheet_full.py 결과 사용 (4,804 토큰, 전수)
  - GDD 식별자: identifier_scan_full.json (Step 1 결과, 단순 키워드)

3-bucket 분류:
  A. 양쪽에 있음
  B. GDD-only — 보강 후보 (다음 step 에서 LLM 으로 진짜 파라미터 판정)
  C. 네이밍 mismatch — 비슷한 이름 (Levenshtein) 이지만 정확히 안 맞는 페어
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
SCAN_GDD = ROOT / "scripts" / "bench_out" / "identifier_scan_full.json"
SCAN_DS = ROOT / "scripts" / "bench_out" / "datasheet_full_index.json"


def levenshtein(a: str, b: str) -> int:
    if a == b: return 0
    if len(a) < len(b): a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            curr[j] = min(curr[j-1] + 1, prev[j] + 1, prev[j-1] + (0 if ca == cb else 1))
        prev = curr
    return prev[-1]


def find_close_matches(token: str, candidates: list[str], max_dist: int = 3) -> list[str]:
    """token 과 candidates 중 Levenshtein 거리 max_dist 이하인 것."""
    out = []
    for c in candidates:
        if c == token: continue
        if abs(len(c) - len(token)) > max_dist: continue
        # 빠른 prefix 휴리스틱: 첫 3자가 다르면 skip (동일 어근 가정)
        if token[:3] != c[:3]: continue
        d = levenshtein(token, c)
        if d <= max_dist:
            out.append((c, d))
    out.sort(key=lambda x: x[1])
    return [c for c, d in out[:5]]


def main():
    print("[load] GDD scan...")
    gdd = json.loads(SCAN_GDD.read_text(encoding="utf-8"))
    gdd_ids: set[str] = set()
    by_id: dict[str, list] = {}
    for o in gdd["occurrences"]:
        gdd_ids.add(o["id"])
        by_id.setdefault(o["id"], []).append(o)
    print(f"  GDD unique tokens: {len(gdd_ids):,}")

    print("[load] DataSheet 전수 scan...")
    ds = json.loads(SCAN_DS.read_text(encoding="utf-8"))
    ds_ids: set[str] = set(ds["tokens"].keys())
    print(f"  DS unique tokens: {len(ds_ids):,}")
    print()

    # ─── 3-bucket ───────────────────────────────────────
    bucket_A = gdd_ids & ds_ids                    # both
    bucket_B = gdd_ids - ds_ids                    # GDD-only
    only_ds = ds_ids - gdd_ids                     # DS-only

    pct = 100 * len(bucket_A) / max(len(gdd_ids), 1)
    print("=== 3-bucket 결과 ===")
    print(f"  A. 양쪽 모두           : {len(bucket_A):>5,}  ({pct:.1f}% of GDD)")
    print(f"  B. GDD-only (보강 후보) : {len(bucket_B):>5,}")
    print(f"     DS-only (참고)       : {len(only_ds):>5,}")
    print()
    print(f"  → 이전 (5K cell limit): GDD-in-DS 32%")
    print(f"  → 전수 스캔 후         : GDD-in-DS {pct:.1f}%")
    delta = pct - 32
    print(f"  → 개선폭: {'+' if delta>0 else ''}{delta:.1f}%p")
    print()

    # ─── Bucket C: naming mismatch (Levenshtein <= 3) ───
    print("[compute] Bucket C — 네이밍 mismatch (Levenshtein <= 3)...")
    print("  (GDD-only 1,597 × DS-only 가까운 후보 매칭)")
    bucket_B_list = sorted(bucket_B)
    only_ds_list = sorted(only_ds)
    mismatches: list[dict] = []
    for tok in bucket_B_list:
        if len(tok) < 8: continue   # 너무 짧으면 false-pos 많음
        close = find_close_matches(tok, only_ds_list, max_dist=3)
        if close:
            mismatches.append({
                "gdd_token": tok,
                "ds_close_matches": close,
                "gdd_first_occ": by_id[tok][0] if tok in by_id else None,
            })
    print(f"  → {len(mismatches)} 개의 naming-mismatch 후보 발견")
    print()

    print("--- 네이밍 mismatch sample 30 (GDD ←→ DataSheet 짝) ---")
    for m in mismatches[:30]:
        ds_str = ", ".join(m["ds_close_matches"])
        ctx = (m["gdd_first_occ"] or {}).get("ctx", "")[:50]
        print(f"   GDD: {m['gdd_token']:<40} ← DS: {ds_str}")
        if ctx:
            print(f"        ctx: {ctx}")

    # 저장
    out = ROOT / "scripts" / "bench_out" / "overlap_3bucket.json"
    out.write_text(json.dumps({
        "bucket_A_count": len(bucket_A),
        "bucket_B_count": len(bucket_B),
        "bucket_A_pct_of_gdd": round(pct, 2),
        "ds_only_count": len(only_ds),
        "naming_mismatches": mismatches,
        "bucket_A": sorted(bucket_A)[:200],
        "bucket_B_sample": sorted(bucket_B)[:200],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print(f"[saved] {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
