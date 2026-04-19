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
    model: str | None = None        # "opus" | "sonnet" | "haiku" | 전체 ID
    role: str | None = None         # qna-poc 호환 — 미사용
    prompt_style: str | None = None # qna-poc 호환 — 미사용
    prompt_overrides: dict | None = None  # qna-poc 호환 — 미사용


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


def _read_label(file_path: str) -> str:
    """파일 경로에서 사용자에게 보일 의미있는 라벨 생성.

    예:
      .../PK_HUD 시스템/HUD_전투/_final/content.md → "PK_HUD 시스템 / HUD_전투"
      .../시스템 디자인/NPC/content.md            → "시스템 디자인 / NPC"
      index/summaries/xlsx/7_System/PK_스탯 및 공식/공식.md → "PK_스탯 및 공식 / 공식"
      index/summaries/confluence/시스템 디자인/대미지 공식 개편.md → "시스템 디자인 / 대미지 공식 개편"
      foo.md → "foo.md"
    """
    if not file_path:
        return "(unknown)"
    parts = [p for p in file_path.split("/") if p]
    if not parts:
        return file_path
    base = parts[-1]

    # content.md → parent dir 조합
    if base == "content.md":
        meaningful = [p for p in parts[:-1] if p and p != "_final"]
        if len(meaningful) >= 2:
            return f"{meaningful[-2]} / {meaningful[-1]}"
        if meaningful:
            return meaningful[-1]
        return base

    # 일반 .md (summaries 등) → parent / basename
    stem = base[:-3] if base.lower().endswith(".md") else base
    meaningful = [p for p in parts[:-1] if p and p not in ("index", "summaries", "xlsx", "confluence")]
    # summaries 아래 '7_System', '8_Contents' 같은 카테고리는 유지한 뒤 그 다음 워크북까지 prefix
    if len(meaningful) >= 1:
        workbook = meaningful[-1]
        # 같은 이름일 경우 중복 방지
        if workbook == stem:
            return stem
        return f"{workbook} / {stem}"
    return stem


def _tool_label(tool: str, tool_input: dict, done: bool = False) -> str:
    """툴 호출 UI 라벨. done=True 면 '중' 제거하고 '완료' 표기."""
    emoji = TOOL_LABEL.get(tool, "🔧")
    verb_running = {"Grep": "검색 중", "Glob": "패턴 매칭 중", "Read": "읽는 중",
                    "mcp_projk": "조회 중"}
    verb_done = {"Grep": "검색", "Glob": "패턴 매칭", "Read": "읽음",
                 "mcp_projk": "조회"}
    if tool == "Grep":
        pat = (tool_input or {}).get("pattern", "")
        path = (tool_input or {}).get("path", "")
        v = verb_done["Grep"] if done else verb_running["Grep"]
        return f"{emoji} `{pat}` {v} ({path})"
    if tool == "Glob":
        pat = (tool_input or {}).get("pattern", "")
        v = verb_done["Glob"] if done else verb_running["Glob"]
        return f"{emoji} {v}: `{pat}`"
    if tool == "Read":
        label = _read_label((tool_input or {}).get("file_path", ""))
        v = verb_done["Read"] if done else verb_running["Read"]
        return f"{emoji} {label} {v}"
    if tool.startswith("mcp__projk__"):
        name = tool.removeprefix("mcp__projk__")
        v = verb_done["mcp_projk"] if done else verb_running["mcp_projk"]
        return f"{emoji} 시스템 관계 {v} ({name})"
    return f"{emoji} {tool}"


