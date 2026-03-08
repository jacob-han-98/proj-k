"""
retriever.py — 하이브리드 검색: 구조적 KG + 시맨틱 벡터

검색 전략 (KG-first + Vector complement):
1. Query에서 시스템명/용어 추출 (사전 기반 + 유의어)
2. 구조적 검색: 시스템→시트→섹션 직접 매핑 (정확도 최우선)
3. KG 관계 탐색: 관련 시스템의 핵심 섹션 포함 (시스템 간 질문 대응)
4. 벡터 검색: 유의어/애매한 표현 대응 (시맨틱 보완)
5. 결합 랭킹 + 토큰 예산 내 조립
"""

import json
import os
import re
from pathlib import Path

import chromadb
import networkx as nx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

CHROMA_DIR = Path.home() / ".qna-poc-chroma"
KNOWLEDGE_GRAPH_PATH = Path(__file__).resolve().parent.parent.parent.parent / "_knowledge_base" / "knowledge_graph.json"
EXTRACTOR_OUTPUT = Path(__file__).resolve().parent.parent.parent / "xlsx-extractor" / "output"
COLLECTION_NAME = "project_k"

# ── 캐시 ──
_system_names: list[str] = []
_system_aliases: dict[str, str] = {}  # 별칭→정식 워크북명
_structural_index: dict[str, dict] = {}  # workbook→{sheets, sections, content_paths}
_graph: nx.Graph | None = None


# ── 시스템명 사전 + 유의어/별칭 매핑 ──

# 게임 기획 도메인 유의어 사전
SYNONYMS = {
    "변신": ["변신 시스템", "트랜스폼", "변환"],
    "스킬": ["스킬 시스템", "기술", "액션 스킬"],
    "버프": ["버프 시스템", "버프/디버프", "상태 효과"],
    "전투": ["전투 시스템", "기본 전투", "기본전투", "전투AI", "공격", "피격"],
    "아이템": ["아이템 시스템", "장비", "인벤토리"],
    "몬스터": ["몬스터 시스템", "몹", "보스", "네임드"],
    "퀘스트": ["퀘스트 시스템", "의뢰"],
    "NPC": ["NPC 시스템", "상인", "엔피씨"],
    "HUD": ["HUD 시스템", "UI", "인터페이스", "화면"],
    "골드": ["골드 밸런스", "재화", "금화"],
    "경험치": ["레벨업", "성장"],
    "강화": ["장비 강화", "인챈트"],
    "합성": ["변신 합성", "조합"],
    "발동 액션": ["패시브 스킬", "자동 발동"],
    "스탯": ["스탯 공식", "능력치", "스탯 및 공식"],
    "펫": ["펫 시스템", "소환수"],
    "파티": ["파티 시스템", "그룹"],
    "텔레포트": ["텔레포트 시스템", "순간이동", "이동"],
    "카메라": ["카메라 시스템", "시점"],
    "채팅": ["채팅 시스템", "대화"],
    "PvP": ["PvP단체전", "대전"],
    "미니맵": ["미니맵 시스템", "지도"],
    "월드맵": ["월드맵 시스템", "세계지도"],
    "설정": ["설정 시스템", "옵션"],
    "트리거": ["트리거 시스템", "이벤트 트리거"],
    "스폰": ["스폰 시스템", "생성"],
    "보상": ["보상 시스템", "리워드"],
    "분해": ["분해 시스템", "해체"],
    "튜토리얼": ["튜토리얼 시스템", "가이드", "도움말"],
    "로그인": ["로그인 플로우", "접속"],
    "복식": ["복식 시스템", "외형", "코스튬"],
    "시네마틱": ["시네마틱 시스템", "연출"],
    "전투력": ["전투력 시스템", "CP", "종합 전투력"],
}


