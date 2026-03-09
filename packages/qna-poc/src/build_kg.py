"""
build_kg.py — 629개 content.md에서 Knowledge Graph 재생성

output/ 디렉토리의 content.md를 파싱하여:
1. 워크북→시트 구조 추출
2. content.md 내 시스템 간 교차 참조 탐지
3. 공통 키워드 기반 관계 추론
4. knowledge_graph.json 출력

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
    """output/ 디렉토리에서 모든 content.md를 스캔하여 메타데이터 추출."""
    entries = []

    if not EXTRACTOR_OUTPUT.exists():
        print(f"[ERROR] output dir not found: {EXTRACTOR_OUTPUT}")
        return entries

    for wb_dir in sorted(EXTRACTOR_OUTPUT.iterdir()):
        if not wb_dir.is_dir():
            continue
        workbook = wb_dir.name

        for sheet_dir in sorted(wb_dir.iterdir()):
            if not sheet_dir.is_dir():
                continue
            sheet = sheet_dir.name

            content_path = sheet_dir / "_final" / "content.md"
            if not content_path.exists():
                continue

            try:
                text = content_path.read_text(encoding="utf-8")
            except Exception:
                continue

            entries.append({
                "workbook": workbook,
                "sheet": sheet,
                "path": str(content_path),
                "text": text,
                "size": len(text),
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
        # 워크북명에서 시스템명 추출
        system_name = wb.replace("PK_", "").strip()

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

        # 1. 명시적 참조 ("PK_XXX" 형태)
        explicit_refs = re.findall(r'PK_([^\s/\\,]+)', all_text)
        for ref in explicit_refs:
            ref_clean = ref.strip().rstrip(')].').replace("'", "").replace('"', '')
            if ref_clean != system_name and len(ref_clean) > 1:
                referenced_systems.add(ref_clean)

        # 2. 시트 내 다른 워크북 참조 ("워크북명!셀" 형태)
        sheet_refs = re.findall(r'([가-힣\w]{2,})![A-Z]\d+', all_text)
        for ref in sheet_refs:
            if ref != system_name and ref not in [s["sheet"] for s in sheets]:
                referenced_systems.add(ref)

        # 3. 헤딩에서 다른 시스템 명시적 언급 (##/### 레벨)
        for section in sections:
            for other_wb in wb_entries:
                other_name = other_wb.replace("PK_", "").strip()
                if other_name != system_name and len(other_name) >= 3:
                    if other_name in section:
                        referenced_systems.add(other_name)

        systems[system_name] = {
            "source_files": [f"packages/xlsx-extractor/output/{wb}"],
            "sheets": sheet_names,
            "sheet_count": len(sheet_names),
            "total_size": sum(s["size"] for s in sheets),
            "related_systems": sorted(referenced_systems),
            "tables": table_count,
            "mermaid_charts": mermaid_count,
            "sections": sections[:20],  # 상위 20개만
            "description": _extract_description(all_text),
            "file_types": ["excel"],
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

    # 이름 정규화 룩업
    for name in system_names:
        name_lookup[name.lower()] = name
        # 공백 제거 버전
        name_lookup[name.lower().replace(" ", "")] = name
        # 짧은 키워드 버전
        words = name.split()
        if words:
            name_lookup[words[0].lower()] = name

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
    print(f"  소스: {EXTRACTOR_OUTPUT}")
    print(f"{'=' * 70}")

    # 1. 스캔
    print(f"\n  [1/4] content.md 스캔 중...")
    entries = scan_content_files()
    print(f"    {len(entries)}개 content.md 발견")

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
            "source_dir": str(EXTRACTOR_OUTPUT),
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
