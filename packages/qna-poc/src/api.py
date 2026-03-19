"""
api.py — FastAPI QnA 엔드포인트

POST /ask          기획 QnA (Agent 파이프라인)
POST /ask_stream   기획 QnA + SSE 스트리밍 (상태 + 결과)
POST /search       검색만 (디버그용)
GET  /systems      시스템 목록
GET  /systems/{name}/related  관련 시스템
GET  /health       헬스체크
"""

import json
import queue
import threading
import uuid
from pathlib import Path

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

# 대화 메모리 (in-memory, 서버 재시작 시 초기화)
conversations: dict[str, list[tuple[str, str]]] = {}
_conv_lock = threading.Lock()


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

    # 이전 대화 히스토리 조회
    with _conv_lock:
        conv_history = list(conversations.get(conv_id, []))

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
            })

    # 대화 히스토리 저장 (최근 5턴)
    with _conv_lock:
        history = conversations.get(conv_id, [])
        history.append((req.question, result["answer"]))
        conversations[conv_id] = history[-5:]

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

    with _conv_lock:
        conv_history = list(conversations.get(conv_id, []))

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

        # 대화 히스토리 저장
        with _conv_lock:
            history = conversations.get(conv_id, [])
            history.append((req.question, result["answer"]))
            conversations[conv_id] = history[-5:]

        payload = {
            "answer": result["answer"],
            "confidence": result.get("confidence", "medium"),
            "sources": sources[:10],
            "conversation_id": conv_id,
            "total_tokens": result.get("total_tokens", 0),
            "api_seconds": result.get("total_api_seconds", 0),
        }
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
