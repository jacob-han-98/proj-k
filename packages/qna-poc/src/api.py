"""
api.py — FastAPI QnA 엔드포인트

POST /ask          기획 QnA
POST /search       검색만 (디버그용)
GET  /systems      시스템 목록
GET  /systems/{name}/related  관련 시스템
"""

import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from src.retriever import retrieve, format_context, extract_system_names, get_related_systems, _build_structural_index
from src.generator import generate_answer

app = FastAPI(title="Project K QnA PoC", version="0.1.0")

# 대화 메모리 (in-memory, 서버 재시작 시 초기화)
conversations: dict[str, list[tuple[str, str]]] = {}


# ── Request/Response 모델 ──

class AskRequest(BaseModel):
    question: str
    conversation_id: str | None = None
    role: str | None = None
    model: str | None = None


class AskResponse(BaseModel):
    answer: str
    sources: list[dict]
    confidence: str
    related_systems: list[str]
    conversation_id: str
    tokens_used: dict
    api_seconds: float


class SearchRequest(BaseModel):
    query: str
    limit: int = 10


class SearchResult(BaseModel):
    results: list[dict]
    detected_systems: list[str]


# ── 엔드포인트 ──

@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest):
    """기획 QnA 질문."""
    # 대화 ID 관리
    conv_id = req.conversation_id or str(uuid.uuid4())
    history = conversations.get(conv_id, [])

    # 검색
    chunks = retrieve(req.question, top_k=12)
    if not chunks:
        raise HTTPException(status_code=404, detail="관련 기획서를 찾을 수 없습니다.")

    context = format_context(chunks)

    # 답변 생성
    result = generate_answer(
        question=req.question,
        context=context,
        role=req.role,
        conversation_history=history,
        model=req.model,
    )

    # 관련 시스템 추출
    detected = extract_system_names(req.question)
    related = []
    for sys_name in detected[:2]:
        related.extend(get_related_systems(sys_name, depth=1))
    related = sorted(set(related) - set(detected))[:10]

    # 대화 히스토리 저장 (최근 3턴)
    history.append((req.question, result["answer"]))
    conversations[conv_id] = history[-3:]

    return AskResponse(
        answer=result["answer"],
        sources=result["sources"],
        confidence=result["confidence"],
        related_systems=related,
        conversation_id=conv_id,
        tokens_used=result["tokens_used"],
        api_seconds=result["api_seconds"],
    )


@app.post("/search", response_model=SearchResult)
async def search_docs(req: SearchRequest):
    """검색만 수행 (디버그/테스트용)."""
    chunks = retrieve(req.query, top_k=req.limit)
    detected = extract_system_names(req.query)

    results = []
    for chunk in chunks:
        results.append({
            "workbook": chunk["workbook"],
            "sheet": chunk["sheet"],
            "section_path": chunk["section_path"],
            "score": round(chunk["score"], 4),
            "tokens": chunk["tokens"],
            "preview": chunk["text"][:300] + "..." if len(chunk["text"]) > 300 else chunk["text"],
        })

    return SearchResult(results=results, detected_systems=detected)


@app.get("/systems")
async def list_systems():
    """인덱싱된 시스템 목록."""
    index = _build_structural_index()
    systems = sorted(index.keys())
    return {"systems": systems, "count": len(systems)}


@app.get("/systems/{name}/related")
async def related_systems(name: str):
    """관련 시스템 조회."""
    related = get_related_systems(name, depth=2)
    return {"system": name, "related": related, "count": len(related)}
