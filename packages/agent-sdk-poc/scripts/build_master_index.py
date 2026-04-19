"""
build_master_index.py — index/summaries/ 를 훑어 MASTER_INDEX.md 생성
=====================================================================
Agent가 세션 첫 턴에 한 번 Read해서 전체 지식 영역을 파악하는 카탈로그.
각 시트/페이지의 `한 줄 설명`을 뽑아 워크북/공간별로 그룹화.

사용법:
    python scripts/build_master_index.py
"""

from __future__ import annotations

import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                                           # agent-sdk-poc
SUMMARIES = ROOT / "index" / "summaries"
OUT = ROOT / "index" / "MASTER_INDEX.md"


def parse_summary(path: Path) -> dict:
    """summary 파일에서 title, origin, one_liner 추출."""
    text = path.read_text(encoding="utf-8")
    title = ""
    origin = ""
    one_liner = ""

    for i, line in enumerate(text.splitlines()):
        if line.startswith("# ") and not title:
            title = line[2:].replace("(요약)", "").strip()
        elif line.startswith("> 원본:"):
            origin = line.split(":", 1)[1].strip()
        elif line.strip() == "## 한 줄 설명":
            # take next non-empty line
            for j in range(i + 1, min(i + 6, len(text.splitlines()))):
                nxt = text.splitlines()[j].strip()
                if nxt:
                    one_liner = nxt
                    break
            break

    return {"path": str(path), "title": title, "origin": origin, "one_liner": one_liner}


def logical_content_path(origin: str) -> str:
    """원본 필드의 상대경로(있으면 그대로, 없으면 summary path에서 역추론)."""
    return origin


def collect():
    items = sorted(SUMMARIES.rglob("*.md"))
    parsed = [parse_summary(p) for p in items]

    # Excel / Confluence 구분
    xlsx_root = SUMMARIES / "xlsx"
    conflu_root = SUMMARIES / "confluence"

    xlsx_items: dict[str, dict[str, list[dict]]] = {}     # 분류(7_System/8_Contents) → workbook → [items]
    conflu_items: dict[str, list[dict]] = {}               # space → [items]
    other_items: list[dict] = []

    for p, meta in zip(items, parsed):
        try:
            rel = p.relative_to(xlsx_root)
            parts = rel.parts
            if len(parts) >= 3:
                category = parts[0]     # 7_System / 8_Contents
                workbook = parts[1]
                xlsx_items.setdefault(category, {}).setdefault(workbook, []).append(meta)
            elif len(parts) == 2:
                # 카테고리 없이 워크북/시트만 있는 경우 (예: output/PK_변신 및 스킬 시스템/...)
                category = "(카테고리 없음)"
                workbook = parts[0]
                xlsx_items.setdefault(category, {}).setdefault(workbook, []).append(meta)
            continue
        except ValueError:
            pass
        try:
            rel = p.relative_to(conflu_root)
            parts = rel.parts
            if parts:
                space = parts[0]
                conflu_items.setdefault(space, []).append(meta)
            continue
        except ValueError:
            pass
        other_items.append(meta)

    return xlsx_items, conflu_items, other_items


def md_link(text: str, path: str) -> str:
    # 파일 링크는 상대경로(summary 파일 또는 원본). 공백은 URL 인코딩 불필요 (IDE/CLI에서는 문제되지만 마크다운 reader는 대부분 OK)
    return f"[{text}]({path})"


def render():
    xlsx_items, conflu_items, other_items = collect()

    lines: list[str] = []
    lines.append("# Project K 지식 베이스 마스터 인덱스\n")
    lines.append(
        "이 파일은 Agent가 세션 시작 시 한 번 읽어 전체 지형을 파악하는 카탈로그다. "
        "각 항목은 `원본 content.md 경로 — 한 줄 설명` 형식이다. "
        "원본 문서를 읽을 때는 해당 경로의 `content.md`를, 요약만 볼 때는 "
        "같은 이름의 `index/summaries/.../*.md`를 사용하라.\n"
    )

    total_xlsx = sum(len(v) for cat in xlsx_items.values() for v in cat.values())
    total_conflu = sum(len(v) for v in conflu_items.values())
    lines.append(f"> 코퍼스 규모: Excel {total_xlsx} 시트 / Confluence {total_conflu} 페이지\n")

    # Excel
    lines.append("\n## Excel 기획서\n")
    for category in sorted(xlsx_items.keys()):
        lines.append(f"\n### {category}\n")
        workbooks = xlsx_items[category]
        for wb in sorted(workbooks.keys()):
            sheets = sorted(workbooks[wb], key=lambda m: m["title"])
            lines.append(f"\n#### {wb} ({len(sheets)} 시트)\n")
            for s in sheets:
                origin = s["origin"] or ""
                title = s["title"] or Path(s["path"]).stem
                one_liner = s["one_liner"] or "(요약 없음)"
                if origin:
                    lines.append(f"- [{title}]({origin}) — {one_liner}")
                else:
                    lines.append(f"- **{title}** — {one_liner}")

    # Confluence
    if conflu_items:
        lines.append("\n\n## Confluence\n")
        for space in sorted(conflu_items.keys()):
            pages = sorted(conflu_items[space], key=lambda m: m["title"])
            lines.append(f"\n### {space} ({len(pages)} 페이지)\n")
            for p in pages:
                origin = p["origin"] or ""
                title = p["title"] or Path(p["path"]).stem
                one_liner = p["one_liner"] or "(요약 없음)"
                if origin:
                    lines.append(f"- [{title}]({origin}) — {one_liner}")
                else:
                    lines.append(f"- **{title}** — {one_liner}")

    if other_items:
        lines.append("\n\n## 기타\n")
        for o in other_items:
            lines.append(f"- **{o.get('title','(untitled)')}** — {o.get('one_liner','')}")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    size = OUT.stat().st_size
    print(f"생성: {OUT}  ({size:,} bytes, {len(lines)} lines)")
    print(f"  Excel: {total_xlsx} 시트 / Confluence: {total_conflu} 페이지")


if __name__ == "__main__":
    render()
