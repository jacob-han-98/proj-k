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
import followups as followups_mod
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
    compare_mode: bool = False      # 비교 모드 (타게임 Deep Research) opt-in
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
      index/summaries/xlsx/7_System/PK_스탯 및 공식/공식.md → "PK_스탯 및 공식 / 공식 (요약본)"
      index/summaries/confluence/시스템 디자인/대미지 공식 개편.md → "시스템 디자인 / 대미지 공식 개편 (요약본)"
      foo.md → "foo.md"
    """
    if not file_path:
        return "(unknown)"
    parts = [p for p in file_path.split("/") if p]
    if not parts:
        return file_path
    base = parts[-1]

    # Haiku 생성 요약본(`index/summaries/...`) 여부 — 라벨 뒤에 " (요약본)" 표시.
    is_summary = "index" in parts and "summaries" in parts
    suffix = " (요약본)" if is_summary else ""

    # content.md → parent dir 조합
    if base == "content.md":
        meaningful = [p for p in parts[:-1] if p and p != "_final"]
        if len(meaningful) >= 2:
            return f"{meaningful[-2]} / {meaningful[-1]}{suffix}"
        if meaningful:
            return f"{meaningful[-1]}{suffix}"
        return base

    # 일반 .md (summaries 등) → parent / basename
    stem = base[:-3] if base.lower().endswith(".md") else base
    meaningful = [p for p in parts[:-1] if p and p not in ("index", "summaries", "xlsx", "confluence")]
    # summaries 아래 '7_System', '8_Contents' 같은 카테고리는 유지한 뒤 그 다음 워크북까지 prefix
    if len(meaningful) >= 1:
        workbook = meaningful[-1]
        # 같은 이름일 경우 중복 방지
        if workbook == stem:
            return f"{stem}{suffix}"
        return f"{workbook} / {stem}{suffix}"
    return f"{stem}{suffix}"


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
        # 경로도 너무 길면 뒷부분만 남기기
        if len(path) > 60:
            parts = [p for p in path.split("/") if p]
            path = ".../" + "/".join(parts[-2:]) if len(parts) > 2 else path
        v = verb_done["Grep"] if done else verb_running["Grep"]
        return f"{emoji} `{pat}` {v} ({path})"
    if tool == "Glob":
        pat = (tool_input or {}).get("pattern", "")
        # 절대 경로를 패턴으로 쓴 케이스: 마지막 몇 세그먼트만 표시
        if len(pat) > 70:
            parts = [p for p in pat.split("/") if p]
            if len(parts) > 3:
                pat = ".../" + "/".join(parts[-3:])
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

        if req.compare_mode:
            yield json.dumps(
                {"type": "stage", "stage": "compare", "label": "타게임 비교 모드"},
                ensure_ascii=False,
            ) + "\n"
            yield json.dumps(
                {"type": "status", "message": "📚 타게임 비교 모드 — 리니지M/W, Lord Nine, Vampir 도 함께 조사합니다."},
                ensure_ascii=False,
            ) + "\n"

        yield json.dumps(
            {"type": "status", "message": "🧠 질문을 분석하고 있습니다..."},
            ensure_ascii=False,
        ) + "\n"
        yield json.dumps(
            {"type": "stage", "stage": "planning", "label": "질문 분석"},
            ensure_ascii=False,
        ) + "\n"

        try:
            async for msg in run_query_with_session(
                question,
                session_id=nonlocal_sdk_sid,
                model=req.model,
                compare_mode=req.compare_mode,
            ):
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

            # 후속 질문 3~5개 (Haiku). 실패해도 답변 본체에는 영향 없음.
            import asyncio as _asyncio
            try:
                follow_ups = await _asyncio.to_thread(followups_mod.generate, question, answer)
            except Exception as _fe:
                log.warning(f"followups 생성 실패: {_fe}")
                follow_ups = []

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
                qa_warnings=qa_warnings,
                follow_ups=follow_ups,
            )

            # confidence: external/ 출처는 점수에 포함 안 함 — PK 1차 출처만 카운트
            primary_sources = [s for s in sources if s.get("source") in ("xlsx", "confluence")]
            payload = {
                "answer": answer,
                "confidence": "high" if primary_sources else "medium",
                "sources": sources[:20],
                "conversation_id": conv_id,
                "total_tokens": 0,
                "api_seconds": elapsed_s,
                "cost_usd": cost,
                "tool_calls": len(tool_trace),
                "tool_trace": [{"tool": t["tool"], "input": t.get("input", {})} for t in tool_trace],
                "qa_warnings": qa_warnings,
                "follow_ups": follow_ups,
                "compare_mode": req.compare_mode,
            }
            yield json.dumps({"type": "result", "data": payload}, ensure_ascii=False) + "\n"
            log_event(conv_id, "done", f"{elapsed_s}s cost=${cost} tools={len(tool_trace)} follow_ups={len(follow_ups)}")

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
    raw_path = path.strip()

    # Agent 의 Read 툴은 절대 경로(/home/ubuntu/proj-k-agent/packages/…)를 그대로 넘긴다.
    # repo_root / agent_dir 하위면 상대 경로로 정규화해 whitelist 검사와 호환시킴.
    if raw_path.startswith("/"):
        try:
            ap = _P(raw_path)
            rel = None
            # agent_dir 을 먼저 시도. agent_dir 은 repo_root 의 하위라 repo_root 가 먼저면
            # index/summaries/... 경로가 'packages/agent-sdk-poc/index/...' 로 되어 whitelist 를 통과하지 못함.
            for base_try in (agent_dir, repo_root):
                try:
                    rel = ap.relative_to(base_try)
                    break
                except ValueError:
                    continue
            if rel is not None:
                raw_path = str(rel)
        except Exception:
            pass

    # DataSheet 식별 — 다음 모두 동일하게 처리:
    #   1) "game-data:<table>" prefix (storage 가 라벨 인코딩한 형태)
    #   2) "DataSheet / <table>" 라벨 직격
    #   3) "<file>.xlsx / <table>" 인데 _xlsx_workbook_to_category 매칭 실패
    #      (storage 가 datasheet 로 fallback)
    ds_table: str | None = None
    if raw_path.startswith("game-data:"):
        ds_table = raw_path[len("game-data:"):].strip()
    else:
        _meta_check = storage._path_to_source_meta(raw_path)
        if _meta_check.get("source") == "datasheet":
            _p = _meta_check.get("path", "") or ""
            if _p.startswith("game-data:"):
                ds_table = _p[len("game-data:"):].strip()

    if ds_table:
        try:
            from projk_tools import (
                _gd_ready,
                _load_game_data,
                _datasheet_citation,
            )
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"datasheet 모듈 로드 실패: {e}")
        ok, err = _gd_ready()
        if not ok:
            raise HTTPException(status_code=503, detail=err)
        mod = _load_game_data()
        spec = {"action": "query", "table": ds_table, "limit": 50}
        r = mod.execute_game_query(spec, mod.get_db_path())
        if r.error:
            raise HTTPException(status_code=404, detail=r.error)
        formatted = mod.format_game_data_result(r, max_display=50)
        citation = _datasheet_citation(ds_table)
        content = f"# DataSheet · `{ds_table}` (미리보기)\n\n"
        if citation:
            content += f"> **원본**: `{citation}` (P4 경로)\n\n"
        content += f"> 총 행 수: **{r.total_matched}**, 컬럼: **{len(r.columns)}**개, 쿼리 시간: {r.execution_ms:.0f}ms\n\n"
        content += "_답변에서 언급된 필터·정렬 조건과 다른 일반 미리보기입니다. 답변 본문의 표가 정답._\n\n"
        content += formatted
        return {
            "path": f"game-data:{ds_table}",
            "section": section,
            "content": content,
            "section_range": None,
            "origin_label": f"DataSheet / {ds_table}",
            "origin_url": "",
            "source": "datasheet",
        }

    normalized = raw_path.lstrip("/").strip()
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

    # Confluence ADF decision/task block 의 localId(UUID)가 raw 로 본문에 찍혀 나오는 케이스를
    # 사용자에게 노출하지 않도록 제거. 1~2개의 UUID 가 연달아 붙은 뒤 상태 토큰이 오는 패턴.
    import re as _re
    _UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    content = _re.sub(
        rf"(?:{_UUID}){{1,3}}(?:DECIDED|NOT_STARTED|IN_PROGRESS|DONE|TASK|ACTION_ITEM)",
        "",
        content,
    )

    # 섹션 위치 (Markdown heading 매칭 — 정규화 후 비교)
    def _norm_heading(s: str) -> str:
        # 백슬래시 이스케이프 제거, 공백·구두점 관대하게 비교
        s = s.replace("\\[", "[").replace("\\]", "]").replace("\\(", "(").replace("\\)", ")").replace("\\.", ".")
        s = _re.sub(r"\s+", " ", s).strip()
        return s

    def _heading_level(line: str) -> int:
        m = 0
        for ch in line:
            if ch == "#": m += 1
            else: break
        return m

    def _unwrap_heading(line: str) -> tuple[str, int] | None:
        """라인을 분석해 (제목, 레벨) 반환 — heading 이 아니면 None.

        지원:
          - 일반 `## 제목`
          - blockquote `> # 제목`, `> ## 제목`
          - Confluence bold-only 줄 `****제목****` (decision/task 타이틀) — 가장 약한 레벨 6
        """
        s = line.strip()
        if not s:
            return None
        # blockquote 제거
        while s.startswith(">"):
            s = s[1:].lstrip()
        if s.startswith("#"):
            lvl = _heading_level(s)
            return (_norm_heading(s.lstrip("#")), lvl)
        # bold-only line — `**...**` / `***...***` / `****...****`
        m = _re.match(r"^(\*{2,})(.+?)\1\s*$", s)
        if m and m.group(2).strip():
            return (_norm_heading(m.group(2)), 6)
        return None

    section_range = None
    if section:
        target = _norm_heading(section)
        target_low = target.lower()
        lines = content.splitlines()
        start = -1
        start_level = 99
        for i, line in enumerate(lines):
            res = _unwrap_heading(line)
            if not res:
                continue
            hd, lvl = res
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

    # GDD 내부 표 매칭 — xlsx 출처 + section 이 표제목과 일치하는 foundation_tables 항목이
    # 있으면 표를 markdown 으로 추출해 본문 앞에 prepend 한다. 답변 신뢰도 검증을 위해
    # 답변에서 인용한 § <표제목> 의 헤더+행을 즉시 확인 가능하게 함.
    if meta.get("source") == "xlsx" and section and meta.get("workbook") and meta.get("sheet"):
        try:
            from projk_tools import _build_gdd_index
            idx = _build_gdd_index()
            if idx.get("available"):
                wb = meta["workbook"]
                sh = meta["sheet"]
                target_low = section.strip().lower()
                matched_meta = None
                for tm in idx["meta"]:
                    if tm["workbook"] == wb and tm["sheet"] == sh:
                        if target_low in tm["table_name"].lower() or tm["table_name"].lower() in target_low:
                            matched_meta = tm
                            break
                if matched_meta:
                    fp = idx["by_key"].get(f"{wb}|{sh}|{matched_meta['table_id']}")
                    if fp:
                        import json as _json
                        from pathlib import Path as _Pp
                        try:
                            data = _json.loads(_Pp(fp).read_text(encoding="utf-8"))
                            target = next(
                                (tt for tt in data.get("tables", []) if tt.get("table_id") == matched_meta["table_id"]),
                                None,
                            )
                            if target:
                                tbl_md = f"## 📋 {target.get('table_name', '')}\n\n"
                                desc = target.get("description") or ""
                                if desc:
                                    tbl_md += f"> {desc}\n\n"
                                headers = [h.get("name", "") if isinstance(h, dict) else str(h) for h in target.get("headers", [])]
                                if headers:
                                    tbl_md += "| " + " | ".join(headers) + " |\n"
                                    tbl_md += "| " + " | ".join("---" for _ in headers) + " |\n"
                                    for row in target.get("rows", [])[:50]:
                                        cells = []
                                        for v in row:
                                            if v is None:
                                                cells.append("")
                                            else:
                                                s = str(v).replace("|", "\\|").replace("\n", " ")
                                                cells.append(s[:120])
                                        tbl_md += "| " + " | ".join(cells) + " |\n"
                                    if len(target.get("rows", [])) > 50:
                                        tbl_md += f"\n*... 외 {len(target['rows']) - 50}건 생략*\n"
                                tbl_md += "\n---\n\n## 시트 본문 (참고)\n\n"
                                content = tbl_md + content
                                section_range = None  # 표를 prepend 했으므로 섹션 강조 무력화
                        except Exception:
                            pass  # JSON 손상 — 그냥 기본 동작
        except Exception:
            pass  # 인덱스 빌드 실패 — 기본 동작

    return {
        "path": normalized,
        "section": section,
        "content": content,
        "section_range": section_range,
        "origin_label": meta.get("origin_label"),
        "origin_url": meta.get("origin_url"),
        "source": meta.get("source"),
    }


@app.get("/screenshot")
async def screenshot(path: str):
    """xlsx sheet 의 원본 스크린샷 반환.
    `path` 는 /source_view 와 같은 xlsx content.md 경로. 동일 시트 디렉터리
    하위의 `_vision_input/overview.png` (세로 이어붙인 전체 뷰) 또는
    `full_original.png` 를 찾아 이미지로 응답.
    """
    from pathlib import Path as _P
    agent_dir = _P(__file__).resolve().parent.parent
    repo_root = agent_dir.parent.parent
    raw = path.strip()
    if raw.startswith("/"):
        try:
            ap = _P(raw)
            for base_try in (agent_dir, repo_root):
                try:
                    raw = str(ap.relative_to(base_try))
                    break
                except ValueError:
                    continue
        except Exception:
            pass
    normalized = raw.lstrip("/").strip()
    if normalized.startswith("../xlsx-extractor/"):
        normalized = "packages/" + normalized[3:]
    # 라벨 형식도 수용
    if not normalized.startswith("packages/xlsx-extractor/output/"):
        resolved = storage._path_to_source_meta(normalized).get("path", "")
        if resolved.startswith("packages/xlsx-extractor/output/"):
            normalized = resolved
    if not normalized.startswith("packages/xlsx-extractor/output/"):
        raise HTTPException(status_code=403, detail="not an xlsx path")

    # <sheet>/_final/content.md → <sheet>/_vision_input/<img>
    cand = (repo_root / normalized).resolve()
    try:
        cand.relative_to(repo_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="path escapes")
    # _final 디렉터리 위로
    if cand.name == "content.md":
        sheet_dir = cand.parent
        if sheet_dir.name == "_final":
            sheet_dir = sheet_dir.parent
    else:
        sheet_dir = cand
    vision_in = sheet_dir / "_vision_input"

    # 1) 가로 폭을 제한한 detail_r{n}.png 가 여러 장이면 세로로 이어붙여 캐시.
    #    full_original.png 는 실제 Excel 렌더 폭 그대로라 매우 넓고(~5000px) 여백이
    #    많아 보기 불편. detail 타일은 콘텐츠 폭 기준(보통 ~1400px)으로 잘려 있다.
    detail_tiles = sorted(vision_in.glob("detail_r*.png"))
    if len(detail_tiles) >= 1:
        stitched = vision_in / "detail_stitched.png"
        # mtime 비교 — 원본이 더 새로우면 재생성
        def _needs_rebuild() -> bool:
            if not stitched.exists():
                return True
            s_m = stitched.stat().st_mtime
            return any(t.stat().st_mtime > s_m for t in detail_tiles)
        if _needs_rebuild():
            try:
                from PIL import Image  # 서버에 Pillow 설치됨
                imgs = [Image.open(p) for p in detail_tiles]
                max_w = max(i.width for i in imgs)
                total_h = sum(i.height for i in imgs)
                canvas = Image.new("RGB", (max_w, total_h), (255, 255, 255))
                y = 0
                for i in imgs:
                    # 좌측 정렬로 붙이기 (폭이 서로 달라도 OK)
                    canvas.paste(i, (0, y))
                    y += i.height
                canvas.save(stitched, "PNG", optimize=True)
            except Exception as e:
                log.warning(f"detail stitch 실패 path={normalized}: {e}")
        if stitched.exists():
            return FileResponse(stitched, media_type="image/png",
                                headers={"Cache-Control": "private, max-age=3600"})

    # 2) fallback — overview → full_original 순
    for name in ("overview.png", "full_original.png"):
        img = vision_in / name
        if img.exists() and img.is_file():
            return FileResponse(img, media_type="image/png",
                                headers={"Cache-Control": "private, max-age=3600"})
    raise HTTPException(status_code=404, detail="screenshot not found")


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


# ─── Refactor Ranker / Decision Overlay ─────────────────────────

from ranker import decision as ranker_decision  # noqa: E402

DECISIONS_DIR = Path(__file__).parent.parent / "decisions"


def _jsonl_read(path: Path, limit: int | None = None) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if limit is not None:
        out = out[-limit:]
    return out


@app.get("/admin/refactor/overview")
async def refactor_overview():
    """Ranker·Decision Overlay 전체 현황. Admin 대시보드 진입 시 가장 먼저 요청."""
    targets_path = DECISIONS_DIR / "refactor_targets.json"
    decisions = _jsonl_read(DECISIONS_DIR / "decisions.jsonl")
    annotations = _jsonl_read(DECISIONS_DIR / "annotations.jsonl")
    feedback = _jsonl_read(DECISIONS_DIR / "feedback.jsonl")

    targets_meta: dict = {}
    grade_counts: dict[str, int] = {}
    if targets_path.exists():
        data = json.loads(targets_path.read_text(encoding="utf-8"))
        targets_meta = {
            "generated_at": data.get("generated_at"),
            "dimensions_used": data.get("dimensions_used"),
            "systems_scope": data.get("systems_scope"),
            "ranker_version": data.get("ranker_version"),
            "total_targets": len(data.get("targets", [])),
        }
        for t in data.get("targets", []):
            g = t.get("grade", "?")
            grade_counts[g] = grade_counts.get(g, 0) + 1

    return {
        "targets_meta": targets_meta,
        "grade_counts": grade_counts,
        "decisions": {"total": len(decisions), "recent": decisions[-5:]},
        "annotations": {
            "total": len(annotations),
            "deprecated": sum(1 for a in annotations if a.get("status") == "deprecated"),
            "recent": annotations[-5:],
        },
        "feedback": {"total": len(feedback), "recent": feedback[-10:]},
    }


@app.get("/admin/refactor/targets")
async def refactor_targets():
    """전체 refactor_targets.json (Ranker 최신 출력)."""
    targets_path = DECISIONS_DIR / "refactor_targets.json"
    if not targets_path.exists():
        raise HTTPException(404, "refactor_targets.json not found — run the Ranker first")
    return json.loads(targets_path.read_text(encoding="utf-8"))


@app.get("/admin/refactor/cards/{target:path}")
async def refactor_cards(target: str):
    """특정 시스템의 충돌 카드 (Stage 1 재활용, LLM 호출 없음)."""
    cards = ranker_decision.build_cards(target)
    return {
        "target": target,
        "count": len(cards),
        "cards": [c.to_dict() for c in cards],
    }


class ApplyDecisionRequest(BaseModel):
    target: str
    card_index: int  # 1-based (decision_cli 와 동일)
    option: str  # "A" / "B" / ... / "other"
    author: str
    ttl_days: int = 30
    custom: str | None = None


@app.post("/admin/refactor/apply_decision")
async def apply_decision_api(req: ApplyDecisionRequest):
    cards = ranker_decision.build_cards(req.target)
    idx = req.card_index - 1
    if idx < 0 or idx >= len(cards):
        raise HTTPException(400, f"card_index out of range 1..{len(cards)}")
    card = cards[idx]
    d, anns = ranker_decision.apply_decision(
        req.target,
        card,
        req.option,
        author=req.author,
        ttl_days=req.ttl_days,
        selected_custom_text=req.custom,
    )
    return {"decision": d, "annotations": anns}


class FeedbackRequest(BaseModel):
    target: str
    action: str  # defer / dismiss / regrade / comment
    author: str
    comment: str = ""
    card_index: int | None = None  # 1-based
    regrade_to: str | None = None  # S/A/B/C (action=regrade)
    ttl_days: int = 30


@app.post("/admin/refactor/feedback")
async def refactor_feedback_api(req: FeedbackRequest):
    comment = req.comment or ""
    if req.card_index is not None:
        cards = ranker_decision.build_cards(req.target)
        idx = req.card_index - 1
        if 0 <= idx < len(cards):
            c = cards[idx]
            prefix = f"[{c.conflict_type}:{c.topic}] "
            if not comment.startswith(prefix):
                comment = (prefix + comment).rstrip()
    rec = ranker_decision.record_feedback(
        req.target,
        action=req.action,
        author=req.author,
        comment=comment,
        regrade_to=req.regrade_to,
        ttl_days=req.ttl_days,
    )
    return {"feedback": rec}


@app.get("/admin/refactor/decisions")
async def list_decisions(limit: int | None = None):
    return {"decisions": _jsonl_read(DECISIONS_DIR / "decisions.jsonl", limit=limit)}


@app.get("/admin/refactor/annotations")
async def list_annotations(limit: int | None = None):
    return {"annotations": _jsonl_read(DECISIONS_DIR / "annotations.jsonl", limit=limit)}


@app.get("/admin/refactor/feedback_list")
async def list_feedback(limit: int | None = None):
    return {"feedback": _jsonl_read(DECISIONS_DIR / "feedback.jsonl", limit=limit)}


# ═══════════════════════════════════════════════════════════════════════════════
# /review_stream + /suggest_edits — Klaud / chrome-extension 의 Confluence 리뷰
# ═══════════════════════════════════════════════════════════════════════════════
# 단일 Bedrock 호출을 token-by-token NDJSON 으로 forward.
# (RAG 사용 안 함 — 사용자가 보고 있는 페이지 텍스트가 모든 컨텍스트)

import re as _re_review
from bedrock_stream import (
    stream_messages as _bd_stream,
    BedrockStreamError as _BdStreamErr,
    normalize_model as _bd_normalize_model,
)


_REVIEW_SYSTEM = """You are a senior game designer and document quality expert reviewing Confluence wiki pages for Project K, a mobile MMORPG.
Analyze the document from multiple perspectives. Respond in Korean.

