"""
Project K MCP Tools for Claude Agent SDK
==========================================
In-process MCP server — knowledge_graph.json 래퍼와 동의어 조회.
Glob/Grep/Read는 SDK 내장 도구를 사용하므로 여기선 보조 도구만 정의.
"""

import json
import os
from pathlib import Path
from typing import Optional

from claude_agent_sdk import tool, create_sdk_mcp_server


# 방어적 .env 로딩 — 모듈 단독 import (probe·테스트 등) 에서도 TAVILY_API_KEY 등이 살게.
# agent.py 가 이미 로드했으면 setdefault 라 noop. 둘 다 로드 (qna-poc 폴백).
_POC_DIR = Path(__file__).parent.parent.resolve()
for _env in [_POC_DIR / ".env", _POC_DIR.parent / "qna-poc" / ".env"]:
    if _env.exists():
        for _line in _env.read_text().splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip())

ROOT = Path(__file__).parent.parent.resolve()           # packages/agent-sdk-poc
REPO_ROOT = ROOT.parent.parent                           # repo root
KG_PATH = ROOT / "index" / "knowledge_graph.json"        # symlink to _knowledge_base/knowledge_graph.json

# 동의어 사전 — Phase 2에서 qna-poc/src/retriever.py:62-265 내용을 이식
GLOSSARY: dict[str, list[str]] = {
    # 임시 시드 — 실제 이식은 Phase 2에서 수행
    # "전투": ["PK_기본전투 시스템", "PK_전투 공식", "PK_자동 전투 시스템"],
    # "스킬": ["PK_변신 및 스킬 시스템"],
}


def _load_kg() -> dict:
    if not KG_PATH.exists():
        return {"systems": {}, "relations": []}
    return json.loads(KG_PATH.read_text(encoding="utf-8"))


def _text_result(data: dict) -> dict:
    text = json.dumps(data, ensure_ascii=False, default=str)
    if len(text) > 12000:
        text = text[:12000] + "\n... (truncated)"
    return {"content": [{"type": "text", "text": text}]}


# ── Tool 1: list_systems ─────────────────────────────────────

@tool(
    name="list_systems",
    description=(
        "Project K 지식 베이스의 전체 시스템 목록을 반환한다.\n"
        "새 질문에서 어떤 시스템이 있는지 조망하고 싶을 때 호출.\n"
        "반환: [{name, source, path, sheet_count}] 형태."
    ),
    input_schema={
        "type": "object",
        "properties": {},
    },
)
async def list_systems(args: dict):
    kg = _load_kg()
    systems = kg.get("systems", {})
    items = []
    for name, meta in systems.items():
        sources = meta.get("source_files", []) or []
        items.append({
            "name": name,
            "file_types": meta.get("file_types", []),
            "source_dir": sources[0] if sources else "",
            "sheet_count": meta.get("sheet_count", 0),
            "description": meta.get("description", "")[:120],
        })
    items.sort(key=lambda x: x["name"])
    return _text_result({"count": len(items), "systems": items})


# ── Tool 2: find_related_systems ─────────────────────────────

