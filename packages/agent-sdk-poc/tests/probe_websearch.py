"""
probe_websearch.py — Bedrock 환경에서 WebSearch/WebFetch 가 실제 호출 가능한지 확인.
====================================================================================
test_compare_mode.py 가 timeout 으로 죽어서 어느 단계에서 막히는지 모름.
이 스크립트는 모든 메시지·툴 호출을 실시간 stdout 으로 흘려보낸다.

사용법: .venv/bin/python tests/probe_websearch.py
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
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

from agent import run_query  # noqa: E402


async def main() -> int:
    # 매우 짧고 명확한 web 요청 — Excel/Confluence 쪽으로 새지 않게 PK 언급 X
    prompt = (
        "WebSearch 도구로 '검은사막 길드 시스템' 한 번 검색하고, "
        "결과 페이지 1개 제목만 한 줄로 답해라. "
        "다른 도구는 쓰지 마라. 답변은 두 문장 이내."
    )
    print(f"[{time.strftime('%H:%M:%S')}] start probe — compare_mode=True, prompt:\n  {prompt}\n")

    start = time.time()
    text_chunks: list[str] = []
    tool_calls: list[dict] = []

    async for msg in run_query(prompt, compare_mode=True):
        elapsed = time.time() - start
        if isinstance(msg, SystemMessage):
            sub = getattr(msg, "subtype", "")
            print(f"[{elapsed:6.1f}s] SystemMessage subtype={sub}")
        elif isinstance(msg, AssistantMessage):
            for b in msg.content:
                if isinstance(b, ThinkingBlock):
                    txt = (b.thinking or "")[:160].replace("\n", " ")
                    print(f"[{elapsed:6.1f}s] THINK: {txt}")
                elif isinstance(b, ToolUseBlock):
                    inp = b.input if isinstance(b.input, dict) else {}
                    inp_short = ", ".join(f"{k}={str(v)[:60]!r}" for k, v in inp.items())
                    print(f"[{elapsed:6.1f}s] TOOL_USE: {b.name}({inp_short})")
                    tool_calls.append({"tool": b.name, "input": inp})
                elif isinstance(b, TextBlock):
                    txt = b.text
                    if txt.strip():
                        print(f"[{elapsed:6.1f}s] TEXT: {txt[:240].rstrip()}")
                        text_chunks.append(txt)
        elif isinstance(msg, UserMessage):
            if hasattr(msg, "content") and isinstance(msg.content, list):
                for b in msg.content:
                    if isinstance(b, ToolResultBlock):
                        c = ""
                        if isinstance(b.content, str):
                            c = b.content
                        elif isinstance(b.content, list):
                            for x in b.content:
                                if hasattr(x, "text"):
                                    c += x.text
                                elif isinstance(x, dict) and "text" in x:
                                    c += x["text"]
                        is_err = getattr(b, "is_error", False)
                        marker = "❌ ERROR" if is_err else "✅ OK"
                        print(f"[{elapsed:6.1f}s] TOOL_RESULT {marker} ({len(c)} chars): {c[:200].replace(chr(10),' ')}")
        elif isinstance(msg, ResultMessage):
            cost = getattr(msg, "total_cost_usd", None)
            print(f"[{elapsed:6.1f}s] RESULT total_cost_usd={cost}")

    print()
    print(f"=== summary ===")
    print(f"  elapsed: {time.time()-start:.1f}s")
    print(f"  tool calls: {len(tool_calls)}")
    for t in tool_calls:
        print(f"    - {t['tool']}: {t['input']}")
    print(f"  final answer:\n    {''.join(text_chunks)[:500]}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
