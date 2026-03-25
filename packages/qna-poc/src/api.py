"""
api.py — FastAPI QnA 엔드포인트

POST /ask          기획 QnA (Agent 파이프라인)
POST /ask_stream   기획 QnA + SSE 스트리밍 (상태 + 결과)
POST /search       검색만 (디버그용)
GET  /systems      시스템 목록
GET  /systems/{name}/related  관련 시스템
GET  /health       헬스체크
GET  /admin/conversations           전체 대화 목록
GET  /admin/conversations/{conv_id} 대화 상세
"""

import datetime
import json
import os
import queue
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import requests as http_requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from src.agent import agent_answer
from src.retriever import retrieve, extract_system_names, get_related_systems, _build_structural_index

app = FastAPI(title="Project K QnA PoC", version="0.2.0")

# ── 백그라운드 자동화 스레드 ──────────────
_auto_threads: dict[str, threading.Thread] = {}
_auto_stop = threading.Event()


def _auto_scheduler():
    """자동 크롤/다운로드/enrich 스케줄러. API 시작 시 백그라운드 실행."""
    import time as _time

    worker_dir = str(Path(__file__).resolve().parent.parent.parent / "data-pipeline")

    log_path = Path(worker_dir).parent.parent / "logs"
    log_path.mkdir(exist_ok=True)

    while not _auto_stop.is_set():
        workers_to_launch = []  # (job_type, worker_id) — DB 밖에서 Popen 실행
        try:
            pdb = _get_pipeline_db()
            with pdb.get_conn() as conn:
                sources = conn.execute("SELECT id, properties FROM crawl_sources WHERE enabled = 1").fetchall()

                for src in sources:
                    props = json.loads(src["properties"] or "{}")
                    source_id = src["id"]

                    # 자동 크롤
                    interval = props.get("auto_crawl_interval", 0)
                    if interval > 0:
                        last = props.get("_last_auto_crawl", 0)
                        now = _time.time()
                        if now - last >= interval:
                            busy = conn.execute(
                                "SELECT COUNT(*) as c FROM jobs WHERE source_id=? AND job_type='crawl' AND status IN ('pending','running')",
                                [source_id]
                            ).fetchone()["c"]
                            if busy == 0:
                                conn.execute(
                                    "INSERT INTO jobs (job_type, source_id, status, priority, worker_type) VALUES ('crawl', ?, 'pending', 1, 'any')",
                                    [source_id]
                                )
                                workers_to_launch.append(("crawl", "auto-crawl"))
                            props["_last_auto_crawl"] = now
                            conn.execute("UPDATE crawl_sources SET properties = ? WHERE id = ?",
                                         [json.dumps(props, ensure_ascii=False), source_id])

                    # 자동 다운로드/enrich
                    for job_type, setting_key in [("download", "auto_download"), ("enrich", "auto_enrich")]:
                        if not props.get(setting_key):
                            continue
                        pending = conn.execute(
                            "SELECT COUNT(*) as c FROM jobs WHERE source_id=? AND job_type=? AND status='pending'",
                            [source_id, job_type]
                        ).fetchone()["c"]
                        running_w = conn.execute(
                            "SELECT COUNT(*) as c FROM jobs WHERE job_type=? AND status='running'",
                            [job_type]
                        ).fetchone()["c"]
                        if pending > 0 and running_w == 0:
                            workers_to_launch.append((job_type, f"auto-{job_type}"))

        except Exception as e:
            print(f"[auto-scheduler] error: {e}")

        # DB 커넥션 닫힌 후 워커 프로세스 실행 (DB lock 방지)
        for job_type, worker_id in workers_to_launch:
            try:
                subprocess.Popen(
                    [sys.executable, "-m", "src.worker", "--id", worker_id, "--types", job_type, "--once"],
                    cwd=worker_dir,
                    stdout=open(log_path / f"{worker_id}.log", "a"),
                    stderr=subprocess.STDOUT,
                )
            except Exception as e:
                print(f"[auto-scheduler] Popen error ({job_type}): {e}")

        _auto_stop.wait(3)  # 3초마다 체크


@app.on_event("startup")
def _start_auto_scheduler():
    t = threading.Thread(target=_auto_scheduler, daemon=True, name="auto-scheduler")
    t.start()
    _auto_threads["scheduler"] = t
    print("[auto-scheduler] 시작됨")


@app.on_event("shutdown")
def _stop_auto_scheduler():
    _auto_stop.set()


# CORS — Streamlit, 로컬 개발 등에서 접근 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 대화 저장 (JSON 파일 영속화)
# 각 대화: { id, title, created_at, updated_at, turns: [{question, answer, sources, ...}] }
_CONV_FILE = Path(__file__).resolve().parent.parent / "data" / "conversations.json"
conversations: dict[str, dict] = {}
_conv_lock = threading.Lock()


def _load_conversations():
    """서버 시작 시 디스크에서 대화 로드."""
    global conversations
    if _CONV_FILE.exists():
        try:
            conversations = json.loads(_CONV_FILE.read_text(encoding="utf-8"))
            print(f"[api] 대화 {len(conversations)}개 로드 ({_CONV_FILE})")
        except Exception as e:
            print(f"[api] 대화 로드 실패: {e}")
            conversations = {}
    else:
        conversations = {}


def _flush_conversations():
    """대화를 디스크에 저장. _conv_lock 안에서 호출."""
    _CONV_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CONV_FILE.write_text(json.dumps(conversations, ensure_ascii=False, indent=2), encoding="utf-8")


def _save_turn(conv_id: str, question: str, result: dict, sources: list[dict], model: str,
               proposals: list[dict] | None = None):
    """대화 턴을 저장하고 디스크에 기록."""
    now = datetime.datetime.utcnow().isoformat() + "Z"
    turn = {
        "question": question,
        "answer": result["answer"],
        "sources": sources,
        "confidence": result.get("confidence", "medium"),
        "model": model,
        "total_tokens": result.get("total_tokens", 0),
        "api_seconds": result.get("total_api_seconds", 0),
        "timestamp": now,
    }
    if proposals:
        turn["proposals"] = proposals
    with _conv_lock:
        if conv_id not in conversations:
            conversations[conv_id] = {
                "id": conv_id,
                "title": question[:40] + ("..." if len(question) > 40 else ""),
                "created_at": now,
                "updated_at": now,
                "turns": [],
            }
        conversations[conv_id]["turns"].append(turn)
        conversations[conv_id]["updated_at"] = now
        _flush_conversations()


def _get_conv_history(conv_id: str) -> list[tuple[str, str]]:
    """agent_answer에 전달할 최근 5턴 히스토리."""
    with _conv_lock:
        turns = conversations.get(conv_id, {}).get("turns", [])
        return [(t["question"], t["answer"]) for t in turns[-5:]]


# 서버 시작 시 기존 대화 로드
_load_conversations()


# ── Request/Response 모델 ──

class AskRequest(BaseModel):
    question: str
    conversation_id: str | None = None
    role: str | None = None
    model: str = "claude-opus-4-6"
    prompt_style: str = "검증세트 최적화"  # "검증세트 최적화" | "기본"


class AskResponse(BaseModel):
    answer: str
    confidence: str
    sources: list[dict]
    conversation_id: str
    total_tokens: int
    api_seconds: float
    trace: list[dict] | None = None


class SearchRequest(BaseModel):
    query: str
    limit: int = 10


class SearchResult(BaseModel):
    results: list[dict]
    detected_systems: list[str]


# ── 엔드포인트 ──