@tool(
    name="find_related_systems",
    description=(
        "주어진 시스템과 관련된 시스템을 KG에서 탐색한다 (BFS, depth 기본 1).\n"
        "교차 시스템 질문(예: '변신이 장비와 어떻게 연결되나?')에서 사용.\n"
        "반환: [{name, relation, path}] — 각 항목의 content.md 경로 포함."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "system_name": {
                "type": "string",
                "description": "시작 시스템명 (예: 'PK_변신 및 스킬 시스템')",
            },
            "depth": {
                "type": "integer",
                "description": "BFS 탐색 깊이 (1~3, 기본 1)",
            },
        },
        "required": ["system_name"],
    },
)
async def find_related_systems(args: dict):
    kg = _load_kg()
    start = args.get("system_name", "").strip()
    depth = max(1, min(3, int(args.get("depth", 1))))

    if not start:
        return _text_result({"status": "error", "error": "system_name required"})

    systems = kg.get("systems", {})

    # KG systems 각 항목의 related_systems 를 adjacency로 사용
    def neighbors(name: str) -> list[str]:
        return systems.get(name, {}).get("related_systems", []) or []

    if start not in systems:
        return _text_result({
            "status": "not_found",
            "error": f"system '{start}' not in KG",
            "hint": "use list_systems to see available system names",
        })

    visited = {start: 0}
    frontier = [start]
    for _ in range(depth):
        next_frontier = []
        for cur in frontier:
            for nbr in neighbors(cur):
                if nbr not in visited:
                    visited[nbr] = visited[cur] + 1
                    next_frontier.append(nbr)
        frontier = next_frontier

    results = []
    for name, d in visited.items():
        if name == start:
            continue
        meta = systems.get(name, {})
        src = (meta.get("source_files", []) or [""])[0]
        results.append({
            "name": name,
            "distance": d,
            "source_dir": src,
            "sheet_count": meta.get("sheet_count", 0),
            "description": meta.get("description", "")[:120],
        })
    results.sort(key=lambda x: (x["distance"], x["name"]))

    return _text_result({
        "start": start,
        "depth": depth,
        "count": len(results),
        "related": results,
    })


# ── Tool 3: glossary_lookup ──────────────────────────────────

@tool(
    name="glossary_lookup",
    description=(
        "사용자가 사용한 일상 표현을 Project K의 공식 시스템명으로 변환한다.\n"
        "예: '전투' → ['PK_기본전투 시스템', 'PK_전투 공식']\n"
        "반환값이 빈 리스트면 해당 표현은 사전에 없음 → 그냥 키워드로 Grep 시도."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "term": {
                "type": "string",
                "description": "사용자가 언급한 표현 (예: '전투', '스킬')",
            },
        },
        "required": ["term"],
    },
)
async def glossary_lookup(args: dict):
    term = args.get("term", "").strip()
    if not term:
        return _text_result({"status": "error", "error": "term required"})

    # 완전 일치 우선, 부분 일치 fallback
    if term in GLOSSARY:
        return _text_result({"term": term, "match": "exact", "systems": GLOSSARY[term]})

    partial: list[str] = []
    for key, vals in GLOSSARY.items():
        if term in key or key in term:
            partial.extend(vals)
    return _text_result({
        "term": term,
        "match": "partial" if partial else "none",
        "systems": sorted(set(partial)),
    })


# ── Tool 4: compare_with_reference_games ─────────────────────

@tool(
    name="compare_with_reference_games",
    description=(
        "타게임(리니지M/W, Lord Nine, Vampir)에서 유사한 시스템·메카닉을 조회한다.\n"
        "사용자가 명시적으로 '타게임 비교'·'레퍼런스'·'사례'를 요구하거나\n"
        "비교 모드가 활성화된 경우에만 호출. 평소에는 호출 금지.\n"
        "반환: {게임명: [{name, category, type, summary, source_url, source_label}, ...]}.\n"
        "답변에서 (출처: <source_label> § <섹션>) 형식으로 인용."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "keyword": {
                "type": "string",
                "description": "검색 키워드 (예: '전투', '강화', 'PVP', '변신', '혈맹')",
            },
            "aspect": {
                "type": "string",
                "description": "ontology category 또는 '전체' (예: 'combat', 'pvp', 'progression')",
            },
            "games": {
                "type": "array",
                "items": {"type": "string"},
                "description": "lineage_m|lineage_w|lord_nine|vampir 부분집합. 생략 시 4종 모두.",
            },
        },
        "required": ["keyword"],
    },
)
async def compare_with_reference_games(args: dict):
    from external_games import search_systems, search_raw

    keyword = (args.get("keyword") or "").strip()
    if not keyword:
        return _text_result({"status": "error", "error": "keyword required"})

    aspect = args.get("aspect", "전체")
    games = args.get("games") or None
    include_raw = bool(args.get("include_raw", False))

    kg_result = search_systems(keyword=keyword, aspect=aspect, games=games, limit_per_game=3)
    raw_result: dict = {}
    # KG 가 비었거나, 사용자가 명시적으로 raw 포함을 요청했으면 raw 도 검색
    if include_raw or not kg_result:
        raw_result = search_raw(query=keyword, games=games, max_files_per_game=2, snippet_chars=350)

    if not kg_result and not raw_result:
        return _text_result({
            "status": "no_match",
            "keyword": keyword,
            "message": (
                "KG·raw 모두 매칭 0건. 키워드를 바꿔 재시도하거나 답변에 "
                "'타게임 사례 확인되지 않음' 명시. 추측 금지."
            ),
        })
    return _text_result({
        "keyword": keyword,
        "kg_results": kg_result,         # 구조화 entity (추천 인용)
        "raw_results": raw_result,        # 커뮤니티/공식 글 발췌 (보조 인용)
        "raw_included": bool(raw_result),
    })


