"""Quick Find 12 케이스 러너 — 라이브 서버 호출 + per-layer quality 평가 리포트.

사용:
    .venv/bin/python tests/run_quick_find_cases.py
    .venv/bin/python tests/run_quick_find_cases.py --case system-1-변신    # 단일 실행
    .venv/bin/python tests/run_quick_find_cases.py --base http://127.0.0.1:8091

리포트:
    각 케이스마다:
      - latency (target/actual)
      - Phase1 layer breakdown (어느 substring 레이어가 후보 만듦)
      - Top N hits (kind / title / matched_via / rerank_source)
      - 검증 결과 (✓/✗): expected_workbooks 매칭, 다양성, 응답 갯수
    종합:
      - 카테고리별 PASS/FAIL
      - layer 별 contribution 통계 (= KG/vector layer 추가 필요 여부 판단 자료)
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


def run_case(base: str, case: dict, *, verbose: bool = True) -> dict:
    """한 케이스 실행 → 결과 dict (검증 포함)."""
    q = case["query"]
    limit = 10
    payload = {"query": q, "limit": limit}
    if case.get("expected_kinds"):
        # filter 안 걸고 전체 받아서 검증 (filter 는 quality 흐림)
        pass

    t0 = time.time()
    hits: list[dict] = []
    statuses: list[dict] = []
    result_meta: dict = {}
    error_msg = None
    try:
        with httpx.stream("POST", f"{base}/quick_find", json=payload, timeout=30.0) as r:
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

    # 검증
    checks: list[tuple[str, bool, str]] = []
    # 1. error 없음
    checks.append(("no_error", error_msg is None, error_msg or ""))
    # 2. 결과 갯수
    min_results = case.get("min_results", 1)
    checks.append((f"min_results>={min_results}", len(hits) >= min_results, f"got {len(hits)}"))
    # 3. latency
    max_lat = case.get("max_latency_ms", 3000)
    checks.append((f"latency<={max_lat}ms", elapsed_ms <= max_lat, f"got {elapsed_ms}ms"))
    # 4. expected_workbooks (모두 안에 있어야)
    if case.get("expected_workbooks"):
        wbs_in_hits = {h.get("workbook") or "" for h in hits}
        for w in case["expected_workbooks"]:
            checks.append((f"includes:{w}", w in wbs_in_hits, f"workbooks={list(wbs_in_hits)[:5]}"))
    # 5. expected_workbooks_any (≥ 1)
    if case.get("expected_workbooks_any"):
        wbs_in_hits = {h.get("workbook") or "" for h in hits}
        any_ok = any(w in wbs_in_hits for w in case["expected_workbooks_any"])
        checks.append((f"any_of:{case['expected_workbooks_any']}", any_ok, f"workbooks={list(wbs_in_hits)[:5]}"))
    # 6. expected_kinds
    if case.get("expected_kinds"):
        kinds_in_hits = {h.get("type") for h in hits}
        for k in case["expected_kinds"]:
            checks.append((f"kind:{k}", k in kinds_in_hits, f"kinds={list(kinds_in_hits)}"))
    # 7. expected_path_contains
    if case.get("expected_path_contains"):
        substr = case["expected_path_contains"]
        any_ok = any(substr in (h.get("path") or "") for h in hits)
        checks.append((f"path_contains:{substr}", any_ok, ""))
    # 8. expected_sheet_contains (xlsx 시트 명에)
    if case.get("expected_sheet_contains"):
        substr = case["expected_sheet_contains"]
        any_ok = any(substr in (h.get("title") or "") for h in hits if h.get("type") == "xlsx")
        checks.append((f"sheet_contains:{substr}", any_ok, ""))
    # 9. expected_diversity_min — 서로 다른 워크북·페이지 path prefix 수
    if case.get("expected_diversity_min"):
        # 워크북 또는 conf top-level path 단위
        sigs = set()
        for h in hits:
            if h.get("type") == "xlsx":
                sigs.add(("xlsx", h.get("workbook")))
            else:
                # confluence — path 의 첫 2 토큰
                p = (h.get("path") or "").split(" / ")
                sigs.add(("conf", " / ".join(p[:2])))
        ok = len(sigs) >= case["expected_diversity_min"]
        checks.append((f"diversity>={case['expected_diversity_min']}", ok, f"got {len(sigs)}: {list(sigs)[:5]}"))

    passed = all(ok for _, ok, _ in checks)

    # 리포트 출력
    if verbose:
        status_emoji = "✅" if passed else "❌"
        print(f"\n{status_emoji} [{case['id']}] query={q!r}  ({case['category']})")
        print(f"   latency: {elapsed_ms}ms  (target {max_lat}ms)  "
              f"phase1={result_meta.get('phase1_ms','?')}ms phase2={result_meta.get('phase2_ms','?')}ms")
        if result_meta.get("phase1_layers"):
            layers = result_meta["phase1_layers"]
            layer_str = " ".join(f"{k}={v}" for k, v in sorted(layers.items(), key=lambda x: -x[1]))
            print(f"   Phase1 layers: {layer_str}  (총 후보 {result_meta.get('phase1_candidates','?')})")
        if hits:
            print(f"   Top {min(len(hits), 5)}:")
            for i, h in enumerate(hits[:5], 1):
                src = h.get("rerank_source", "?")
                via = h.get("matched_via", "?")
                title = h.get("title", "?")
                kind = h.get("type", "?")
                wb = h.get("workbook") or h.get("space") or ""
                print(f"     {i}. [{kind}] {title}  ← {wb}  (via={via}, src={src})")
        for name, ok, detail in checks:
            mark = "✓" if ok else "✗"
            tail = f" — {detail}" if detail else ""
            if not ok or detail:
                print(f"     {mark} {name}{tail}")

    return {
        "case_id": case["id"],
        "category": case["category"],
        "query": q,
        "passed": passed,
        "latency_ms": elapsed_ms,
        "n_hits": len(hits),
        "n_status": len(statuses),
        "phase1_layers": result_meta.get("phase1_layers", {}),
        "phase1_ms": result_meta.get("phase1_ms"),
        "phase2_ms": result_meta.get("phase2_ms"),
        "checks": [(n, ok, d) for n, ok, d in checks],
        "hits": hits,
        "error": error_msg,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8090")
    p.add_argument("--case", help="단일 케이스 id (생략 시 전체)")
    args = p.parse_args()

    cases = [get_case(args.case)] if args.case else CASES

    print(f"=== Quick Find 12 케이스 러너  base={args.base} ===")
    print(f"실행: {len(cases)}개\n")

    results = [run_case(args.base, c) for c in cases]

    # 종합
    print("\n" + "=" * 80)
    print("=== 종합 ===")
    n_pass = sum(1 for r in results if r["passed"])
    print(f"PASS {n_pass}/{len(results)}")
    print()

    # 카테고리별
    by_cat: dict[str, list] = {}
    for r in results:
        by_cat.setdefault(r["category"], []).append(r)
    for cat, rs in by_cat.items():
        n_ok = sum(1 for r in rs if r["passed"])
        avg_lat = sum(r["latency_ms"] for r in rs) // len(rs)
        print(f"  {cat:20s}  PASS {n_ok}/{len(rs)}  avg_lat {avg_lat}ms")
    print()

    # Layer contribution 종합 (KG/vector 추가 가치 판단용)
    layer_total: dict[str, int] = {}
    for r in results:
        for k, v in (r.get("phase1_layers") or {}).items():
            layer_total[k] = layer_total.get(k, 0) + v
    if layer_total:
        print("Phase1 layer 누적 contribution:")
        for k, v in sorted(layer_total.items(), key=lambda x: -x[1]):
            print(f"  {k:30s}  {v} hits")
        print()
        print("→ key_term/title 매칭이 대부분이면 substring layer 만으로 충분.")
        print("→ 0건 결과 케이스가 있으면 (특히 의미매칭 edge-1) vector layer 추가 검토.")

    # 0 결과 케이스
    zeros = [r for r in results if r["n_hits"] == 0]
    if zeros:
        print()
        print("⚠️ 0 결과 케이스 (vector/KG layer 추가 후보):")
        for r in zeros:
            print(f"  - {r['case_id']}  query={r['query']!r}")

    # Latency 종합
    lats = [r["latency_ms"] for r in results]
    print(f"\nLatency: min={min(lats)}ms  median={sorted(lats)[len(lats)//2]}ms  max={max(lats)}ms")

    sys.exit(0 if n_pass == len(results) else 1)


if __name__ == "__main__":
    main()
