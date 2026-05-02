"""Auto v2 threshold 5회 반복 튜닝 — 100 케이스로.

각 iteration:
  - threshold 설정 (score_l1_high, score_vec_high, min_high_hits, overlap_threshold)
  - 100 케이스 호출 (auto 만 — l1/vector 비교는 별도)
  - 종합 보고: PASS rate, expand 빈도, 카테고리별
  - 다음 iteration 의 threshold 추천

실행:
  .venv/bin/python tests/run_auto_v2_tuning.py
  .venv/bin/python tests/run_auto_v2_tuning.py --iterations 3
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_quick_find_100 import gen_cases, build_index  # noqa


# 5 iterations 의 threshold 설정 — 시작점 + 점진 조정
ITERATIONS = [
    # iter, l1_high, vec_high, min_high, overlap, name
    (1, 0.85, 0.45, 2, 2, "기본 — 안전"),
    (2, 0.85, 0.45, 2, 1, "overlap 1 — expand 적게 (더 stop)"),
    (3, 0.95, 0.50, 1, 2, "high score 빡빡 (title_prefix↑) + min_high=1 (expand 적게)"),
    (4, 0.85, 0.40, 2, 2, "vec_high 완화 — expand 더 적게"),
    (5, 0.80, 0.35, 1, 1, "공격적 stop — expand 가장 적게"),
]


def call_one_auto(base: str, case: dict, thresholds: dict, top_n: int = 5) -> dict:
    payload = {
        "query": case["query"], "limit": 10, "strategy": "auto",
        **thresholds,
    }
    t0 = time.time()
    hits: list[dict] = []
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
                    if t == "hit":
                        hits.append(ev["data"])
                    elif t == "result":
                        result_meta = ev["data"]
                    elif t == "error":
                        error_msg = ev.get("message")
    except Exception as e:
        error_msg = str(e)
    elapsed_ms = int((time.time() - t0) * 1000)

    # 검증
    top_hits = hits[:top_n]
    passed = False
    if error_msg:
        pass
    elif len(hits) < case.get("min_results", 1):
        pass
    elif case.get("expected_doc_id"):
        passed = case["expected_doc_id"] in [h.get("doc_id") for h in top_hits]
    elif case.get("expected_workbook"):
        passed = case["expected_workbook"] in [h.get("workbook") for h in top_hits]
    elif case.get("expected_workbooks_any"):
        wbs = {h.get("workbook") or "" for h in top_hits}
        passed = any(w in wbs for w in case["expected_workbooks_any"])

    return {
        "case_id": case["id"], "category": case["category"], "query": case["query"],
        "passed": passed, "latency_ms": elapsed_ms, "n_hits": len(hits),
        "expanded": result_meta.get("expanded", False),
        "expand_yielded": result_meta.get("expand_yielded", 0),
        "expanded_keywords": result_meta.get("expanded_keywords"),
        "confidence_signals": result_meta.get("confidence_signals", {}),
        "error": error_msg,
    }


def run_iteration(base: str, cases: list[dict], thresholds: dict, label: str, iter_no: int) -> dict:
    print(f"\n{'=' * 80}")
    print(f"=== ITER {iter_no}: {label} ===")
    print(f"thresholds: {thresholds}")
    print(f"running {len(cases)} cases...")

    t_start = time.time()
    results = []
    for i, c in enumerate(cases):
        r = call_one_auto(base, c, thresholds)
        results.append(r)
        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(cases)}  ({time.time()-t_start:.0f}s)")

    elapsed = time.time() - t_start

    # 분석
    n_pass = sum(1 for r in results if r["passed"])
    n_expanded = sum(1 for r in results if r["expanded"])
    lats = [r["latency_ms"] for r in results]
    avg_lat = sum(lats) // len(lats)
    p50 = sorted(lats)[len(lats) // 2]
    p90 = sorted(lats)[int(len(lats) * 0.9)]
    p95 = sorted(lats)[int(len(lats) * 0.95)]

    # latency: expand 한 vs 안 한
    lat_no_exp = [r["latency_ms"] for r in results if not r["expanded"]]
    lat_exp = [r["latency_ms"] for r in results if r["expanded"]]

    # 카테고리별
    by_cat: dict[str, list[dict]] = {}
    for r in results:
        by_cat.setdefault(r["category"], []).append(r)

    # expand 효과: expand 한 케이스 중 PASS 비율 vs 안 한 케이스
    pass_no_exp = sum(1 for r in results if not r["expanded"] and r["passed"])
    pass_exp = sum(1 for r in results if r["expanded"] and r["passed"])

    summary = {
        "iter": iter_no, "label": label, "thresholds": thresholds,
        "elapsed_s": int(elapsed),
        "pass": n_pass, "total": len(cases),
        "pass_rate": n_pass / len(cases) * 100,
        "expanded": n_expanded, "expand_rate": n_expanded / len(cases) * 100,
        "avg_lat": avg_lat, "p50": p50, "p90": p90, "p95": p95,
        "lat_no_exp_avg": sum(lat_no_exp) // len(lat_no_exp) if lat_no_exp else 0,
        "lat_exp_avg": sum(lat_exp) // len(lat_exp) if lat_exp else 0,
        "pass_no_exp": pass_no_exp,
        "pass_exp": pass_exp,
        "by_cat_pass": {cat: sum(1 for r in rs if r["passed"]) for cat, rs in by_cat.items()},
        "by_cat_total": {cat: len(rs) for cat, rs in by_cat.items()},
        "by_cat_expand": {cat: sum(1 for r in rs if r["expanded"]) for cat, rs in by_cat.items()},
        "results": results,
    }

    # 출력
    print(f"\n--- ITER {iter_no} 결과 ({elapsed:.0f}s) ---")
    print(f"  PASS: {n_pass}/{len(cases)} ({summary['pass_rate']:.0f}%)")
    print(f"  Expanded: {n_expanded}/{len(cases)} ({summary['expand_rate']:.0f}%)")
    print(f"  Latency  avg={avg_lat}ms  p50={p50}ms  p90={p90}ms  p95={p95}ms")
    print(f"  No-expand avg: {summary['lat_no_exp_avg']}ms")
    print(f"  Expand avg:    {summary['lat_exp_avg']}ms")
    print(f"  PASS by expand:")
    print(f"    no-expand cases: {pass_no_exp}/{len(cases) - n_expanded} PASS")
    print(f"    expanded  cases: {pass_exp}/{n_expanded} PASS")
    print(f"  Category PASS:")
    for cat in summary["by_cat_total"]:
        p = summary["by_cat_pass"][cat]
        t = summary["by_cat_total"][cat]
        e = summary["by_cat_expand"][cat]
        print(f"    {cat:20s}  {p:>3}/{t:<3} ({p/t*100:>3.0f}%)  expand={e}")

    return summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8090")
    p.add_argument("--iterations", type=int, default=5)
    args = p.parse_args()

    print("[setup] 인덱스 빌드 + 100 cases 생성...")
    docs = build_index()
    cases = gen_cases(docs)
    print(f"  {len(docs)} docs, {len(cases)} cases\n")

    iterations_to_run = ITERATIONS[: args.iterations]
    summaries = []
    for it in iterations_to_run:
        iter_no, l1h, vh, mh, ovr, label = it
        thresholds = {
            "score_l1_high": l1h,
            "score_vec_high": vh,
            "min_high_hits": mh,
            "overlap_threshold": ovr,
        }
        s = run_iteration(args.base, cases, thresholds, label, iter_no)
        summaries.append(s)

    # 최종 비교
    print("\n" + "=" * 90)
    print("=== 5 iterations 종합 비교 ===\n")
    print(f"{'iter':>4}  {'label':30s}  {'thresholds':35s}  {'PASS':>10s}  {'expand':>8s}  {'avg_lat':>7s}")
    for s in summaries:
        thr = s["thresholds"]
        thr_str = f"l1≥{thr['score_l1_high']} vec≥{thr['score_vec_high']} min={thr['min_high_hits']} ovr={thr['overlap_threshold']}"
        print(f"  {s['iter']:>2}  {s['label'][:28]:30s}  {thr_str:35s}  "
              f"{s['pass']:>3}/{s['total']:<3} ({s['pass_rate']:>3.0f}%)  "
              f"{s['expanded']:>3}/{s['total']:<3}  {s['avg_lat']:>5}ms")

    # 카테고리별 비교
    print(f"\n--- 카테고리별 PASS rate per iter ---")
    cats = list(summaries[0]["by_cat_total"].keys())
    print(f"  {'category':22s}  total  " + "  ".join(f"iter{s['iter']:>2}" for s in summaries))
    for cat in cats:
        total = summaries[0]["by_cat_total"][cat]
        row = "  ".join(f"{s['by_cat_pass'][cat]:>3}/{total:<3}" for s in summaries)
        print(f"  {cat:22s}  {total:>5}  {row}")

    # 최적 iteration
    best = max(summaries, key=lambda s: (s["pass_rate"], -s["avg_lat"]))
    print(f"\n=== 최적 iteration ===")
    print(f"  ITER {best['iter']}: {best['label']}")
    print(f"  PASS {best['pass']}/{best['total']} ({best['pass_rate']:.0f}%)  "
          f"expand {best['expanded']}/{best['total']}  avg {best['avg_lat']}ms")
    print(f"  thresholds: {best['thresholds']}")

    # 저장
    out_path = Path(__file__).resolve().parent / "auto_v2_tuning_results.json"
    out_path.write_text(json.dumps(summaries, ensure_ascii=False, indent=2, default=str))
    print(f"\n저장: {out_path}")


if __name__ == "__main__":
    main()