@app.get("/health")
def health():
    """헬스체크."""
    return {"status": "ok", "version": "0.2.0"}


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest):
    """기획 QnA 질문 — Agent 파이프라인 (Planning→Search→Answer→Reflection).

    def (not async def) → FastAPI가 자동으로 threadpool에서 실행 → 동시 요청 처리 가능.
    """
    conv_id = req.conversation_id or str(uuid.uuid4())
    conv_history = _get_conv_history(conv_id)

    result = agent_answer(req.question, role=req.role,
                          model=req.model, prompt_style=req.prompt_style,
                          conversation_history=conv_history or None)

    # 소스 정보 추출
    sources = []
    seen = set()
    for chunk in result.get("chunks", []):
        key = f"{chunk.get('workbook', '')}/{chunk.get('sheet', '')}"
        if key not in seen:
            seen.add(key)
            sources.append({
                "workbook": chunk.get("workbook", ""),
                "sheet": chunk.get("sheet", ""),
                "section_path": chunk.get("section_path", ""),
                "score": round(chunk.get("combined_score", chunk.get("score", 0)), 3),
                "source_url": chunk.get("source_url", ""),
            })

    proposals = result.get("proposals") if result.get("mode") == "proposal" else None
    _save_turn(conv_id, req.question, result, sources[:10], req.model, proposals=proposals)

    return AskResponse(
        answer=result["answer"],
        confidence=result.get("confidence", "medium"),
        sources=sources[:10],
        conversation_id=conv_id,
        total_tokens=result.get("total_tokens", 0),
        api_seconds=result.get("total_api_seconds", 0),
        trace=result.get("trace"),
    )


@app.post("/ask_stream")
def ask_stream(req: AskRequest):
    """기획 QnA + SSE 스트리밍.

    NDJSON 형식으로 중간 상태와 최종 결과를 스트리밍:
      {"type": "status", "message": "🧠 질문을 분석하고 있습니다..."}
      {"type": "status", "message": "🔎 기획서에서 관련 내용을 검색하고 있습니다..."}
      ...
      {"type": "result", "data": { ...AskResponse... }}
    """
    conv_id = req.conversation_id or str(uuid.uuid4())
    conv_history = _get_conv_history(conv_id)

    # status_callback → queue로 중간 상태 전달
    status_q: queue.Queue[str | None] = queue.Queue()

    def on_status(msg: str):
        status_q.put(msg)

    # agent_answer를 별도 스레드에서 실행
    result_holder: list[dict] = []
    error_holder: list[Exception] = []

    def run_agent():
        try:
            res = agent_answer(
                req.question, role=req.role,
                model=req.model, prompt_style=req.prompt_style,
                conversation_history=conv_history or None,
                status_callback=on_status,
            )
            result_holder.append(res)
        except Exception as e:
            error_holder.append(e)
        finally:
            status_q.put(None)  # sentinel: 완료 신호

    t = threading.Thread(target=run_agent, daemon=True)
    t.start()

    def event_generator():
        while True:
            msg = status_q.get()
            if msg is None:
                break
            yield json.dumps({"type": "status", "message": msg}, ensure_ascii=False) + "\n"

        t.join()

        if error_holder:
            yield json.dumps({"type": "error", "message": str(error_holder[0])}, ensure_ascii=False) + "\n"
            return

        result = result_holder[0]

        # 소스 정보 추출 (동일 로직)
        sources = []
        seen = set()
        for chunk in result.get("chunks", []):
            key = f"{chunk.get('workbook', '')}/{chunk.get('sheet', '')}"
            if key not in seen:
                seen.add(key)
                sources.append({
                    "workbook": chunk.get("workbook", ""),
                    "sheet": chunk.get("sheet", ""),
                    "section_path": chunk.get("section_path", ""),
                    "score": round(chunk.get("combined_score", chunk.get("score", 0)), 3),
                })

        proposals = result.get("proposals") if result.get("mode") == "proposal" else None
        _save_turn(conv_id, req.question, result, sources[:10], req.model, proposals=proposals)

        payload = {
            "answer": result["answer"],
            "confidence": result.get("confidence", "medium"),
            "sources": sources[:10],
            "conversation_id": conv_id,
            "total_tokens": result.get("total_tokens", 0),
            "api_seconds": result.get("total_api_seconds", 0),
        }
        if proposals:
            payload["proposals"] = proposals
        yield json.dumps({"type": "result", "data": payload}, ensure_ascii=False) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")


@app.post("/search", response_model=SearchResult)
def search_docs(req: SearchRequest):
    """검색만 수행 (디버그/테스트용)."""
    chunks, _info = retrieve(req.query, top_k=req.limit)
    detected = extract_system_names(req.query)

    results = []
    for chunk in chunks:
        results.append({
            "workbook": chunk["workbook"],
            "sheet": chunk["sheet"],
            "section_path": chunk["section_path"],
            "score": round(chunk["score"], 4),
            "tokens": chunk["tokens"],
            "source": chunk.get("source", "unknown"),
            "preview": chunk["text"][:300] + "..." if len(chunk["text"]) > 300 else chunk["text"],
        })

    return SearchResult(results=results, detected_systems=detected)


# ── Admin 엔드포인트 ──

@app.get("/admin/conversations")
def admin_conversations():
    """Admin: 모든 대화 목록 (최신순)."""
    with _conv_lock:
        all_convs = list(conversations.values())
    all_convs.sort(key=lambda c: c.get("updated_at", ""), reverse=True)
    summaries = []
    for c in all_convs:
        summaries.append({
            "id": c["id"],
            "title": c["title"],
            "created_at": c["created_at"],
            "updated_at": c["updated_at"],
            "turn_count": len(c["turns"]),
            "last_model": c["turns"][-1]["model"] if c["turns"] else "",
        })
    return {"conversations": summaries, "total": len(summaries)}


@app.get("/admin/conversations/{conv_id}")
def admin_conversation_detail(conv_id: str):
    """Admin: 단일 대화 상세 (모든 턴 포함)."""
    with _conv_lock:
        conv = conversations.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


# ── Conflicts 엔드포인트 ──

_CONFLICT_FILE = Path(__file__).resolve().parent.parent / "eval" / "conflict_scan_latest.json"


# ── Confluence 페이지 생성 ──

def _md_to_confluence_storage(md: str) -> str:
    """Markdown → Confluence Storage Format (간이 변환)."""
    lines = md.split('\n')
    html_parts = []
    in_table = False
    table_rows = []

    def flush_table():
        nonlocal in_table, table_rows
        if not table_rows:
            return
        html_parts.append('<table><tbody>')
        for i, row in enumerate(table_rows):
            tag = 'th' if i == 0 else 'td'
            cells = row.split('|')
            cells = [c.strip() for c in cells if c.strip()]
            html_parts.append(f'<tr>{"".join(f"<{tag}>{c}</{tag}>" for c in cells)}</tr>')
        html_parts.append('</tbody></table>')
        in_table = False
        table_rows = []

    for line in lines:
        stripped = line.strip()

        # 테이블 행
        if stripped.startswith('|') and stripped.endswith('|'):
            if re.match(r'^\|[\s\-:|]+\|$', stripped):
                continue  # 구분자 행 스킵
            in_table = True
            table_rows.append(stripped)
            continue
        elif in_table:
            flush_table()

        # 헤더
        if stripped.startswith('### '):
            html_parts.append(f'<h3>{stripped[4:]}</h3>')
        elif stripped.startswith('## '):
            html_parts.append(f'<h2>{stripped[3:]}</h2>')
        elif stripped.startswith('# '):
            html_parts.append(f'<h1>{stripped[2:]}</h1>')
        # 리스트
        elif stripped.startswith('- '):
            html_parts.append(f'<ul><li>{stripped[2:]}</li></ul>')
        elif re.match(r'^\d+\.\s', stripped):
            content = re.sub(r'^\d+\.\s', '', stripped)
            html_parts.append(f'<ol><li>{content}</li></ol>')
        # 빈 줄
        elif not stripped:
            continue
        # 볼드/일반 텍스트
        else:
            text = stripped
            text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
            text = re.sub(r'\*(.+?)\*', r'<em>\1</em>', text)
            html_parts.append(f'<p>{text}</p>')

    if in_table:
        flush_table()

    return '\n'.join(html_parts)


