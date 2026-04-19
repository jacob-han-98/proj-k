"""
Agent SDK Server — Project K
==============================
FastAPI + SSE 스트리밍. Claude Agent SDK의 메시지 스트림을 SSE로 브라우저에 전달.

Usage:
    uvicorn src.server:app --host 0.0.0.0 --port 8090
"""

import json
import logging
import sys
import time
import uuid
from datetime import date, datetime
from pathlib import Path

# Ensure sibling modules (agent, projk_tools) are importable whether loaded as
# `src.server:app` or `server:app`
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
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
import storage
from preset_prompts import PRESETS

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


class AskStreamRequest(BaseModel):
    """qna-poc 호환 /ask_stream 요청 — React 프론트엔드 공통."""
    question: str
    conversation_id: str | None = None
    # 아래 필드들은 qna-poc 호환용. agent-sdk 에서는 사용하지 않음.
    role: str | None = None
    model: str | None = None
    prompt_style: str | None = None
    prompt_overrides: dict | None = None


# web session (conversation_id) → SDK session id
sdk_session_by_conv: dict[str, str] = {}


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


# ── React 프론트엔드 호환 API (qna-poc 스키마) ────────────────

TOOL_LABEL = {
    "Grep": "🔎",
    "Glob": "📂",
    "Read": "📖",
    "mcp__projk__list_systems": "📋",
    "mcp__projk__find_related_systems": "🔗",
    "mcp__projk__glossary_lookup": "🔤",
}


def _tool_status_msg(tool: str, tool_input: dict) -> str:
    emoji = TOOL_LABEL.get(tool, "🔧")
    if tool == "Grep":
        pat = (tool_input or {}).get("pattern", "")
        path = (tool_input or {}).get("path", "")
        return f"{emoji} `{pat}` 검색 중 ({path})"
    if tool == "Glob":
        return f"{emoji} 패턴 매칭: `{(tool_input or {}).get('pattern', '')}`"
    if tool == "Read":
        fp = (tool_input or {}).get("file_path", "")
        base = fp.rsplit("/", 1)[-1] if fp else ""
        return f"{emoji} `{base}` 읽는 중"
    if tool.startswith("mcp__projk__"):
        return f"{emoji} 시스템 관계 조회 ({tool.removeprefix('mcp__projk__')})"
    return f"{emoji} {tool}"


@app.get("/preset_prompts")
async def preset_prompts():
    """프리셋 질문 리스트 (홈 화면에서 클릭 → 입력창 자동 채움)."""
    return {"presets": PRESETS}


@app.get("/prompts/defaults")
async def prompts_defaults_legacy():
    """qna-poc 호환 — 빈 응답. agent-sdk 는 CLAUDE.md 기반이라 커스터마이즈 X."""
    return {}


@app.post("/ask_stream")
async def ask_stream(req: AskStreamRequest):
    """qna-poc 호환 NDJSON 스트리밍. React 프론트엔드가 그대로 사용.

    이벤트 스키마:
        {"type": "status", "message": "..."}   # 중간 진행
        {"type": "result", "data": { ... }}    # 최종 결과 (qna-poc AskResponse 호환)
        {"type": "error",  "message": "..."}
    """
    conv_id = req.conversation_id or str(uuid.uuid4())
    sdk_sid = sdk_session_by_conv.get(conv_id)
    question = req.question

    async def event_gen():
        start = time.time()
        log_event(conv_id, "ask_stream", question[:100])

        answer_text_parts: list[str] = []
        tool_trace: list[dict] = []
        cost = None
        duration_ms = None
        nonlocal_sdk_sid = sdk_sid

        yield json.dumps(
            {"type": "status", "message": "🧠 질문을 분석하고 있습니다..."},
            ensure_ascii=False,
        ) + "\n"

        try:
            async for msg in run_query_with_session(question, session_id=nonlocal_sdk_sid):
                if isinstance(msg, SystemMessage):
                    subtype = getattr(msg, "subtype", "")
                    if subtype == "init" and hasattr(msg, "data"):
                        new_sid = msg.data.get("session_id")
                        if new_sid and not nonlocal_sdk_sid:
                            nonlocal_sdk_sid = new_sid
                            sdk_session_by_conv[conv_id] = new_sid
                    continue

                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, ThinkingBlock):
                            preview = (block.thinking or "").strip().replace("\n", " ")[:100]
                            if preview:
                                yield json.dumps(
                                    {"type": "status", "message": f"💭 {preview}..."},
                                    ensure_ascii=False,
                                ) + "\n"
                        elif isinstance(block, TextBlock):
                            if block.text.strip():
                                answer_text_parts.append(block.text)
                        elif isinstance(block, ToolUseBlock):
                            inp = block.input if isinstance(block.input, dict) else {}
                            tool_trace.append({"tool": block.name, "input": inp})
                            yield json.dumps(
                                {"type": "status", "message": _tool_status_msg(block.name, inp)},
                                ensure_ascii=False,
                            ) + "\n"

                elif isinstance(msg, ResultMessage):
                    cost = getattr(msg, "total_cost_usd", None)
                    duration_ms = getattr(msg, "total_duration_ms", None)

            # 최종 결과 조립
            answer = "".join(answer_text_parts).strip()
            sources = storage.extract_sources(answer)
            elapsed_s = round(time.time() - start, 2)

            # 저장
            storage.save_turn(
                conv_id,
                question,
                answer=answer,
                sources=sources,
                tool_trace=[{"tool": t["tool"]} for t in tool_trace],
                elapsed_s=elapsed_s,
                cost_usd=cost,
                sdk_session_id=nonlocal_sdk_sid,
            )

            payload = {
                "answer": answer,
                "confidence": "high" if sources else "medium",
                "sources": sources[:10],
                "conversation_id": conv_id,
                "total_tokens": 0,  # agent-sdk 는 ResultMessage 가 token 세부 제공 X
                "api_seconds": elapsed_s,
                "cost_usd": cost,
                "tool_calls": len(tool_trace),
            }
            yield json.dumps({"type": "result", "data": payload}, ensure_ascii=False) + "\n"
            log_event(conv_id, "done", f"{elapsed_s}s cost=${cost} tools={len(tool_trace)}")

        except Exception as e:
            log.exception("ask_stream failed")
            yield json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False) + "\n"

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


@app.get("/admin/conversations")
async def admin_conversations():
    items = storage.list_conversations()
    return {"conversations": items, "total": len(items)}


@app.get("/admin/conversations/{conv_id}")
async def admin_conversation_detail(conv_id: str):
    conv = storage.get_conversation(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.post("/conversations/{conv_id}/fork")
async def fork_conversation(conv_id: str):
    new = storage.fork_conversation(conv_id)
    if not new:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {
        "conversation_id": new["id"],
        "title": new["title"],
        "turn_count": len(new["turns"]),
    }


@app.get("/shared/{conv_id}")
async def shared_conversation(conv_id: str):
    """읽기 전용 공유 조회 — 모든 필드 반환."""
    conv = storage.get_conversation(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


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
