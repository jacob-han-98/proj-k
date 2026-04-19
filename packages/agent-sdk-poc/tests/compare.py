"""
compare.py — qna-poc vs agent-sdk-poc 답변을 나란히 생성
==========================================================
69개 평가셋 자동 채점이 아닌 **pair comparison**. 정답 매칭 안 함.
기획자/사용자가 runbook.md에서 어느 쪽이 더 유용한지 수기 판정.

사용법:
    # 1개 질문, 양쪽 실행
    python tests/compare.py "던전은 어떤 종류가 있나요?"

    # useful_prompts.md 일부 질문만 실행
    python tests/compare.py --from-file tests/useful_prompts.md --limit 3

    # qna-poc URL 지정 (기본: 미호출, agent-sdk만)
    python tests/compare.py --qna-url http://localhost:8088/ask "질문"

결과: tests/compare_out/<timestamp>/<slug>.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

import httpx  # noqa: E402

from claude_agent_sdk import (  # noqa: E402
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    UserMessage,
    ToolResultBlock,
)
from agent import run_query                           # noqa: E402


def _slug(text: str, n: int = 40) -> str:
    s = re.sub(r"[^0-9A-Za-z가-힣]+", "_", text).strip("_")
    return s[:n] or "q"


async def run_agent_sdk(prompt: str) -> dict:
    t0 = time.time()
    answer_text: list[str] = []
    tool_calls: list[dict] = []
    async for msg in run_query(prompt):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    answer_text.append(block.text)
                elif isinstance(block, ToolUseBlock):
                    tool_calls.append({
                        "tool": block.name,
                        "input": block.input if isinstance(block.input, dict) else {},
                    })
        elif isinstance(msg, ResultMessage):
            cost = getattr(msg, "total_cost_usd", None)
            return {
                "answer": "\n".join(answer_text).strip(),
                "tool_calls": tool_calls,
                "cost_usd": cost,
                "elapsed_s": round(time.time() - t0, 2),
            }
    return {
        "answer": "\n".join(answer_text).strip(),
        "tool_calls": tool_calls,
        "cost_usd": None,
        "elapsed_s": round(time.time() - t0, 2),
    }


def run_qna_poc(prompt: str, url: str) -> dict:
    t0 = time.time()
    try:
        with httpx.Client(timeout=180.0) as client:
            r = client.post(url, json={"question": prompt})
        if r.status_code == 200:
            data = r.json()
            return {
                "answer": data.get("answer", ""),
                "sources": data.get("sources", []),
                "elapsed_s": round(time.time() - t0, 2),
                "raw": {k: v for k, v in data.items() if k not in ("answer", "sources")},
            }
        return {"error": f"HTTP {r.status_code}: {r.text[:500]}",
                "elapsed_s": round(time.time() - t0, 2)}
    except httpx.HTTPError as e:
        return {"error": str(e), "elapsed_s": round(time.time() - t0, 2)}


def parse_prompts_from_markdown(path: Path) -> list[str]:
    """useful_prompts.md 의 ### Q*-* 제목 아래 첫 문장을 프롬프트로 추출."""
    text = path.read_text(encoding="utf-8")
    prompts: list[str] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = re.match(r"^###\s+Q\d+(?:-\d+)?\.\s+(.+?)$", line)
        if m:
            prompts.append(m.group(1).strip())
        i += 1
    return prompts


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="단일 질문")
    ap.add_argument("--from-file", help="useful_prompts.md 경로")
    ap.add_argument("--limit", type=int, help="--from-file 과 함께, 앞에서 N개")
    ap.add_argument("--qna-url", help="qna-poc POST URL (미지정 시 호출 생략)")
    ap.add_argument("--out-dir", default=str(ROOT / "tests" / "compare_out"))
    args = ap.parse_args()

    prompts: list[str] = []
    if args.from_file:
        prompts = parse_prompts_from_markdown(Path(args.from_file))
        if args.limit:
            prompts = prompts[: args.limit]
    elif args.prompt:
        prompts = [args.prompt]
    else:
        ap.error("prompt 또는 --from-file 필요")

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir) / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[compare] {len(prompts)}개 질문 → {out_dir}")

    summary = []
    for i, prompt in enumerate(prompts, 1):
        print(f"\n[{i}/{len(prompts)}] {prompt[:80]}")
        agent_res = await run_agent_sdk(prompt)
        qna_res = run_qna_poc(prompt, args.qna_url) if args.qna_url else {"skipped": True}

        entry = {
            "prompt": prompt,
            "agent_sdk": agent_res,
            "qna_poc": qna_res,
        }
        dst = out_dir / f"{i:02d}_{_slug(prompt)}.json"
        dst.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")

        agent_preview = agent_res.get("answer", "")[:160].replace("\n", " ")
        qna_preview = (qna_res.get("answer", "") if "answer" in qna_res else str(qna_res))[:160].replace("\n", " ")
        print(f"  agent-sdk ({agent_res['elapsed_s']}s / {len(agent_res['tool_calls'])} tool calls):")
        print(f"    {agent_preview}…")
        if args.qna_url:
            print(f"  qna-poc ({qna_res.get('elapsed_s','?')}s):")
            print(f"    {qna_preview}…")

        summary.append({
            "i": i,
            "prompt": prompt,
            "file": dst.name,
            "agent_sdk_elapsed_s": agent_res["elapsed_s"],
            "agent_sdk_tool_calls": len(agent_res["tool_calls"]),
        })

    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n완료. 결과: {out_dir}")
    print("  각 JSON 을 열어 answer 필드를 확인하고 tests/runbook.md 에 판정을 남기세요.")


if __name__ == "__main__":
    asyncio.run(main())
