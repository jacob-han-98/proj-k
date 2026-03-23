#!/usr/bin/env python3
"""
Document Conflict Scanner - 기획서 충돌/outdated 정보 탐지

동일 주제를 다루는 여러 문서(Excel ↔ Confluence) 간의
충돌, 버전 불일치, outdated 정보를 AI로 탐지합니다.

Usage:
    python conflict_scanner.py --dry-run          # 매칭만 (LLM 비교 X)
    python conflict_scanner.py --max-pairs 5      # 상위 5쌍만 분석
    python conflict_scanner.py                    # 전체 스캔 (high+medium)
"""

import argparse
import io
import json
import os
import re
import sys
import time
from collections import defaultdict

# Windows cp949 인코딩 문제 방지
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
from datetime import datetime
from pathlib import Path

# ── 경로 설정 ────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[2]

sys.path.insert(0, str(SCRIPT_DIR))

from dotenv import load_dotenv
load_dotenv(SCRIPT_DIR.parent / ".env")

from generator import call_bedrock

EXCEL_OUTPUT = PROJECT_ROOT / "packages" / "xlsx-extractor" / "output"
CONFLUENCE_OUTPUT = PROJECT_ROOT / "packages" / "confluence-downloader" / "output"
RESULTS_DIR = SCRIPT_DIR.parent / "eval"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)


# ── Phase 1: 문서 인덱스 구축 ──────────────────────────────

def build_excel_index():
    """Excel 워크북별 시트 목록 + 요약 추출."""
    docs = []
    for d in sorted(EXCEL_OUTPUT.iterdir()):
        if not d.is_dir():
            continue
        sheets = []
        for s in sorted(d.iterdir()):
            if not s.is_dir():
                continue
            content_path = s / "_final" / "content.md"
            if not content_path.exists():
                continue
            content = content_path.read_text(encoding="utf-8")
            sheets.append({
                "name": s.name,
                "path": str(content_path),
                "chars": len(content),
            })
        if sheets:
            docs.append({
                "source": "excel",
                "name": d.name,
                "display": d.name.replace("PK_", ""),
                "sheets": sheets,
                "total_chars": sum(s["chars"] for s in sheets),
            })
    return docs


def build_confluence_index():
    """Confluence 페이지별 제목 + 카테고리 + 요약 추출."""
    docs = []
    for root, _dirs, files in os.walk(CONFLUENCE_OUTPUT):
        has_content = any(f in files for f in ("content_enriched.md", "content.md"))
        if not has_content:
            continue
        content_file = "content_enriched.md" if "content_enriched.md" in files else "content.md"
        content_path = Path(root) / content_file
        content = content_path.read_text(encoding="utf-8")

        rel = Path(root).relative_to(CONFLUENCE_OUTPUT)
        parts = list(rel.parts)
        # 카테고리: Design/시스템 디자인/전투 → "시스템 디자인/전투"
        category = "/".join(parts[1:-1]) if len(parts) > 2 else (parts[1] if len(parts) > 1 else "")

        docs.append({
            "source": "confluence",
            "name": parts[-1],
            "category": category,
            "rel_path": str(rel),
            "path": str(content_path),
            "chars": len(content),
            "has_enriched": "content_enriched.md" in files,
        })
    return docs


def build_index():
    """전체 문서 인덱스 구축."""
    print("=" * 70)
    print("Phase 1: 문서 인덱스 구축")
    print("=" * 70)

    excel_docs = build_excel_index()
    confluence_docs = build_confluence_index()

    print(f"  Excel 워크북: {len(excel_docs)}개 ({sum(d['total_chars'] for d in excel_docs):,} chars)")
    print(f"  Confluence 페이지: {len(confluence_docs)}개 ({sum(d['chars'] for d in confluence_docs):,} chars)")
    return excel_docs, confluence_docs


# ── Phase 2: LLM 기반 주제 매칭 ──────────────────────────