Return a JSON object with this exact structure:
{
  "score": 0-100,
  "issues": [{"text": "...", "perspective": "기획팀장|프로그래머"}],
  "verifications": [{"text": "...", "perspective": "기획팀장|프로그래머"}],
  "suggestions": ["..."],
  "flow": "전체 로직을 단계별 텍스트 순서도로 정리 (1. → 2. → 3. ...)",
  "qa_checklist": ["테스트 항목 1", "테스트 항목 2", "..."],
  "readability": {"score": 0-100, "issues": ["가독성 관련 지적 사항"]}
}

## 리뷰 관점 (perspective)

모든 issues/verifications 항목에 관점을 명시하세요:
- **"기획팀장"**: 기획 의도, 시스템 설계, 콘텐츠 방향성, 다른 시스템과의 정합성, 우선순위/스코프 판단
- **"프로그래머"**: 구현 가능성, 기술적 명세 부족, 서버/클라이언트 처리 방식, 체크 빈도/타이밍, 데이터 타입/단위 오류, 예외 처리

## 카테고리 규칙 — 각 항목은 정확히 하나의 카테고리에만 속함

- **"issues"**: 문서에 반드시 있어야 하는데 빠진 것. 구현자가 이 문서만 보고 작업할 수 없는 수준의 누락.
  - 수치가 기획서에 없는 경우, 실제 데이터시트(ContentSetting, 테이블 등)에 값이 존재할 수 있음. 데이터시트에서 채워야 할 값은 "[TODO: 데이터시트에서 실제 값 확인 필요]"로 표기.
  - 예: 수치 없음, 예외 케이스 미기술, 필수 정의 누락, 데이터 타입/단위 모호
