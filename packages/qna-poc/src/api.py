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
    model: str = "claude-opus-4-5"
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

def _get_pipeline_conn():
    """데이터 파이프라인 DB 연결."""
    import sys as _sys
    pipeline_dir = Path(__file__).resolve().parent.parent.parent / "data-pipeline"
    _sys.path.insert(0, str(pipeline_dir))
    from src.db import get_conn, init_db
    init_db()
    return get_conn


@app.get("/admin/pipeline/status")
def pipeline_status():
    """데이터 파이프라인 전체 현황."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import get_pipeline_stats
    with get_conn_fn() as conn:
        return get_pipeline_stats(conn)


@app.get("/admin/pipeline/sources")
def pipeline_sources():
    """크롤링 소스 목록."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import list_sources
    with get_conn_fn() as conn:
        return {"sources": list_sources(conn, enabled_only=False)}


@app.get("/admin/pipeline/documents")
def pipeline_documents(source_id: int = None, status: str = None, limit: int = 100):
    """문서 목록."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import list_documents
    with get_conn_fn() as conn:
        docs = list_documents(conn, source_id=source_id, status=status)
        return {"documents": docs[:limit], "total": len(docs)}


@app.get("/admin/pipeline/documents/{doc_id}")
def pipeline_document_detail(doc_id: int):
    """문서 상세 + 변환 이력."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import get_document, list_conversion_history, list_issues
    with get_conn_fn() as conn:
        doc = get_document(conn, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")
        conversions = list_conversion_history(conn, doc_id)
        issues = list_issues(conn, document_id=doc_id)
        return {"document": doc, "conversions": conversions, "issues": issues}


@app.get("/admin/pipeline/jobs")
def pipeline_jobs(status: str = None, job_type: str = None, limit: int = 50):
    """작업큐 목록."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import list_jobs, get_job_stats
    with get_conn_fn() as conn:
        jobs = list_jobs(conn, status=status, job_type=job_type, limit=limit)
        stats = get_job_stats(conn)
        return {"jobs": jobs, "stats": stats}


@app.post("/admin/pipeline/jobs/trigger")
def pipeline_trigger_job(job_type: str, source_id: int = None, document_id: int = None):
    """작업 트리거."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import create_job
    worker_type = "windows" if job_type == "capture" else "any"
    with get_conn_fn() as conn:
        job_id = create_job(conn, job_type, source_id=source_id,
                            document_id=document_id, worker_type=worker_type)
        return {"job_id": job_id, "job_type": job_type, "status": "pending"}


@app.get("/admin/pipeline/issues")
def pipeline_issues(status: str = None):
    """품질 이슈 목록."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import list_issues
    with get_conn_fn() as conn:
        return {"issues": list_issues(conn, status=status)}


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
    get_conn_fn = _get_pipeline_conn()
    from src.db import create_issue
    with get_conn_fn() as conn:
        issue_id = create_issue(
            conn, issue.document_id, issue.issue_type, issue.title,
            description=issue.description, reported_by=issue.reported_by,
            severity=issue.severity
        )
        return {"issue_id": issue_id, "status": "open"}


@app.post("/admin/pipeline/rollback/document/{doc_id}")
def pipeline_rollback_document(doc_id: int, version: int, stage: str = "synthesize"):
    """문서 특정 버전으로 롤백."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import rollback_conversion
    with get_conn_fn() as conn:
        rollback_conversion(conn, doc_id, stage, version)
        return {"document_id": doc_id, "rolled_back_to": version, "stage": stage}


@app.post("/admin/pipeline/rollback/index/{snapshot_id}")
def pipeline_rollback_index(snapshot_id: int):
    """인덱스 스냅샷으로 롤백."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import activate_snapshot
    with get_conn_fn() as conn:
        activate_snapshot(conn, snapshot_id)
        return {"snapshot_id": snapshot_id, "status": "activated"}


# ── 워커용 API (개발PC → 서버 DB 접근) ──────────────────

@app.post("/admin/pipeline/jobs/claim")
def pipeline_claim_job(worker_id: str, worker_types: str = "any"):
    """워커가 작업을 가져감."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import claim_job
    types_list = [t.strip() for t in worker_types.split(",")]
    with get_conn_fn() as conn:
        job = claim_job(conn, worker_id, types_list)
        if not job:
            return {"job": None}
        return {"job": job}


@app.post("/admin/pipeline/jobs/{job_id}/start")
def pipeline_start_job(job_id: int):
    """작업 시작 표시."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import start_job
    with get_conn_fn() as conn:
        start_job(conn, job_id)
        return {"job_id": job_id, "status": "running"}


@app.post("/admin/pipeline/jobs/{job_id}/complete")
def pipeline_complete_job(job_id: int, result: dict = None):
    """작업 완료."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import complete_job
    with get_conn_fn() as conn:
        complete_job(conn, job_id, result)
        return {"job_id": job_id, "status": "completed"}


@app.post("/admin/pipeline/jobs/{job_id}/fail")
def pipeline_fail_job(job_id: int, error_message: str = "unknown error"):
    """작업 실패."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import fail_job
    with get_conn_fn() as conn:
        fail_job(conn, job_id, error_message)
        return {"job_id": job_id, "status": "failed"}


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
    """문서 등록/갱신 (워커에서 호출)."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import upsert_document
    with get_conn_fn() as conn:
        doc_id = upsert_document(
            conn, doc.source_id, doc.file_path, doc.file_type,
            file_hash=doc.file_hash, file_size=doc.file_size,
            title=doc.title, metadata=doc.metadata
        )
        return {"document_id": doc_id}


@app.post("/admin/pipeline/documents/{doc_id}/status")
def pipeline_update_doc_status(doc_id: int, status: str):
    """문서 상태 업데이트."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import update_document_status
    with get_conn_fn() as conn:
        update_document_status(conn, doc_id, status)
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
    get_conn_fn = _get_pipeline_conn()
    from src.db import create_conversion
    with get_conn_fn() as conn:
        conv_id = create_conversion(
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
    get_conn_fn = _get_pipeline_conn()
    from src.db import complete_conversion
    with get_conn_fn() as conn:
        complete_conversion(conn, conv_id, data.output_path,
                            quality_score=data.quality_score, stats=data.stats)
        return {"conversion_id": conv_id, "status": "completed"}


@app.get("/admin/pipeline/sources/{source_id}")
def pipeline_source_detail(source_id: int):
    """소스 상세."""
    get_conn_fn = _get_pipeline_conn()
    from src.db import get_source
    with get_conn_fn() as conn:
        source = get_source(conn, source_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source not found")
        return source
