"""
smoke.py — Agent SDK 파이프라인 엔드투엔드 스모크
====================================================
FastAPI 서버를 거치지 않고 agent.run_query() 를 직접 호출해
Agent가 어떤 tool을 호출하고 어떤 답변을 만드는지 콘솔에 실시간 덤프한다.

사용법:
    python tests/smoke.py "질문 텍스트"
    python tests/smoke.py --preset 1            # 사전 정의 질문 실행
    python tests/smoke.py --preset all          # 모두 실행
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                                   # agent-sdk-poc
sys.path.insert(0, str(ROOT / "src"))

from claude_agent_sdk import (  # noqa: E402
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    UserMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
)

from agent import run_query                           # noqa: E402


# ── 현재 스모크용 프리셋 (13개 요약 범위) ─────────────────────
PRESETS = [
    "HUD_전투 화면에 어떤 UI 요소들이 배치되어 있나요? 번호별로 알려주세요.",
    "변신 전환 쿨타임은 몇 초인가요? 출처를 명시해주세요.",
    "던전은 어떤 종류가 있나요?",
]


def _short(text: str, n: int = 140) -> str:
    s = text.strip().replace("\n", " ⏎ ")
    return (s[:n] + "…") if len(s) > n else s


async def run_one(prompt: str):
    t0 = time.time()
    tool_calls = []
    result_blocks = []
    final_text = []

    print(f"\n\033[1;34m▶ Q: {prompt}\033[0m")
    print("-" * 70)

    async for msg in run_query(prompt):
        if isinstance(msg, SystemMessage):
            subtype = getattr(msg, "subtype", "")
            print(f"\033[2m[system:{subtype}]\033[0m")
        elif isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, ThinkingBlock):
                    print(f"\033[2m💭 {_short(block.thinking, 180)}\033[0m")
                elif isinstance(block, TextBlock):
                    text = block.text
                    if text.strip():
                        final_text.append(text)
                        print(f"\033[37m{text}\033[0m")
                elif isinstance(block, ToolUseBlock):
                    inp = block.input if isinstance(block.input, dict) else {}
                    inp_s = json.dumps(inp, ensure_ascii=False)[:200]
                    print(f"\033[1;33m→ {block.name}\033[0m {inp_s}")
                    tool_calls.append({"tool": block.name, "input": inp})
        elif isinstance(msg, UserMessage):
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, ToolResultBlock):
                        c = ""
                        if isinstance(block.content, str):
                            c = block.content
                        elif isinstance(block.content, list):
                            for x in block.content:
                                if hasattr(x, "text"):
                                    c += x.text
                                elif isinstance(x, dict) and "text" in x:
                                    c += x["text"]
                        result_blocks.append(c)
                        print(f"\033[2m← {_short(c, 200)}\033[0m")
        elif isinstance(msg, ResultMessage):
            cost = getattr(msg, "total_cost_usd", None)
            duration_ms = getattr(msg, "total_duration_ms", None)
            print("-" * 70)
            print(
                f"\033[1;32m✓ done\033[0m  "
                f"elapsed={time.time()-t0:.1f}s  cost=${cost}  "
                f"tool_calls={len(tool_calls)}"
            )

    return {
        "prompt": prompt,
        "final_text": "\n".join(final_text).strip(),
        "tool_calls": tool_calls,
        "elapsed_s": round(time.time() - t0, 2),
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="자유 질문 텍스트")
    ap.add_argument("--preset", help="사전 정의 번호 (1-N) 또는 'all'")
    ap.add_argument("--save", help="결과 JSON 저장 경로")
    args = ap.parse_args()

    prompts: list[str] = []
    if args.preset:
        if args.preset == "all":
            prompts = PRESETS[:]
        else:
            try:
                idx = int(args.preset) - 1
                prompts = [PRESETS[idx]]
            except (ValueError, IndexError):
                ap.error(f"invalid preset: {args.preset}")
    elif args.prompt:
        prompts = [args.prompt]
    else:
        ap.error("질문 텍스트 또는 --preset 필요")

    results = []
    for p in prompts:
        results.append(await run_one(p))

    if args.save:
        Path(args.save).parent.mkdir(parents=True, exist_ok=True)
        Path(args.save).write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n저장: {args.save}")


if __name__ == "__main__":
    asyncio.run(main())