# ── Tool 5: search_external_game ──────────────────────────────

@tool(
    name="search_external_game",
    description=(
        "특정 게임에 대한 직접 조회. 사용자가 게임 이름(HIT2, 리니지M, Lord Nine, "
        "검은사막, 로스트아크 등)을 명시적으로 거론한 경우 사용한다.\n"
        "- 4게임(리니지M/W, Lord Nine, Vampir) 이면 KG + raw 모두 검색.\n"
        "- 그 외 게임명(HIT2 등)은 raw 전체에서 게임명+쿼리 동시 매칭으로 사례 수집.\n"
        "반환: {game, game_id, kg_hits[], raw_hits[], cross_mentions[]}.\n"
        "cross_mentions 의 found_in_game 은 'X 게임 raw 안에서 언급된 Y' 라는 뜻 — 답변에서 \n"
        "출처 표기 시 'X 게임 커뮤니티 자료에 언급' 형태로 인용."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "game_name": {
                "type": "string",
                "description": "조회할 게임 이름 (예: 'HIT2', '리니지M', '검은사막')",
            },
            "query": {
                "type": "string",
                "description": "검색 쿼리 — 메카닉/시스템/키워드 (예: '서버 버프', '강화', '투표')",
            },
            "limit": {
                "type": "integer",
                "description": "각 결과 타입별 최대 개수 (기본 5)",
            },
        },
        "required": ["game_name", "query"],
    },
)
async def search_external_game(args: dict):
    from external_games import search_external_game as _search

    game_name = (args.get("game_name") or "").strip()
    query = (args.get("query") or "").strip()
    if not game_name or not query:
        return _text_result({"status": "error", "error": "game_name and query required"})

    limit = int(args.get("limit", 5))
    result = _search(game_name=game_name, query=query, limit=limit)

    # 빈 결과 처리 — 명확한 miss 메시지로 환각 방지
    has_any = bool(result.get("kg_hits") or result.get("raw_hits") or result.get("cross_mentions"))
    if not has_any:
        result["status"] = "no_match"
        result["message"] = (
            f"'{game_name}'(과)와 '{query}' 가 동시 매칭되는 자료를 찾지 못함. "
            f"답변에 '{game_name} 의 {query} 관련 자료 확인되지 않음' 명시. 추측 금지."
        )
    return _text_result(result)


# ── Tool 6: web_search (Gemini google_search grounding) ─────────
# 2026-04-21: Tavily → Gemini swap. A/B 결과 (tests/ab_out/) 기준:
#   - 답변 정확도: Gemini 우수 (요일별 인원 차등 수치까지 정확)
#   - 비용: Tavily $0.08/q vs Gemini ~$0 (Gemini Flash + grounding free tier)
#   - 속도: 동급 (~10초)
# Tavily 코드는 git history 에 보존 (원복 필요시 commit 58f3e83 참조).

