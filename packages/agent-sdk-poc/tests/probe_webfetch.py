"""WebFetch 만으로 namu.wiki 조회가 실제 가능한지 확인."""

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
    ToolUseBlock,
    ToolResultBlock,
)

from agent import run_query  # noqa: E402


async def main() -> int:
    prompt = (
        "WebFetch 도구로 https://namu.wiki/w/HIT2 페이지를 가져와서 "
        "'서버 시스템' 섹션의 핵심 메카닉 한 문장만 답해라. 다른 도구는 쓰지 마라."
    )
    print(f"[{time.strftime('%H:%M:%S')}] start — compare_mode=True\n  prompt: {prompt}\n")

    start = time.time()
    answer_chunks: list[str] = []

    async for msg in run_query(prompt, compare_mode=True):
        elapsed = time.time() - start
        if isinstance(msg, AssistantMessage):
            for b in msg.content:
                if isinstance(b, ToolUseBlock):
                    inp = b.input if isinstance(b.input, dict) else {}
                    inp_short = ", ".join(f"{k}={str(v)[:80]!r}" for k, v in inp.items())
                    print(f"[{elapsed:6.1f}s] TOOL_USE: {b.name}({inp_short})")
                elif isinstance(b, TextBlock) and b.text.strip():
                    print(f"[{elapsed:6.1f}s] TEXT: {b.text[:300].rstrip()}")
                    answer_chunks.append(b.text)
        elif isinstance(msg, UserMessage) and hasattr(msg, "content") and isinstance(msg.content, list):
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
                    print(f"[{elapsed:6.1f}s] TOOL_RESULT {marker} ({len(c)} chars): {c[:300].replace(chr(10),' ')}")
        elif isinstance(msg, ResultMessage):
            cost = getattr(msg, "total_cost_usd", None)
            print(f"[{elapsed:6.1f}s] RESULT cost=${cost}")

    print()
    print(f"=== summary ===")
    print(f"  elapsed: {time.time()-start:.1f}s")
    print(f"  final answer: {''.join(answer_chunks)[:500]}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
