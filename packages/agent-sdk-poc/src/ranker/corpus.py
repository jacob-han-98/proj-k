"""Ranker의 코퍼스·인덱스 접근 레이어.

- knowledge_graph.json 로드 / 상위 Hub 시스템 선정
- conflict_scan_latest.json 로드 / 시스템별 충돌 집계
- 시스템명 → content.md 경로 resolve (Excel 시트 + 관련 Confluence 페이지)
"""
from __future__ import annotations

import json
from collections import defaultdict
from functools import cache
from pathlib import Path
from typing import Any

PKG_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PKG_ROOT.parents[1]

KG_PATH = PKG_ROOT / "index" / "knowledge_graph.json"
EXCEL_OUTPUT = REPO_ROOT / "packages" / "xlsx-extractor" / "output"
CONFLUENCE_OUTPUT = REPO_ROOT / "packages" / "confluence-downloader" / "output"
CONFLICT_SCAN_JSON = REPO_ROOT / "packages" / "qna-poc" / "eval" / "conflict_scan_latest.json"


# ---- Knowledge Graph -----------------------------------------------------

@cache
def load_kg() -> dict[str, Any]:
    if not KG_PATH.exists():
        raise FileNotFoundError(f"knowledge_graph.json not found at {KG_PATH}")
    return json.loads(KG_PATH.read_text(encoding="utf-8"))


def all_systems() -> list[str]:
    return sorted(load_kg()["systems"].keys())


def hub_degree(name: str) -> int:
    sys_ = load_kg()["systems"].get(name, {})
    return len(sys_.get("related_systems", []))


def top_hub_systems(n: int) -> list[str]:
    """related_systems degree 상위 N개 시스템 이름 (초벌 Hub 랭킹)."""
    systems = load_kg()["systems"]
    ranked = sorted(systems.keys(), key=lambda k: len(systems[k].get("related_systems", [])), reverse=True)
    return ranked[:n]


def related_systems(name: str) -> list[str]:
    return load_kg()["systems"].get(name, {}).get("related_systems", [])


# ---- Conflict Scan (qna-poc 결과 재활용) ---------------------------------

@cache
def load_conflict_scan() -> dict[str, Any] | None:
    if not CONFLICT_SCAN_JSON.exists():
        return None
    return json.loads(CONFLICT_SCAN_JSON.read_text(encoding="utf-8"))


def system_conflicts(excel_name: str) -> list[dict[str, Any]]:
    """특정 Excel 시스템에 대한 conflict analysis 리스트 반환.

    반환 예시:
        [
          {
            "confluence": "...",
            "overlap_topic": "...",
            "comparison": {
               "has_conflict": true,
               "severity": "critical|major|minor",
               "conflicts": [{"type": ..., "topic": ..., "excel_says": ..., "confluence_says": ...}],
               ...
            }
          },
          ...
        ]
    """
    scan = load_conflict_scan()
    if not scan:
        return []
    result: list[dict[str, Any]] = []
    for a in scan.get("analyses", []):
        pair = a.get("pair", {})
        if pair.get("excel") != excel_name:
            continue
        if "comparison" not in a:  # error 케이스
            continue
        comp = a["comparison"]
        if not comp.get("conflicts"):
            continue
        result.append(
            {
                "confluence": pair.get("confluence"),
                "overlap_topic": pair.get("overlap_topic"),
                "risk_reason": pair.get("risk_reason"),
                "comparison": comp,
            }
        )
    return result


def systems_with_conflicts() -> dict[str, int]:
    """시스템명 → conflict 총 건수."""
    counts: dict[str, int] = defaultdict(int)
    scan = load_conflict_scan()
    if not scan:
        return counts
    for a in scan.get("analyses", []):
        name = a.get("pair", {}).get("excel")
        if not name:
            continue
        comp = a.get("comparison", {})
        counts[name] += len(comp.get("conflicts", []))
    return dict(counts)


# ---- Content paths -------------------------------------------------------

def excel_system_dir(name: str) -> Path | None:
    """Excel 워크북 이름 → xlsx-extractor/output 내 디렉토리.

    우선순위:
      1. knowledge_graph.json의 `source_files` 필드 (레포 상대 경로)
      2. EXCEL_OUTPUT 직접 매치
      3. 1-depth 분류 밑에서 검색 (예: 7_System/<name>)
    모두 실패하면 None (호출자가 skip).
    """
    if not EXCEL_OUTPUT.exists():
        return None
    # 1. KG source_files 기반
    sys_meta = load_kg()["systems"].get(name, {})
    for rel in sys_meta.get("source_files") or []:
        candidate = REPO_ROOT / rel
        if candidate.is_dir():
            return candidate
    # 2. 직접 매치
    direct = EXCEL_OUTPUT / name
    if direct.is_dir():
        return direct
    # 3. 1-depth 분류
    for category in EXCEL_OUTPUT.iterdir():
        if not category.is_dir():
            continue
        candidate = category / name
        if candidate.is_dir():
            return candidate
    return None


def excel_sheet_contents(name: str, max_chars_per_sheet: int = 30000) -> list[dict[str, Any]]:
    """Excel 시스템의 모든 시트 content.md 읽기.

    Returns: [{"sheet": str, "path": str, "text": str}, ...]
    """
    d = excel_system_dir(name)
    if d is None:
        return []
    results: list[dict[str, Any]] = []
    for sheet_dir in sorted(d.iterdir()):
        if not sheet_dir.is_dir():
            continue
        content = sheet_dir / "_final" / "content.md"
        if not content.exists():
            continue
        text = content.read_text(encoding="utf-8")
        if len(text) > max_chars_per_sheet:
            text = text[:max_chars_per_sheet] + "\n\n...(truncated)"
        results.append({"sheet": sheet_dir.name, "path": str(content), "text": text})
    return results


def confluence_page_content(rel_path: str, max_chars: int = 30000) -> dict[str, Any] | None:
    """Confluence rel_path → content.md (또는 content_enriched.md) 로드.

    rel_path 예: "Design\\시스템 디자인\\성장 밸런스\\스탯 및 대미지 공식 개편"
    (conflict_scan_latest.json의 포맷. 백슬래시 사용.)
    """
    normalized = rel_path.replace("\\", "/")
    base = CONFLUENCE_OUTPUT / normalized
    for candidate in (base / "content_enriched.md", base / "content.md"):
        if candidate.exists():
            text = candidate.read_text(encoding="utf-8")
            if len(text) > max_chars:
                text = text[:max_chars] + "\n\n...(truncated)"
            return {"path": str(candidate), "text": text, "rel_path": rel_path}
    return None