class CreateConfluencePageRequest(BaseModel):
    title: str
    content_md: str  # Markdown 형식의 내용
    parent_path: str | None = None  # e.g. "Design/시스템 디자인/성장 밸런스"


@app.post("/confluence/create-page")
def create_confluence_page(req: CreateConfluencePageRequest):
    """Proposal의 create 항목을 Confluence 페이지로 생성."""
    confluence_url = os.environ.get("CONFLUENCE_URL")
    username = os.environ.get("CONFLUENCE_USERNAME")
    api_token = os.environ.get("CONFLUENCE_API_TOKEN")
    # 개발 단계: PKTEST 스페이스 사용, 운영 시 PK로 전환
    space_key = os.environ.get("CONFLUENCE_PUBLISH_SPACE", "PKTEST")

    if not all([confluence_url, username, api_token]):
        raise HTTPException(status_code=500, detail="Confluence 크레덴셜 미설정 (.env)")

    # Markdown → Confluence Storage Format
    storage_body = _md_to_confluence_storage(req.content_md)

    # 페이지 생성 API 호출
    api_url = f"{confluence_url}/rest/api/content"
    payload = {
        "type": "page",
        "title": req.title,
        "space": {"key": space_key},
        "body": {
            "storage": {
                "value": storage_body,
                "representation": "storage",
            }
        },
    }

    try:
        resp = http_requests.post(
            api_url,
            json=payload,
            auth=(username, api_token),
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        resp.raise_for_status()
        result = resp.json()
        page_id = result.get("id", "")
        # _links.webui가 가장 정확한 URL
        base = result.get("_links", {}).get("base", confluence_url)
        webui = result.get("_links", {}).get("webui", "")
        page_url = f"{base}{webui}" if webui else f"{confluence_url}/spaces/{space_key}/pages/{page_id}"

        return {
            "success": True,
            "page_id": page_id,
            "page_url": page_url,
            "title": result.get("title", req.title),
        }
    except http_requests.exceptions.HTTPError as e:
        error_detail = ""
        try:
            error_detail = e.response.json().get("message", str(e))
        except Exception:
            error_detail = str(e)
        raise HTTPException(status_code=e.response.status_code, detail=f"Confluence API 오류: {error_detail}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Confluence 연결 실패: {str(e)}")


# ── 기획서 품질 기준 관리 ──

_CRITERIA_FILE = Path(__file__).resolve().parent.parent / "data" / "quality_criteria.json"


@app.get("/quality-criteria")
def get_quality_criteria():
    """기획서 품질 기준 조회."""
    if not _CRITERIA_FILE.exists():
        raise HTTPException(status_code=404, detail="품질 기준 파일 없음")
    return json.loads(_CRITERIA_FILE.read_text(encoding="utf-8"))


class UpdateCriteriaRequest(BaseModel):
    criteria: list[dict]


@app.put("/quality-criteria")
def update_quality_criteria(req: UpdateCriteriaRequest):
    """기획서 품질 기준 수정 (Admin에서 리더가 편집)."""
    if not _CRITERIA_FILE.exists():
        raise HTTPException(status_code=404, detail="품질 기준 파일 없음")
    data = json.loads(_CRITERIA_FILE.read_text(encoding="utf-8"))
    data["criteria"] = req.criteria
    data["updated_at"] = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    _CRITERIA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"success": True, "count": len(req.criteria)}


@app.get("/conflicts")
def get_conflicts():
    """기획서 충돌 스캔 결과 조회."""
    if not _CONFLICT_FILE.exists():
        raise HTTPException(status_code=404, detail="No conflict scan results found. Run conflict_scanner.py first.")
    data = json.loads(_CONFLICT_FILE.read_text(encoding="utf-8"))
    return data


@app.get("/conversations/{conv_id}/export")
def export_conversation(conv_id: str):
    """대화 + Proposal을 Claude Cowork용 Markdown으로 내보내기."""
    with _conv_lock:
        conv = conversations.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    lines = [
        "# 기획서 수정 지시서",
        "",
        f"> 대화 ID: {conv_id}",
        f"> 생성: {conv.get('created_at', '')}",
        "",
        "---",
        "",
        "## 1. 대화 맥락",
        "",
    ]

    # 대화 턴
    proposals_data = []
    for i, turn in enumerate(conv["turns"], 1):
        lines.append(f"### 질문 {i}")
        lines.append(turn["question"])
        lines.append("")
        lines.append(f"### 답변 {i}")
        lines.append(turn["answer"][:2000] + ("..." if len(turn["answer"]) > 2000 else ""))
        lines.append("")

        if turn.get("proposals"):
            proposals_data = turn["proposals"]

    # Proposal 섹션
    if proposals_data:
        lines.append("---")
        lines.append("")
        lines.append("## 2. 수정/생성 제안")
        lines.append("")

        for j, p in enumerate(proposals_data, 1):
            p_type = p.get("type", "modify")
            wb = p.get("workbook", "")
            sh = p.get("sheet", "")

            if p_type == "modify":
                lines.append(f"### 제안 {j}: 기존 문서 수정")
                lines.append(f"- **대상 파일**: `{wb}`")
                lines.append(f"- **시트**: `{sh}`")
                if p.get("section"):
                    lines.append(f"- **섹션**: `{p['section']}`")
                lines.append(f"- **변경 이유**: {p.get('reason', '')}")
                lines.append(f"- **요약**: {p.get('diff_summary', '')}")
                lines.append("")
                lines.append("#### 변경 전")
                lines.append("```")
                lines.append(p.get("before", "(없음)"))
                lines.append("```")
                lines.append("")
                lines.append("#### 변경 후")
                lines.append("```")
                lines.append(p.get("after", "(없음)"))
                lines.append("```")
            else:
                lines.append(f"### 제안 {j}: 신규 문서 생성")
                lines.append(f"- **대상 워크북**: `{wb}`")
                lines.append(f"- **시트명**: `{sh}`")
                lines.append(f"- **생성 이유**: {p.get('reason', '')}")
                lines.append(f"- **요약**: {p.get('diff_summary', '')}")
                lines.append("")
                lines.append("#### 내용")
                lines.append(p.get("content", "(없음)"))

            lines.append("")

        # Claude Cowork 실행 가이드 (상세 컨텍스트)
        # 워크북→실제 Excel 파일 매핑 구성
        excel_targets = set()
        confluence_targets = set()
        for p in proposals_data:
            wb = p.get("workbook", "")
            if wb.startswith("PK_"):
                excel_targets.add(wb)
            elif wb.startswith("Confluence"):
                confluence_targets.add(wb)

        lines.append("---")
        lines.append("")
        lines.append("## 3. 실행 컨텍스트 (Claude Cowork / Claude Code용)")
        lines.append("")
        lines.append("이 문서는 AI 에이전트(Claude)가 실제 파일을 수정하기 위한 지시서입니다.")
        lines.append("아래 환경 정보와 방법론을 참고하여 제안을 적용해주세요.")
        lines.append("")
        lines.append("### 프로젝트 환경")
        lines.append("- **프로젝트**: Project K (모바일 MMORPG)")
        lines.append("- **기획서 원본 위치**: `D:/ProjectK/Design/7_System/` (Perforce 동기화)")
        lines.append("- **기획서 변환본 위치**: `packages/xlsx-extractor/output/` (MD 변환 결과)")
        lines.append("- **Confluence**: `https://bighitcorp.atlassian.net/wiki/spaces/PK/`")
        lines.append("")

        if excel_targets:
            lines.append("### Excel 수정 대상 파일")
            for wb in sorted(excel_targets):
                xlsx_name = wb + ".xlsx"
                lines.append(f"- `D:/ProjectK/Design/7_System/{xlsx_name}`")
            lines.append("")
            lines.append("### Excel 수정 방법")
            lines.append("")
            lines.append("**중요: openpyxl 등 프로그래밍 라이브러리로 수정하지 마세요.**")
            lines.append("기획서 Excel은 서식, 병합셀, 차트, 이미지 등 복잡한 레이아웃이 있어서")
            lines.append("프로그래밍으로 수정하면 레이아웃이 깨집니다.")
            lines.append("")
            lines.append("대신 아래 절차를 따르세요:")
            lines.append("")
            lines.append("1. **Excel에서 직접 열기** — 위 경로의 xlsx 파일을 Excel 앱으로 엽니다")
            lines.append("2. **대상 시트 이동** — 위 제안에 명시된 시트 탭으로 이동합니다")
            lines.append("3. **'변경 전' 내용 찾기** — Ctrl+F로 '변경 전' 테이블의 값을 검색하여 위치를 확인합니다")
            lines.append("4. **'변경 후' 값으로 수정** — 해당 셀의 값을 '변경 후' 내용으로 직접 변경합니다")
            lines.append("5. **서식 유지 확인** — 수정 후 기존 서식(글꼴, 색상, 테두리 등)이 유지되었는지 확인합니다")
            lines.append("6. **저장** — Ctrl+S로 저장합니다")
            lines.append("")
            lines.append("### 신규 시트 추가 시")
            lines.append("- 기존 시트를 복제(우클릭 → 이동/복사)하여 양식을 유지한 채 내용만 교체하는 것을 권장합니다")
            lines.append("- '변경 후' 또는 '내용' 섹션의 Markdown 테이블을 참고하여 Excel 셀에 직접 입력합니다")
            lines.append("")

        if confluence_targets:
            lines.append("### Confluence 수정 대상 페이지")
            for wb in sorted(confluence_targets):
                page_path = wb.replace("Confluence/", "")
                lines.append(f"- `{page_path}`")
            lines.append("")
            lines.append("### Confluence 수정 방법 (REST API)")
            lines.append("```python")
            lines.append("import requests")
            lines.append("")
            lines.append("CONFLUENCE_BASE = 'https://bighitcorp.atlassian.net/wiki/rest/api'")
            lines.append("# 인증: Confluence API 토큰 필요")
            lines.append("# headers = {'Authorization': 'Bearer <token>', 'Content-Type': 'application/json'}")
            lines.append("")
            lines.append("# 1. 페이지 조회 (현재 버전 확인)")
            lines.append("# GET {CONFLUENCE_BASE}/content/{page_id}?expand=body.storage,version")
            lines.append("")
            lines.append("# 2. 페이지 업데이트")
            lines.append("# PUT {CONFLUENCE_BASE}/content/{page_id}")
            lines.append("# body: {version: {number: current+1}, body: {storage: {value: new_html}}}")
            lines.append("```")
            lines.append("")

        lines.append("### 작업 완료 후")
        lines.append("1. 수정한 파일 목록과 변경 내용을 요약하여 보고")
        lines.append("2. Excel 수정 시: 변경된 셀의 before/after 값을 테이블로 출력")
        lines.append("3. 에러 발생 시: 백업에서 복원하고 원인을 보고")

    md_content = "\n".join(lines)

    from fastapi.responses import Response
    filename = f"proposal_{conv_id[:8]}.md"
    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/conversations/{conv_id}/fork")