def _build_system_aliases():
    """워크북 이름에서 별칭 매핑 자동 구축 + 유의어 사전 통합."""
    global _system_aliases
    if _system_aliases:
        return _system_aliases

    _system_aliases = {}

    try:
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        collection = client.get_collection(COLLECTION_NAME)
        result = collection.get(include=["metadatas"])

        workbooks = set()
        for meta in result["metadatas"]:
            wb = meta.get("workbook", "")
            if wb:
                workbooks.add(wb)

        # 정식명에서 별칭 생성
        for wb in workbooks:
            _system_aliases[wb] = wb
            _system_aliases[wb.lower()] = wb

            # PK_ 제거 버전
            short = wb.replace("PK_", "").strip()
            _system_aliases[short] = wb
            _system_aliases[short.lower()] = wb

            # 공백 제거 버전
            nospace = short.replace(" ", "")
            _system_aliases[nospace] = wb
            _system_aliases[nospace.lower()] = wb

            # "_" 제거 버전
            nounderscore = short.replace("_", " ").strip()
            _system_aliases[nounderscore] = wb
            _system_aliases[nounderscore.lower()] = wb

        # 유의어 사전 통합
        for key, aliases in SYNONYMS.items():
            # key와 매칭되는 워크북 찾기 — 이름 시작부분 매칭 우선
            candidates = []
            for wb in workbooks:
                wb_lower = wb.lower().replace("pk_", "")
                if key.lower() in wb_lower or any(a.lower() in wb_lower for a in aliases):
                    # 워크북명이 key로 시작하면 높은 우선순위
                    starts_with = wb_lower.startswith(key.lower())
                    candidates.append((wb, starts_with))

            if candidates:
                # 시작 매칭 우선, 그 다음 이름 길이 짧은 것 (더 구체적)
                candidates.sort(key=lambda x: (-x[1], len(x[0])))
                matched_wb = candidates[0][0]

                _system_aliases[key] = matched_wb
                _system_aliases[key.lower()] = matched_wb
                for alias in aliases:
                    _system_aliases[alias] = matched_wb
                    _system_aliases[alias.lower()] = matched_wb

    except Exception as e:
        print(f"[WARN] Could not build system aliases: {e}")

    return _system_aliases


def _build_structural_index():
    """content.md 파일 경로에서 구조적 인덱스 구축.

    workbook → [sheets] → [sections] 매핑.
    ChromaDB 메타데이터에서 추출.
    """
    global _structural_index
    if _structural_index:
        return _structural_index

    _structural_index = {}

    try:
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        collection = client.get_collection(COLLECTION_NAME)
        result = collection.get(include=["metadatas"])

        for meta in result["metadatas"]:
            wb = meta.get("workbook", "")
            sheet = meta.get("sheet", "")
            section = meta.get("section_path", "")

            if wb not in _structural_index:
                _structural_index[wb] = {"sheets": {}, "chunk_count": 0}

            if sheet not in _structural_index[wb]["sheets"]:
                _structural_index[wb]["sheets"][sheet] = {"sections": set()}

            _structural_index[wb]["sheets"][sheet]["sections"].add(section)
            _structural_index[wb]["chunk_count"] += 1

        # set → list 변환
        for wb in _structural_index:
            for sheet in _structural_index[wb]["sheets"]:
                _structural_index[wb]["sheets"][sheet]["sections"] = \
                    sorted(_structural_index[wb]["sheets"][sheet]["sections"])

    except Exception as e:
        print(f"[WARN] Could not build structural index: {e}")

    return _structural_index


def _load_graph() -> nx.Graph:
    """knowledge_graph.json을 NetworkX 그래프로 로드."""
    global _graph
    if _graph is not None:
        return _graph

    _graph = nx.Graph()

    if not KNOWLEDGE_GRAPH_PATH.exists():
        print(f"[WARN] Knowledge graph not found: {KNOWLEDGE_GRAPH_PATH}")
        return _graph

    try:
        data = json.loads(KNOWLEDGE_GRAPH_PATH.read_text(encoding="utf-8"))
        systems = data.get("systems", {})

        for name, info in systems.items():
            _graph.add_node(name, **{k: v for k, v in info.items() if k != "related_systems"})
            for related in info.get("related_systems", []):
                _graph.add_edge(name, related)
    except Exception as e:
        print(f"[WARN] Could not load knowledge graph: {e}")

    return _graph


# ── 시스템명 추출 ──