def detect_pairs(excel_docs, confluence_docs):
    """LLM으로 동일 주제 문서 쌍 탐지."""
    print("\n" + "=" * 70)
    print("Phase 2: LLM 주제 매칭")
    print("=" * 70)

    # Excel 목록 (시트명 포함)
    excel_lines = []
    for d in excel_docs:
        sheet_names = ", ".join(s["name"] for s in d["sheets"])
        excel_lines.append(f"- {d['name']}  [시트: {sheet_names}]")

    # Confluence 목록 (카테고리 포함)
    conf_lines = []
    for d in confluence_docs:
        conf_lines.append(f"- {d['rel_path']}")

    prompt = f"""당신은 게임 기획 문서 분석 전문가입니다.

두 가지 출처의 문서 목록을 비교하여, **동일하거나 밀접하게 관련된 주제**를 다루는 문서 쌍을 찾아주세요.

## Excel 기획서 (Perforce 원본, {len(excel_docs)}개)
{chr(10).join(excel_lines)}

## Confluence 페이지 (위키, {len(confluence_docs)}개)
{chr(10).join(conf_lines)}

## 찾아야 할 것
- 같은 시스템/기능/밸런스를 다루지만 출처가 다른 문서 쌍
- 특히: Excel 원본이 있는데 Confluence에서 개편/수정/보완한 경우
- 하나의 Excel 문서가 여러 Confluence 페이지와 겹칠 수 있음

## 응답 형식 (JSON만)
```json
[
  {{
    "excel": "워크북 전체 이름 (PK_xxx)",
    "confluence": "페이지 rel_path 전체",
    "confidence": "high|medium|low",
    "overlap_topic": "겹치는 주제 한줄 요약",
    "risk_reason": "충돌/outdated 가능성 이유"
  }}
]
```

규칙:
- high: 거의 확실히 같은 주제 (공식, 밸런스, 시스템 설계가 겹침)
- medium: 관련성 높지만 세부 범위가 다를 수 있음
- low: 간접적 관련 — **최대 10개**까지만
- 무관한 쌍은 포함 X
- **충돌 가능성이 높은 순서로 정렬**"""

    print("  Claude Sonnet 호출 중...")
    t0 = time.time()
    result = call_bedrock(
        messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        system="You are a game design document analyst. Respond ONLY with valid JSON array. No markdown, no explanation.",
        model="claude-opus-4-6",
        max_tokens=8192,
        temperature=0,
    )
    elapsed = time.time() - t0
    print(f"  완료: {elapsed:.1f}s | {result['input_tokens']:,}+{result['output_tokens']:,} tokens")

    # JSON 파싱
    text = result["text"].strip()
    m = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    # JSON 배열 추출
    if not text.startswith("["):
        m2 = re.search(r"\[.*\]", text, re.DOTALL)
        if m2:
            text = m2.group(0)

    pairs = json.loads(text)

    by_conf = defaultdict(int)
    for p in pairs:
        by_conf[p["confidence"]] += 1
    print(f"  발견: {len(pairs)}쌍 (high:{by_conf.get('high',0)}, medium:{by_conf.get('medium',0)}, low:{by_conf.get('low',0)})")

    # 요약 출력
    for i, p in enumerate(pairs):
        marker = {"high": "🔴", "medium": "🟡", "low": "⚪"}.get(p["confidence"], "?")
        print(f"  {marker} [{i+1}] {p['excel']} ↔ {p['confluence']}")
        print(f"       {p['overlap_topic']}")

    return pairs


# ── Phase 3: 심층 충돌 분석 ───────────────────────────────

def read_excel_content(doc, max_chars=15000):
    """Excel 워크북의 전체 시트 내용 읽기 (truncate)."""
    parts = []
    total = 0
    for sheet in doc["sheets"]:
        if total >= max_chars:
            break
        content = Path(sheet["path"]).read_text(encoding="utf-8")
        budget = max_chars - total
        if len(content) > budget:
            content = content[:budget] + "\n...(truncated)"
        parts.append(f"### 시트: {sheet['name']}\n{content}")
        total += len(content)
    return "\n\n---\n\n".join(parts)


def read_confluence_content(doc, max_chars=10000):
    """Confluence 페이지 내용 읽기 (truncate)."""
    content = Path(doc["path"]).read_text(encoding="utf-8")
    if len(content) > max_chars:
        content = content[:max_chars] + "\n...(truncated)"
    return content