def fork_conversation(conv_id: str):
    """대화를 복제하여 새 대화 생성. Admin의 Fork 기능용."""
    with _conv_lock:
        original = conversations.get(conv_id)
    if not original:
        raise HTTPException(status_code=404, detail="Conversation not found")

    import copy
    new_id = str(uuid.uuid4())
    now = datetime.datetime.utcnow().isoformat() + "Z"
    new_conv = copy.deepcopy(original)
    new_conv["id"] = new_id
    new_conv["title"] = f"(fork) {original['title']}"
    new_conv["created_at"] = now
    new_conv["updated_at"] = now

    with _conv_lock:
        conversations[new_id] = new_conv
        _flush_conversations()

    return {"conversation_id": new_id, "title": new_conv["title"], "turn_count": len(new_conv["turns"])}


@app.get("/systems")
def list_systems():
    """인덱싱된 시스템 목록."""
    index = _build_structural_index()
    systems = sorted(index.keys())
    return {"systems": systems, "count": len(systems)}


@app.get("/systems/{name}/related")
def related_systems(name: str):
    """관련 시스템 조회."""
    related = get_related_systems(name, depth=2)
    return {"system": name, "related": related, "count": len(related)}


# ── 데이터 파이프라인 Admin API ───────────────────────────

_pipeline_db = None

