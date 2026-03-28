"""
build_kg.py — content.md에서 Knowledge Graph 재생성

데이터 소스:
1. xlsx-extractor output (packages/xlsx-extractor/output/)
2. confluence-downloader output (packages/confluence-downloader/output/)
   - content_enriched.md 우선 사용

Usage:
    python -m src.build_kg
    python -m src.build_kg --dry-run
"""

import io
import json
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

EXTRACTOR_OUTPUT = Path(__file__).resolve().parent.parent.parent / "xlsx-extractor" / "output"
CONFLUENCE_OUTPUT = Path(__file__).resolve().parent.parent.parent / "confluence-downloader" / "output"
KG_OUTPUT = Path(__file__).resolve().parent.parent.parent.parent / "_knowledge_base" / "knowledge_graph.json"

# 시스템 간 관계를 감지하기 위한 키워드 패턴
SYSTEM_KEYWORDS = {
    "변신": ["변신", "트랜스폼"],
    "스킬": ["스킬", "기술"],
    "버프": ["버프", "디버프", "상태 효과"],
    "전투": ["전투", "공격", "피격", "대미지"],
    "아이템": ["아이템", "장비", "인벤토리"],
    "몬스터": ["몬스터", "몹", "보스", "네임드"],
    "퀘스트": ["퀘스트", "의뢰"],
    "NPC": ["NPC", "엔피씨", "상인"],
    "HUD": ["HUD", "UI", "인터페이스"],
    "스탯": ["스탯", "능력치", "공식"],
    "펫": ["펫", "소환수"],
    "파티": ["파티", "그룹"],
    "PvP": ["PvP", "피아", "대전"],
    "레벨": ["레벨", "경험치", "성장"],
    "보상": ["보상", "리워드", "드롭"],
    "골드": ["골드", "재화", "금화"],
    "텔레포트": ["텔레포트", "이동", "순간이동"],
    "스폰": ["스폰", "리젠", "생성"],
    "사망": ["사망", "부활", "죽음"],
    "전투력": ["전투력", "CP"],
    "튜토리얼": ["튜토리얼", "가이드"],
    "채팅": ["채팅", "대화"],
    "카메라": ["카메라", "시점"],
    "미니맵": ["미니맵", "월드맵", "지도"],
    "강화": ["강화", "인챈트"],
    "합성": ["합성", "조합"],
    "분해": ["분해", "해체"],
    "복식": ["복식", "외형", "코스튬"],
    "로그인": ["로그인", "접속"],
    "설정": ["설정", "옵션"],
    "트리거": ["트리거", "이벤트"],
    "시네마틱": ["시네마틱", "연출"],
    "어그로": ["어그로", "헤이트", "타기팅"],
}


def scan_content_files() -> list[dict]:
    """output/ 디렉토리에서 모든 content.md를 스캔하여 메타데이터 추출.

    디렉토리 구조:
    - output/{workbook}/{sheet}/_final/content.md  (직접 하위)
    - output/{category}/{workbook}/{sheet}/_final/content.md  (7_System, 8_Contents 등)
    rglob으로 모든 깊이를 탐색한다.
    """
    entries = []

    if not EXTRACTOR_OUTPUT.exists():
        print(f"[ERROR] output dir not found: {EXTRACTOR_OUTPUT}")
        return entries

    for content_path in sorted(EXTRACTOR_OUTPUT.rglob("_final/content.md")):
        # _final의 부모 = sheet_dir, 그 부모 = workbook_dir
        final_dir = content_path.parent  # _final
        sheet_dir = final_dir.parent     # sheet
        wb_dir = sheet_dir.parent        # workbook (또는 category)

        sheet = sheet_dir.name
        workbook = wb_dir.name

        # category 디렉토리인 경우 (7_System, 8_Contents 등)
        # workbook은 보통 "PK_" 접두사가 있음
        # category 디렉토리(숫자_이름)면 workbook을 한 단계 올려 봄
        if not workbook.startswith("PK_") and not workbook.startswith("Confluence"):
            # 시트 폴더 내부에 _final이 있는지로 판단 — 실제 workbook은 sheet_dir
            # 구조: output/7_System/PK_xxx/시트/_final/content.md
            # 이 경우 wb_dir = PK_xxx, sheet_dir 위가 category
            pass  # workbook = wb_dir.name 이 이미 PK_xxx

        try:
            text = content_path.read_text(encoding="utf-8")
        except Exception:
            continue

        # survey.json에서 cross_references 추출
        survey_refs = []
        survey_path = final_dir / "survey.json"
        if survey_path.exists():
            try:
                survey = json.loads(survey_path.read_text(encoding="utf-8"))
                sv = survey.get("survey", {}).get("service_value", {})
                survey_refs = sv.get("cross_references", [])
            except Exception:
                pass

        entries.append({
            "workbook": workbook,
            "sheet": sheet,
            "path": str(content_path),
            "text": text,
            "size": len(text),
            "survey_cross_references": survey_refs,
        })

    return entries


