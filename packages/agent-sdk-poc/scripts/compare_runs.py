"""
벤치 run 결과 비교기 — before/after 각 카테고리별 차이 시각화.

Usage:
    python scripts/compare_runs.py BEFORE.json AFTER.json
    python scripts/compare_runs.py --latest-pair    # 최신 before/after 자동 매칭
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


def load_run(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def index_results(run: dict) -> dict[str, dict]:
    return {r["id"]: r for r in run["results"]}


def pct_diff(after: float, before: float) -> str:
    if before == 0:
        return "n/a"
    d = (after - before) / before * 100
    sign = "+" if d > 0 else ""
    return f"{sign}{d:.1f}%"


def fmt_delta(after: float, before: float, lower_better: bool = True) -> str:
    """이전 → 이후 값 변화 화살표."""
    if before == after:
        return "="
    if lower_better:
        return "↓" if after < before else "↑"
    else:
        return "↑" if after > before else "↓"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("before", nargs="?")
    ap.add_argument("after", nargs="?")
    ap.add_argument("--latest-pair", action="store_true",
                    help="run_sample_before*/after* 중 최신 페어 자동 선택")
    args = ap.parse_args()

    if args.latest_pair or (not args.before and not args.after):
        before_files = sorted(glob.glob(str(OUT_DIR / "run_sample_before*.json")), key=os.path.getmtime, reverse=True)
        after_files = sorted(glob.glob(str(OUT_DIR / "run_sample_after*.json")), key=os.path.getmtime, reverse=True)
        if not before_files or not after_files:
            print("[err] before/after 파일 못 찾음")
            return 1
        bp, ap_ = Path(before_files[0]), Path(after_files[0])
    else:
        bp, ap_ = Path(args.before), Path(args.after)

    print(f"[load] before = {bp.name}")
    print(f"[load] after  = {ap_.name}")
    before = load_run(bp)
    after = load_run(ap_)

    bidx = index_results(before)
    aidx = index_results(after)
    common_ids = set(bidx) & set(aidx)
    print(f"[load] common questions = {len(common_ids)}\n")

    # ─── 전체 통계 ───
    def agg(idx, ids):
        n = len(ids)
        sum_t = sum(idx[i]["result"]["total_s"] for i in ids)
        sum_tools = sum(idx[i]["result"]["tool_calls"] for i in ids)
        sum_cost = sum((idx[i]["result"]["cost_usd"] or 0) for i in ids)
        sum_ans = sum(idx[i]["result"]["answer_len"] for i in ids)
        passed = sum(1 for i in ids if idx[i]["passed"] is True)
        eligible = sum(1 for i in ids if idx[i]["passed"] in (True, False))
        errors = sum(1 for i in ids if idx[i]["result"].get("error"))
        empty = sum(1 for i in ids if idx[i]["result"]["answer_len"] == 0)
        return {
            "avg_t": sum_t / n, "avg_tools": sum_tools / n, "avg_cost": sum_cost / n, "avg_ans": sum_ans / n,
            "sum_t": sum_t, "sum_cost": sum_cost,
            "pass": passed, "eligible": eligible, "errors": errors, "empty": empty,
        }

    b = agg(bidx, common_ids)
    a = agg(aidx, common_ids)

    print("=" * 80)
    print(f"{'metric':<25}{'before':>15}{'after':>15}{'delta':>15}")
    print("-" * 80)
    rows = [
        ("avg_total_s", b["avg_t"], a["avg_t"], True),
        ("avg_tools", b["avg_tools"], a["avg_tools"], True),
        ("avg_answer_chars", b["avg_ans"], a["avg_ans"], False),
        ("avg_cost_usd", b["avg_cost"], a["avg_cost"], True),
        ("sum_total_s", b["sum_t"], a["sum_t"], True),
        ("sum_cost_usd", b["sum_cost"], a["sum_cost"], True),
    ]
    for label, bv, av, lower_better in rows:
        arrow = fmt_delta(av, bv, lower_better)
        print(f"  {label:<23}{bv:>15.2f}{av:>15.2f}   {arrow} {pct_diff(av, bv):>8}")
    pass_rate_b = b["pass"] / max(b["eligible"], 1) * 100
    pass_rate_a = a["pass"] / max(a["eligible"], 1) * 100
    print(f"  {'pass_rate':<23}{pass_rate_b:>14.1f}%{pass_rate_a:>14.1f}%   {fmt_delta(pass_rate_a, pass_rate_b, lower_better=False)} {'+' if pass_rate_a>=pass_rate_b else ''}{pass_rate_a-pass_rate_b:.1f}pp")
    print(f"  {'errors':<23}{b['errors']:>15}{a['errors']:>15}")
    print(f"  {'empty_answer':<23}{b['empty']:>15}{a['empty']:>15}")
    print()

    # ─── 카테고리별 ───
    print("=" * 80)
    print("카테고리별 비교")
    print("-" * 80)
    print(f"{'category':<25}{'n':>4}{'B avg_s':>10}{'A avg_s':>10}{'delta':>10}{'B tools':>9}{'A tools':>9}")
    by_cat = defaultdict(list)
    for i in common_ids:
        by_cat[bidx[i]["category"]].append(i)
    for cat in sorted(by_cat.keys()):
        ids = by_cat[cat]
        bb = agg(bidx, ids)
        aa = agg(aidx, ids)
        print(f"  {cat:<23}{len(ids):>4}{bb['avg_t']:>10.1f}{aa['avg_t']:>10.1f}{pct_diff(aa['avg_t'], bb['avg_t']):>10}{bb['avg_tools']:>9.1f}{aa['avg_tools']:>9.1f}")
    print()

    # ─── 개별 질문별 ───
    print("=" * 100)
    print("질문별 변화 (이상치만 강조 — Δ ≥ 30%)")
    print("-" * 100)
    deltas = []
    for i in sorted(common_ids):
        b_s = bidx[i]["result"]["total_s"]
        a_s = aidx[i]["result"]["total_s"]
        b_tools = bidx[i]["result"]["tool_calls"]
        a_tools = aidx[i]["result"]["tool_calls"]
        delta_pct = (a_s - b_s) / max(b_s, 0.1) * 100
        b_pass = bidx[i]["passed"]
        a_pass = aidx[i]["passed"]
        deltas.append({
            "id": i,
            "category": bidx[i]["category"],
            "question": bidx[i]["question"],
            "b_s": b_s, "a_s": a_s, "delta_pct": delta_pct,
            "b_tools": b_tools, "a_tools": a_tools,
            "b_pass": b_pass, "a_pass": a_pass,
            "b_ans": bidx[i]["result"]["answer_len"],
            "a_ans": aidx[i]["result"]["answer_len"],
        })
    # Δ 절댓값 큰 순
    deltas.sort(key=lambda x: -abs(x["delta_pct"]))
    for d in deltas:
        if abs(d["delta_pct"]) < 30:
            continue
        bp = "✓" if d["b_pass"] is True else ("✗" if d["b_pass"] is False else "·")
        ap_ind = "✓" if d["a_pass"] is True else ("✗" if d["a_pass"] is False else "·")
        sign = "+" if d["delta_pct"] > 0 else ""
        print(f"  [{d['category'][:18]:<18}] {bp}→{ap_ind}  {d['b_s']:>5.1f}s →{d['a_s']:>5.1f}s ({sign}{d['delta_pct']:>5.1f}%)  "
              f"tools {d['b_tools']:>2}→{d['a_tools']:>2}  ans {d['b_ans']}→{d['a_ans']}")
        print(f"       {d['question'][:90]}")
    print()

    # ─── 자동채점 변화 ───
    print("=" * 80)
    print("PASS 변화 (eligible 만)")
    print("-" * 80)
    became_pass = []
    became_fail = []
    for i in common_ids:
        bp = bidx[i]["passed"]
        ap_ = aidx[i]["passed"]
        if bp is False and ap_ is True:
            became_pass.append(i)
        elif bp is True and ap_ is False:
            became_fail.append(i)
    print(f"  ✗ → ✓ : {len(became_pass)} 개 (개선)")
    for i in became_pass:
        q = bidx[i]["question"]
        print(f"      {q[:80]}")
    print(f"  ✓ → ✗ : {len(became_fail)} 개 (회귀)")
    for i in became_fail:
        q = bidx[i]["question"]
        print(f"      {q[:80]}")


if __name__ == "__main__":
    sys.exit(main() or 0)