def _tool_status_msg(tool: str, tool_input: dict) -> str:
    """기존 호환 — 진행중 라벨."""
    return _tool_label(tool, tool_input, done=False)


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
        tool_trace: list[dict] = []     # 저장용 (input 포함)
        tool_id_map: dict[str, int] = {}   # SDK tool_use id → trace idx
        writing_announced = False         # "답변 작성 중..." 이벤트를 이 라운드에서 내보냈는가
        cost = None
        nonlocal_sdk_sid = sdk_sid

        yield json.dumps(
            {"type": "status", "message": "🧠 질문을 분석하고 있습니다..."},
            ensure_ascii=False,
        ) + "\n"
        yield json.dumps(
            {"type": "stage", "stage": "planning", "label": "질문 분석"},
            ensure_ascii=False,
        ) + "\n"

        try:
            async for msg in run_query_with_session(question, session_id=nonlocal_sdk_sid, model=req.model):
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
                            text = (block.thinking or "").strip()
                            if text:
                                yield json.dumps(
                                    {"type": "thinking", "text": text},
                                    ensure_ascii=False,
                                ) + "\n"
                                yield json.dumps(
                                    {"type": "status", "message": f"💭 {text.replace(chr(10), ' ')[:100]}..."},
                                    ensure_ascii=False,
                                ) + "\n"
                        elif isinstance(block, TextBlock):
                            if block.text.strip():
                                # 새 라운드의 TextBlock 시작 — writing stage 알림 (이모지 shimmer 유지)
                                if not writing_announced:
                                    yield json.dumps(
                                        {"type": "stage", "stage": "writing", "label": "답변 작성"},
                                        ensure_ascii=False,
                                    ) + "\n"
                                    yield json.dumps(
                                        {"type": "status", "message": "✨ 답변을 작성하고 있습니다..."},
                                        ensure_ascii=False,
                                    ) + "\n"
                                    writing_announced = True
                                answer_text_parts.append(block.text)
                                # 누적 글자 수 주기적으로 알림 (200자 단위)
                                total_chars = sum(len(s) for s in answer_text_parts)
                                if total_chars // 200 > (total_chars - len(block.text)) // 200:
                                    yield json.dumps(
                                        {"type": "status", "message": f"✨ 답변 작성 중... ({total_chars:,}자)"},
                                        ensure_ascii=False,
                                    ) + "\n"
                        elif isinstance(block, ToolUseBlock):
                            # 툴 호출이 재개되면 다음 텍스트 블록이 올 때 다시 writing stage 알림
                            writing_announced = False
                            inp = block.input if isinstance(block.input, dict) else {}
                            idx = len(tool_trace)
                            tool_trace.append({"tool": block.name, "input": inp, "id": block.id})
                            tool_id_map[block.id] = idx
                            yield json.dumps(
                                {
                                    "type": "tool_start",
                                    "id": block.id,
                                    "tool": block.name,
                                    "input": inp,
                                    "label": _tool_status_msg(block.name, inp),
                                },
                                ensure_ascii=False,
                            ) + "\n"
                            yield json.dumps(
                                {"type": "status", "message": _tool_status_msg(block.name, inp)},
                                ensure_ascii=False,
                            ) + "\n"

                elif isinstance(msg, UserMessage):
                    # Tool results — 해당 tool_start 에 summary + done_label + preview 동반
                    if hasattr(msg, "content") and isinstance(msg.content, list):
                        for block in msg.content:
                            if isinstance(block, ToolResultBlock):
                                tool_id = getattr(block, "tool_use_id", None) or getattr(block, "id", None)
                                c = ""
                                if isinstance(block.content, str):
                                    c = block.content
                                elif isinstance(block.content, list):
                                    for x in block.content:
                                        if hasattr(x, "text"):
                                            c += x.text
                                        elif isinstance(x, dict) and "text" in x:
                                            c += x["text"]
                                summary = _summarize_tool_result(c)
                                # 해당 tool 의 input 을 찾아 done label 생성
                                done_label = ""
                                for t in tool_trace:
                                    if t.get("id") == tool_id:
                                        done_label = _tool_label(t["tool"], t.get("input", {}), done=True)
                                        break
                                # 전체 결과 일부 (UI 상세 펼치기용, 8KB 제한)
                                preview = c[:8000] + ("\n…(더 있음)" if len(c) > 8000 else "")
                                yield json.dumps(
                                    {"type": "tool_end", "id": tool_id,
                                     "summary": summary, "label": done_label, "preview": preview},
                                    ensure_ascii=False,
                                ) + "\n"

                elif isinstance(msg, ResultMessage):
                    cost = getattr(msg, "total_cost_usd", None)

            # 최종 결과 조립
            answer_raw = "".join(answer_text_parts).strip()
            answer_stripped = storage.strip_progress_prefix(answer_raw)
            # sources 추출은 반드시 내부 경로가 살아있는 원문 기준으로 먼저
            # (rewrite 이후 경로가 origin_label 로 바뀌면 _path_to_source_meta 가
            #  분류에 실패해 source='other', path=label 이 되어 source_view 403 유발)
            sources = storage.extract_sources(answer_stripped)
            # 1차: (출처: <path>) 패턴 치환 → 사용자 표시용
            answer_rewritten = storage.rewrite_source_paths(answer_stripped)
            # 2차: 본문 전체에서 내부 경로/인덱스 경로 sanitize
            answer, path_findings = storage.sanitize_internal_paths(answer_rewritten)

            qa_warnings: list[str] = []

            # 🚨 Confluence 누락 검증
            has_confluence_source = any(s.get("source") == "confluence" for s in sources)
            explored_confluence = any(
                "confluence" in json.dumps(t.get("input", {}), ensure_ascii=False).lower()
                for t in tool_trace
            )
            if not explored_confluence:
                log.warning(f"[warn] conv={conv_id[:8]} Confluence 미탐색")
                qa_warnings.append("Confluence 미탐색")
            elif not has_confluence_source:
                log.warning(f"[warn] conv={conv_id[:8]} Confluence 탐색했으나 인용 없음")
                qa_warnings.append("Confluence 탐색했으나 인용 없음")

            # 🚨 내부 경로 누출 검증 — sanitize 가 치환 수행했으면 findings 있음
            if path_findings:
                log.warning(f"[warn] conv={conv_id[:8]} 내부 경로 {len(path_findings)}건 치환됨")
                qa_warnings.append(f"내부 경로 노출 {len(path_findings)}건 (자동 치환됨)")
            # 최종 잔여 검증 — 남아있으면 치명적
            if "packages/xlsx-extractor" in answer or "packages/confluence-downloader" in answer:
                log.error(f"[err] conv={conv_id[:8]} 치환 후에도 내부 경로 잔여!")
                qa_warnings.append("⚠ 치환 실패 (잔여 내부 경로)")
            elapsed_s = round(time.time() - start, 2)

            # 저장 — tool_trace 에 input 포함 (admin/shared 에서 실제 탐색 경로 확인 가능)
            storage.save_turn(
                conv_id,
                question,
                answer=answer,
                sources=sources,
                tool_trace=[{"tool": t["tool"], "input": t.get("input", {})} for t in tool_trace],
                elapsed_s=elapsed_s,
                cost_usd=cost,
                sdk_session_id=nonlocal_sdk_sid,
            )

            payload = {
                "answer": answer,
                "confidence": "high" if sources else "medium",
                "sources": sources[:20],
                "conversation_id": conv_id,
                "total_tokens": 0,
                "api_seconds": elapsed_s,
                "cost_usd": cost,
                "tool_calls": len(tool_trace),
                "tool_trace": [{"tool": t["tool"], "input": t.get("input", {})} for t in tool_trace],
                "qa_warnings": qa_warnings,
            }
            yield json.dumps({"type": "result", "data": payload}, ensure_ascii=False) + "\n"
            log_event(conv_id, "done", f"{elapsed_s}s cost=${cost} tools={len(tool_trace)}")

        except Exception as e:
            log.exception("ask_stream failed")
            yield json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False) + "\n"

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


