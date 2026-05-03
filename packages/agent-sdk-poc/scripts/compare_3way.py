"""
3-way 비교: before / after-1 (DataSheet 인덱스만) / after-2 (C-strategy + 인덱스).

각 질문 ID 마다 3개 run 의 (시간, tools, 답변길이, pass) 를 표로 비교.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scripts" / "bench_out"


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def latest(pattern: str) -> Path:
    fs = sorted(glob.glob(str(OUT_DIR / pattern)), key=os.path.getmtime, reverse=True)
    return Path(fs[0]) if fs else None


def agg(results, ids):
    n = len(ids)
    if n == 0:
        return {}
    sum_t = sum(r["result"]["total_s"] for r in results if r["id"] in ids)
    sum_tools = sum(r["result"]["tool_calls"] for r in results if r["id"] in ids)
    sum_cost = sum((r["result"]["cost_usd"] or 0) for r in results if r["id"] in ids)
    sum_ans = sum(r["result"]["answer_len"] for r in results if r["id"] in ids)
    pass_count = sum(1 for r in results if r["id"] in ids and r["passed"] is True)
    pass_eligible = sum(1 for r in results if r["id"] in ids and r["passed"] in (True, False))
    empty = sum(1 for r in results if r["id"] in ids and r["result"]["answer_len"] == 0)
    return {
        "n": n, "avg_t": sum_t / n, "avg_tools": sum_tools / n,
        "avg_cost": sum_cost / n, "avg_ans": sum_ans / n,
        "sum_t": sum_t, "sum_cost": sum_cost,
        "pass": pass_count, "pass_eligible": pass_eligible, "empty": empty,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", default=None)
    ap.add_argument("--after1", default=None)
    ap.add_argument("--after2", default=None)
    args = ap.parse_args()

    bp = Path(args.before) if args.before else latest("run_sample_before*.json")
    a1 = Path(args.after1) if args.after1 else latest("run_sample_after-datasheet-index*.json")
    a2 = Path(args.after2) if args.after2 else latest("run_sample_after-c-parallel*.json") or latest("run_sample_after-c-strategy*.json")

    if not (bp and a1 and a2):
        print("[err] missing files. before/after1/after2 required.")
        return 1

    print(f"[load] B  : {bp.name}")
    print(f"[load] A1 : {a1.name}  (DataSheet index only)")
    print(f"[load] A2 : {a2.name}  (C-strategy + index)")

    runs = {"B": load(bp), "A1": load(a1), "A2": load(a2)}
    common = set(r["id"] for r in runs["B"]["results"]) \
        & set(r["id"] for r in runs["A1"]["results"]) \
        & set(r["id"] for r in runs["A2"]["results"])
    print(f"common questions = {len(common)}\n")

    # === 전체 ===
    print("=" * 95)
    print(f"{'metric':<22}{'B (none)':>15}{'A1 (idx)':>15}{'A2 (C)':>15}{'A2 vs B':>15}")
    print("-" * 95)
    aggs = {k: agg(runs[k]["results"], common) for k in ("B", "A1", "A2")}

    def diff(a, b):
        if b == 0: return "n/a"
        d = (a - b) / b * 100
        return f"{'+' if d > 0 else ''}{d:.1f}%"

    rows = [("avg_total_s", "avg_t"), ("avg_tools", "avg_tools"),
            ("avg_answer_chars", "avg_ans"), ("avg_cost_usd", "avg_cost"),
            ("sum_total_s", "sum_t"), ("sum_cost_usd", "sum_cost")]
    for label, key in rows:
        b = aggs["B"][key]; a1v = aggs["A1"][key]; a2v = aggs["A2"][key]
        print(f"  {label:<20}{b:>15.2f}{a1v:>15.2f}{a2v:>15.2f}{diff(a2v, b):>15}")

    # pass rate
    for k in ("B", "A1", "A2"):
        s = aggs[k]
        s["pass_rate"] = s["pass"] / max(s["pass_eligible"], 1) * 100
    pb, p1, p2 = aggs["B"]["pass_rate"], aggs["A1"]["pass_rate"], aggs["A2"]["pass_rate"]
    print(f"  {'pass_rate (%)':<20}{pb:>15.1f}{p1:>15.1f}{p2:>15.1f}{'+' if p2>=pb else ''}{p2-pb:>11.1f}pp")
    print(f"  {'empty_answers':<20}{aggs['B']['empty']:>15}{aggs['A1']['empty']:>15}{aggs['A2']['empty']:>15}")
    print(f"  {'wall_time_s':<20}{'(seq)':>15}{'(seq)':>15}{runs['A2'].get('wall_seconds', '?'):>15}")
    print()

    # === 카테고리별 ===
    print("=" * 95)
    print("카테고리별 평균 시간 (B → A1 → A2)")
    print("-" * 95)
    by_cat = defaultdict(list)
    bidx = {r["id"]: r for r in runs["B"]["results"]}
    for i in common:
        by_cat[bidx[i]["category"]].append(i)
    print(f"{'category':<22}{'n':>4}{'B':>10}{'A1':>10}{'A2':>10}{'A2 vs B':>12}")
    for cat in sorted(by_cat):
        ids = by_cat[cat]
        a_b = agg(runs["B"]["results"], ids)
        a_1 = agg(runs["A1"]["results"], ids)
        a_2 = agg(runs["A2"]["results"], ids)
        print(f"  {cat:<20}{len(ids):>4}{a_b['avg_t']:>10.1f}{a_1['avg_t']:>10.1f}{a_2['avg_t']:>10.1f}{diff(a_2['avg_t'], a_b['avg_t']):>12}")
    print()

    # === 질문별 (가장 큰 변화 우선) ===
    print("=" * 100)
    print("질문별 변화 (B → A2 정렬, 가장 큰 단축 위) ")
    print("-" * 100)
    bdic = {r["id"]: r for r in runs["B"]["results"]}
    a1dic = {r["id"]: r for r in runs["A1"]["results"]}
    a2dic = {r["id"]: r for r in runs["A2"]["results"]}
    rows = []
    for i in common:
        b = bdic[i]; a1r = a1dic[i]; a2r = a2dic[i]
        b_t = b["result"]["total_s"]; a2_t = a2r["result"]["total_s"]
        rows.append({
            "q": b["question"], "cat": b["category"][:18],
            "b_t": b_t, "a1_t": a1r["result"]["total_s"], "a2_t": a2_t,
            "b_ans": b["result"]["answer_len"], "a2_ans": a2r["result"]["answer_len"],
            "b_pass": b["passed"], "a2_pass": a2r["passed"],
            "delta": (a2_t - b_t) / max(b_t, 0.1) * 100,
        })
    rows.sort(key=lambda x: x["delta"])
    for r in rows:
        bp = "✓" if r["b_pass"] is True else ("✗" if r["b_pass"] is False else "·")
        ap = "✓" if r["a2_pass"] is True else ("✗" if r["a2_pass"] is False else "·")
        print(f"  [{r['cat']:<18}] {bp}→{ap}  {r['b_t']:>5.1f}s →{r['a2_t']:>5.1f}s ({'+' if r['delta']>0 else ''}{r['delta']:>5.1f}%)  ans {r['b_ans']:>4}→{r['a2_ans']:>4}  {r['q'][:55]}")


if __name__ == "__main__":
    sys.exit(main() or 0)