def extract_system_names(query: str) -> list[str]:
    """질문에서 시스템명을 추출 (별칭 + 유의어 포함).

    Returns:
        정식 워크북명 리스트 (중복 제거, 긴 것 우선)
    """
    aliases = _build_system_aliases()
    query_lower = query.lower()

    found = {}  # 별칭→워크북명
    for alias, wb in sorted(aliases.items(), key=lambda x: len(x[0]), reverse=True):
        if alias.lower() in query_lower:
            if wb not in found.values():
                found[alias] = wb

    # 워크북명 기준 중복 제거
    return list(dict.fromkeys(found.values()))


def get_related_systems(system_name: str, depth: int = 2) -> list[str]:
    """지식 그래프에서 관련 시스템을 BFS로 탐색."""
    graph = _load_graph()

    # 이름 매칭 (부분 매칭 시도)
    target = None
    if graph.has_node(system_name):
        target = system_name
    else:
        # PK_ 제거한 이름으로 시도
        short = system_name.replace("PK_", "").strip()
        for node in graph.nodes():
            if short in node or node in short:
                target = node
                break

    if not target:
        return []

    related = set()
    for node, dist in nx.single_source_shortest_path_length(graph, target, cutoff=depth).items():
        if node != target:
            related.add(node)

    return sorted(related)


# ── 검색 레이어 ──

def _vector_search(query: str, top_k: int = 8, system_filter: str = None) -> list[dict]:
    """ChromaDB 시맨틱 검색."""
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_collection(COLLECTION_NAME)

    from src.indexer import embed_texts
    query_embedding = embed_texts([query])[0]

    where_filter = None
    if system_filter:
        where_filter = {"workbook": {"$eq": system_filter}}

    try:
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )
    except Exception:
        return []

    items = []
    if not results["ids"] or not results["ids"][0]:
        return items

    for i in range(len(results["ids"][0])):
        items.append({
            "id": results["ids"][0][i],
            "text": results["documents"][0][i],
            "workbook": results["metadatas"][0][i].get("workbook", ""),
            "sheet": results["metadatas"][0][i].get("sheet", ""),
            "section_path": results["metadatas"][0][i].get("section_path", ""),
            "has_mermaid": results["metadatas"][0][i].get("has_mermaid", False),
            "has_table": results["metadatas"][0][i].get("has_table", False),
            "tokens": results["metadatas"][0][i].get("tokens", 0),
            "distance": results["distances"][0][i],
            "score": 1 - results["distances"][0][i],
            "source": "vector",
        })

    return items


def _structural_search(workbook: str, query: str) -> list[dict]:
    """구조적 검색: 특정 워크북의 모든 청크를 가져와 키워드 관련성으로 랭킹."""
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_collection(COLLECTION_NAME)

    # 해당 워크북의 모든 청크 조회
    try:
        results = collection.get(
            where={"workbook": {"$eq": workbook}},
            include=["documents", "metadatas"],
        )
    except Exception:
        return []

    if not results["ids"]:
        return []

    items = []
    query_lower = query.lower()
    query_terms = set(re.findall(r'[\w가-힣]+', query_lower))

    for i in range(len(results["ids"])):
        text = results["documents"][i]
        meta = results["metadatas"][i]

        # 키워드 관련성 스코어링
        text_lower = text.lower()
        term_hits = sum(1 for term in query_terms if term in text_lower)
        keyword_score = term_hits / max(len(query_terms), 1)

        # 섹션 제목에 키워드가 있으면 보너스
        section = meta.get("section_path", "").lower()
        section_bonus = 0.2 if any(t in section for t in query_terms) else 0

        # 구조적 검색은 높은 기본 점수 부여 (시스템명이 매칭됐으므로)
        base_score = 0.6
        score = base_score + keyword_score * 0.3 + section_bonus

        items.append({
            "id": results["ids"][i],
            "text": text,
            "workbook": meta.get("workbook", ""),
            "sheet": meta.get("sheet", ""),
            "section_path": meta.get("section_path", ""),
            "has_mermaid": meta.get("has_mermaid", False),
            "has_table": meta.get("has_table", False),
            "tokens": meta.get("tokens", 0),
            "distance": 0,
            "score": min(score, 1.0),
            "source": "structural",
        })

    # 스코어 순 정렬
    items.sort(key=lambda x: x["score"], reverse=True)
    return items


