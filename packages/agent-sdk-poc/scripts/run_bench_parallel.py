"""
병렬 벤치 runner — N 개 질문 동시 실행으로 wall time 단축.

기존 run_bench_suite.py 는 sequential (질문 하나씩). 22 질문 ~10분.
이 버전은 ThreadPoolExecutor 로 N concurrent (default 10). 22 질문 ~90초.

각 질문은 독립 세션 (서버에서 conversation_id 미지정 → 새 conv).
스레드 안전: 결과 list 에 append 만, 매 질문 후 즉시 파일 저장.

Usage:
    python scripts/run_bench_parallel.py --suite sample --label after-c-parallel --workers 10
    python scripts/run_bench_parallel.py --suite naturallang --workers 12
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scripts" / "bench_out"
DEFAULT_BASE = "https://cp.tech2.hybe.im/proj-k/agentsdk/api"

_save_lock = threading.Lock()


def stream_query(base_url: str, question: str, compare_mode: bool, timeout_s: int = 300) -> dict:
    body = json.dumps({"question": question, "compare_mode": compare_mode}).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/ask_stream",
        data=body, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
    )
    answer = ""
    api_seconds = None
    cost_usd = None
    tool_calls = 0
    tool_trace: list[dict] = []
    qa_warnings: list[str] = []
    follow_ups: list[str] = []
    error: str | None = None
    events_count = 0
    ttft_token_s: float | None = None       # streaming: first 'token' event
    ttft_writing_s: float | None = None     # 'stage:writing' 이벤트 (token 미지원 fallback)
    token_count = 0

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            for line in io.TextIOWrapper(r, encoding="utf-8", newline=""):
                line = line.strip()
                if not line:
                    continue
                events_count += 1
                try:
                    evt = json.loads(line)
                except Exception:
                    continue
                t = evt.get("type", "")
                if t == "tool_start":
                    tool_calls += 1
                    tool_trace.append({"tool": evt.get("tool"), "input_keys": list((evt.get("input") or {}).keys())})
                elif t == "token":
                    token_count += 1
                    if ttft_token_s is None:
                        ttft_token_s = round(time.time() - t0, 3)
                elif t == "stage" and evt.get("stage") == "writing":
                    if ttft_writing_s is None:
                        ttft_writing_s = round(time.time() - t0, 3)
                elif t == "result":
                    d = evt.get("data", {})
                    answer = d.get("answer", "")
                    api_seconds = d.get("api_seconds")
                    cost_usd = d.get("cost_usd")
                    qa_warnings = d.get("qa_warnings", [])
                    follow_ups = d.get("follow_ups", [])
                elif t == "error":
                    error = evt.get("message", "")
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    return {
        "answer": answer, "answer_len": len(answer),
        "total_s": round(time.time() - t0, 3),
        "ttft_token_s": ttft_token_s,
        "ttft_writing_s": ttft_writing_s,
        "token_count": token_count,
        "api_seconds_server": api_seconds,
        "cost_usd": cost_usd, "tool_calls": tool_calls,
        "tool_trace": tool_trace, "events_count": events_count,
        "qa_warnings": qa_warnings, "follow_ups": follow_ups,
        "error": error,
    }


def expected_pass(question: dict, answer: str) -> bool | None:
    must = ((question.get("expected") or {}).get("must_contain") or [])
    if not must:
        return None
    return all(m in answer for m in must)


def run_one(idx: int, q: dict, base_url: str) -> dict:
    print(f"  [start  {idx:>3}] {q['category']:<22} {q['question'][:55]}", flush=True)
    r = stream_query(base_url, q["question"], q.get("compare_mode", False))
    passed = expected_pass(q, r["answer"])
    p_ind = "✓" if passed else ("✗" if passed is False else "·")
    err = " ⚠" if r.get("error") else ""
    print(f"  [done   {idx:>3}] {p_ind} {r['total_s']:>5.1f}s tools={r['tool_calls']:>2} ans={r['answer_len']:>4}자{err}  {q['question'][:50]}", flush=True)
    return {
        "id": q["id"], "category": q["category"],
        "question": q["question"], "expected": q.get("expected", {}),
        "passed": passed, "result": r, "source": q.get("source", ""),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", default="sample")
    ap.add_argument("--label", required=True)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--only", default=None)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    suite_p = OUT_DIR / f"benchmark_{args.suite}.json"
    if not suite_p.exists():
        print(f"[err] no suite: {suite_p}")
        return 1
    suite = json.loads(suite_p.read_text(encoding="utf-8"))
    questions = suite["questions"]
    if args.only:
        questions = [q for q in questions if args.only in q["category"]]
    if args.limit:
        questions = questions[:args.limit]
    n = len(questions)
    print(f"[run] suite={args.suite} label={args.label}  →  {n} questions, workers={args.workers}")
    print(f"[run] base_url = {args.base_url}\n")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_p = OUT_DIR / f"run_{args.suite}_{args.label}_{ts}.json"

    results: list[dict] = []
    sum_time = sum_cost = 0.0
    sum_tools = 0
    pass_count = pass_eligible = 0
    completed = 0
    wall_t0 = time.time()

    def save():
        with _save_lock:
            wall = time.time() - wall_t0
            out_p.write_text(json.dumps({
                "suite": args.suite, "label": args.label, "base_url": args.base_url,
                "ts": ts, "workers": args.workers,
                "in_progress": completed < n, "completed": completed, "total": n,
                "wall_seconds": round(wall, 1),
                "running_stats": {
                    "avg_total_s": round(sum_time / max(completed, 1), 2),
                    "sum_cost_usd": round(sum_cost, 3),
                    "sum_tool_calls": sum_tools,
                    "pass_rate_so_far": (round(pass_count / pass_eligible * 100, 1) if pass_eligible else None),
                    "speedup_vs_sequential_est": round(sum_time / max(wall, 0.1), 2),
                },
                "results": results,
            }, ensure_ascii=False, indent=2), encoding="utf-8")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(run_one, i + 1, q, args.base_url): i for i, q in enumerate(questions)}
        for fut in as_completed(futures):
            try:
                rec = fut.result()
            except Exception as e:
                print(f"  [exc] {e}")
                continue
            results.append(rec)
            sum_time += rec["result"]["total_s"]
            sum_cost += (rec["result"]["cost_usd"] or 0)
            sum_tools += rec["result"]["tool_calls"]
            if rec["passed"] is True:
                pass_count += 1
                pass_eligible += 1
            elif rec["passed"] is False:
                pass_eligible += 1
            completed += 1
            save()

    wall = time.time() - wall_t0
    print()
    print(f"=== 완료 ===")
    print(f"  파일:        {out_p.relative_to(ROOT)}")
    print(f"  wall time:   {wall:.1f}s ({n} questions, {args.workers} workers)")
    print(f"  sum CPU time: {sum_time:.1f}s  → speedup ≈ {sum_time/max(wall,0.1):.1f}x")
    print(f"  평균 시간:   {sum_time/max(n,1):.2f}s")
    print(f"  총 비용:     ${sum_cost:.3f}")
    print(f"  pass:        {pass_count}/{pass_eligible} ({round(pass_count/pass_eligible*100,1) if pass_eligible else 'n/a'}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
