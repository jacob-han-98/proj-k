"""4 strategy × 12 case 비교 매트릭스 러너.

각 strategy 의 강점/약점 가시화:
    - L1                  : 메타 어휘 매칭 (LLM 0회)
    - haiku_rerank        : L1 + Haiku 재정렬
    - haiku_expand        : Haiku 가 query 확장 → L1
    - vector              : Titan v2 + ChromaDB

사용:
    .venv/bin/python tests/run_quick_find_matrix.py
    .venv/bin/python tests/run_quick_find_matrix.py --case system-1-변신
    .venv/bin/python tests/run_quick_find_matrix.py --strategies l1,vector
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quick_find_cases import CASES, get_case  # noqa

STRATEGIES = ["l1", "vector", "parallel", "haiku_rerank", "haiku_expand", "auto"]


def call_strategy(base: str, strategy: str, case: dict) -> dict:
    payload = {"query": case["query"], "limit": 10, "strategy": strategy}
    t0 = time.time()
    hits: list[dict] = []
    statuses: list[dict] = []
    result_meta: dict = {}
    error_msg = None
    try:
        with httpx.stream("POST", f"{base}/quick_find", json=payload, timeout=60.0) as r:
            if r.status_code != 200:
                error_msg = f"HTTP {r.status_code}"
            else:
                for line in r.iter_lines():
                    if not line.strip():
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    t = ev.get("type")
                    if t == "status":
                        statuses.append(ev)
                    elif t == "hit":
                        hits.append(ev["data"])
                    elif t == "result":
                        result_meta = ev["data"]
                    elif t == "error":
                        error_msg = ev.get("message")
    except Exception as e:
        error_msg = str(e)
    elapsed_ms = int((time.time() - t0) * 1000)

    # 검증 (run_quick_find_cases.py 와 동일한 로직)
    checks: list[tuple[str, bool, str]] = []
    checks.append(("no_error", error_msg is None, error_msg or ""))
    min_results = case.get("min_results", 1)
    checks.append((f"min_results>={min_results}", len(hits) >= min_results, f"got {len(hits)}"))
    max_lat = case.get("max_latency_ms", 5000)
    checks.append((f"latency<={max_lat}ms", elapsed_ms <= max_lat, f"got {elapsed_ms}ms"))
    if case.get("expected_workbooks"):
        wbs = {h.get("workbook") or "" for h in hits}
        for w in case["expected_workbooks"]:
            checks.append((f"includes:{w}", w in wbs, ""))
    if case.get("expected_workbooks_any"):
        wbs = {h.get("workbook") or "" for h in hits}
        any_ok = any(w in wbs for w in case["expected_workbooks_any"])
        checks.append((f"any_of:{case['expected_workbooks_any']}", any_ok, f"got {list(wbs)[:3]}"))
    if case.get("expected_kinds"):
        kinds_ = {h.get("type") for h in hits}
        for k in case["expected_kinds"]:
            checks.append((f"kind:{k}", k in kinds_, ""))
    if case.get("expected_path_contains"):
        substr = case["expected_path_contains"]
        any_ok = any(substr in (h.get("path") or "") for h in hits)
        checks.append((f"path_contains:{substr}", any_ok, ""))
    if case.get("expected_sheet_contains"):
        substr = case["expected_sheet_contains"]
        any_ok = any(substr in (h.get("title") or "") for h in hits if h.get("type") == "xlsx")
        checks.append((f"sheet_contains:{substr}", any_ok, ""))
    if case.get("expected_diversity_min"):
        sigs = set()
        for h in hits:
            if h.get("type") == "xlsx":
                sigs.add(("xlsx", h.get("workbook")))
            else:
                p = (h.get("path") or "").split(" / ")
                sigs.add(("conf", " / ".join(p[:2])))
        ok = len(sigs) >= case["expected_diversity_min"]
        checks.append((f"diversity>={case['expected_diversity_min']}", ok, f"{len(sigs)}"))

    passed = all(ok for _, ok, _ in checks)
    return {
        "strategy": strategy, "case_id": case["id"], "query": case["query"],
        "passed": passed, "latency_ms": elapsed_ms,
        "n_hits": len(hits), "checks": checks,
        "hits": hits, "result": result_meta, "error": error_msg,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8090")
    p.add_argument("--case")
    p.add_argument("--strategies", default=",".join(STRATEGIES))
    args = p.parse_args()

    cases = [get_case(args.case)] if args.case else CASES
    strats = [s.strip() for s in args.strategies.split(",") if s.strip()]
    print(f"=== Multi-strategy matrix  base={args.base} ===")
    print(f"strategies: {strats}    cases: {len(cases)}\n")

    # 매트릭스: results[case_id][strategy] = run_result
    results: dict[str, dict[str, dict]] = {c["id"]: {} for c in cases}

    for c in cases:
        print(f"\n──── {c['id']}: {c['query']!r}  ({c['category']}) ────")
        for s in strats:
            r = call_strategy(args.base, s, c)
            results[c["id"]][s] = r
            mark = "✅" if r["passed"] else "❌"
            top1 = r["hits"][0] if r["hits"] else None
            top1_str = ""
            if top1:
                wb = top1.get("workbook") or top1.get("space") or "?"
                top1_str = f"  →  {top1.get('type')}/{wb}/{top1.get('title')}"
            print(f"  {mark} {s:18s}  {r['latency_ms']:>5}ms  hits={r['n_hits']:>2}{top1_str}")
            if not r["passed"]:
                fail_reasons = [n for n, ok, _ in r["checks"] if not ok]
                if fail_reasons:
                    print(f"           ✗ {', '.join(fail_reasons[:3])}")

    # ── 종합 매트릭스 ──
    print("\n" + "=" * 100)
    print("=== 종합: PASS/FAIL × 카테고리 ===\n")
    by_strat_pass: dict[str, int] = {s: 0 for s in strats}
    by_strat_lat: dict[str, list[int]] = {s: [] for s in strats}

    # case별 PASS 표
    print(f"{'case':30s}  " + "  ".join(f"{s:14s}" for s in strats))
    print("-" * (32 + 16 * len(strats)))
    for c in cases:
        row = []
        for s in strats:
            r = results[c["id"]].get(s, {})
            mark = "✅" if r.get("passed") else "❌"
            lat = r.get("latency_ms", 0)
            row.append(f"{mark} {lat:>5}ms")
            if r.get("passed"):
                by_strat_pass[s] = by_strat_pass.get(s, 0) + 1
            by_strat_lat[s].append(lat)
        print(f"{c['id']:30s}  " + "  ".join(f"{r:14s}" for r in row))

    # strategy 별 종합
    print("\n" + "-" * 80)
    print(f"{'strategy':18s}  PASS    avg_lat  median   max")
    for s in strats:
        lats = by_strat_lat[s]
        if not lats:
            continue
        avg = sum(lats) // len(lats)
        med = sorted(lats)[len(lats) // 2]
        mx = max(lats)
        print(f"{s:18s}  {by_strat_pass[s]}/{len(cases)}    {avg:>5}ms   {med:>5}ms  {mx:>5}ms")

    # 카테고리별 분석
    print("\n=== 카테고리별 strategy quality ===\n")
    cats: dict[str, list[dict]] = {}
    for c in cases:
        cats.setdefault(c["category"], []).append(c)
    for cat, cat_cases in cats.items():
        print(f"  [{cat}]")
        for s in strats:
            n_pass = sum(1 for c in cat_cases if results[c["id"]].get(s, {}).get("passed"))
            print(f"    {s:18s}  {n_pass}/{len(cat_cases)}")
        print()

    # JSON 으로도 저장
    out_path = Path(__file__).resolve().parent / "quick_find_matrix_results.json"
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str))
    print(f"\n전체 결과 저장: {out_path}")


if __name__ == "__main__":
    main()