- **"verifications"**: 적혀 있지만 맞는지 확인이 필요한 것. 오타/오류 의심, 모호한 표현, 다른 문서와 불일치 가능성.
  - 예: 텍스트 키 중복, 수치 단위 혼동, 용어 불일치
- **"suggestions"**: issues/verifications에 해당하지 않지만, 추가하면 문서 품질이 올라가는 것.
  - 예: 다이어그램 추가, 관련 문서 링크, 구조 개선, 연출/피드백 명세

IMPORTANT: suggestions는 issues와 겹치면 안 됨. "없어서 문제"이면 issues, "있어도 되고 없어도 되지만 있으면 좋은 것"이면 suggestions.

## 로직 플로우 (flow)

시스템의 전체 동작 로직을 **텍스트 기반 순서도**로 정리하세요.
- 조건 분기: "→ [조건] → 결과A / [아니면] → 결과B" 형식
- 구현자와 QA 모두 이해할 수 있는 수준으로 작성
- 문서에 명시된 로직만 기반으로 작성 (추측 금지)

## QA 테스트 체크리스트 (qa_checklist)

이 기획서를 기반으로 **QA가 검증해야 할 테스트 케이스**를 생성하세요:
- **기본 흐름(Happy Path)을 최우선으로 포함** — 시스템의 가장 기본적인 정상 동작을 먼저 검증 (예: "물약 보유 상태에서 HP가 설정 비율 이하로 감소 → 자동 사용 → HP 회복 확인")
- 기본 흐름 이후 엣지 케이스 + 경계값 테스트 추가
- 각 항목은 구체적이고 실행 가능해야 함 (예: "물약 0개 상태에서 HP 50% 이하로 감소 시 동작 확인")
- 문서에 정의된 모든 조건 분기, 상태 전이, 예외 처리를 커버
- 다른 시스템과의 상호작용 테스트 포함 (예: PVP 전환, 서포트 모드, 던전 입장 등)