def _get_pipeline_db():
    """데이터 파이프라인 DB 모듈 로드 (src.db 충돌 방지)."""
    global _pipeline_db
    if _pipeline_db is not None:
        return _pipeline_db
    import importlib.util
    db_path = Path(__file__).resolve().parent.parent.parent / "data-pipeline" / "src" / "db.py"
    spec = importlib.util.spec_from_file_location("pipeline_db", str(db_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.init_db()
    _pipeline_db = mod
    return mod

def _get_pipeline_conn():
    """데이터 파이프라인 DB 연결."""
    return _get_pipeline_db().get_conn


@app.get("/admin/pipeline/status")
def pipeline_status():
    """데이터 파이프라인 전체 현황."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        return pdb.get_pipeline_stats(conn)


@app.get("/admin/pipeline/sources")
def pipeline_sources():
    """크롤링 소스 목록 + 마지막 크롤 시간."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        sources = pdb.list_sources(conn, enabled_only=False)
        # 각 소스의 마지막 크롤 시간 조회
        for s in sources:
            row = conn.execute(
                "SELECT created_at, new_files, changed_files, unchanged_files "
                "FROM crawl_logs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1",
                [s["id"]]
            ).fetchone()
            if row:
                s["last_crawled_at"] = row["created_at"]
                s["last_crawl_summary"] = f"+{row['new_files']} ~{row['changed_files']} ={row['unchanged_files']}"
            else:
                s["last_crawled_at"] = None
                s["last_crawl_summary"] = None
        return {"sources": sources}


@app.get("/admin/pipeline/documents")
def pipeline_documents(source_id: int = None, status: str = None, limit: int = 1000):
    """문서 목록."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        docs = pdb.list_documents(conn, source_id=source_id, status=status)
        return {"documents": docs[:limit], "total": len(docs)}


@app.get("/admin/pipeline/documents/{doc_id}")
def pipeline_document_detail(doc_id: int):
    """문서 상세 + 변환 이력."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        doc = pdb.get_document(conn, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        conversions = pdb.list_conversion_history(conn, doc_id)
        issues = pdb.list_issues(conn, document_id=doc_id)
        return {"document": doc, "conversions": conversions, "issues": issues}


@app.get("/admin/pipeline/documents/{doc_id}/content")
def pipeline_document_content(doc_id: int):
    """문서의 변환된 MD 콘텐츠 + 메타 정보 반환."""
    import re as _re
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        doc = pdb.get_document(conn, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        meta = json.loads(doc.get("metadata", "{}") or "{}")
        tree_path = meta.get("tree_path", doc.get("title", ""))
        title = doc.get("title", "")
        source = conn.execute("SELECT * FROM crawl_sources WHERE id=?", [doc["source_id"]]).fetchone()
        source_type = dict(source)["source_type"] if source else ""

        # 안전한 경로 생성
        def safe_name(s):
            return _re.sub(r'[<>:"/\\|?*]', '_', s)[:100]

        if '/' in title and tree_path.endswith(title):
            parent = tree_path[:-len(title)].rstrip('/')
            parts = [safe_name(p) for p in parent.split('/') if p]
            parts.append(safe_name(title))
        else:
            parts = [safe_name(p) for p in tree_path.split('/')]

        # 콘텐츠 파일 경로 결정
        project_root = Path(__file__).resolve().parent.parent.parent.parent
        if source_type == "confluence":
            base = project_root / "packages" / "confluence-downloader" / "output"
            page_dir = base / "/".join(parts)
            # enriched가 있으면 우선
            enriched = page_dir / "content_enriched.md"
            content_md = page_dir / "content.md"
            md_path = enriched if enriched.exists() else content_md
            confluence_url = f"https://bighitcorp.atlassian.net/wiki/pages/viewpage.action?pageId={doc['file_path']}"
        elif source_type == "perforce":
            base = project_root / "packages" / "xlsx-extractor" / "output"
            wb_name = title.replace('.xlsx', '').replace('.xlsm', '')
            wb_dir = base / wb_name
            if not wb_dir.exists():
                wb_dir = base / f"PK_{wb_name}"
            page_dir = wb_dir
            confluence_url = None

            # 시트별 content.md 수집
            sheets_data = []
            if wb_dir.exists():
                for sheet_dir in sorted(wb_dir.iterdir()):
                    if not sheet_dir.is_dir() or sheet_dir.name.startswith('_'):
                        continue
                    final_md = sheet_dir / "_final" / "content.md"
                    if final_md.exists():
                        img_dir = sheet_dir / "_final" / "images"
                        img_count = len(list(img_dir.iterdir())) if img_dir.exists() else 0
                        sheets_data.append({
                            "name": sheet_dir.name,
                            "md_size": final_md.stat().st_size,
                            "images_count": img_count,
                        })

            # 첫 번째 시트를 기본 표시
            md_path = None
            if sheets_data:
                md_path = wb_dir / sheets_data[0]["name"] / "_final" / "content.md"
        else:
            return {"error": "unknown source type"}

        md_content = ""
        if md_path and md_path.exists():
            md_content = md_path.read_text(encoding="utf-8")

        result = {
            "doc_id": doc_id,
            "title": title,
            "source_type": source_type,
            "tree_path": tree_path,
            "storage_path": str(page_dir.relative_to(project_root)) if page_dir.exists() else None,
            "md_file": md_path.name if md_path and md_path.exists() else None,
            "md_content": md_content,
            "confluence_url": confluence_url,
            "file_path": doc.get("file_path", ""),
            "status": doc.get("status", ""),
            "images_count": len(_re.findall(r'!\[[^\]]*\]\(images/', md_content)),
        }
        # Excel: 시트 목록 추가
        if source_type == "perforce" and sheets_data:
            result["sheets"] = sheets_data
        return result


@app.get("/admin/pipeline/documents/{doc_id}/sheet/{sheet_name}")
def pipeline_document_sheet(doc_id: int, sheet_name: str):
    """Excel 워크북의 특정 시트 콘텐츠 반환."""
    import re as _re
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        doc = pdb.get_document(conn, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        title = doc.get("title", "")
        project_root = Path(__file__).resolve().parent.parent.parent.parent
        base = project_root / "packages" / "xlsx-extractor" / "output"
        wb_name = title.replace('.xlsx', '').replace('.xlsm', '')
        wb_dir = base / wb_name
        if not wb_dir.exists():
            wb_dir = base / f"PK_{wb_name}"

        md_path = wb_dir / sheet_name / "_final" / "content.md"
        if not md_path.exists():
            raise HTTPException(status_code=404, detail=f"Sheet not found: {sheet_name}")

        md_content = md_path.read_text(encoding="utf-8")
        img_count = len(_re.findall(r'!\[[^\]]*\]\(images/', md_content))
        return {
            "sheet_name": sheet_name,
            "md_content": md_content,
            "images_count": img_count,
        }


@app.get("/admin/pipeline/documents/{doc_id}/images/{filename:path}")
def pipeline_document_image(doc_id: int, filename: str):
    """문서의 이미지 파일 서빙."""
    import re as _re
    from fastapi.responses import FileResponse
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        doc = pdb.get_document(conn, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        meta = json.loads(doc.get("metadata", "{}") or "{}")
        tree_path = meta.get("tree_path", doc.get("title", ""))
        title = doc.get("title", "")
        source = conn.execute("SELECT * FROM crawl_sources WHERE id=?", [doc["source_id"]]).fetchone()
        source_type = dict(source)["source_type"] if source else ""

        def safe_name(s):
            return _re.sub(r'[<>:"/\\|?*]', '_', s)[:100]

        if '/' in title and tree_path.endswith(title):
            parent = tree_path[:-len(title)].rstrip('/')
            parts = [safe_name(p) for p in parent.split('/') if p]
            parts.append(safe_name(title))
        else:
            parts = [safe_name(p) for p in tree_path.split('/')]

        project_root = Path(__file__).resolve().parent.parent.parent.parent
        if source_type == "confluence":
            base = project_root / "packages" / "confluence-downloader" / "output"
            img_path = base / "/".join(parts) / "images" / filename
        else:
            # Excel: filename에 "시트명/이미지파일" 형태
            base = project_root / "packages" / "xlsx-extractor" / "output"
            wb_name = title.replace('.xlsx', '').replace('.xlsm', '')
            wb_dir = base / wb_name
            if not wb_dir.exists():
                wb_dir = base / f"PK_{wb_name}"
            img_path = wb_dir / filename  # 예: 변신/_final/images/xxx.png

        if not img_path.exists():
            raise HTTPException(status_code=404, detail=f"Image not found: {filename}")

        # MIME type
        suffix = img_path.suffix.lower()
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp"
                }.get(suffix.lstrip('.'), "application/octet-stream")
        return FileResponse(str(img_path), media_type=mime)


@app.get("/admin/pipeline/documents/{doc_id}/download")
def pipeline_document_download(doc_id: int):
    """Excel 원본 파일 다운로드."""
    from fastapi.responses import FileResponse
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        doc = pdb.get_document(conn, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        meta = json.loads(doc.get("metadata", "{}") or "{}")
        source = conn.execute("SELECT * FROM crawl_sources WHERE id=?", [doc["source_id"]]).fetchone()
        if not source or dict(source)["source_type"] != "perforce":
            raise HTTPException(status_code=400, detail="Excel 다운로드는 Perforce 소스만 지원")
        props = json.loads(dict(source).get("properties", "{}"))
        local_path = props.get("local_path", "")
        file_path = Path(local_path) / doc.get("file_path", "")
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=f"파일 없음: {file_path}")
        return FileResponse(str(file_path), filename=file_path.name,
                            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/admin/pipeline/jobs")
def pipeline_jobs(status: str = None, job_type: str = None, limit: int = 50, offset: int = 0, source_id: int = None):
    """작업 내역 목록 (페이징 지원)."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        jobs = pdb.list_jobs(conn, status=status, job_type=job_type, limit=limit, offset=offset, source_id=source_id)
        stats = pdb.get_job_stats(conn)
        # 작업별 progress 주입
        for j in jobs:
            if j.get("status") == "running" and j.get("job_type") == "crawl" and j.get("source_id"):
                if not j.get("progress"):
                    total = conn.execute(
                        "SELECT COUNT(*) as cnt FROM documents WHERE source_id = ?",
                        [j["source_id"]]
                    ).fetchone()["cnt"]
                    converted = conn.execute(
                        "SELECT COUNT(*) as cnt FROM documents WHERE source_id = ? AND status = 'converted'",
                        [j["source_id"]]
                    ).fetchone()["cnt"]
                    j["progress"] = f"{converted}/{total} 페이지 변환 완료"
            # 완료된 크롤링 작업: result 요약을 doc_title(문서 컬럼)에 표시
            if j.get("job_type") == "crawl" and j.get("result"):
                try:
                    r = json.loads(j["result"]) if isinstance(j["result"], str) else j["result"]
                    parts = []
                    if r.get("new_files"):
                        parts.append(f"생성 {r['new_files']}")
                    if r.get("changed_files"):
                        parts.append(f"변경 {r['changed_files']}")
                    if r.get("deleted_files"):
                        parts.append(f"삭제 {r['deleted_files']}")
                    if r.get("unchanged_files"):
                        parts.append(f"유지 {r['unchanged_files']}")
                    if not parts and not r.get("total_files"):
                        parts.append("변경 없음")
                    if parts:
                        j["doc_title"] = f"[{j.get('source_name', '')}] {', '.join(parts)}"
                except Exception:
                    pass
        total_count = pdb.count_jobs(conn, status=status, job_type=job_type, source_id=source_id)
        return {"jobs": jobs, "stats": stats, "total": total_count}


@app.post("/admin/pipeline/jobs/trigger")
def pipeline_trigger_job(job_type: str, source_id: int = None, document_id: int = None):
    """작업 트리거."""
    pdb = _get_pipeline_db()
    worker_type = "windows" if job_type == "capture" else "any"
    with pdb.get_conn() as conn:
        job_id = pdb.create_job(conn, job_type, source_id=source_id,
                                document_id=document_id, worker_type=worker_type)
        return {"job_id": job_id, "job_type": job_type, "status": "pending"}


@app.get("/admin/pipeline/dag")
def pipeline_dag():
    """통합 파이프라인 DAG — 소스별 단계 + 공유 단계(index, kg_build).

    하나의 통합 그래프로 반환:
    - sources: 소스별 고유 단계 + 상태
    - shared: 공유 단계 (index, kg_build) — 모든 소스의 마지막 단계에서 합류
    """
    pdb = _get_pipeline_db()

    # 소스 타입별 고유 단계 (index/kg_build 제외)
    SOURCE_STAGES = {
        "perforce": {
            "pipeline": "excel-vision",
            "stages": [
                {"id": "crawl", "label": "P4 Get Latest", "desc": "P4 서버에서 7_System 폴더를 동기화하고, SHA256 해시 비교로 변경/추가된 xlsx 파일을 감지합니다."},
                {"id": "capture", "label": "ScreenShot (Excel COM)", "desc": "Excel COM을 이용해 각 시트를 PNG 스크린샷으로 캡처합니다. (Windows 전용)"},
                {"id": "convert", "label": "Vision Convert (Opus 4.6)", "desc": "Vision AI(Opus 4.6)로 스크린샷을 분석하고, OOXML 파싱 데이터로 수치를 보정하여 Markdown을 생성합니다."},
            ],
            "edges": [
                {"from": "crawl", "to": "capture"},
                {"from": "capture", "to": "convert"},
            ],
            "last_stage": "convert",
        },
        "confluence": {
            "pipeline": "confluence-enrich",
            "stages": [
                {"id": "crawl", "label": "Web Scan", "desc": "Design 하위 페이지 트리를 재귀 탐색하여 전체 목록을 수집하고, 각 페이지의 version 번호를 DB와 비교하여 신규/변경/삭제를 감지합니다. 변경된 페이지만 download 작업큐에 등록합니다."},
                {"id": "download", "label": "Web Download", "desc": "Confluence REST API로 페이지 본문(HTML)을 가져와 Markdown으로 변환하고, 첨부 이미지를 다운로드합니다. Design/시스템 디자인/스킬/... 계층 구조로 저장합니다."},
                {"id": "enrich", "label": "Image Vision (Opus 4.6)", "desc": "이미지가 포함된 페이지를 Opus 4.6 Vision API로 분석하여, 각 이미지 아래에 게임 기획 맥락의 설명을 자동 삽입합니다. (content_enriched.md 생성)"},
            ],
            "edges": [
                {"from": "crawl", "to": "download"},
                {"from": "download", "to": "enrich"},
            ],
            "last_stage": "enrich",
        },
    }

    SHARED_STAGES = [
        {"id": "index", "label": "Vector Indexing", "desc": "변환 완료된 Markdown을 청크 분할 → Titan 임베딩 → ChromaDB 벡터DB에 저장합니다."},
        {"id": "kg_build", "label": "KG Build", "desc": "시스템 간 관계를 분석하여 Knowledge Graph(NetworkX)를 생성합니다. QnA 검색 시 관련 시스템 확장에 사용됩니다."},
    ]

    with pdb.get_conn() as conn:
        sources = pdb.list_sources(conn, enabled_only=False)
        source_data = []

        for src in sources:
            src_type = src["source_type"]
            src_def = SOURCE_STAGES.get(src_type)
            if not src_def:
                continue

            stage_status = {}
            for stage in src_def["stages"]:
                row = conn.execute(
                    "SELECT status, completed_at, created_at, error_message "
                    "FROM jobs WHERE source_id = ? AND job_type = ? "
                    "ORDER BY created_at DESC LIMIT 1",
                    [src["id"], stage["id"]]
                ).fetchone()
                if row:
                    stage_status[stage["id"]] = {
                        "status": row["status"],
                        "completed_at": row["completed_at"],
                        "created_at": row["created_at"],
                        "error": row["error_message"],
                    }
                elif stage["id"] == "crawl":
                    # jobs에 없으면 crawl_logs에서 가져오기
                    cl = conn.execute(
                        "SELECT created_at, total_files, new_files, changed_files "
                        "FROM crawl_logs WHERE source_id = ? ORDER BY id DESC LIMIT 1",
                        [src["id"]]
                    ).fetchone()
                    stage_status["crawl"] = {
                        "status": "completed" if cl else "idle",
                        "completed_at": cl["created_at"] if cl else None,
                        "created_at": cl["created_at"] if cl else None,
                    } if cl else {"status": "idle"}
                else:
                    stage_status[stage["id"]] = {"status": "idle"}

                # pending/running 카운트 추가
                counts = conn.execute(
                    "SELECT status, COUNT(*) as c FROM jobs "
                    "WHERE source_id = ? AND job_type = ? AND status IN ('pending','running') "
                    "GROUP BY status",
                    [src["id"], stage["id"]]
                ).fetchall()
                for c in counts:
                    stage_status[stage["id"]][c["status"] + "_count"] = c["c"]

            # crawl 노드 시간: last_crawl_at vs job completed_at 중 최신
            src_props = json.loads(src.get("properties", "{}") or "{}")
            lca = src_props.get("last_crawl_at")
            if lca and "crawl" in stage_status:
                job_completed = stage_status["crawl"].get("completed_at") or ""
                # 둘 중 더 최신 시간 사용
                if lca > job_completed:
                    stage_status["crawl"]["completed_at"] = lca

            # 자동 크롤 상태 보정: auto_crawl이 ON이면 status를 "auto" 표시
            if src_props.get("auto_crawl_interval", 0) > 0 and "crawl" in stage_status:
                cs = stage_status["crawl"]
                if cs.get("status") not in ("running", "pending"):
                    cs["status"] = "auto"  # 자동 실행 중 (주기적)

            source_data.append({
                "source_id": src["id"],
                "source_name": src["name"],
                "source_type": src_type,
                "pipeline": src_def["pipeline"],
                "stages": src_def["stages"],
                "edges": src_def["edges"],
                "last_stage": src_def["last_stage"],
                "stage_status": stage_status,
                "settings": {
                    "auto_crawl_interval": src_props.get("auto_crawl_interval", 0),
                    "auto_download": src_props.get("auto_download", False),
                    "auto_enrich": src_props.get("auto_enrich", False),
                },
            })

        # 공유 단계 상태 (소스 무관, 가장 최근 작업 기준)
        shared_status = {}
        for stage in SHARED_STAGES:
            row = conn.execute(
                "SELECT status, completed_at, created_at, error_message "
                "FROM jobs WHERE job_type = ? "
                "ORDER BY created_at DESC LIMIT 1",
                [stage["id"]]
            ).fetchone()
            shared_status[stage["id"]] = {
                "status": row["status"] if row else "idle",
                "completed_at": row["completed_at"] if row else None,
                "created_at": row["created_at"] if row else None,
                "error": row["error_message"] if row else None,
            } if row else {"status": "idle"}

        # 가동 중인 워커 정보
        active_workers = pdb.get_active_workers(conn, timeout_sec=120)
        all_job_types = ["crawl", "download", "enrich", "capture", "convert", "index"]
        # job_type별 워커 수 집계
        workers_by_type: dict[str, int] = {}
        for w in active_workers:
            job_types = [jt.strip() for jt in (w.get("job_types") or "").split(",") if jt.strip()]
            # "any" 타입은 모든 job_type에 해당
            if "any" in job_types:
                job_types = all_job_types
            for jt in job_types:
                workers_by_type[jt] = workers_by_type.get(jt, 0) + 1

        return {
            "sources": source_data,
            "shared_stages": SHARED_STAGES,
            "shared_edges": [{"from": "index", "to": "kg_build"}],
            "shared_status": shared_status,
            "workers": workers_by_type,
        }


@app.post("/admin/pipeline/settings")
def pipeline_settings(source_id: int, auto_crawl_interval: int = None,
                      auto_download: bool = None, auto_enrich: bool = None):
    """소스별 자동화 설정 저장."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        row = conn.execute("SELECT properties FROM crawl_sources WHERE id = ?", [source_id]).fetchone()
        if not row:
            return {"error": "소스 없음"}, 404
        props = json.loads(row["properties"] or "{}")
        if auto_crawl_interval is not None:
            props["auto_crawl_interval"] = auto_crawl_interval
        if auto_download is not None:
            props["auto_download"] = auto_download
        if auto_enrich is not None:
            props["auto_enrich"] = auto_enrich
        conn.execute("UPDATE crawl_sources SET properties = ? WHERE id = ?",
                     [json.dumps(props, ensure_ascii=False), source_id])
        return {"ok": True, "settings": {
            "auto_crawl_interval": props.get("auto_crawl_interval", 0),
            "auto_download": props.get("auto_download", False),
            "auto_enrich": props.get("auto_enrich", False),
        }}


@app.post("/admin/pipeline/dag/run")
def pipeline_dag_run(source_id: int, stage: str, mode: str = "single"):
    """파이프라인 단계 실행.

    mode:
      - single: 해당 단계만 실행
      - downstream: 해당 단계 + 이후 모든 단계 순차 실행
      - all: 전체 파이프라인 실행 (첫 단계부터)
    """
    pdb = _get_pipeline_db()

    PIPELINE_DEFS = {
        "perforce": ["crawl", "capture", "convert", "index", "kg_build"],
        "confluence": ["crawl", "download", "enrich", "index", "kg_build"],
    }

    with pdb.get_conn() as conn:
        src = conn.execute("SELECT * FROM crawl_sources WHERE id = ?", [source_id]).fetchone()
        if not src:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail=f"소스 {source_id} 없음")

        src_type = src["source_type"]
        stages = PIPELINE_DEFS.get(src_type, [])
        if stage not in stages:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail=f"잘못된 단계: {stage}")

        # 실행할 단계 목록 결정
        stage_idx = stages.index(stage)
        if mode == "single":
            run_stages = [stage]
        elif mode == "downstream":
            run_stages = stages[stage_idx:]
        elif mode == "all":
            run_stages = stages[:]
        else:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail=f"잘못된 mode: {mode}")

        # pending 작업 수 확인
        pending_counts = {}
        for s in run_stages:
            cnt = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE job_type=? AND source_id=? AND status='pending'",
                [s, source_id]
            ).fetchone()[0]
            pending_counts[s] = cnt

        total_pending = sum(pending_counts.values())

    # 워커 실행: pending 작업을 처리할 워커만 띄움
    target_stage = run_stages[0] if run_stages else stage
    if target_stage != "capture" and total_pending > 0:
        worker_dir = str(Path(__file__).resolve().parent.parent.parent / "data-pipeline")
        log_path = Path(worker_dir).parent.parent / "logs"
        log_path.mkdir(exist_ok=True)
        worker_count = min(total_pending, 5)
        for wi in range(worker_count):
            subprocess.Popen(
                [sys.executable, "-m", "src.worker", "--id", f"manual-{target_stage}-{wi}", "--types", target_stage, "--once"],
                cwd=worker_dir,
                stdout=open(log_path / f"manual-{target_stage}.log", "a"),
                stderr=subprocess.STDOUT,
            )

    windows_only = target_stage == "capture"

    return {
        "source_id": source_id,
        "mode": mode,
        "windows_only": windows_only,
        "pending": pending_counts,
        "workers_launched": min(total_pending, 5) if total_pending > 0 else 0,
    }


@app.get("/admin/pipeline/issues")
def pipeline_issues(status: str = None):
    """품질 이슈 목록."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        return {"issues": pdb.list_issues(conn, status=status)}


class IssueCreate(BaseModel):
    document_id: int
    issue_type: str = "other"
    severity: str = "medium"
    title: str
    description: str = None
    reported_by: str = None


@app.post("/admin/pipeline/issues")
def pipeline_create_issue(issue: IssueCreate):
    """품질 이슈 등록 (기획자 피드백)."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        issue_id = pdb.create_issue(
            conn, issue.document_id, issue.issue_type, issue.title,
            description=issue.description, reported_by=issue.reported_by,
            severity=issue.severity
        )
        return {"issue_id": issue_id, "status": "open"}