def compare_pair(excel_doc, conf_doc, pair_info, pair_idx, total_pairs):
    """문서 쌍의 심층 충돌 분석."""
    label = f"[{pair_idx}/{total_pairs}]"
    print(f"\n  {label} {pair_info['excel']} ↔ {pair_info['confluence']}")
    print(f"    주제: {pair_info['overlap_topic']}")

    excel_text = read_excel_content(excel_doc)
    conf_text = read_confluence_content(conf_doc)

    prompt = f"""두 문서를 비교하여 충돌, 불일치, outdated 정보를 찾아주세요.

## 문서 A: Excel 기획서 (Perforce 원본)
출처: {excel_doc['name']}
{excel_text}

## 문서 B: Confluence 페이지
출처: {conf_doc.get('rel_path', conf_doc['name'])}
{conf_text}

## 분석 관점
1. **공식/수치 불일치**: 같은 개념의 공식이나 수치가 다른 경우
2. **구조적 차이**: 같은 시스템 설계가 근본적으로 다른 경우
3. **정보 추가/누락**: 한쪽에만 있는 중요 정보
4. **버전 관계**: 개편/대체 관계, 어느 쪽이 더 최신인지
5. **폐기 후보**: 명시적으로 대체된 정보

## 응답 (JSON만)
```json
{{
  "has_conflict": true/false,
  "severity": "critical|major|minor|none",
  "version_relationship": "어떤 관계인지 설명",
  "conflicts": [
    {{
      "type": "공식불일치|수치불일치|구조적차이|정보누락|버전불일치|폐기후보",
      "topic": "충돌 주제",
      "excel_says": "Excel 내용 요약 (핵심만)",
      "confluence_says": "Confluence 내용 요약 (핵심만)",
      "severity": "critical|major|minor",
      "recommendation": "기획자에게 제안할 액션"
    }}
  ],
  "summary": "전체 요약 2-3문장"
}}
```"""

    t0 = time.time()
    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            system="You are an expert at comparing game design documents. Be thorough, precise, and fair. Respond ONLY with valid JSON.",
            model="claude-opus-4-6",
            max_tokens=4096,
            temperature=0,
        )
    except Exception as e:
        print(f"    ❌ API 오류: {e}")
        return {"error": str(e), "pair": pair_info}

    elapsed = time.time() - t0

    # 파싱
    text = result["text"].strip()
    m = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    try:
        comparison = json.loads(text)
    except json.JSONDecodeError:
        print(f"    ❌ JSON 파싱 실패")
        return {"error": "JSON parse error", "raw": result["text"][:500], "pair": pair_info}

    # 결과 출력
    n_conflicts = len(comparison.get("conflicts", []))
    sev = comparison.get("severity", "?")
    sev_icon = {"critical": "🔴", "major": "🟠", "minor": "🟡", "none": "✅"}.get(sev, "?")

    print(f"    {sev_icon} {sev} | 충돌 {n_conflicts}건 | {elapsed:.1f}s | {result['input_tokens']:,}+{result['output_tokens']:,} tok")

    if comparison.get("summary"):
        print(f"    📋 {comparison['summary']}")

    if comparison.get("version_relationship"):
        print(f"    🔗 관계: {comparison['version_relationship']}")

    for j, c in enumerate(comparison.get("conflicts", []), 1):
        c_icon = {"critical": "🔴", "major": "🟠", "minor": "🟡"}.get(c.get("severity"), "·")
        print(f"      {c_icon} [{j}] {c['type']}: {c['topic']}")
        print(f"         Excel: {c.get('excel_says', '-')[:100]}")
        print(f"         Confluence: {c.get('confluence_says', '-')[:100]}")
        print(f"         → {c.get('recommendation', '-')[:100]}")

    comparison["_meta"] = {
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "api_seconds": result["api_seconds"],
    }
    return comparison


# ── Phase 4: 결과 저장 ───────────────────────────────────

def save_results(pairs, analyses, elapsed):
    """결과를 JSON + Markdown으로 저장."""
    total_conflicts = sum(
        len(a.get("comparison", {}).get("conflicts", []))
        for a in analyses if "comparison" in a
    )

    report = {
        "scan_time": datetime.now().isoformat(),
        "elapsed_seconds": round(elapsed, 1),
        "pairs_found": len(pairs),
        "pairs_analyzed": len(analyses),
        "total_conflicts": total_conflicts,
        "severity_counts": _count_severities(analyses),
        "pairs": pairs,
        "analyses": analyses,
    }

    # JSON
    json_path = RESULTS_DIR / "conflict_scan_latest.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Markdown 리포트
    md_path = RESULTS_DIR / "conflict_scan_latest.md"
    md_path.write_text(_build_markdown(report), encoding="utf-8")

    print(f"\n  💾 결과 저장: {json_path.name}, {md_path.name}")
    return json_path, md_path


def _count_severities(analyses):
    counts = defaultdict(int)
    for a in analyses:
        comp = a.get("comparison", {})
        for c in comp.get("conflicts", []):
            counts[c.get("severity", "unknown")] += 1
    return dict(counts)