## 문서 가독성 평가 (readability)

이 문서를 **프로그래머, QA, 아트 담당자가 읽고 바로 작업에 착수할 수 있는지** 평가하세요:
- 논리적 흐름: 개념정의 → 규칙 → 데이터 → 예외처리 → UI 순서가 자연스러운가
- 계층 구조: 한 섹션이 너무 비대하거나, 관련 없는 내용이 섞여 있지 않은가
- 용어 일관성: 같은 개념을 다른 이름으로 부르고 있지 않은가
- 조건문 명확성: "일정 수준", "적절히" 같은 모호한 표현이 없는가
- 독립성: 이 문서만으로 이해 가능한가, 암묵적 전제가 없는가
- UX 관점: UI 이미지나 와이어프레임이 포함되어 있다면, 일반적인 모바일 게임 UX 관점에서 개선점 제시

Return ONLY the raw JSON object. No markdown fences."""


_EDIT_SYSTEM = """You are an editor for Confluence wiki pages. Propose text changes as a JSON array.

CRITICAL RULES:
- "before": COPY-PASTE an exact substring from the page text. It MUST appear verbatim. Keep it short (1 sentence max, no newlines, no tabs).
- "after": the REPLACEMENT text that will REPLACE "before". It must contain the full corrected version of "before", NOT just the addition.
  - WRONG: before="HP 물약" after="HP 물약 (자동 사용 포함)" ← this ADDS text instead of replacing
  - RIGHT: before="HP 물약을 사용한다" after="HP 물약을 자동으로 사용한다" ← this REPLACES the sentence
