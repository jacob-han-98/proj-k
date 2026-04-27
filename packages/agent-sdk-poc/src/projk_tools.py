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


def _text_result(data: dict, max_chars: int = 32000) -> dict:
    """JSON 직렬화 + 길이 제한. DataSheet list_game_tables 등 큰 응답을 위해 32KB 기본."""
    text = json.dumps(data, ensure_ascii=False, default=str)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n... (truncated)"
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
    import httpx

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

    # 2026-04-22: Gemini API 키 IP allowlist 가 IPv4 만 등록되어 있어
    # AWS EC2 (dual-stack) 에서 IPv6 우선 호출 시 403 PERMISSION_DENIED.
    # 우회 → httpx transport 의 local_address="0.0.0.0" 로 IPv4 강제.
    # (google-genai SDK 는 transport 주입이 어려우므로 REST 직접 호출로 변경.)
    # 사용자가 Cloud Console 에서 IPv6 prefix 추가하면 이 우회 없어도 됨.
    transport = httpx.HTTPTransport(local_address="0.0.0.0")
    payload = {
        "contents": [{"parts": [{"text": query}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.2},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    try:
        with httpx.Client(transport=transport, timeout=30.0) as c:
            r = c.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        body = e.response.text[:400] if e.response is not None else ""
        return _text_result({
            "status": "error",
            "error": f"Gemini HTTP {e.response.status_code}: {body}",
        })
    except Exception as e:
        return _text_result({
            "status": "error",
            "error": f"Gemini call failed: {type(e).__name__}: {str(e)[:200]}",
        })

    # 응답 파싱 — REST 스키마 기준
    candidates = data.get("candidates", []) or []
    answer = ""
    grounding_queries: list[str] = []
    citations: list[dict] = []
    if candidates:
        cand = candidates[0]
        parts = (cand.get("content") or {}).get("parts", []) or []
        answer = "".join(p.get("text", "") or "" for p in parts)
        gm = cand.get("groundingMetadata") or {}
        grounding_queries = list(gm.get("webSearchQueries") or [])
        chunks = gm.get("groundingChunks") or []
        for c in chunks:
            web = c.get("web") or {}
            uri = web.get("uri") or ""
            title = web.get("title") or ""
            # Gemini grounding chunk 의 title 패턴 (실측):
            #   (a) "tistory.com"             ← title 자체가 도메인
            #   (b) "페이지 제목 - tistory.com"
            #   (c) "페이지 제목 | inven.co.kr"
            if " - " in title:
                domain = title.rsplit(" - ", 1)[-1].strip()
                clean_title = title.rsplit(" - ", 1)[0].strip()
            elif " | " in title:
                domain = title.rsplit(" | ", 1)[-1].strip()
                clean_title = title.rsplit(" | ", 1)[0].strip()
            elif title and "." in title and "/" not in title and " " not in title:
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

    um = data.get("usageMetadata") or {}
    usage = {
        "prompt_tokens": um.get("promptTokenCount"),
        "output_tokens": um.get("candidatesTokenCount"),
        "total_tokens": um.get("totalTokenCount"),
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


# ── DataSheet (게임 런타임 데이터) — game_data.py 동적 로드 ──────

_GD_MODULE = None
_GD_TABLE_SOURCE_CACHE: dict[str, str] = {}  # table_name → source_file (예: "MonsterClass" → "MonsterClass.xlsx")
_DATASHEET_P4_PREFIX = "//main/ProjectK/Resource/design"


def _load_game_data():
    """packages/data-pipeline/src/game_data.py 를 importlib 로 로드 (qna-poc 동일 패턴).

    네임스페이스 충돌 방지 + lazy load. 실패 시 None.
    """
    global _GD_MODULE
    if _GD_MODULE is not None:
        return _GD_MODULE
    import importlib.util
    gd_path = REPO_ROOT / "packages" / "data-pipeline" / "src" / "game_data.py"
    if not gd_path.exists():
        return None
    spec = importlib.util.spec_from_file_location("gd_module", str(gd_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _GD_MODULE = mod
    return mod


def _gd_ready() -> tuple[bool, str]:
    """DataSheet DB 사용 가능 여부. (ok, error_message)"""
    mod = _load_game_data()
    if mod is None:
        return False, "data-pipeline 모듈 미발견 (packages/data-pipeline/src/game_data.py)"
    if not mod.is_db_ready():
        return False, f"DataSheet DB 미빌드 ({mod.get_db_path()}) — ingest_all 필요"
    return True, ""


def _ensure_source_cache():
    """table_name → source_file 매핑 1회 빌드 (인용용)."""
    if _GD_TABLE_SOURCE_CACHE:
        return
    ok, _ = _gd_ready()
    if not ok:
        return
    mod = _load_game_data()
    r = mod.execute_game_query({"action": "list_tables"}, mod.get_db_path())
    # columns: ['table_name', 'source_file', 'rows', 'columns', 'cs']
    for row in r.rows:
        _GD_TABLE_SOURCE_CACHE[row[0]] = row[1]


def _datasheet_citation(table_name: str) -> str:
    """테이블명 → P4 경로 (출처 인용용). 미발견 시 빈 문자열."""
    _ensure_source_cache()
    src = _GD_TABLE_SOURCE_CACHE.get(table_name, "")
    return f"{_DATASHEET_P4_PREFIX}/{src}" if src else ""


def get_datasheet_schema_summary() -> str:
    """system_prompt 주입용 컴팩트 schema. 원본 get_schema_summary (~31KB) 의 다이어트
    버전 (~10KB). cold call 비용 절감 목적.

    포함: 테이블명 / 행수 / 컬럼수 / 도메인(c/s/cs) / source_file (xlsx).
    제외: 컬럼 이름 목록, FK 관계, Enum 값 목록.
    → 자세한 컬럼·Enum 정보는 describe_game_table / lookup_game_enum 도구로 분산.

    실패 시 빈 문자열.
    """
    ok, _ = _gd_ready()
    if not ok:
        return ""
    try:
        mod = _load_game_data()
        db = mod.get_db_path()
        r = mod.execute_game_query({"action": "list_tables"}, db)
        if not r.rows:
            return ""
        lines = [f"## 게임 데이터 테이블 ({len(r.rows)}개) — DataSheet"]
        lines.append("")
        lines.append("도구 사용:")
        lines.append("- 컬럼 정의: `describe_game_table(table)` — 호출 결과는 메모리에 두고 재호출 금지")
        lines.append("- Enum 값:   `lookup_game_enum(enum_name)`")
        lines.append("- 행 조회:   `query_game_table(table, columns, filters, limit)` — 반드시 columns 명시")
        lines.append("")
        # columns: ['table_name', 'source_file', 'rows', 'columns', 'cs']
        for row in r.rows:
            tn, src, rows_, cols, dom = row
            lines.append(f"- **{tn}** ({rows_}행, {cols}컬럼, {dom}) `{src}`")
        return "\n".join(lines)
    except Exception:
        return ""


# ── Tool 7: list_game_tables ─────────────────────────────────

@tool(
    name="list_game_tables",
    description=(
        "DataSheet (게임 런타임 데이터) 의 전체 테이블 목록을 반환한다. 약 187개 테이블.\n"
        "각 테이블이 어느 xlsx 에서 왔는지(source_file), 행 수, 컬럼 수, 도메인(c=client/s=server/cs=both)을 알 수 있다.\n"
        "수치/목록/ID 검색 류 질문(예: '레전더리 무기 목록', 'X 몬스터 HP', '아이템 ID 검색')에서\n"
        "어떤 테이블을 query 할지 결정 전 호출. system_prompt 의 schema 요약에 이미 주요 정보가 있으면 생략 가능.\n"
        "반환: {count, tables:[{name, source_file, rows, columns, domain}]}"
    ),
    input_schema={"type": "object", "properties": {}},
)
async def list_game_tables(args: dict):
    ok, err = _gd_ready()
    if not ok:
        return _text_result({"status": "error", "error": err})
    mod = _load_game_data()
    r = mod.execute_game_query({"action": "list_tables"}, mod.get_db_path())
    tables = [
        {
            "name": row[0],
            "source_file": row[1],
            "rows": row[2],
            "columns": row[3],
            "domain": row[4],
        }
        for row in r.rows
    ]
    return _text_result({"count": len(tables), "tables": tables})


# ── Tool 8: describe_game_table ─────────────────────────────

@tool(
    name="describe_game_table",
    description=(
        "DataSheet 특정 테이블의 컬럼 정의를 조회. query_game_table 호출 전 정확한 컬럼명·타입·Enum 을 확인하라.\n"
        "**컬럼명 추측 금지** — LLM 추측 컬럼명은 SQL 에러를 일으킨다 (예: 실측 케이스: Skill 테이블에 'TextkeyTitle' 컬럼은 없음).\n"
        "반환: {table, source_file, column_count, columns:[{name, type, sql_type, domain, is_enum, enum_name}]}\n"
        "is_enum=true 컬럼은 lookup_game_enum 으로 값 디코딩 가능."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "table": {"type": "string", "description": "테이블명 (예: 'MonsterClass', 'Skill', 'ItemEquipClass')"},
        },
        "required": ["table"],
    },
)
async def describe_game_table(args: dict):
    ok, err = _gd_ready()
    if not ok:
        return _text_result({"status": "error", "error": err})
    table = (args.get("table") or "").strip()
    if not table:
        return _text_result({"status": "error", "error": "table required"})
    mod = _load_game_data()
    r = mod.execute_game_query({"action": "describe", "table": table}, mod.get_db_path())
    if r.error:
        return _text_result({"status": "error", "error": r.error})
    cols = [
        {
            "name": row[0],
            "type": row[1],
            "sql_type": row[2],
            "domain": row[3],
            "is_enum": row[4],
            "enum_name": row[5],
        }
        for row in r.rows
    ]
    return _text_result({
        "table": table,
        "source_file": _datasheet_citation(table),
        "column_count": len(cols),
        "columns": cols,
    })


# ── Tool 9: query_game_table ─────────────────────────────────

@tool(
    name="query_game_table",
    description=(
        "DataSheet 테이블에서 행을 조회한다. ID 직접 매칭, 부분일치(LIKE), 정렬, 페이지 크기 제한 지원.\n\n"
        "**필수 — 컬럼 셀렉션**: 일부 테이블은 47개 이상의 wide 컬럼을 가진다. 답변에 필요한 컬럼만 columns 로 명시해 토큰을 절약하라. 생략 시 전체 컬럼 반환 (대부분의 경우 비효율).\n\n"
        "**허용 연산자**: =, !=, <, >, <=, >=, LIKE, IN, IS NULL, IS NOT NULL (그 외는 거부됨)\n\n"
        "**예시**:\n"
        "  - ID 조회: table='Skill', columns=['Id','Name','Damage'], filters=[{column:'Id',op:'=',value:1001}]\n"
        "  - 부분일치: table='MonsterClass', columns=['Id','TextkeyTitle','Keyward','Level','MaxHp'], filters=[{column:'Keyward',op:'LIKE',value:'%Boss%'}], limit=10\n"
        "  - 정렬+상위: table='MonsterClass', columns=['Id','Level','MaxHp'], order_by=[{column:'MaxHp',direction:'DESC'}], limit=5\n\n"
        "반환: {table, source_file, total_matched, execution_ms, columns, rows, formatted (마크다운 표 + 출처), sql}\n\n"
        "**답변 인용 형식**: (출처: DataSheet / <테이블명> § Id=<n> 또는 행) — formatted 의 출처 줄을 그대로 사용 가능."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "table": {"type": "string", "description": "테이블명 (필수)"},
            "columns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "조회할 컬럼 목록. 생략 시 전체. wide 테이블은 반드시 명시.",
            },
            "filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "column": {"type": "string"},
                        "op": {"type": "string"},
                        "value": {},
                    },
                    "required": ["column", "op"],
                },
                "description": "필터 [{column, op, value}]. AND 결합. value 는 LIKE 연산자 사용 시 % 와일드카드 포함.",
            },
            "order_by": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "column": {"type": "string"},
                        "direction": {"type": "string"},
                    },
                    "required": ["column"],
                },
                "description": "정렬 [{column, direction:'ASC'|'DESC'}]",
            },
            "limit": {
                "type": "integer",
                "description": "최대 반환 행 수 (기본 50, 최대 500)",
            },
            "include_raw_rows": {
                "type": "boolean",
                "description": "true 면 rows (각 행 = 셀 list) 도 응답에 포함. default false — formatted (markdown 표) 만 반환해 토큰·SDK buffer 부담 절감. 셀 단위 후속 처리가 정말 필요할 때만 true.",
            },
        },
        "required": ["table"],
    },
)
async def query_game_table(args: dict):
    ok, err = _gd_ready()
    if not ok:
        return _text_result({"status": "error", "error": err})
    table = (args.get("table") or "").strip()
    if not table:
        return _text_result({"status": "error", "error": "table required"})

    spec: dict = {"action": "query", "table": table}
    if args.get("columns"):
        spec["columns"] = args["columns"]
    if args.get("filters"):
        spec["filters"] = args["filters"]
    if args.get("order_by"):
        spec["order_by"] = args["order_by"]
    if args.get("limit") is not None:
        spec["limit"] = int(args["limit"])

    mod = _load_game_data()
    r = mod.execute_game_query(spec, mod.get_db_path())
    if r.error:
        return _text_result({
            "status": "error",
            "table": table,
            "error": r.error,
            "sql": r.sql[:300],
            "hint": "describe_game_table 로 정확한 컬럼명을 먼저 확인하세요.",
        })

    formatted = mod.format_game_data_result(r, max_display=50)
    citation = _datasheet_citation(table)
    if citation:
        formatted = formatted + f"\n\n**출처**: {citation} — 테이블 `{table}`"

    response: dict = {
        "table": table,
        "source_file": citation,
        "total_matched": r.total_matched,
        "execution_ms": r.execution_ms,
        "columns": r.columns,
        "formatted": formatted,
        "sql": r.sql[:400],
    }
    # 기본은 raw rows 생략 — formatted 만으로 충분. 명시 요청 시만 첨부.
    if bool(args.get("include_raw_rows", False)):
        response["rows"] = r.rows[:50]
        response["row_truncated"] = len(r.rows) > 50
    return _text_result(response)


