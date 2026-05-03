"""
/ask_stream 응답시간 분석 harness.

NDJSON 스트림을 한 줄씩 받아 각 이벤트의 (절대 ms, 직전 대비 delta, type, summary)
를 기록한다. 최적화 전 baseline 측정/분석 용도.

Usage:
    python scripts/bench_response_time.py                                # 기본 프리셋 1회
    python scripts/bench_response_time.py --preset "변신 시스템 정리"
    python scripts/bench_response_time.py --question "변신 등급은?"
    python scripts/bench_response_time.py --runs 3                       # cold/warm 비교
    python scripts/bench_response_time.py --base-url http://127.0.0.1:8090
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

# Windows cp949 콘솔에서도 emoji/한글이 죽지 않도록.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_BASE_URL = "https://cp.tech2.hybe.im/proj-k/agentsdk/api"
DEFAULT_PRESET = "변신 시스템 정리"
OUT_DIR = Path(__file__).resolve().parent / "bench_out"


def fetch_presets(base_url: str) -> list[dict]:
    with urllib.request.urlopen(f"{base_url}/preset_prompts", timeout=10) as r:
        return json.loads(r.read())["presets"]


def resolve_question(base_url: str, preset_label: str | None, raw_question: str | None) -> tuple[str, str, bool]:
    if raw_question:
        return ("(custom)", raw_question, False)
    presets = fetch_presets(base_url)
    label = preset_label or DEFAULT_PRESET
    for p in presets:
        if p["label"] == label:
            return (p["label"], p["prompt"], bool(p.get("compare_mode")))
    raise SystemExit(f"preset '{label}' 못 찾음. 사용 가능: {[p['label'] for p in presets][:5]}…")


def summarize_event(evt: dict) -> str:
    t = evt.get("type", "?")
    if t == "stage":
        return f"stage={evt.get('stage')} label={evt.get('label')}"
    if t == "status":
        return f"status: {evt.get('message', '')[:80]}"
    if t == "thinking":
        txt = (evt.get("text") or "").replace("\n", " ")
        return f"thinking ({len(evt.get('text', ''))} 자): {txt[:80]}"
    if t == "tool_start":
        return f"tool_start {evt.get('tool')} input={json.dumps(evt.get('input', {}), ensure_ascii=False)[:80]}"
    if t == "tool_end":
        return f"tool_end summary={evt.get('summary', '')[:60]}"
    if t == "result":
        d = evt.get("data", {})
        return (
            f"RESULT answer={len(d.get('answer', ''))}자 "
            f"tools={d.get('tool_calls')} elapsed={d.get('api_seconds')}s "
            f"cost=${d.get('cost_usd')}"
        )
    if t == "error":
        return f"ERROR {evt.get('message', '')[:120]}"
    return f"{t} {json.dumps({k: v for k, v in evt.items() if k != 'type'}, ensure_ascii=False)[:80]}"


def stream_query(base_url: str, question: str, compare_mode: bool, model: str | None = None) -> list[dict]:
    """POST /ask_stream → 각 NDJSON 라인의 timing 을 ms 단위로 기록."""
    payload = {
        "question": question,
        "compare_mode": compare_mode,
    }
    if model:
        payload["model"] = model

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/ask_stream",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/x-ndjson",
        },
    )

    timeline: list[dict] = []
    t0 = time.time()
    last_ts = t0
    line_count = 0

    print(f"[{datetime.now().isoformat(timespec='seconds')}] POST {base_url}/ask_stream")
    print(f"  question = {question[:80]}…" if len(question) > 80 else f"  question = {question}")
    print(f"  compare_mode = {compare_mode}")
    print()
    print(f"{'time(s)':>8} {'+ms':>7}  type")
    print("-" * 100)

    with urllib.request.urlopen(req, timeout=300) as r:
        # NDJSON: 한 줄당 하나의 JSON 객체
        # urllib 의 stream 은 일반적으로 chunked transfer 를 즉시 흘려준다
        reader = io.TextIOWrapper(r, encoding="utf-8", newline="")
        for raw_line in reader:
            line = raw_line.strip()
            if not line:
                continue
            now = time.time()
            t_abs = now - t0
            t_delta = now - last_ts
            last_ts = now
            line_count += 1

            try:
                evt = json.loads(line)
            except Exception:
                evt = {"type": "_parse_error", "raw": line[:200]}

            event_type = evt.get("type", "?")
            entry = {
                "n": line_count,
                "t_abs_s": round(t_abs, 3),
                "delta_ms": round(t_delta * 1000),
                "type": event_type,
                "summary": summarize_event(evt),
                "raw": evt,
            }
            timeline.append(entry)

            # 콘솔에는 raw 빼고 출력
            print(f"{entry['t_abs_s']:>8.3f} {entry['delta_ms']:>6}ms  {entry['summary']}")

    total = time.time() - t0
    print("-" * 100)
    print(f"DONE in {total:.2f}s  ({line_count} events)")
    return timeline


def analyze(timeline: list[dict]) -> dict:
    """주요 intervals 추출."""
    by_type: dict[str, list[dict]] = {}
    for e in timeline:
        by_type.setdefault(e["type"], []).append(e)

    def first_t(matcher) -> float | None:
        for e in timeline:
            if matcher(e):
                return e["t_abs_s"]
        return None

    t_first_event = timeline[0]["t_abs_s"] if timeline else None  # TTFB-ish (server's planning stage emit)
    t_first_thinking = first_t(lambda e: e["type"] == "thinking")
    t_first_tool_start = first_t(lambda e: e["type"] == "tool_start")
    t_first_tool_end = first_t(lambda e: e["type"] == "tool_end")
    t_first_writing_stage = first_t(
        lambda e: e["type"] == "stage" and e["raw"].get("stage") == "writing"
    )
    t_result = first_t(lambda e: e["type"] == "result")

    # 툴별 duration (tool_start id ↔ tool_end id 매칭)
    tool_durations: list[dict] = []
    starts_by_id: dict[str, dict] = {}
    for e in timeline:
        if e["type"] == "tool_start":
            tid = e["raw"].get("id")
            if tid:
                starts_by_id[tid] = e
        elif e["type"] == "tool_end":
            tid = e["raw"].get("id")
            s = starts_by_id.get(tid)
            if s:
                tool_durations.append({
                    "tool": s["raw"].get("tool"),
                    "input": s["raw"].get("input", {}),
                    "start_s": s["t_abs_s"],
                    "end_s": e["t_abs_s"],
                    "duration_ms": round((e["t_abs_s"] - s["t_abs_s"]) * 1000),
                })

    # round 단위 분석: tool_end → 다음 tool_start (또는 thinking) 사이 = "모델 reasoning + 새 tool 결정" 시간
    reasoning_gaps: list[dict] = []
    last_round_anchor: dict | None = None  # 마지막으로 본 tool_end 또는 result-precursor
    for e in timeline:
        if e["type"] == "tool_end":
            last_round_anchor = e
        elif e["type"] in ("tool_start", "thinking"):
            if last_round_anchor is not None:
                reasoning_gaps.append({
                    "after": last_round_anchor["summary"][:60],
                    "before": e["summary"][:60],
                    "gap_ms": round((e["t_abs_s"] - last_round_anchor["t_abs_s"]) * 1000),
                })
                last_round_anchor = None  # 같은 round 안에서 한 번만 카운트

    # event count 분포
    type_counts = {k: len(v) for k, v in by_type.items()}

    # result payload
    result_evt = by_type.get("result", [])
    api_seconds = None
    answer_len = None
    cost_usd = None
    if result_evt:
        d = result_evt[0]["raw"].get("data", {})
        api_seconds = d.get("api_seconds")
        answer_len = len(d.get("answer", ""))
        cost_usd = d.get("cost_usd")

    return {
        "total_s": timeline[-1]["t_abs_s"] if timeline else None,
        "server_reported_api_seconds": api_seconds,
        "answer_len": answer_len,
        "cost_usd": cost_usd,
        "intervals": {
            "t_first_event_s": t_first_event,
            "t_first_thinking_s": t_first_thinking,
            "t_first_tool_start_s": t_first_tool_start,
            "t_first_tool_end_s": t_first_tool_end,
            "t_first_writing_stage_s": t_first_writing_stage,
            "t_result_s": t_result,
            # 핵심 derived intervals
            "ttft_thinking_s": t_first_thinking,  # request → first model token (thinking)
            "ttft_text_s": t_first_writing_stage,  # request → answer body 시작
            "tool_phase_total_s": (
                round(t_first_writing_stage - t_first_tool_start, 3)
                if (t_first_writing_stage and t_first_tool_start)
                else None
            ),
            "writing_phase_s": (
                round(t_result - t_first_writing_stage, 3)
                if (t_result and t_first_writing_stage)
                else None
            ),
        },
        "type_counts": type_counts,
        "tool_count": len(tool_durations),
        "tool_durations": tool_durations,
        "reasoning_gaps_after_tool_end": reasoning_gaps,
        "tool_total_ms": sum(t["duration_ms"] for t in tool_durations),
    }


def render_summary(analysis: dict) -> str:
    out = io.StringIO()
    iv = analysis["intervals"]
    out.write("\n=== TIMING SUMMARY ===\n")
    out.write(f"total_s                       = {analysis['total_s']}\n")
    out.write(f"server_reported_api_seconds   = {analysis['server_reported_api_seconds']}\n")
    out.write(f"answer_len (chars)            = {analysis['answer_len']}\n")
    out.write(f"cost_usd                      = {analysis['cost_usd']}\n")
    out.write("\n--- key intervals (request 기준 절대 초) ---\n")
    for k, v in iv.items():
        out.write(f"  {k:<32} = {v}\n")
    out.write("\n--- event counts ---\n")
    for k, v in sorted(analysis["type_counts"].items(), key=lambda x: -x[1]):
        out.write(f"  {k:<14} {v}\n")
    out.write("\n--- tool durations (서버→클라 visible 기준, SDK turn 단위) ---\n")
    out.write(f"  tools fired = {analysis['tool_count']}, total tool wall = {analysis['tool_total_ms']} ms\n")
    for i, t in enumerate(analysis["tool_durations"], 1):
        inp = json.dumps(t["input"], ensure_ascii=False)[:80]
        out.write(f"  [{i:>2}] {t['tool']:<32} {t['duration_ms']:>5} ms  {inp}\n")
    out.write("\n--- reasoning gap (tool_end → 다음 tool_start/thinking) ---\n")
    out.write("    = SDK 가 한 라운드 결과를 받고 다음 행동 결정까지 걸린 시간\n")
    out.write("    = '모델 reasoning + API round-trip' 추정\n")
    for i, g in enumerate(analysis["reasoning_gaps_after_tool_end"], 1):
        out.write(f"  [{i:>2}] {g['gap_ms']:>5} ms   after: {g['after'][:50]}\n")
        out.write(f"        →  next: {g['before'][:50]}\n")
    return out.getvalue()


def save(timeline: list[dict], analysis: dict, label: str, run_idx: int) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_label = label.replace("/", "_").replace(" ", "_")[:40]
    p = OUT_DIR / f"{ts}_{safe_label}_run{run_idx}.json"
    p.write_text(
        json.dumps(
            {"label": label, "run_idx": run_idx, "timeline": timeline, "analysis": analysis},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--preset", default=None, help=f"프리셋 라벨 (default: '{DEFAULT_PRESET}')")
    ap.add_argument("--question", default=None, help="raw 질문 (preset 무시)")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--model", default=None, help="opus|sonnet|haiku")
    args = ap.parse_args()

    label, question, compare_mode = resolve_question(args.base_url, args.preset, args.question)
    print(f"\n=== preset/label: {label} ===")

    for i in range(1, args.runs + 1):
        print(f"\n##### RUN {i}/{args.runs} #####")
        timeline = stream_query(args.base_url, question, compare_mode, args.model)
        analysis = analyze(timeline)
        print(render_summary(analysis))
        out = save(timeline, analysis, label, i)
        print(f"saved: {out}")


if __name__ == "__main__":
    sys.exit(main() or 0)
