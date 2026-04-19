"""
build_term_index.py — summaries 의 '핵심 용어' / '참조 시스템' 역색인
=======================================================================
LLM 미사용, 순수 텍스트 파싱. summaries가 빌드된 이후에 실행.

사용법:
    python scripts/build_term_index.py
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SUMMARIES = ROOT / "index" / "summaries"
OUT = ROOT / "index" / "TERM_INDEX.md"

MIN_TERM_LEN = 2
MAX_TERMS_PER_ENTRY = 500  # 너무 많이 나오는 용어는 앞에서 N개만


def parse_section(text: str, heading: str) -> list[str]:
    """## <heading> 섹션의 - 불릿 리스트를 추출. (없음)이면 빈 리스트."""
    lines = text.splitlines()
    in_section = False
    items = []
    for line in lines:
        if line.strip().startswith("## "):
            if line.strip() == f"## {heading}":
                in_section = True
                continue
            elif in_section:
                break
        if in_section:
            m = re.match(r"^\s*[-*]\s+(.+?)\s*$", line)
            if m:
                val = m.group(1).strip()
                if val in ("(없음)", "없음"):
                    continue
                items.append(val)
    return items


def collect():
    term_to_files: dict[str, list[str]] = defaultdict(list)
    ref_to_files: dict[str, list[str]] = defaultdict(list)

    files = sorted(SUMMARIES.rglob("*.md"))
    for f in files:
        text = f.read_text(encoding="utf-8")
        title = ""
        origin = ""
        for line in text.splitlines()[:10]:
            if line.startswith("# "):
                title = line[2:].replace("(요약)", "").strip()
            elif line.startswith("> 원본:"):
                origin = line.split(":", 1)[1].strip()
            if title and origin:
                break

        # 축약 경로
        summary_rel = str(f.relative_to(ROOT))

        terms = parse_section(text, "핵심 용어")
        refs = parse_section(text, "참조 시스템")

        for t in terms:
            # 괄호 속 영문명도 키로 등록 (예: "타겟 정보 (TARGET INFO)" → "타겟 정보", "TARGET INFO")
            parts = [t]
            m = re.match(r"^(.+?)\s*\(([^)]+)\)\s*$", t)
            if m:
                parts = [m.group(1).strip(), m.group(2).strip()]
            for p in parts:
                if len(p) >= MIN_TERM_LEN:
                    term_to_files[p].append(f"{title} ← {origin or summary_rel}")

        for r in refs:
            ref_to_files[r].append(f"{title} ← {origin or summary_rel}")

    return term_to_files, ref_to_files


def render():
    terms, refs = collect()

    lines: list[str] = []
    lines.append("# Project K 용어 인덱스\n")
    lines.append(
        "각 요약 파일의 '핵심 용어' / '참조 시스템' 섹션을 역색인한 결과다. "
        "Agent가 특정 용어를 포함하는 시트/페이지를 빠르게 찾을 때 `Read`로 열어 훑거나, "
        "대안으로 `Grep -i '용어' index/summaries/`를 쓸 수 있다.\n"
    )

    lines.append(f"> 용어: {len(terms):,}개 · 참조 시스템: {len(refs):,}개\n")

    # ── 핵심 용어 ──
    lines.append("\n## 핵심 용어\n")
    # 용어를 등장 빈도 내림차순, 동률은 가나다
    for term in sorted(terms.keys(), key=lambda t: (-len(terms[t]), t)):
        occurrences = terms[term]
        if len(occurrences) > MAX_TERMS_PER_ENTRY:
            shown = occurrences[:MAX_TERMS_PER_ENTRY]
            suffix = f" (+{len(occurrences) - MAX_TERMS_PER_ENTRY} more)"
        else:
            shown = occurrences
            suffix = ""
        unique = sorted(set(shown))
        lines.append(f"### {term} ({len(occurrences)})")
        for s in unique:
            lines.append(f"- {s}")
        if suffix:
            lines.append(f"- …{suffix}")
        lines.append("")

    # ── 참조 시스템 ──
    lines.append("\n## 참조 시스템 (xref)\n")
    for ref in sorted(refs.keys(), key=lambda r: (-len(refs[r]), r)):
        occurrences = refs[ref]
        unique = sorted(set(occurrences))
        lines.append(f"### {ref} ({len(occurrences)})")
        for s in unique:
            lines.append(f"- {s}")
        lines.append("")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    size = OUT.stat().st_size
    print(f"생성: {OUT}  ({size:,} bytes)")
    print(f"  용어: {len(terms)}개 · 참조 시스템: {len(refs)}개")


if __name__ == "__main__":
    render()