- If you need to ADD new content, use "before" as the sentence AFTER which the content should appear, and "after" as that sentence + the new content.
- Each change must be SMALL: 1-2 sentences only.
- Return ONLY a raw JSON array. No markdown fences. No explanation.
- Ensure valid JSON: escape quotes with \\", no literal newlines in strings.
- Generate one change per instruction item. Do NOT skip items.
- When referencing other documents: you do NOT know which documents actually exist. Never invent document names or links. Instead, write "[TODO: 관련 문서 링크 추가 필요]" so the author can fill in real links later.
- For features planned but not yet designed, mark as "[TODO]" with a brief note.
- TABLE CELLS: The page text shows tables in markdown format (| col1 | col2 |). CRITICAL table rules:
  1. NEVER include pipe characters (|) in "before" or "after" — pipes are column separators, not content.
  2. "before" must contain text from ONE CELL ONLY. Never span multiple columns.
  3. If you need to edit a cell, copy ONLY that cell's text without any | or adjacent cell text.
  Example: For row "| KeywordA | 텍스트A | 설명A |", to edit 텍스트A → 텍스트B:
  ✅ CORRECT: before="텍스트A" after="텍스트B"
  ❌ WRONG: before="KeywordA | 텍스트A" (spans 2 cells)
  ❌ WRONG: before="KeywordA || 텍스트A" (includes pipes)"""


class ReviewStreamRequest(BaseModel):
    title: str
    text: str
    model: str | None = None
    review_instruction: str | None = None


class SuggestEditsRequest(BaseModel):
    title: str
    text: str | None = None
    html: str | None = None
    instruction: str
    max_changes: int | None = 10
    model: str | None = None


def _ndj(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _strip_md_fences(s: str) -> str:
    s = _re_review.sub(r"```(?:json)?\s*", "", s)
    return _re_review.sub(r"```\s*$", "", s).strip()


def _extract_json_object(s: str) -> dict | None:
    s = _strip_md_fences(s)
    m = _re_review.search(r"\{[\s\S]*\}", s)
    if not m:
        return None
    raw = m.group(0)
    # 흔한 LLM JSON 흠 보정
    raw = _re_review.sub(r",\s*([}\]])", r"\1", raw)
    try:
        return json.loads(raw)
    except Exception:
        return None


def _extract_json_array(s: str) -> list | None:
    s = _strip_md_fences(s)
    m = _re_review.search(r"\[[\s\S]*\]", s)
    if not m:
        return None
    raw = m.group(0)
    raw = _re_review.sub(r",\s*([}\]])", r"\1", raw)
    raw = _re_review.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", raw)
    try:
        return json.loads(raw)
    except Exception:
        return None


@app.post("/review_stream")
async def review_stream(req: ReviewStreamRequest):
    """Confluence 페이지 리뷰 — Bedrock 단일 호출, NDJSON 토큰 스트리밍.

    이벤트:
        {"type":"status","message":"..."}
        {"type":"token","text":"..."}            # text_delta 마다
        {"type":"result","data":{"review":"<JSON 문자열>","model":"opus","usage":{...}}}
        {"type":"error","message":"..."}
    """
    title = req.title
    text = (req.text or "")[:100000]
    instruction_block = (
        f"\n\nReviewer's focus instruction: {req.review_instruction.strip()}"
        if req.review_instruction
        else ""
    )
    user_msg = (
        f"Page Title: {title}\n\nPage Content:\n{text}"
        f"{instruction_block}\n\nReview this document thoroughly and return the JSON result:"
    )
    model = _bd_normalize_model(req.model)

    async def gen():
        log_event("review", "review_stream", f"{title[:60]} ({len(text)}c, {model})")
        yield _ndj({"type": "status", "message": f"🧠 문서 분석 중... ({model})"})
        yield _ndj({"type": "status", "message": f"📄 길이: {len(text):,}자"})

        acc: list[str] = []
        usage: dict = {}
        try:
            async for ev in _bd_stream(
                messages=[{"role": "user", "content": user_msg}],
                system=_REVIEW_SYSTEM,
                model=model,
                max_tokens=8192,
                temperature=0.0,
            ):
                t = ev.get("type")
                if t == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta":
                        chunk = d.get("text", "")
                        if chunk:
                            acc.append(chunk)
                            yield _ndj({"type": "token", "text": chunk})
                elif t == "message_delta":
                    u = ev.get("usage")
                    if u:
                        usage.update(u)
                # message_start / content_block_start / _stop 무시
        except _BdStreamErr as e:
            log_event("review", "review_error", str(e)[:200])
            yield _ndj({"type": "error", "message": f"Bedrock stream error: {e}"})
            return
        except Exception as e:
            log_event("review", "review_error", str(e)[:200])
            yield _ndj({"type": "error", "message": f"unexpected: {e}"})
            return

        full = "".join(acc)
        log_event("review", "review_done", f"{len(full)} chars, usage={usage}")
        yield _ndj({"type": "status", "message": "📋 리뷰 결과 정리 중..."})

        # 클라이언트(chrome-extension/Klaud) 가 review 텍스트를 다시 JSON 파싱하므로
        # 본문은 raw 그대로 전달. 단, 서버 측에서도 한 번 파싱해서 정합성만 확인.
        parsed = _extract_json_object(full)
        result_data: dict = {
            "review": full,
            "model": model,
            "usage": usage,
        }
        if parsed is None:
            yield _ndj(
                {
                    "type": "status",
                    "message": "⚠️ JSON 파싱 실패 — 클라이언트 측에서 재시도 가능",
                }
            )
        yield _ndj({"type": "result", "data": result_data})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.post("/suggest_edits")
async def suggest_edits(req: SuggestEditsRequest):
    """Confluence 페이지 부분 편집 제안 — Bedrock 단일 호출, NDJSON 토큰 스트리밍.

    이벤트:
        {"type":"status","message":"..."}
        {"type":"token","text":"..."}             # text_delta 마다 (JSON array 가 점진 형성)
        {"type":"result","data":{"changes":[{"id","section","description","before","after"}]}}
        {"type":"error","message":"..."}
    """
    title = req.title
    content = (req.text or req.html or "")[:60000]
    if not content:
        return StreamingResponse(
            iter(
                [
                    _ndj(
                        {
                            "type": "error",
                            "message": "No page content (text or html required).",
                        }
                    )
                ]
            ),
            media_type="application/x-ndjson",
        )
    instr = req.instruction or "전반적인 검토와 개선 제안"
    max_changes = req.max_changes or 10
    model = _bd_normalize_model(req.model)
    user_msg = (
        f"Page Title: {title}\n\nPage Text:\n{content}\n\n"
        f"Edit Instruction: {instr}\n\n"
        f"Return JSON array (generate up to {max_changes} changes — one per instruction item). "
        f'Each "before" must be a short EXACT substring from the page text above '
        f"(1 sentence, no newlines):\n"
        f'[{{"id":"change-1","section":"섹션명","description":"간단한 설명",'
        f'"before":"페이지에서 복사한 정확한 짧은 텍스트","after":"대체 텍스트"}}]'
    )

    async def gen():
        log_event(
            "suggest", "suggest_edits", f"{title[:60]} ({len(content)}c, {model}, {instr[:40]})"
        )
        yield _ndj(
            {"type": "status", "message": f"✏️ 수정안 생성 중... ({model}, max {max_changes})"}
        )

        acc: list[str] = []
        usage: dict = {}
        try:
            async for ev in _bd_stream(
                messages=[{"role": "user", "content": user_msg}],
                system=_EDIT_SYSTEM,
                model=model,
                max_tokens=8192,
                temperature=0.0,
            ):
                t = ev.get("type")
                if t == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta":
                        chunk = d.get("text", "")
                        if chunk:
                            acc.append(chunk)
                            yield _ndj({"type": "token", "text": chunk})
                elif t == "message_delta":
                    u = ev.get("usage")
                    if u:
                        usage.update(u)
        except _BdStreamErr as e:
            log_event("suggest", "suggest_error", str(e)[:200])
            yield _ndj({"type": "error", "message": f"Bedrock stream error: {e}"})
            return
        except Exception as e:
            log_event("suggest", "suggest_error", str(e)[:200])
            yield _ndj({"type": "error", "message": f"unexpected: {e}"})
            return

        full = "".join(acc)
        yield _ndj({"type": "status", "message": "📋 수정안 파싱 중..."})

        changes = _extract_json_array(full)
        if changes is None:
            log_event("suggest", "suggest_parse_fail", full[:200])
            yield _ndj(
                {
                    "type": "error",
                    "message": "Failed to parse edit suggestions as JSON array",
                    "raw_preview": full[:500],
                }
            )
            return

        # {id, before, after} 필수 검증 (chrome-extension background.js:307 와 동일)
        valid: list[dict] = []
        for ch in changes:
            if not isinstance(ch, dict):
                continue
            if not (ch.get("id") and ch.get("before") and ch.get("after")):
                continue
            # | 포함 시 경고만 (테이블 셀 spanning) — 차단은 안 함, 클라이언트에서 처리
            valid.append(ch)

        log_event(
            "suggest",
            "suggest_done",
            f"{len(valid)}/{len(changes)} valid changes, usage={usage}",
        )
        yield _ndj(
            {
                "type": "result",
                "data": {
                    "changes": valid,
                    "model": model,
                    "usage": usage,
                    "raw_count": len(changes),
                },
            }
        )

    return StreamingResponse(gen(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn

    port = int(__import__("os").environ.get("PORT", "8090"))
    uvicorn.run(app, host="0.0.0.0", port=port)