@app.post("/admin/pipeline/rollback/document/{doc_id}")
def pipeline_rollback_document(doc_id: int, version: int, stage: str = "synthesize"):
    """문서 특정 버전으로 롤백."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.rollback_conversion(conn, doc_id, stage, version)
        return {"document_id": doc_id, "rolled_back_to": version, "stage": stage}


@app.post("/admin/pipeline/rollback/index/{snapshot_id}")
def pipeline_rollback_index(snapshot_id: int):
    """인덱스 스냅샷으로 롤백."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.activate_snapshot(conn, snapshot_id)
        return {"snapshot_id": snapshot_id, "status": "activated"}


# ── 워커용 API (개발PC → 서버 DB 접근) ──────────────────

@app.post("/admin/pipeline/workers/heartbeat")
def pipeline_worker_heartbeat(worker_id: str, worker_types: str = "any", job_types: str = "any"):
    """원격 워커 하트비트."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.worker_heartbeat(conn, worker_id,
                             worker_types.split(","),
                             job_types.split(","))
    return {"ok": True}


@app.post("/admin/pipeline/jobs/claim")
def pipeline_claim_job(worker_id: str, worker_types: str = "any"):
    """워커가 작업을 가져감."""
    pdb = _get_pipeline_db()
    types_list = [t.strip() for t in worker_types.split(",")]
    with pdb.get_conn() as conn:
        job = pdb.claim_job(conn, worker_id, types_list)
        if not job:
            return {"job": None}
        return {"job": job}


@app.post("/admin/pipeline/jobs/{job_id}/start")
def pipeline_start_job(job_id: int):
    """작업 시작 표시."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.start_job(conn, job_id)
        return {"job_id": job_id, "status": "running"}


