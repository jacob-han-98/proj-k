"""
Project K MCP Tools for Claude Agent SDK
==========================================
In-process MCP server — knowledge_graph.json 래퍼와 동의어 조회.
Glob/Grep/Read는 SDK 내장 도구를 사용하므로 여기선 보조 도구만 정의.
"""

import json
from pathlib import Path
from typing import Optional

from claude_agent_sdk import tool, create_sdk_mcp_server

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


# ── MCP Server Factory ───────────────────────────────────────

def create_projk_server():
    return create_sdk_mcp_server(
        name="projk",
        version="0.1.0",
        tools=[list_systems, find_related_systems, glossary_lookup],
    )