# ── Tool 10: lookup_game_enum ────────────────────────────────

@tool(
    name="lookup_game_enum",
    description=(
        "DataSheet 의 Enum 값 디코딩. describe_game_table 결과에서 is_enum=true 컬럼을 본 뒤 사용.\n"
        "반환: {enum, count, values:[{value, name, comment}]}\n"
        "Enum 데이터가 미인제스트된 케이스가 있을 수 있음 — 0건이면 system_prompt 의 Enum 목록 참조."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "enum_name": {"type": "string", "description": "Enum 이름 (예: 'MonsterTypeEnum', 'SkillTypeEnum')"},
        },
        "required": ["enum_name"],
    },
)
async def lookup_game_enum(args: dict):
    ok, err = _gd_ready()
    if not ok:
        return _text_result({"status": "error", "error": err})
    enum_name = (args.get("enum_name") or "").strip()
    if not enum_name:
        return _text_result({"status": "error", "error": "enum_name required"})
    mod = _load_game_data()
    r = mod.execute_game_query({"action": "lookup_enum", "enum_name": enum_name}, mod.get_db_path())
    if r.error:
        return _text_result({"status": "error", "error": r.error})
    values = [
        {
            "value": row[0],
            "name": row[1] if len(row) > 1 else "",
            "comment": row[2] if len(row) > 2 else "",
        }
        for row in r.rows
    ]
    return _text_result({"enum": enum_name, "count": r.total_matched, "values": values})


