"""
NL suite 결과 리포트 — vocab pair 별로 동의어 layer 효과 정리.
"""
from __future__ import annotations

import glob
import json
import os
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent


def latest(pattern: str) -> Path | None:
    fs = sorted(glob.glob(str(ROOT / "scripts" / "bench_out" / pattern)), key=os.path.getmtime, reverse=True)
    return Path(fs[0]) if fs else None


def main():
    p = latest("run_naturallang_*.json")
    if not p:
        print("[err] NL run 없음")
        return 1
    d = json.loads(p.read_text(encoding="utf-8"))
    print(f"[load] {p.name}")
    print(f"completed {d['completed']}/{d['total']}, wall={d.get('wall_seconds','?')}s")
    print(f"avg time per-q (parallel sum/n): {d['running_stats']['avg_total_s']}s")
    print(f"speedup vs sequential: {d['running_stats']['speedup_vs_sequential_est']}x")
    print(f"pass: {d['running_stats']['pass_rate_so_far']}%, cost: ${d['running_stats']['sum_cost_usd']}")
    print()

    # NL suite의 각 질문은 vocab_pair 메타데이터 있음 — 원본 suite 에서 lookup
    nl_suite = json.loads((ROOT / "scripts" / "bench_out" / "benchmark_naturallang.json").read_text(encoding="utf-8"))
    pair_by_id = {q["id"]: q.get("vocab_pair", "?") for q in nl_suite["questions"]}

    print(f"{'pair':<15}{'pass':>6}{'time':>7}{'tools':>6}{'ans':>6}  question")
    print("-" * 110)
    rows = []
    for r in d["results"]:
        rows.append({
            "pair": pair_by_id.get(r["id"], "?"),
            "passed": r["passed"],
            "t": r["result"]["total_s"],
            "tools": r["result"]["tool_calls"],
            "ans": r["result"]["answer_len"],
            "q": r["question"],
        })
    rows.sort(key=lambda x: x["t"])
    for r in rows:
        p = "✓" if r["passed"] is True else ("✗" if r["passed"] is False else "·")
        print(f"  {r['pair']:<13}{p:>5}{r['t']:>7.1f}s{r['tools']:>6}{r['ans']:>6}  {r['q'][:60]}")
    print()

    # 통계
    pass_n = sum(1 for r in rows if r["passed"] is True)
    eligible = sum(1 for r in rows if r["passed"] in (True, False))
    avg_t = sum(r["t"] for r in rows) / max(len(rows), 1)
    avg_tools = sum(r["tools"] for r in rows) / max(len(rows), 1)
    avg_ans = sum(r["ans"] for r in rows) / max(len(rows), 1)
    print(f"=== summary ===")
    print(f"  pass {pass_n}/{eligible} ({100*pass_n/max(eligible,1):.0f}%)")
    print(f"  avg time {avg_t:.1f}s, avg tools {avg_tools:.1f}, avg answer {avg_ans:.0f}자")


if __name__ == "__main__":
    sys.exit(main() or 0)