@tool(
    name="web_search",
    description=(
        "Gemini google_search grounding 으로 인터넷에서 실시간 조회.\n"
        "Deep Research(compare_mode=True) 에서 oracle KG·raw 모두 0건이거나 빈약할 때만 호출.\n"
        "Gemini 가 자동으로 검색 쿼리 분해·결과 합성·citation 생성을 처리한다.\n"
        "반환: {query, answer, citations:[{title, domain, url}], grounding_queries:[...]}.\n"
        "agent 는 answer 를 토대로 답변하고, 사실 인용은 citations 의 domain 을 사용:\n"
        "  형식: (출처: web/<domain>/<title> § <섹션>)"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "검색 쿼리 (예: '검은사막 거점전 인원 제한', 'HIT2 조율자의 제단')",
            },
            "model": {
                "type": "string",
                "description": "'flash' (기본·빠름·저렴) | 'pro' (더 깊은 합성, 비용 ↑)",
            },
        },
        "required": ["query"],
    },
)
async def web_search(args: dict):
    import os

    query = (args.get("query") or "").strip()
    if not query:
        return _text_result({"status": "error", "error": "query required"})

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return _text_result({
            "status": "error",
            "error": "GEMINI_API_KEY 미설정 — 답변에 'web 미확인 (key 부재)' 명시 후 진행.",
        })

    model_alias = (args.get("model") or "flash").lower()
    model = "gemini-2.5-pro" if model_alias == "pro" else "gemini-2.5-flash"

    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=api_key)
        resp = client.models.generate_content(
            model=model,
            contents=query,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                temperature=0.2,
            ),
        )
    except Exception as e:
        return _text_result({
            "status": "error",
            "error": f"Gemini call failed: {type(e).__name__}: {str(e)[:200]}",
        })

    answer = getattr(resp, "text", None) or ""
    grounding_queries: list[str] = []
    citations: list[dict] = []
    if resp.candidates:
        gm = getattr(resp.candidates[0], "grounding_metadata", None)
        if gm:
            grounding_queries = list(getattr(gm, "web_search_queries", None) or [])
            chunks = getattr(gm, "grounding_chunks", None) or []
            for c in chunks:
                web = getattr(c, "web", None)
                if web:
                    uri = getattr(web, "uri", "") or ""
                    title = getattr(web, "title", "") or ""
                    # Gemini grounding chunk 의 title 패턴 (실측):
                    #   (a) "tistory.com"          ← title 자체가 도메인
                    #   (b) "페이지 제목 - tistory.com"   ← 일부 사이트
                    #   (c) "페이지 제목 | inven.co.kr"
                    # uri 는 vertexaisearch redirect 라 호스트 추출 불가 → title 에서만 도출.
                    if " - " in title:
                        domain = title.rsplit(" - ", 1)[-1].strip()
                        clean_title = title.rsplit(" - ", 1)[0].strip()
                    elif " | " in title:
                        domain = title.rsplit(" | ", 1)[-1].strip()
                        clean_title = title.rsplit(" | ", 1)[0].strip()
                    elif title and "." in title and "/" not in title and " " not in title:
                        # title 자체가 도메인 (예: "tistory.com")
                        domain = title
                        clean_title = title
                    else:
                        domain = ""
                        clean_title = title
                    citations.append({
                        "title": clean_title or domain or "(제목 없음)",
                        "domain": domain,
                        "url": uri,
                    })

    um = getattr(resp, "usage_metadata", None)
    usage = {}
    if um:
        usage = {
            "prompt_tokens": getattr(um, "prompt_token_count", None),
            "output_tokens": getattr(um, "candidates_token_count", None),
            "total_tokens": getattr(um, "total_token_count", None),
        }

    return _text_result({
        "query": query,
        "model": model,
        "answer": answer[:4000],   # Gemini 종합 답변 (대부분 800~1500자)
        "citations": citations[:10],
        "citation_count": len(citations),
        "grounding_queries": grounding_queries[:6],
        "usage": usage,
    })


# ── MCP Server Factory ───────────────────────────────────────

def create_projk_server():
    return create_sdk_mcp_server(
        name="projk",
        version="0.1.0",
        tools=[
            list_systems,
            find_related_systems,
            glossary_lookup,
            compare_with_reference_games,
            search_external_game,
            web_search,
        ],
    )