def _kg_expand(system_names: list[str], query: str, depth: int = 1) -> list[dict]:
    """KG 관계 확장: 관련 시스템의 관련 청크 검색."""
    items = []
    seen_systems = set(system_names)

    for sys_name in system_names[:3]:
        related = get_related_systems(sys_name, depth=depth)
        for rel_sys in related[:5]:
            if rel_sys in seen_systems:
                continue
            seen_systems.add(rel_sys)

            # 관련 시스템의 워크북명 찾기
            aliases = _build_system_aliases()
            wb_name = aliases.get(rel_sys, aliases.get(f"PK_{rel_sys}", ""))
            if not wb_name:
                continue

            # 관련 시스템에서 쿼리 관련 청크 찾기
            rel_items = _structural_search(wb_name, query)
            for item in rel_items[:3]:  # 관련 시스템은 상위 3개만
                item["score"] *= 0.5  # 간접 관련이므로 가중치 하향
                item["source"] = "kg_expand"
            items.extend(rel_items[:3])

    return items


# ── 통합 검색 ──

def retrieve(query: str, top_k: int = 12, token_budget: int = 80000) -> list[dict]:
    """하이브리드 검색: 구조적 KG + 벡터 시맨틱.

    검색 우선순위:
    1. 구조적 검색 (시스템명 직접 매칭) → 가장 높은 정확도
    2. KG 관계 확장 (관련 시스템) → 시스템 간 질문 대응
    3. 벡터 검색 (시맨틱) → 유의어/애매한 표현 대응

    Args:
        query: 사용자 질문
        top_k: 최종 반환 청크 수
        token_budget: 최대 토큰 예산

    Returns:
        랭킹된 청크 리스트 (토큰 예산 내)
    """
    all_results = {}

    # 1. 시스템명 추출 (유의어 포함)
    detected_systems = extract_system_names(query)

    # 2. 구조적 검색 (시스템명이 감지된 경우)
    for sys_name in detected_systems[:3]:
        structural_items = _structural_search(sys_name, query)
        for item in structural_items:
            key = item["id"]
            if key not in all_results or item["score"] > all_results[key]["score"]:
                all_results[key] = item

    # 3. KG 관계 확장 (시스템 간 질문 대응)
    if detected_systems:
        kg_items = _kg_expand(detected_systems, query, depth=1)
        for item in kg_items:
            key = item["id"]
            if key not in all_results or item["score"] > all_results[key]["score"]:
                all_results[key] = item

    # 4. 벡터 시맨틱 검색 (항상 실행 — 유의어/애매한 표현 커버)
    vector_items = _vector_search(query, top_k=top_k)
    for item in vector_items:
        key = item["id"]
        if key not in all_results:
            # 벡터 전용 결과는 구조적 결과보다 낮은 우선순위
            all_results[key] = item
        else:
            # 이미 구조적으로 찾은 항목이면 벡터 스코어로 보완
            existing = all_results[key]
            # 구조적 + 벡터 양쪽에서 발견되면 신뢰도 상승
            existing["score"] = min(existing["score"] * 1.2, 1.0)

    # 5. 시스템별 부스트 벡터 검색 (감지된 시스템에 한정)
    for sys_name in detected_systems[:2]:
        boosted = _vector_search(query, top_k=5, system_filter=sys_name)
        for item in boosted:
            key = item["id"]
            if key not in all_results:
                item["score"] *= 1.5  # 시스템 매칭 부스트
                all_results[key] = item

    # 6. 랭킹
    ranked = sorted(all_results.values(), key=lambda x: x["score"], reverse=True)

    # 7. 토큰 예산 내로 자르기
    final = []
    total_tokens = 0
    for item in ranked:
        if total_tokens + item["tokens"] > token_budget:
            break
        final.append(item)
        total_tokens += item["tokens"]
        if len(final) >= top_k:
            break

    return final


def format_context(chunks: list[dict]) -> str:
    """검색 결과를 LLM 컨텍스트 문자열로 포맷."""
    parts = []
    for i, chunk in enumerate(chunks, 1):
        source = f"[출처 {i}: {chunk['workbook']} / {chunk['sheet']} / {chunk['section_path']}]"
        parts.append(f"{source}\n{chunk['text']}")

    return "\n\n---\n\n".join(parts)