@app.post("/admin/pipeline/jobs/{job_id}/complete")
def pipeline_complete_job(job_id: int, result: dict = None):
    """작업 완료 + 다음 단계 자동 체이닝."""
    pdb = _get_pipeline_db()
    chained = None
    with pdb.get_conn() as conn:
        # 완료 처리
        pdb.complete_job(conn, job_id, result)

        # 체이닝: capture → convert, download → enrich
        job = conn.execute("SELECT * FROM jobs WHERE id=?", [job_id]).fetchone()
        if job:
            job = dict(job)
            job_type = job.get("job_type")
            doc_id = job.get("document_id")
            source_id = job.get("source_id")

            CHAIN_MAP = {
                "capture": "convert",
                "download": "enrich",
            }
            next_type = CHAIN_MAP.get(job_type)
            if next_type and doc_id:
                # 중복 방지
                existing = conn.execute(
                    "SELECT id FROM jobs WHERE job_type=? AND document_id=? AND status IN ('pending','running','assigned')",
                    [next_type, doc_id]
                ).fetchone()
                if not existing:
                    worker_type = "any"
                    new_job_id = pdb.create_job(conn, next_type, source_id=source_id,
                                                document_id=doc_id, worker_type=worker_type, priority=4)
                    chained = {"job_type": next_type, "job_id": new_job_id}

        return {"job_id": job_id, "status": "completed", "chained": chained}


