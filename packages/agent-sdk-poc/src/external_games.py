"""
External Games Loader — agent-sdk-poc 비교 모드 데이터 소스
==============================================================
oracle 레포(/home/jacob/repos/oracle/)의 게임 크롤 데이터를
**읽기 전용으로 직접 참조**한다. 데이터 복사 X, 심볼릭 링크 X.

주 데이터 소스: knowledge_graph.json (NetworkX node-link 형식)
- nodes: 389개 (GameGuide 245, CommunityTopic 57, MediaReview 30,
  StreamerReview 20, ExtSystem 8, ExtMechanic 8, DesignLesson 5, ExtGame 4, ...)
- 4게임 모두 커버: lineage_m(91), lineage_w(146), lord_nine(77), vampir(75)

extracted/*_entities.json 은 대부분 비어 있어 보조 소스로만 사용.
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Any

ORACLE_ROOT = Path(
    os.environ.get("ORACLE_DATA_ROOT", "/home/jacob/repos/oracle/data/game_knowledge")
)

# game_id → 한국어 표시명 (source label, prompt 모두 한국어 사용)
GAMES: dict[str, str] = {
    "lineage_m": "리니지M",
    "lineage_w": "리니지W",
    "lord_nine": "Lord Nine",
    "vampir":    "Vampir",
}

# 검색 대상 노드 타입 — 비교 분석에 의미있는 것만
SEARCHABLE_TYPES = {
    "GameGuide",        # 공식 가이드/위키
    "ExtSystem",        # 게임 시스템
    "ExtMechanic",      # 메카닉
    "CommunityTopic",   # 커뮤니티 토픽
    "MediaReview",      # 웹진 리뷰
    "StreamerReview",   # 유튜버 리뷰
    "DesignLesson",     # 설계 교훈
    "OfficialNotice",   # 공식 공지
}

_KG_CACHE: dict | None = None
_NODE_INDEX: dict[str, list[dict]] | None = None  # {game_id: [node, ...]}
_DATA_VERSION: str | None = None
_RAW_FILES: dict[str, list[Path]] | None = None     # {game_id: [Path, ...]}
_RAW_TEXT_CACHE: dict[Path, str] = {}                # {Path: 텍스트} — lazy

# 한국어/영문 게임명 별칭 → game_id (ko 별칭 매핑은 사용자 자연어 친화)
GAME_ALIASES: dict[str, str] = {
    "리니지m": "lineage_m",   "lineage m": "lineage_m",
    "lineagem": "lineage_m", "린엠": "lineage_m",
    "리니지w": "lineage_w",   "lineage w": "lineage_w",
    "lineagew": "lineage_w", "린지더블유": "lineage_w",
    "lord nine": "lord_nine", "로드나인": "lord_nine",
    "lordnine": "lord_nine", "lord 9": "lord_nine",
    "vampir": "vampir",       "뱀피르": "vampir",
}

# 4게임 외부 — raw 안에 언급되는 다른 MMORPG 의 한↔영 alias.
# search_external_game 이 이 dict 의 모든 변형을 raw 검색 시 시도한다.
EXTERNAL_GAME_TERMS: dict[str, list[str]] = {
    "hit2":      ["HIT2", "Hit2", "히트2", "히트 2", "히트투"],
    "히트2":     ["HIT2", "Hit2", "히트2", "히트 2", "히트투"],
    "검은사막":  ["검은사막", "Black Desert", "BDO", "흑사"],
    "bdo":       ["검은사막", "Black Desert", "BDO", "흑사"],
    "로스트아크":["로스트아크", "Lost Ark", "LostArk", "로아"],
    "lost ark":  ["로스트아크", "Lost Ark", "LostArk", "로아"],
    "디아블로":  ["디아블로", "Diablo", "Diablo IV", "디아4"],
    "diablo":    ["디아블로", "Diablo", "Diablo IV", "디아4"],
    "wow":       ["WoW", "와우", "World of Warcraft", "월드 오브 워크래프트"],
    "와우":      ["WoW", "와우", "World of Warcraft"],
    "rf":        ["RF", "RF온라인", "rf_online", "RF Online"],
    "rf온라인":  ["RF", "RF온라인", "RF Online"],
    "오딘":      ["오딘", "ODIN", "Odin: Valhalla Rising"],
    "odin":      ["오딘", "ODIN", "Odin: Valhalla Rising"],
}


def _game_name_variants(name: str) -> list[str]:
    """검색 시 시도할 게임명 변형 리스트 (자기 자신 포함)."""
    norm = name.strip().lower()
    if norm in EXTERNAL_GAME_TERMS:
        return EXTERNAL_GAME_TERMS[norm]
    return [name.strip()]


def _kg_path() -> Path:
    return ORACLE_ROOT / "knowledge_graph.json"


def load_kg() -> dict:
    """knowledge_graph.json 캐시 로드. NetworkX node-link 형식."""
    global _KG_CACHE
    if _KG_CACHE is not None:
        return _KG_CACHE
    p = _kg_path()
    if not p.exists():
        _KG_CACHE = {"nodes": [], "edges": []}
        return _KG_CACHE
    _KG_CACHE = json.loads(p.read_text(encoding="utf-8"))
    return _KG_CACHE


def build_node_index() -> dict[str, list[dict]]:
    """{game_id: [searchable nodes]} 캐시 구축."""
    global _NODE_INDEX
    if _NODE_INDEX is not None:
        return _NODE_INDEX
    kg = load_kg()
    index: dict[str, list[dict]] = {gid: [] for gid in GAMES}
    for node in kg.get("nodes", []):
        gid = node.get("game_id")
        ntype = node.get("type")
        if gid in index and ntype in SEARCHABLE_TYPES:
            index[gid].append(node)
    _NODE_INDEX = index
    return index


def _node_text(node: dict) -> str:
    """검색 대상 텍스트 — 부분문자열 매칭용."""
    parts = [
        node.get("name", ""),
        node.get("category", ""),
        node.get("subgenre", ""),
        (node.get("summary") or "")[:500],
    ]
    return " ".join(p for p in parts if p)


def _normalize_keyword(keyword: str) -> str:
    return keyword.strip().lower()


def search_systems(
    keyword: str,
    aspect: str = "전체",
    games: list[str] | None = None,
    limit_per_game: int = 3,
) -> dict[str, list[dict]]:
    """
    키워드/카테고리로 4게임에서 유사 시스템·메카닉을 조회.

    반환: {게임명(한국어): [{name, category, type, summary, source_url, source_label}, ...]}
    """
    index = build_node_index()
    kw = _normalize_keyword(keyword)
    aspect_norm = aspect.strip().lower() if aspect else "전체"
    target_games = [g for g in (games or list(GAMES)) if g in GAMES]

    out: dict[str, list[dict]] = {}
    for gid in target_games:
        hits: list[tuple[int, dict]] = []
        for node in index.get(gid, []):
            text = _node_text(node).lower()
            if kw and kw not in text:
                continue
            if aspect_norm not in ("", "전체"):
                cat = (node.get("category") or "").lower()
                if aspect_norm not in cat and cat not in aspect_norm:
                    continue
            # 점수: name 일치 > category 일치 > summary 일치
            name_l = (node.get("name") or "").lower()
            cat_l = (node.get("category") or "").lower()
            score = 0
            if kw and kw in name_l:
                score += 100
            if kw and kw in cat_l:
                score += 30
            score += len(text)  # tie-breaker: 더 풍부한 노드 선호
            hits.append((score, node))
        hits.sort(key=lambda x: -x[0])

        out_list = []
        for _score, node in hits[:limit_per_game]:
            out_list.append({
                "name":         node.get("name", ""),
                "category":     node.get("category", ""),
                "type":         node.get("type", ""),
                "summary":      (node.get("summary") or "")[:600],
                "source_url":   node.get("url", ""),
                "source_label": entity_source_label(gid, node),
            })
        if out_list:
            out[GAMES[gid]] = out_list
    return out


def entity_source_label(game_id: str, node: dict) -> str:
    """`external/<게임명>/<카테고리>/<항목명>` — storage.py 가 인식하는 형식."""
    game = GAMES.get(game_id, game_id)
    category = node.get("category") or node.get("type") or "기타"
    name = node.get("name") or "(이름없음)"
    return f"external/{game}/{category}/{name}"


def get_raw_entity(rel_path: str) -> dict | None:
    """v1.1 — external/<게임>/<카테고리>/<항목명> → 원본 노드 복원. v1: stub."""
    return None


def resolve_game_id(name: str) -> str | None:
    """사용자가 적은 게임명을 game_id 로 정규화. 미매칭 시 None."""
    if not name:
        return None
    norm = name.strip().lower().replace("-", " ").replace("_", " ")
    if norm in GAMES:
        return norm
    if norm in GAME_ALIASES:
        return GAME_ALIASES[norm]
    # 부분 매칭 (한국어 표시명 substring)
    for gid, kr in GAMES.items():
        if kr.lower() in norm or norm in kr.lower():
            return gid
    return None


def list_raw_files() -> dict[str, list[Path]]:
    """{game_id: [raw 파일 Path...]} 캐시 구축."""
    global _RAW_FILES
    if _RAW_FILES is not None:
        return _RAW_FILES
    raw_root = ORACLE_ROOT / "raw"
    out: dict[str, list[Path]] = {gid: [] for gid in GAMES}
    if not raw_root.exists():
        _RAW_FILES = out
        return out
    for gid in GAMES:
        gdir = raw_root / gid
        if gdir.exists():
            out[gid] = sorted(p for p in gdir.rglob("*") if p.is_file() and p.suffix in (".md", ".json", ".txt"))
    _RAW_FILES = out
    return out


def _read_raw(p: Path) -> str:
    """raw 파일 lazy 로드 + 캐시. 텍스트만."""
    if p in _RAW_TEXT_CACHE:
        return _RAW_TEXT_CACHE[p]
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        text = ""
    _RAW_TEXT_CACHE[p] = text
    return text


def search_raw(
    query: str,
    games: list[str] | None = None,
    max_files_per_game: int = 3,
    snippet_chars: int = 400,
) -> dict[str, list[dict]]:
    """
    raw/<game>/*.{md,json,txt} 에서 부분문자열 검색. KG 가 비어있는 영역 (예: HIT2,
    경쟁 분석, 커뮤니티 인사이트) 보완용.

    반환: {게임명(한국어): [{file, hits, snippets[]}]}
        - hits: 파일 내 매치 수
        - snippets: 매치 주변 ±snippet_chars 발췌, 최대 3개
    """
    if not query or not query.strip():
        return {}
    files_by_game = list_raw_files()
    target_games = [g for g in (games or list(GAMES)) if g in GAMES]
    needle = query.strip()
    needle_low = needle.lower()

    out: dict[str, list[dict]] = {}
    for gid in target_games:
        results: list[tuple[int, dict]] = []
        for fp in files_by_game.get(gid, []):
            text = _read_raw(fp)
            if not text:
                continue
            text_low = text.lower()
            count = text_low.count(needle_low)
            if count == 0:
                continue
            # snippet 추출 (최대 3개)
            snippets: list[str] = []
            i = 0
            while len(snippets) < 3:
                idx = text_low.find(needle_low, i)
                if idx < 0:
                    break
                left = max(0, idx - snippet_chars // 2)
                right = min(len(text), idx + len(needle) + snippet_chars // 2)
                snippet = text[left:right].strip()
                snippet = "…" + snippet if left > 0 else snippet
                snippet = snippet + "…" if right < len(text) else snippet
                snippets.append(snippet)
                i = idx + len(needle)
            results.append((count, {
                "file": fp.name,
                "rel_path": str(fp.relative_to(ORACLE_ROOT)),
                "hits": count,
                "snippets": snippets,
            }))
        results.sort(key=lambda x: -x[0])
        if results:
            out[GAMES[gid]] = [r[1] for r in results[:max_files_per_game]]
    return out


def search_external_game(
    game_name: str,
    query: str,
    limit: int = 5,
) -> dict:
    """
    특정 게임에 대한 직접 조회. 게임명이 4종 중 하나면 KG + raw 모두 검색,
    아니면 raw 전체에서 게임명 + 쿼리 동시 매칭으로 사례 수집 (예: HIT2).

    반환: {
        "game": "<resolved or unresolved>",
        "game_id": "<id or null>",
        "kg_hits": [...],     # search_systems 결과 (해당 게임만)
        "raw_hits": [...],    # search_raw 결과 (해당 게임만)
        "cross_mentions": [...],  # game_id 해석 안 될 때, raw 전체에서 game_name + query 동시 매칭
    }
    """
    if not game_name or not query:
        return {"error": "game_name and query required"}

    gid = resolve_game_id(game_name)
    out: dict = {
        "game": GAMES[gid] if gid else game_name,
        "game_id": gid,
        "kg_hits": [],
        "raw_hits": [],
        "cross_mentions": [],
    }

    if gid:
        # 정규 4게임 — KG + raw 모두
        kg_search = search_systems(query, games=[gid], limit_per_game=limit)
        out["kg_hits"] = kg_search.get(GAMES[gid], [])
        raw_search = search_raw(query, games=[gid], max_files_per_game=limit)
        out["raw_hits"] = raw_search.get(GAMES[gid], [])
    else:
        # 4게임 외 (예: HIT2, 검은사막, 로스트아크) — raw 전체에서 게임명+쿼리 둘 다 등장하는 파일
        files_by_game = list_raw_files()
        # 게임명 변형들 (HIT2 ↔ 히트2 등) 모두 시도
        gname_variants = [v.lower() for v in _game_name_variants(game_name)]
        query_low = query.strip().lower()
        # 쿼리도 게임명을 단독 검색하는 경우(query == game_name)면 변형 모두를 OR
        query_variants = (
            [v.lower() for v in _game_name_variants(query)]
            if query.strip().lower() in EXTERNAL_GAME_TERMS
            else [query_low]
        )
        seen: set[tuple[str, str]] = set()
        for src_gid, files in files_by_game.items():
            for fp in files:
                text = _read_raw(fp)
                if not text:
                    continue
                tlow = text.lower()
                # 게임명 변형 중 하나라도 등장하면 후보 (셀프-쿼리는 게임명만 봐도 OK)
                g_idx = -1
                for v in gname_variants:
                    g_idx = tlow.find(v)
                    if g_idx >= 0:
                        break
                if g_idx < 0:
                    continue
                # 쿼리 변형 중 하나가 같은 파일에 있어야 함 (셀프-쿼리면 g_idx 와 같아도 OK)
                q_idx = -1
                for v in query_variants:
                    q_idx = tlow.find(v)
                    if q_idx >= 0:
                        break
                if q_idx < 0:
                    continue
                center = (g_idx + q_idx) // 2
                left = max(0, center - 300)
                right = min(len(text), center + 300)
                snippet = text[left:right].strip()
                snippet = "…" + snippet if left > 0 else snippet
                snippet = snippet + "…" if right < len(text) else snippet
                key = (src_gid, fp.name)
                if key in seen:
                    continue
                seen.add(key)
                out["cross_mentions"].append({
                    "found_in_game": GAMES[src_gid],
                    "file": fp.name,
                    "rel_path": str(fp.relative_to(ORACLE_ROOT)),
                    "snippet": snippet,
                })
        out["cross_mentions"] = out["cross_mentions"][:limit]
    return out


def data_version() -> str:
    """_registry.json 의 가장 최근 last_crawled (YYYY-MM-DD). UI 푸터용."""
    global _DATA_VERSION
    if _DATA_VERSION is not None:
        return _DATA_VERSION
    p = ORACLE_ROOT / "_registry.json"
    if not p.exists():
        _DATA_VERSION = "unknown"
        return _DATA_VERSION
    try:
        reg = json.loads(p.read_text(encoding="utf-8"))
        latest = ""
        for entry in reg.get("entries", {}).values():
            lc = entry.get("last_crawled", "")
            if lc and lc > latest:
                latest = lc
        _DATA_VERSION = latest[:10] if latest else "unknown"
    except Exception:
        _DATA_VERSION = "unknown"
    return _DATA_VERSION


def stats() -> dict[str, Any]:
    """진단용: 게임별 노드 수 + 데이터 버전."""
    index = build_node_index()
    return {
        "oracle_root": str(ORACLE_ROOT),
        "exists": _kg_path().exists(),
        "data_version": data_version(),
        "by_game": {GAMES[gid]: len(nodes) for gid, nodes in index.items()},
        "today": date.today().isoformat(),
    }


if __name__ == "__main__":
    # smoke: python -m external_games
    import sys
    print(json.dumps(stats(), ensure_ascii=False, indent=2))
    if len(sys.argv) > 1:
        kw = sys.argv[1]
        print(f"\n=== search('{kw}') ===")
        print(json.dumps(search_systems(kw), ensure_ascii=False, indent=2))