def scan_confluence_files() -> list[dict]:
    """Confluence output에서 content_enriched.md (또는 content.md)를 스캔."""
    entries = []

    if not CONFLUENCE_OUTPUT.exists():
        print(f"[WARN] Confluence output dir not found: {CONFLUENCE_OUTPUT}")
        return entries

    for content_md in sorted(CONFLUENCE_OUTPUT.rglob("content.md")):
        # 최상위 파일 건너뛰기
        if content_md.parent == CONFLUENCE_OUTPUT:
            continue

        # enriched 우선
        enriched = content_md.parent / "content_enriched.md"
        target = enriched if enriched.exists() else content_md

        try:
            text = target.read_text(encoding="utf-8")
        except Exception:
            continue

        if len(text) < 50:
            continue

        # YAML frontmatter에서 title 추출
        title = content_md.parent.name
        for line in text.split("\n")[:10]:
            if line.startswith("title:"):
                title = line.split(":", 1)[1].strip().strip('"').strip("'")
                break

        # 경로에서 카테고리 추출
        try:
            rel = content_md.parent.relative_to(CONFLUENCE_OUTPUT)
            category = "/".join(rel.parts[:-1]) if len(rel.parts) > 1 else "Confluence"
        except ValueError:
            category = "Confluence"

        entries.append({
            "workbook": f"Confluence/{category}",
            "sheet": title,
            "path": str(target),
            "text": text,
            "size": len(text),
            "source_type": "confluence",
        })

    return entries