# ── DataSheet in GDD (기획서 내부 표) — foundation_tables.json 인덱스 ──

# DataSheet (game_data) 와 다름:
#   DataSheet         = 게임 런타임 데이터 (Resource/design/*.xlsx 의 lookup 테이블)
#   DataSheet in GDD  = 기획자가 GDD 안에 그린 설계 표 (예: 'HUD 요소 상세 테이블')
#
# 자산: packages/xlsx-extractor/output/**/_final/foundation_tables.json (~817개 파일)
# 파일 schema: {source_file, sheet_name, tables: [{table_id, table_name, description,
#               sample_queries, headers, rows, notes}]}

_GDD_INDEX: dict | None = None  # 1회 빌드 후 메모리 캐시
_GDD_INDEX_CACHE_PATH = ROOT / "index" / "_gdd_index.json"  # 디스크 캐시


def _build_gdd_index() -> dict:
    """xlsx-extractor/output 의 foundation_tables.json 들을 1회 스캔.

    Cold build: ~55s (817 파일 read+parse). 결과는 디스크 캐시
    (`index/_gdd_index.json`, ~3.4MB) 에 저장 → 이후 콜드 스타트는 ~200ms.

    캐시 invalidate 는 **명시적**:
      - foundation_tables.json 가 갱신됐으면 캐시 파일 삭제 후 재빌드
      - (817 파일 stat 호출이 WSL/NTFS 에서 ~40초 걸려 자동 mtime 검사는 비효율)

    인덱스 구조:
      {
        "available": bool,
        "meta": [{workbook, sheet, table_id, table_name, description, row_count, ...}],
        "by_key": {"<workbook>|<sheet>|<table_id>": "/abs/path/foundation_tables.json"},
        "built_at": float,  # cold build 시각 (정보용)
      }
    """
    global _GDD_INDEX
    if _GDD_INDEX is not None:
        return _GDD_INDEX

    # 1) 디스크 캐시 우선 사용 (mtime 검사 없음 — 명시적 invalidate)
    if _GDD_INDEX_CACHE_PATH.exists():
        try:
            cached = json.loads(_GDD_INDEX_CACHE_PATH.read_text(encoding="utf-8"))
            if cached.get("available"):
                _GDD_INDEX = cached
                return _GDD_INDEX
        except Exception:
            pass  # 캐시 손상 → 재빌드

    # 2) Cold build
    output_dir = REPO_ROOT / "packages" / "xlsx-extractor" / "output"
    if not output_dir.exists():
        _GDD_INDEX = {"available": False, "meta": [], "by_key": {}, "built_at": 0.0}
        return _GDD_INDEX

    import time as _time
    meta: list[dict] = []
    by_key: dict[str, str] = {}
    for ft_path in output_dir.rglob("foundation_tables.json"):
        try:
            data = json.loads(ft_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        wb = data.get("source_file", "") or ""
        sh = data.get("sheet_name", "") or ""
        for tbl in data.get("tables", []) or []:
            tid = tbl.get("table_id", "") or ""
            meta.append({
                "workbook": wb,
                "sheet": sh,
                "table_id": tid,
                "table_name": tbl.get("table_name", "") or "",
                "description": (tbl.get("description") or "")[:240],
                "row_count": len(tbl.get("rows", []) or []),
                "header_count": len(tbl.get("headers", []) or []),
                "sample_queries": (tbl.get("sample_queries") or [])[:5],
            })
            by_key[f"{wb}|{sh}|{tid}"] = str(ft_path)

    _GDD_INDEX = {
        "available": True,
        "meta": meta,
        "by_key": by_key,
        "built_at": _time.time(),
    }

    # 디스크 캐시 저장
    try:
        _GDD_INDEX_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _GDD_INDEX_CACHE_PATH.write_text(
            json.dumps(_GDD_INDEX, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass

    return _GDD_INDEX


# ── Tool 11: list_gdd_tables ─────────────────────────────────

@tool(
    name="list_gdd_tables",
    description=(
        "GDD (기획서 xlsx) 안에 박혀있는 표의 카탈로그를 반환한다. xlsx-extractor 가 추출한\n"
        "foundation_tables.json 자산 (~817 파일, 수천 개 표).\n\n"
        "**DataSheet 와의 차이**:\n"
        "  - DataSheet (query_game_table): 게임 런타임 데이터 (Resource/design/*.xlsx)\n"
        "  - DataSheet in GDD (이 도구): 기획자가 GDD 에 그린 설계 표 (예: 'HUD 요소 상세 테이블', '변신 등급별 스펙')\n\n"
        "옵셔널 필터: workbook (워크북명 부분일치), sheet (시트명 부분일치).\n"
        "반환: {count, tables:[{workbook, sheet, table_id, table_name, description, row_count, header_count, sample_queries}]}"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "workbook": {"type": "string", "description": "워크북명 부분일치 (예: 'PK_HUD 시스템')"},
            "sheet": {"type": "string", "description": "시트명 부분일치 (예: 'HUD_기본')"},
            "limit": {"type": "integer", "description": "최대 반환 (기본 100)"},
        },
    },
)
async def list_gdd_tables(args: dict):
    idx = _build_gdd_index()
    if not idx["available"]:
        return _text_result({"status": "error", "error": "xlsx-extractor/output 디렉토리 미발견"})

    wb = (args.get("workbook") or "").strip().lower()
    sh = (args.get("sheet") or "").strip().lower()
    limit = int(args.get("limit", 100))

    items = idx["meta"]
    if wb:
        items = [t for t in items if wb in t["workbook"].lower()]
    if sh:
        items = [t for t in items if sh in t["sheet"].lower()]

    return _text_result({
        "count": len(items),
        "total_indexed": len(idx["meta"]),
        "tables": items[:limit],
    })


# ── Tool 12: find_gdd_tables ─────────────────────────────────

@tool(
    name="find_gdd_tables",
    description=(
        "키워드로 GDD 내부 표를 검색한다. table_name, description, sample_queries 안 매칭.\n"
        "예: 'Button 분류' → 'HUD 요소 상세 테이블' 매칭 (description 에 'Button' 포함).\n\n"
        "**용도**: 어느 워크북·시트에 어떤 표가 있는지 모를 때 첫 단계 탐색.\n"
        "**다음 단계**: 결과에서 (workbook, sheet, table_id) 를 추출해 get_gdd_table 호출.\n"
        "반환: {keyword, count, matches:[{workbook, sheet, table_id, table_name, matched_field, snippet}]}"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "keyword": {"type": "string", "description": "검색 키워드 (예: 'Button', '쿨타임', '등급별')"},
            "limit": {"type": "integer", "description": "최대 반환 (기본 20)"},
        },
        "required": ["keyword"],
    },
)
async def find_gdd_tables(args: dict):
    idx = _build_gdd_index()
    if not idx["available"]:
        return _text_result({"status": "error", "error": "GDD 인덱스 빌드 실패"})

    kw = (args.get("keyword") or "").strip()
    if not kw:
        return _text_result({"status": "error", "error": "keyword required"})
    limit = int(args.get("limit", 20))
    kwl = kw.lower()

    matches: list[dict] = []
    for t in idx["meta"]:
        # 매칭 우선순위: table_name > description > sample_queries
        if kwl in t["table_name"].lower():
            entry = {**t, "matched_field": "table_name", "snippet": t["table_name"]}
        elif kwl in t["description"].lower():
            d = t["description"]
            i = d.lower().find(kwl)
            s_start = max(0, i - 60)
            s_end = min(len(d), i + len(kw) + 60)
            snip = ("..." if s_start > 0 else "") + d[s_start:s_end] + ("..." if s_end < len(d) else "")
            entry = {**t, "matched_field": "description", "snippet": snip}
        else:
            sq_match = next((q for q in t.get("sample_queries", []) if kwl in q.lower()), None)
            if sq_match:
                entry = {**t, "matched_field": "sample_queries", "snippet": sq_match}
            else:
                continue
        matches.append(entry)

    if not matches:
        return _text_result({
            "keyword": kw,
            "count": 0,
            "matches": [],
            "message": f"키워드 '{kw}' 매칭 GDD 표 없음. 다른 표현 시도 또는 list_gdd_tables 로 워크북 좁히기.",
        })

    return _text_result({"keyword": kw, "count": len(matches), "matches": matches[:limit]})


# ── Tool 13: get_gdd_table ───────────────────────────────────

@tool(
    name="get_gdd_table",
    description=(
        "GDD 내부 표 한 개의 전체 내용 (헤더 + 행 + 메타) 을 가져온다.\n"
        "list_gdd_tables / find_gdd_tables 결과에서 (workbook, sheet, table_id) 받아 호출.\n"
        "table_id 모르면 table_name 으로도 조회 가능 (해당 시트 안에서 부분일치).\n\n"
        "반환: {workbook, sheet, table_id, table_name, description, headers, rows, sample_queries, notes, citation}\n\n"
        "**답변 인용 형식**: (출처: <workbook>.xlsx / <sheet> § <table_name>)\n"
        "응답의 citation 필드를 그대로 사용 가능."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "workbook": {"type": "string", "description": "워크북명 (예: 'PK_HUD 시스템') — 정확히 일치"},
            "sheet": {"type": "string", "description": "시트명 (예: 'HUD_기본') — 정확히 일치"},
            "table_id": {"type": "string", "description": "표 ID (예: 't1'). table_name 과 둘 중 하나 필요."},
            "table_name": {"type": "string", "description": "표 제목 부분일치 (예: 'HUD 요소 상세 테이블'). table_id 없을 때 사용."},
        },
        "required": ["workbook", "sheet"],
    },
)
async def get_gdd_table(args: dict):
    idx = _build_gdd_index()
    if not idx["available"]:
        return _text_result({"status": "error", "error": "GDD 인덱스 빌드 실패"})

    wb = (args.get("workbook") or "").strip()
    sh = (args.get("sheet") or "").strip()
    tid = (args.get("table_id") or "").strip()
    tname = (args.get("table_name") or "").strip()

    if not wb or not sh:
        return _text_result({"status": "error", "error": "workbook, sheet 필수"})
    if not tid and not tname:
        return _text_result({"status": "error", "error": "table_id 또는 table_name 중 하나 필요"})

    path: str | None = None
    if tid:
        path = idx["by_key"].get(f"{wb}|{sh}|{tid}")
        if not path:
            return _text_result({
                "status": "error",
                "error": f"표 미발견: {wb} / {sh} / {tid}",
                "hint": "list_gdd_tables(workbook=..., sheet=...) 로 정확한 table_id 확인",
            })
    else:
        # table_name 부분일치로 해당 시트 안에서 매칭
        prefix = f"{wb}|{sh}|"
        candidates = [m for m in idx["meta"] if m["workbook"] == wb and m["sheet"] == sh]
        match = next((m for m in candidates if tname.lower() in m["table_name"].lower()), None)
        if not match:
            return _text_result({
                "status": "error",
                "error": f"표 미발견: {wb} / {sh} / table_name~='{tname}'",
                "hint": "list_gdd_tables 로 해당 시트의 table_name 목록 확인",
            })
        tid = match["table_id"]
        path = idx["by_key"].get(f"{prefix}{tid}")
        if not path:
            return _text_result({"status": "error", "error": f"인덱스 불일치: {prefix}{tid}"})

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        return _text_result({"status": "error", "error": f"JSON 로드 실패: {e}"})

    target = next((t for t in data.get("tables", []) or [] if t.get("table_id") == tid), None)
    if not target:
        return _text_result({"status": "error", "error": f"파일에 table_id={tid} 없음"})

    citation = f"{wb}.xlsx / {sh} § {target.get('table_name', '')}"
    return _text_result({
        "workbook": wb,
        "sheet": sh,
        "table_id": tid,
        "table_name": target.get("table_name", ""),
        "description": target.get("description", ""),
        "headers": target.get("headers", []),
        "rows": target.get("rows", []),
        "sample_queries": target.get("sample_queries", []),
        "notes": target.get("notes", ""),
        "citation": citation,
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
            list_game_tables,
            describe_game_table,
            query_game_table,
            lookup_game_enum,
            list_gdd_tables,
            find_gdd_tables,
            get_gdd_table,
        ],
    )