def _summarize_tool_result(text: str) -> str:
    """Tool result 한 줄 요약 (UI collapsible 카드의 summary용)."""
    if not text:
        return ""
    t = text.strip()
    first = t.split("\n", 1)[0].strip()
    # Grep "Found N file(s)" 첫 줄
    if first.startswith("Found ") and "file" in first:
        return first
    # Read 결과: 길이 / 라인 수 안내
    line_count = t.count("\n") + 1
    # 너무 길면 라인수만
    if len(t) > 200:
        return f"{line_count} 라인 ({len(t):,} 자)"
    return first[:160] + ("…" if len(first) > 160 else "")


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


@app.get("/source_view")
async def source_view(path: str, section: str = ""):
    """출처 카드 클릭 시 해당 content.md 본문 반환.
    `path` 는 Agent 가 인용한 내부 경로(상대) 또는 절대 경로.
    응답: {path, section, content, origin_label, origin_url, section_range}
    """
    from pathlib import Path as _P
    agent_dir = _P(__file__).resolve().parent.parent          # agent-sdk-poc/
    repo_root = agent_dir.parent.parent                        # repo root (proj-k-agent on server)
    normalized = path.lstrip("/").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="invalid path")

    # Agent 가 인용한 '../xlsx-extractor/...' / '../confluence-downloader/...' →
    # repo_root 기준 'packages/…' 로 정규화
    if normalized.startswith("../xlsx-extractor/"):
        normalized = "packages/" + normalized[3:]
    elif normalized.startswith("../confluence-downloader/"):
        normalized = "packages/" + normalized[3:]

    # 라벨 형식(`Confluence / ...`, `PK_xxx.xlsx / 시트`) 도 수용:
    # 프론트의 인라인 출처 링크는 sources 매칭 실패 시 라벨을 그대로 보낸다.
    # _path_to_source_meta 가 라벨→내부 경로를 복원하므로 활용.
    if not normalized.startswith(("packages/", "index/")):
        resolved = storage._path_to_source_meta(normalized).get("path", "")
        if resolved and resolved.startswith(("packages/", "index/")):
            normalized = resolved

    # 기준 디렉터리 선택: index/summaries/ 는 agent-sdk-poc 하위, 나머지는 repo_root.
    allowed_under_repo = ("packages/xlsx-extractor/output/", "packages/confluence-downloader/output/")
    allowed_under_agent = ("index/summaries/",)
    if normalized.startswith(allowed_under_repo):
        base = repo_root
    elif normalized.startswith(allowed_under_agent):
        base = agent_dir
    else:
        raise HTTPException(status_code=403, detail="path not allowed")

    candidate = (base / normalized).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=403, detail="path escapes base")

    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="file not found")

    content = candidate.read_text(encoding="utf-8", errors="replace")

    # 섹션 위치 (Markdown heading 매칭 — 정규화 후 비교)
    def _norm_heading(s: str) -> str:
        # 백슬래시 이스케이프 제거, 공백·구두점 관대하게 비교
        import re as _re
        s = s.replace("\\[", "[").replace("\\]", "]").replace("\\(", "(").replace("\\)", ")").replace("\\.", ".")
        s = _re.sub(r"\s+", " ", s).strip()
        return s

    def _heading_level(line: str) -> int:
        m = 0
        for ch in line:
            if ch == "#": m += 1
            else: break
        return m

    section_range = None
    if section:
        target = _norm_heading(section)
        target_low = target.lower()
        lines = content.splitlines()
        start = -1
        start_level = 99
        for i, line in enumerate(lines):
            s = line.strip()
            if not s.startswith("#"):
                continue
            lvl = _heading_level(s)
            hd = _norm_heading(s.lstrip("#"))
            hd_low = hd.lower()
            if start < 0:
                if hd_low == target_low or target_low in hd_low or hd_low in target_low:
                    start = i
                    start_level = lvl
            else:
                # 동급/상위 헤딩을 만나면 구간 종료
                if lvl <= start_level:
                    section_range = {"start_line": start + 1, "end_line": i}
                    break
        if start >= 0 and section_range is None:
            section_range = {"start_line": start + 1, "end_line": len(lines)}

    meta = storage._path_to_source_meta(normalized)
    return {
        "path": normalized,
        "section": section,
        "content": content,
        "section_range": section_range,
        "origin_label": meta.get("origin_label"),
        "origin_url": meta.get("origin_url"),
        "source": meta.get("source"),
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
