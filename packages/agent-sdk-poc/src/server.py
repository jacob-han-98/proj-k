"""
Agent SDK Server — Project K
==============================
FastAPI + SSE 스트리밍. Claude Agent SDK의 메시지 스트림을 SSE로 브라우저에 전달.

Usage:
    uvicorn src.server:app --host 0.0.0.0 --port 8090
"""

import json
import logging
import time
import uuid
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
from starlette.staticfiles import StaticFiles

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    UserMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
)

from agent import run_query_with_session

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("projk-agent-sdk")

app = FastAPI(title="Project K Agent SDK", version="0.1.0")

STATIC_DIR = Path(__file__).parent.parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# web session → SDK session mapping
sessions: dict[str, str] = {}

# debug log (최근 50개)
query_logs: list[dict] = []
MAX_LOGS = 50
active_queries: dict[str, dict] = {}


def log_event(sid: str, event_type: str, detail: str = ""):
    ts = datetime.now().isoformat(timespec="milliseconds")
    entry = {"ts": ts, "session": sid[:8], "event": event_type, "detail": detail[:200]}
    query_logs.append(entry)
    if len(query_logs) > MAX_LOGS:
        query_logs.pop(0)
    if sid in active_queries:
        active_queries[sid]["events"].append(entry)
        active_queries[sid]["status"] = event_type
        active_queries[sid]["last_event"] = ts
    log.info(f"[{sid[:8]}] {event_type}: {detail[:100]}")


def _sse(event_type: str, data: dict) -> dict:
    return {"event": event_type, "data": json.dumps(data, ensure_ascii=False, default=str)}


def _extract_tool_result_text(block) -> str:
    if hasattr(block, "content"):
        if isinstance(block.content, str):
            return block.content
        if isinstance(block.content, list):
            for c in block.content:
                if hasattr(c, "text"):
                    return c.text
                if isinstance(c, dict) and "text" in c:
                    return c["text"]
    return ""


class QueryRequest(BaseModel):
    prompt: str
    session_id: str | None = None


# ── Routes ────────────────────────────────────────────────────

@app.get("/")
async def index():
    html = STATIC_DIR / "index.html"
    if html.exists():
        return FileResponse(html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return {"status": "ok", "hint": "static/index.html not found"}


@app.get("/health")
async def health():
    return {"status": "ok", "date": date.today().isoformat(), "sessions": len(sessions)}


@app.get("/debug")
async def debug():
    active = []
    now = time.time()
    for sid, info in list(active_queries.items()):
        active.append({
            "session": sid[:8],
            "status": info["status"],
            "elapsed_s": round(now - info["start"], 1),
            "event_count": len(info["events"]),
            "last_event": info.get("last_event", ""),
        })
    return {
        "active_queries": active,
        "recent_logs": query_logs[-30:],
        "total_sessions": len(sessions),
    }


@app.post("/query")
async def query_endpoint(req: QueryRequest):
    web_sid = req.session_id or str(uuid.uuid4())
    sdk_sid = sessions.get(web_sid)

    async def event_generator():
        nonlocal sdk_sid

        yield _sse("session", {"session_id": web_sid})

        active_queries[web_sid] = {
            "start": time.time(),
            "status": "starting",
            "events": [],
            "last_event": "",
        }
        log_event(web_sid, "query_start", req.prompt[:100])

        try:
            msg_iter = run_query_with_session(req.prompt, session_id=sdk_sid)

            async for msg in msg_iter:

                if isinstance(msg, SystemMessage):
                    subtype = getattr(msg, "subtype", "")
                    if subtype == "init" and hasattr(msg, "data"):
                        new_sid = msg.data.get("session_id")
                        if new_sid:
                            sdk_sid = new_sid
                            sessions[web_sid] = new_sid
                    log_event(web_sid, f"system:{subtype}")
                    yield _sse("system", {"subtype": subtype})

                elif isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, ThinkingBlock):
                            log_event(web_sid, "thinking", block.thinking[:80])
                            yield _sse("thinking", {"text": block.thinking})
                        elif isinstance(block, TextBlock):
                            text = block.text.strip()
                            if text:
                                log_event(web_sid, "text", text[:80])
                                yield _sse("text", {"text": text})
                        elif isinstance(block, ToolUseBlock):
                            tool_input = block.input if isinstance(block.input, dict) else {}
                            log_event(
                                web_sid,
                                "tool_call",
                                f"{block.name}: {json.dumps(tool_input, ensure_ascii=False)[:120]}",
                            )
                            yield _sse("tool_call", {"tool": block.name, "input": tool_input})
                        elif isinstance(block, ToolResultBlock):
                            content_text = _extract_tool_result_text(block)
                            log_event(web_sid, "tool_result", content_text[:80])
                            yield _sse("tool_result", {"content": content_text[:3000]})

                elif isinstance(msg, UserMessage):
                    if hasattr(msg, "content") and isinstance(msg.content, list):
                        for block in msg.content:
                            if isinstance(block, ToolResultBlock):
                                content_text = _extract_tool_result_text(block)
                                if content_text:
                                    log_event(web_sid, "tool_result(user)", content_text[:80])
                                    yield _sse("tool_result", {"content": content_text[:3000]})

                elif isinstance(msg, ResultMessage):
                    cost = getattr(msg, "total_cost_usd", None)
                    duration = getattr(msg, "total_duration_ms", None)
                    elapsed = round(
                        time.time() - active_queries.get(web_sid, {}).get("start", time.time()), 1
                    )
                    log_event(web_sid, "done", f"cost=${cost}, elapsed={elapsed}s")
                    active_queries.pop(web_sid, None)
                    yield _sse("done", {
                        "status": "success",
                        "cost": cost,
                        "duration": duration,
                        "elapsed": elapsed,
                        "session_id": web_sid,
                    })

        except Exception as e:
            log_event(web_sid, "error", str(e)[:200])
            active_queries.pop(web_sid, None)
            yield _sse("error", {"message": str(e)})
            yield _sse("done", {"status": "error", "session_id": web_sid})

    return EventSourceResponse(event_generator())


if __name__ == "__main__":
    import uvicorn

    port = int(__import__("os").environ.get("PORT", "8090"))
    uvicorn.run(app, host="0.0.0.0", port=port)