def _build_markdown(report):
    """Markdown 리포트 생성."""
    lines = [
        "# 기획서 충돌 스캔 결과",
        f"\n> 스캔 시각: {report['scan_time']}",
        f"> 소요 시간: {report['elapsed_seconds']}s",
        f"> 매칭 쌍: {report['pairs_found']}개, 분석: {report['pairs_analyzed']}개",
        f"> 발견된 충돌: {report['total_conflicts']}건",
        "",
        "## 심각도 분포",
        "",
    ]
    for sev in ("critical", "major", "minor"):
        cnt = report["severity_counts"].get(sev, 0)
        if cnt:
            lines.append(f"- **{sev}**: {cnt}건")

    lines.append("\n---\n")

    for i, a in enumerate(report["analyses"], 1):
        pair = a.get("pair", {})
        comp = a.get("comparison", {})
        if "error" in a:
            lines.append(f"## [{i}] ❌ {pair.get('excel', '?')} ↔ {pair.get('confluence', '?')}")
            lines.append(f"오류: {a['error']}\n")
            continue

        sev = comp.get("severity", "?")
        icon = {"critical": "🔴", "major": "🟠", "minor": "🟡", "none": "✅"}.get(sev, "?")
        lines.append(f"## [{i}] {icon} {pair.get('excel', '?')} ↔ {pair.get('confluence', '?')}")
        lines.append(f"\n**주제**: {pair.get('overlap_topic', '-')}")
        lines.append(f"**심각도**: {sev}")
        lines.append(f"**관계**: {comp.get('version_relationship', '-')}")
        lines.append(f"\n> {comp.get('summary', '-')}")

        conflicts = comp.get("conflicts", [])
        if conflicts:
            lines.append(f"\n### 충돌 상세 ({len(conflicts)}건)\n")
            for j, c in enumerate(conflicts, 1):
                c_icon = {"critical": "🔴", "major": "🟠", "minor": "🟡"}.get(c.get("severity"), "·")
                lines.append(f"#### {c_icon} {j}. [{c.get('type', '?')}] {c.get('topic', '?')}")
                lines.append(f"- **Excel**: {c.get('excel_says', '-')}")
                lines.append(f"- **Confluence**: {c.get('confluence_says', '-')}")
                lines.append(f"- **권고**: {c.get('recommendation', '-')}")
                lines.append("")

        lines.append("\n---\n")

    return "\n".join(lines)


# ── 메인 실행 ─────────────────────────────────────────────

def run_scan(max_pairs=None, dry_run=False, confidence_filter=("high", "medium")):
    """스캔 전체 워크플로우."""
    t_start = time.time()

    # Phase 1
    excel_docs, confluence_docs = build_index()

    # Phase 2
    pairs = detect_pairs(excel_docs, confluence_docs)

    if dry_run:
        elapsed = time.time() - t_start
        print(f"\n--- DRY RUN 완료 ({elapsed:.1f}s) ---")
        # 매칭 결과만 저장
        save_results(pairs, [], elapsed)
        return pairs, []

    # Phase 3
    print("\n" + "=" * 70)
    print("Phase 3: 심층 충돌 분석")
    print("=" * 70)

    target = [p for p in pairs if p["confidence"] in confidence_filter]
    if max_pairs:
        target = target[:max_pairs]
    print(f"  분석 대상: {len(target)}쌍 (confidence: {', '.join(confidence_filter)})")

    # Lookup maps
    excel_map = {d["name"]: d for d in excel_docs}
    conf_map = {d["rel_path"]: d for d in confluence_docs}

    analyses = []
    for i, pair in enumerate(target, 1):
        e_doc = excel_map.get(pair["excel"])
        c_doc = conf_map.get(pair["confluence"])

        if not e_doc or not c_doc:
            print(f"\n  [{i}/{len(target)}] ⚠️ 문서 매칭 실패: {pair['excel']} / {pair['confluence']}")
            analyses.append({"pair": pair, "error": "document not found"})
            continue

        comparison = compare_pair(e_doc, c_doc, pair, i, len(target))
        analyses.append({"pair": pair, "comparison": comparison})

        # 매 항목 즉시 저장
        save_results(pairs, analyses, time.time() - t_start)

    # 최종 요약
    elapsed = time.time() - t_start
    total_conflicts = sum(
        len(a.get("comparison", {}).get("conflicts", []))
        for a in analyses if "comparison" in a
    )
    sev_counts = _count_severities(analyses)

    print("\n" + "=" * 70)
    print(f"✅ 스캔 완료: {elapsed:.1f}s")
    print(f"   매칭 쌍: {len(pairs)}개")
    print(f"   분석 완료: {len(analyses)}개")
    print(f"   발견 충돌: {total_conflicts}건", end="")
    if sev_counts:
        parts = [f"{k}:{v}" for k, v in sorted(sev_counts.items())]
        print(f" ({', '.join(parts)})")
    else:
        print()
    print("=" * 70)

    save_results(pairs, analyses, elapsed)
    return pairs, analyses


def main():
    parser = argparse.ArgumentParser(description="기획서 충돌/outdated 정보 탐지 스캐너")
    parser.add_argument("--max-pairs", type=int, default=None, help="분석할 최대 쌍 수")
    parser.add_argument("--dry-run", action="store_true", help="매칭만 수행 (LLM 비교 X)")
    parser.add_argument("--include-low", action="store_true", help="low confidence 쌍도 분석")
    args = parser.parse_args()

    conf_filter = ("high", "medium", "low") if args.include_low else ("high", "medium")
    run_scan(max_pairs=args.max_pairs, dry_run=args.dry_run, confidence_filter=conf_filter)


if __name__ == "__main__":
    main()
