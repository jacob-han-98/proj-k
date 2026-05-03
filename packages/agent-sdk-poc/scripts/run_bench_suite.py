"""
벤치 suite runner — benchmark_sample.json / benchmark_full.json 의 모든 질문을
/ask_stream 으로 실행하고 timing 을 기록.

핵심 원칙 (CLAUDE.md "실시간 결과 가시성"):
- 매 질문 처리 즉시 결과 파일에 append (사용자가 진행 중에 열어볼 수 있게)
- 콘솔에도 1줄 진행 상황 print
- 누적 통계 (PASS 추정 / 평균 시간 / 비용) 실시간 업데이트

Usage:
    python scripts/run_bench_suite.py --suite sample --label baseline-no-index
    python scripts/run_bench_suite.py --suite full   --label after-datasheet-index
    python scripts/run_bench_suite.py --suite sample --only kv-shortform
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scripts" / "bench_out"
DEFAULT_BASE = "https://cp.tech2.hybe.im/proj-k/agentsdk/api"


def stream_query(base_url: str, question: str, compare_mode: bool, timeout_s: int = 300) -> dict:
    """단일 질문 실행 → timing + 결과 dict.

    각 NDJSON 이벤트의 t_abs (s, request 기준) 와 type 만 보존.
    raw 답변 본문은 result 이벤트에서 추출.
    """
    body = json.dumps({"question": question, "compare_mode": compare_mode}).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/ask_stream",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
    )

    events: list[dict] = []
    answer = ""
    api_seconds = None
    cost_usd = None
    tool_calls = 0
    tool_trace: list[dict] = []
    qa_warnings: list[str] = []
    error: str | None = None

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            reader = io.TextIOWrapper(r, encoding="utf-8", newline="")
            for line in reader:
                line = line.strip()
                if not line:
                    continue
                t_abs = round(time.time() - t0, 3)
                try:
                    evt = json.loads(line)
                except Exception:
                    continue
                etype = evt.get("type", "?")
                # 필수 필드만 timeline 에 보존
                events.append({"t": t_abs, "type": etype})
                if etype == "tool_start":
                    tool_calls += 1
                    tool_trace.append({"tool": evt.get("tool"), "input_keys": list((evt.get("input") or {}).keys())})
                elif etype == "result":
                    d = evt.get("data", {})
                    answer = d.get("answer", "")
                    api_seconds = d.get("api_seconds")
                    cost_usd = d.get("cost_usd")
                    qa_warnings = d.get("qa_warnings", [])
                elif etype == "error":
                    error = evt.get("message", "")
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    total = round(time.time() - t0, 3)
    return {
        "answer": answer,
        "answer_len": len(answer),
        "total_s": total,
        "api_seconds_server": api_seconds,
        "cost_usd": cost_usd,
        "tool_calls": tool_calls,
        "tool_trace": tool_trace,
        "events_count": len(events),
        "events_summary": _events_summary(events),
        "qa_warnings": qa_warnings,
        "error": error,
    }


def _events_summary(events: list[dict]) -> dict:
    """이벤트에서 핵심 인터벌 추출."""
    def first_t(matcher):
        for e in events:
            if matcher(e):
                return e["t"]
        return None
    return {
        "t_first_event": events[0]["t"] if events else None,
        "t_first_tool_start": first_t(lambda e: e["type"] == "tool_start"),
        "t_first_writing": first_t(lambda e: e["type"] == "stage" and False),  # noop, will fix
        # 'stage' 이벤트만으로 writing/planning 구분이 어려우니 type='result' 까지 시간 표기
        "t_result": first_t(lambda e: e["type"] == "result"),
    }


def expected_pass(question: dict, answer: str) -> bool | None:
    """expected.must_contain 의 모든 항목이 answer 에 들어있나? (자동 채점 시드)"""
    must = ((question.get("expected") or {}).get("must_contain") or [])
    if not must:
        return None
    return all(m in answer for m in must)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", choices=["sample", "full"], default="sample")
    ap.add_argument("--label", required=True, help="결과 파일 식별 라벨 (e.g. baseline-no-index)")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--only", default=None, help="특정 카테고리만 (e.g. kv-shortform)")
    ap.add_argument("--limit", type=int, default=0, help="앞 N 개만 (디버그)")
    ap.add_argument("--start", type=int, default=0, help="N 번째부터 시작 (이어 돌리기)")
    args = ap.parse_args()

    suite_p = OUT_DIR / f"benchmark_{args.suite}.json"
    if not suite_p.exists():
        print(f"[err] suite 없음: {suite_p}. build_bench_suites.py 먼저 실행.")
        return 1
    suite = json.load(suite_p.open(encoding="utf-8"))
    questions = suite["questions"]
    if args.only:
        questions = [q for q in questions if q["category"].startswith(args.only) or q["category"] == args.only]
    if args.start:
        questions = questions[args.start:]
    if args.limit:
        questions = questions[:args.limit]

    print(f"[run] suite={args.suite} label={args.label}  →  {len(questions)} 질문")
    print(f"[run] base_url = {args.base_url}")
    print()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_p = OUT_DIR / f"run_{args.suite}_{args.label}_{ts}.json"

    results: list[dict] = []
    sum_time = 0.0
    sum_cost = 0.0
    sum_tools = 0
    pass_count = 0
    pass_eligible = 0

    for i, q in enumerate(questions, 1):
        print(f"  [{i:>3}/{len(questions)}] {q['category']:<22}  {q['question'][:60]}")
        sys.stdout.flush()
        r = stream_query(args.base_url, q["question"], q.get("compare_mode", False))
        passed = expected_pass(q, r["answer"])
        if passed is True:
            pass_count += 1
            pass_eligible += 1
        elif passed is False:
            pass_eligible += 1
        sum_time += r["total_s"]
        sum_cost += (r["cost_usd"] or 0)
        sum_tools += r["tool_calls"]

        rec = {
            "id": q["id"],
            "category": q["category"],
            "question": q["question"],
            "expected": q.get("expected", {}),
            "passed": passed,
            "result": r,
            "source": q.get("source", ""),
        }
        results.append(rec)

        # === 즉시 저장 (매 질문 후) ===
        out_p.write_text(json.dumps({
            "suite": args.suite,
            "label": args.label,
            "base_url": args.base_url,
            "ts": ts,
            "in_progress": i < len(questions),
            "completed": i,
            "total": len(questions),
            "running_stats": {
                "avg_total_s": round(sum_time / i, 2),
                "sum_cost_usd": round(sum_cost, 3),
                "sum_tool_calls": sum_tools,
                "pass_rate_so_far": (round(pass_count / pass_eligible * 100, 1) if pass_eligible else None),
            },
            "results": results,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        # 콘솔 1줄 요약
        pass_ind = "✓" if passed else ("✗" if passed is False else "·")
        err_ind = " ⚠" if r.get("error") else ""
        print(f"           {pass_ind} {r['total_s']:>5.1f}s  tools={r['tool_calls']:>2}  cost=${(r['cost_usd'] or 0):.3f}  ans={r['answer_len']}자{err_ind}")

    # 최종 통계
    print()
    print("=== 완료 ===")
    print(f"  파일: {out_p.relative_to(ROOT)}")
    print(f"  평균 시간: {sum_time / max(len(questions),1):.2f}s")
    print(f"  총 비용:   ${sum_cost:.3f}")
    print(f"  툴 호출 합: {sum_tools}")
    print(f"  pass: {pass_count}/{pass_eligible} ({round(pass_count/pass_eligible*100,1) if pass_eligible else 'n/a'}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