def extract_system_info(entries: list[dict]) -> dict:
    """엔트리에서 시스템 정보 추출."""
    systems = {}

    # 워크북별 그룹핑
    wb_entries = defaultdict(list)
    for e in entries:
        wb_entries[e["workbook"]].append(e)

    for wb, sheets in wb_entries.items():
        # 워크북명을 그대로 시스템명으로 사용 (ChromaDB 워크북명과 일치)
        system_name = wb

        all_text = "\n".join(s["text"] for s in sheets)

        # 테이블 개수
        tables = re.findall(r'^\|.+\|$', all_text, re.MULTILINE)
        table_count = len([t for t in tables if '---' not in t]) // 2  # 헤더+데이터 쌍

        # Mermaid 플로우차트 개수
        mermaid_count = all_text.count("```mermaid")

        # 섹션 제목 추출
        sections = re.findall(r'^#{1,3}\s+(.+)$', all_text, re.MULTILINE)

        # 시트 목록
        sheet_names = [s["sheet"] for s in sheets]

        # 관계 탐지 — 명시적 참조만 사용 (키워드 매칭은 노이즈 과다)
        referenced_systems = set()

        # 1. 명시적 참조 ("PK_XXX" 형태 — PK_ 접두사 포함하여 ChromaDB 워크북명과 일치)
        explicit_refs = re.findall(r'(PK_[^\s/\\,]+)', all_text)
        for ref in explicit_refs:
            ref_clean = ref.strip().rstrip(')].').replace("'", "").replace('"', '')
            if ref_clean != system_name and len(ref_clean) > 3:
                referenced_systems.add(ref_clean)

        # 2. 시트 내 다른 워크북 참조 ("워크북명!셀" 형태)
        sheet_refs = re.findall(r'([가-힣\w]{2,})![A-Z]\d+', all_text)
        sheet_names_local = [s["sheet"] for s in sheets]
        for ref in sheet_refs:
            if ref == system_name or ref in sheet_names_local:
                continue
            # 참조를 워크북명으로 해소 (PK_ 접두사 추가 시도)
            if f"PK_{ref}" in wb_entries:
                referenced_systems.add(f"PK_{ref}")
            elif ref in wb_entries:
                referenced_systems.add(ref)
            else:
                # 부분 매칭으로 워크북 찾기
                for candidate_wb in wb_entries:
                    candidate_short = candidate_wb.replace("PK_", "").strip()
                    if ref in candidate_short or candidate_short in ref:
                        referenced_systems.add(candidate_wb)
                        break

        # 3. 헤딩에서 다른 시스템 명시적 언급 (##/### 레벨)
        for section in sections:
            for other_wb in wb_entries:
                if other_wb != system_name and len(other_wb) >= 3:
                    # PK_ 제거한 이름으로도 매칭 시도
                    other_short = other_wb.replace("PK_", "").strip()
                    if other_short in section or other_wb in section:
                        referenced_systems.add(other_wb)

        # 4. survey.json cross_references (Vision AI가 의미적으로 파악한 관계)
        for s in sheets:
            for ref in s.get("survey_cross_references", []):
                ref_clean = ref.strip()
                if not ref_clean or len(ref_clean) < 2:
                    continue
                # 직접 매칭 시도
                for candidate_wb in wb_entries:
                    if candidate_wb == system_name:
                        continue
                    candidate_short = candidate_wb.replace("PK_", "").strip()
                    # "소환 시스템" → "PK_소환 시스템" 등
                    ref_normalized = ref_clean.replace(" 시스템", "").replace("시스템", "").strip()
                    if (ref_clean in candidate_short or candidate_short in ref_clean
                            or ref_normalized in candidate_short
                            or candidate_short in ref_normalized):
                        referenced_systems.add(candidate_wb)
                        break

        # 소스 유형 결정
        file_types = list(set(s.get("source_type", "excel") for s in sheets))

        systems[system_name] = {
            "source_files": [f"packages/xlsx-extractor/output/{wb}"] if "excel" in file_types
                            else [f"packages/confluence-downloader/output/{wb}"],
            "sheets": sheet_names,
            "sheet_count": len(sheet_names),
            "total_size": sum(s["size"] for s in sheets),
            "related_systems": sorted(referenced_systems),
            "tables": table_count,
            "mermaid_charts": mermaid_count,
            "sections": sections[:20],  # 상위 20개만
            "description": _extract_description(all_text),
            "file_types": file_types,
        }

    return systems


def _extract_description(text: str) -> str:
    """content.md에서 첫 번째 의미 있는 설명 추출."""
    lines = text.split("\n")
    for line in lines:
        line = line.strip()
        # 메타데이터/헤딩/빈줄 스킵
        if not line or line.startswith("#") or line.startswith(">") or line.startswith("---"):
            continue
        if line.startswith("|") or line.startswith("```"):
            continue
        # 짧은 설명 반환
        if len(line) > 10:
            return line[:200]
    return ""


def resolve_relationships(systems: dict) -> dict:
    """교차 참조를 정규화하여 양방향 관계로 변환."""
    system_names = set(systems.keys())
    name_lookup = {}

    # 이름 정규화 룩업 (ChromaDB 워크북명 기준)
    for name in system_names:
        name_lookup[name.lower()] = name
        # 공백 제거 버전
        name_lookup[name.lower().replace(" ", "")] = name
        # PK_ 제거 버전 (참조가 PK_ 없이 들어올 수 있음)
        if name.startswith("PK_"):
            short = name[3:].strip()
            name_lookup[short.lower()] = name
            name_lookup[short.lower().replace(" ", "")] = name
        # Confluence 마지막 세그먼트
        if name.startswith("Confluence/"):
            last_seg = name.split("/")[-1]
            name_lookup[last_seg.lower()] = name

    # 관계 해소 및 양방향화
    for sys_name, info in systems.items():
        resolved_refs = set()
        for ref in info["related_systems"]:
            ref_lower = ref.lower()

            # 직접 매칭
            if ref_lower in name_lookup:
                resolved = name_lookup[ref_lower]
                if resolved != sys_name:
                    resolved_refs.add(resolved)
                continue

            # 부분 매칭
            for known_name in system_names:
                if known_name == sys_name:
                    continue
                if ref_lower in known_name.lower() or known_name.lower() in ref_lower:
                    resolved_refs.add(known_name)
                    break

        info["related_systems"] = sorted(resolved_refs)

    # 양방향 보장
    for sys_name, info in systems.items():
        for related in info["related_systems"]:
            if related in systems:
                if sys_name not in systems[related]["related_systems"]:
                    systems[related]["related_systems"].append(sys_name)
                    systems[related]["related_systems"].sort()

    return systems