@app.post("/admin/pipeline/jobs/{job_id}/fail")
def pipeline_fail_job(job_id: int, error_message: str = "unknown error"):
    """작업 실패."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.fail_job(conn, job_id, error_message)
        return {"job_id": job_id, "status": "failed"}


@app.post("/admin/pipeline/jobs/{job_id}/retry")
def pipeline_retry_job(job_id: int):
    """실패한 작업을 pending으로 재시도."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        job = conn.execute("SELECT * FROM jobs WHERE id=?", [job_id]).fetchone()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if dict(job)["status"] not in ("failed", "completed"):
            raise HTTPException(status_code=400, detail=f"재시도 불가: status={dict(job)['status']}")
        conn.execute(
            "UPDATE jobs SET status='pending', worker_id=NULL, error_message=NULL, "
            "completed_at=NULL, assigned_at=NULL, retry_count=retry_count+1 WHERE id=?",
            [job_id]
        )
        return {"job_id": job_id, "status": "pending", "retry": True}


class DocumentUpsert(BaseModel):
    source_id: int
    file_path: str
    file_type: str
    file_hash: str = None
    file_size: int = None
    title: str = None
    metadata: dict = None


@app.post("/admin/pipeline/documents/upsert")
def pipeline_upsert_document(doc: DocumentUpsert):
    """문서 등록/갱신 (워커에서 호출). changed/is_new 반환."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        result = pdb.upsert_document(
            conn, doc.source_id, doc.file_path, doc.file_type,
            file_hash=doc.file_hash, file_size=doc.file_size,
            title=doc.title, metadata=doc.metadata
        )
        return {"document_id": result["id"],
                "changed": result["changed"],
                "is_new": result["is_new"]}


@app.post("/admin/pipeline/documents/{doc_id}/status")
def pipeline_update_doc_status(doc_id: int, status: str):
    """문서 상태 업데이트."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.update_document_status(conn, doc_id, status)
        return {"document_id": doc_id, "status": status}


class ConversionCreate(BaseModel):
    document_id: int
    stage: str
    strategy: str
    input_path: str = None
    version: int = None


@app.post("/admin/pipeline/conversions")
def pipeline_create_conversion(conv: ConversionCreate):
    """변환 이력 생성."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        conv_id = pdb.create_conversion(
            conn, conv.document_id, conv.stage, conv.strategy,
            input_path=conv.input_path, version=conv.version
        )
        return {"conversion_id": conv_id}


class ConversionComplete(BaseModel):
    output_path: str
    quality_score: float = None
    stats: dict = None


@app.post("/admin/pipeline/conversions/{conv_id}/complete")
def pipeline_complete_conversion(conv_id: int, data: ConversionComplete):
    """변환 완료."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.complete_conversion(conn, conv_id, data.output_path,
                                quality_score=data.quality_score, stats=data.stats)
        return {"conversion_id": conv_id, "status": "completed"}


@app.get("/admin/pipeline/sources/{source_id}")
def pipeline_source_detail(source_id: int):
    """소스 상세."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        source = pdb.get_source(conn, source_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source not found")
        return source


@app.get("/admin/pipeline/sources/{source_id}/documents")
def pipeline_source_documents(source_id: int):
    """소스의 모든 문서 목록."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        docs = pdb.get_documents_by_source(conn, source_id)
        return {"documents": docs}


@app.post("/admin/pipeline/sources/{source_id}/properties")
def pipeline_update_source_props(source_id: int, properties: dict):
    """소스 properties 머지 업데이트."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        pdb.update_source_properties(conn, source_id, properties)
        return {"source_id": source_id, "status": "updated"}


@app.get("/admin/pipeline/crawl-logs")
def pipeline_crawl_logs(source_id: int = None, limit: int = 20):
    """크롤 히스토리 로그."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        logs = pdb.list_crawl_logs(conn, source_id=source_id, limit=limit)
        return {"logs": logs}


@app.post("/admin/pipeline/crawl-logs")
def pipeline_create_crawl_log(data: dict):
    """크롤 로그 생성 (워커에서 호출)."""
    pdb = _get_pipeline_db()
    with pdb.get_conn() as conn:
        log_id = pdb.create_crawl_log(
            conn, data["source_id"],
            job_id=data.get("job_id"),
            crawl_type=data.get("crawl_type", "full"),
            total_files=data.get("total_files", 0),
            new_files=data.get("new_files", 0),
            changed_files=data.get("changed_files", 0),
            unchanged_files=data.get("unchanged_files", 0),
            deleted_files=data.get("deleted_files", 0),
            errors=data.get("errors", 0),
            details=data.get("details"),
            duration_sec=data.get("duration_sec"),
        )
        return {"log_id": log_id}


# ── Webhook 트리거 (P4/Confluence 변경 알림) ──────────────

@app.post("/webhook/perforce")
def webhook_perforce(data: dict):
    """Perforce trigger에서 호출. changelist 변경 시 크롤링 작업 생성.

    P4 trigger 설정 예시:
      proj-k-crawl change-commit //main/ProjectK/.../7_System/... "curl -X POST http://서버:8088/webhook/perforce -H 'Content-Type: application/json' -d '{\"changelist\": %changelist%, \"depot_path\": \"//main/ProjectK/.../7_System/...\"}"
    """
    pdb = _get_pipeline_db()
    depot_path = data.get("depot_path", "")
    changelist = data.get("changelist")

    with pdb.get_conn() as conn:
        sources = pdb.list_sources(conn, enabled_only=True)
        matched = [s for s in sources if s["source_type"] == "perforce"
                   and depot_path.startswith(s["path"].replace("/...", "").rstrip("/"))]

        if not matched:
            return {"status": "ignored", "reason": "no matching source"}

        jobs_created = []
        for source in matched:
            job_id = pdb.create_job(conn, "crawl", source_id=source["id"], priority=2,
                                     params={"trigger": "webhook", "changelist": changelist})
            jobs_created.append({"source": source["name"], "job_id": job_id})

    return {"status": "triggered", "changelist": changelist, "jobs": jobs_created}


@app.post("/webhook/confluence")
def webhook_confluence(data: dict):
    """Confluence webhook에서 호출. 페이지 변경 시 크롤링 작업 생성.

    Confluence webhook 설정: Admin → Webhooks → URL: http://서버:8088/webhook/confluence
    이벤트: page_created, page_updated, page_removed
    """
    pdb = _get_pipeline_db()
    # Confluence webhook payload에서 페이지 정보 추출
    page = data.get("page", {})
    page_id = str(page.get("id", ""))
    event = data.get("eventType", data.get("event", "unknown"))
    space_key = page.get("spaceKey", data.get("space", {}).get("key", ""))

    with pdb.get_conn() as conn:
        sources = pdb.list_sources(conn, enabled_only=True)
        matched = [s for s in sources if s["source_type"] == "confluence"]

        if not matched:
            return {"status": "ignored", "reason": "no confluence source configured"}

        jobs_created = []
        for source in matched:
            job_id = pdb.create_job(conn, "crawl", source_id=source["id"], priority=2,
                                     params={"trigger": "webhook", "event": event,
                                             "page_id": page_id, "space_key": space_key})
            jobs_created.append({"source": source["name"], "job_id": job_id})

    return {"status": "triggered", "event": event, "page_id": page_id, "jobs": jobs_created}