def build_knowledge_graph(dry_run: bool = False):
    """Knowledge Graph 구축."""
    t0 = time.time()

    print(f"{'=' * 70}")
    print(f"  Knowledge Graph 재생성")
    print(f"  소스: Excel({EXTRACTOR_OUTPUT}) + Confluence({CONFLUENCE_OUTPUT})")
    print(f"{'=' * 70}")

    # 1. 스캔
    print(f"\n  [1/4] content.md 스캔 중...")
    entries = scan_content_files()
    survey_ref_count = sum(len(e.get("survey_cross_references", [])) for e in entries)
    print(f"    Excel: {len(entries)}개 content.md (survey cross_refs: {survey_ref_count}개)")
    conf_entries = scan_confluence_files()
    print(f"    Confluence: {len(conf_entries)}개 content.md")
    entries.extend(conf_entries)
    print(f"    합계: {len(entries)}개")

    # 2. 시스템 정보 추출
    print(f"  [2/4] 시스템 정보 추출 중...")
    systems = extract_system_info(entries)
    print(f"    {len(systems)}개 시스템 추출")

    # 3. 관계 해소
    print(f"  [3/4] 관계 정규화 중...")
    systems = resolve_relationships(systems)

    total_rels = sum(len(s["related_systems"]) for s in systems.values())
    systems_with_rels = sum(1 for s in systems.values() if s["related_systems"])
    print(f"    총 관계: {total_rels}, 관계가 있는 시스템: {systems_with_rels}/{len(systems)}")

    # 통계
    avg_sheets = sum(s["sheet_count"] for s in systems.values()) / max(len(systems), 1)
    avg_rels = total_rels / max(len(systems), 1)
    max_rels = max((len(s["related_systems"]) for s in systems.values()), default=0)
    max_rel_sys = max(systems.keys(), key=lambda k: len(systems[k]["related_systems"])) if systems else ""

    print(f"\n  통계:")
    print(f"    평균 시트 수: {avg_sheets:.1f}")
    print(f"    평균 관계 수: {avg_rels:.1f}")
    print(f"    최대 관계 수: {max_rels} ({max_rel_sys})")

    # 상위 연결 시스템
    print(f"\n  가장 많이 연결된 시스템 (Top 10):")
    sorted_systems = sorted(systems.items(), key=lambda x: len(x[1]["related_systems"]), reverse=True)
    for name, info in sorted_systems[:10]:
        print(f"    {name}: {len(info['related_systems'])} 관계 — {info['related_systems'][:5]}")

    if dry_run:
        print(f"\n  [DRY RUN] 저장하지 않음.")
        return

    # 4. 저장
    print(f"\n  [4/4] 저장 중...")
    kg = {
        "meta": {
            "created": datetime.now().isoformat(),
            "project": "Project K",
            "source_dirs": [str(EXTRACTOR_OUTPUT), str(CONFLUENCE_OUTPUT)],
            "source_files": len(entries),
            "total_systems": len(systems),
            "total_relationships": total_rels,
            "systems_with_relationships": systems_with_rels,
            "generator": "build_kg.py (content.md 기반 재생성)",
        },
        "systems": systems,
    }

    KG_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    KG_OUTPUT.write_text(
        json.dumps(kg, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    elapsed = time.time() - t0
    file_size = KG_OUTPUT.stat().st_size / 1024
    print(f"    저장 완료: {KG_OUTPUT}")
    print(f"    파일 크기: {file_size:.1f} KB")
    print(f"    소요 시간: {elapsed:.1f}s")
    print(f"{'=' * 70}")

    return kg


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    build_knowledge_graph(dry_run=dry_run)
