"""
generate_gt_questions.py — Ground Truth QnA 대량 생성

629개 content.md를 규칙 기반으로 파싱하여 ~500개 QnA 쌍을 생성.
API 호출 없이 로컬에서 실행 (비용 $0).

카테고리:
  A. 사실 조회 (단일 문서 즉답)
  B. 시스템 간 연관 (2개+ 문서 종합)
  C. 밸런스 수치 (정확한 숫자/공식)
  D. 프로세스/플로우 (Mermaid 추적)
  E. UI 사양 (UI 요소/레이아웃)
  F. 메타/히스토리 (변경 이력/용어 정의)
  H. 할루시네이션 트랩 (존재하지 않는 데이터)

Usage:
    python -m eval.generate_gt_questions
    python -m eval.generate_gt_questions --dry-run   # 통계만
"""

import io
import json
import os
import re
import sys
import hashlib
import random
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

EXTRACTOR_OUTPUT = Path(__file__).resolve().parent.parent.parent / "xlsx-extractor" / "output"
OUTPUT_PATH = Path(__file__).resolve().parent / "gt_questions.json"


# ── 파서 유틸 ──

def parse_content_md(filepath: Path) -> dict:
    """content.md 파일을 파싱하여 구조화된 데이터를 추출."""
    text = filepath.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")

    result = {
        "filepath": str(filepath),
        "workbook": filepath.parts[-4] if len(filepath.parts) >= 4 else "",
        "sheet": filepath.parts[-3] if len(filepath.parts) >= 3 else "",
        "title": "",
        "sections": [],
        "tables": [],
        "mermaid_blocks": [],
        "definitions": [],
        "key_values": [],
        "has_ui": False,
        "total_lines": len(lines),
    }

    # 워크북/시트 경로에서 추출
    parts = filepath.relative_to(EXTRACTOR_OUTPUT).parts
    if len(parts) >= 2:
        result["workbook"] = parts[0]
        result["sheet"] = parts[1]

    current_section = ""
    current_subsection = ""
    in_mermaid = False
    mermaid_buf = []
    in_table = False
    table_buf = []

    for i, line in enumerate(lines):
        stripped = line.strip()

        # 제목 추출
        if stripped.startswith("# ") and not stripped.startswith("## "):
            result["title"] = stripped[2:].strip()
            continue

        # 섹션 추출
        if stripped.startswith("## "):
            if in_table and table_buf:
                result["tables"].append({
                    "section": current_section,
                    "subsection": current_subsection,
                    "rows": _parse_table(table_buf),
                    "raw": "\n".join(table_buf),
                })
                table_buf = []
                in_table = False
            current_section = stripped[3:].strip()
            current_subsection = ""
            result["sections"].append(current_section)
            continue

        if stripped.startswith("### "):
            if in_table and table_buf:
                result["tables"].append({
                    "section": current_section,
                    "subsection": current_subsection,
                    "rows": _parse_table(table_buf),
                    "raw": "\n".join(table_buf),
                })
                table_buf = []
                in_table = False
            current_subsection = stripped[4:].strip()
            continue

        # Mermaid 블록
        if stripped.startswith("```mermaid"):
            in_mermaid = True
            mermaid_buf = []
            continue
        if in_mermaid:
            if stripped == "```":
                in_mermaid = False
                result["mermaid_blocks"].append({
                    "section": current_section,
                    "subsection": current_subsection,
                    "content": "\n".join(mermaid_buf),
                })
            else:
                mermaid_buf.append(line)
            continue

        # 테이블 감지
        if "|" in stripped and stripped.startswith("|"):
            if not in_table:
                in_table = True
                table_buf = []
            table_buf.append(stripped)
            continue
        elif in_table:
            if table_buf:
                result["tables"].append({
                    "section": current_section,
                    "subsection": current_subsection,
                    "rows": _parse_table(table_buf),
                    "raw": "\n".join(table_buf),
                })
            table_buf = []
            in_table = False

        # 정의 추출 (→ 또는 : 패턴)
        if stripped.startswith("→ ") or stripped.startswith("- "):
            content = stripped.lstrip("→- ").strip()
            if len(content) > 10:
                result["definitions"].append({
                    "section": current_section,
                    "subsection": current_subsection,
                    "text": content,
                })

        # 키-값 추출 (: 구분)
        kv_match = re.match(r'^[-→•]\s*\*?\*?\[?(.+?)\]?\*?\*?\s*[:：]\s*(.+)', stripped)
        if kv_match:
            result["key_values"].append({
                "section": current_section,
                "key": kv_match.group(1).strip(),
                "value": kv_match.group(2).strip(),
            })

        # UI 관련 키워드 감지
        if any(kw in stripped.lower() for kw in ["hud", "ui", "화면", "버튼", "인터페이스", "레이아웃"]):
            result["has_ui"] = True

    # 마지막 테이블 처리
    if in_table and table_buf:
        result["tables"].append({
            "section": current_section,
            "subsection": current_subsection,
            "rows": _parse_table(table_buf),
            "raw": "\n".join(table_buf),
        })

    return result


def _parse_table(lines: list[str]) -> list[list[str]]:
    """마크다운 테이블을 2D 배열로 파싱."""
    rows = []
    for line in lines:
        if re.match(r'^\|[\s\-:]+\|', line):
            continue  # 구분선 스킵
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c]  # 빈 셀 제거
        if cells:
            rows.append(cells)
    return rows


# ── 질문 생성기 ──

def _make_id(category: str, idx: int) -> str:
    return f"GT-{category}-{idx:03d}"


def generate_table_questions(parsed: dict) -> list[dict]:
    """테이블에서 사실 조회 질문 생성 (카테고리 A, C)."""
    questions = []
    wb = parsed["workbook"]
    sheet = parsed["sheet"]

    for table in parsed["tables"]:
        rows = table["rows"]
        if len(rows) < 2:
            continue

        header = rows[0]
        data_rows = rows[1:]

        # 행이 2개 이상이고 열이 2개 이상인 유효한 테이블
        if len(header) < 2:
            continue

        # 패턴 1: 특정 행의 특정 열 값 질문
        for row in data_rows[:5]:  # 최대 5행
            if len(row) < 2:
                continue

            row_label = row[0].strip()
            if not row_label or len(row_label) > 30:
                continue

            # 의미 없는 행 필터 (순수 날짜, 버전 번호 등)
            if re.match(r'^[\d.\-/]+$', row_label):
                continue
            if len(row_label) < 2:
                continue

            for col_idx in range(1, min(len(row), len(header))):
                col_name = header[col_idx].strip()
                cell_value = row[col_idx].strip()

                if not cell_value or cell_value in ["-", "—", "", "X"]:
                    continue
                if len(cell_value) > 50:
                    continue
                # 컬럼명이 너무 짧거나 의미 없으면 스킵
                if not col_name or len(col_name) < 2:
                    continue

                # 숫자 값이 있으면 C (밸런스), 아니면 A (사실 조회)
                has_number = bool(re.search(r'\d', cell_value))
                category = "C" if has_number else "A"

                # 시스템 이름 정리
                sys_name = wb.replace("PK_", "")
                section_ctx = table["section"] if table["section"] else ""

                q_templates = [
                    f"{sys_name}에서 {row_label}의 {col_name}은(는) 무엇인가?",
                    f"{sys_name} 기획서에서 {row_label}의 {col_name}을(를) 알려줘",
                ]

                q = random.choice(q_templates)
                keywords = [kw for kw in [row_label, cell_value] if len(kw) > 1]
                if col_name and len(col_name) > 1:
                    keywords.append(col_name)

                questions.append({
                    "query": q,
                    "category": category,
                    "expected_workbooks": [wb],
                    "expected_sheets": [sheet],
                    "expected_answer_keywords": keywords[:5],
                    "ground_truth_source": f"{wb}/{sheet}/_final/content.md",
                    "ground_truth_text": f"{row_label}의 {col_name} = {cell_value}",
                    "section": section_ctx,
                })

                if len(questions) > 3:
                    break  # 테이블당 최대 3개
            if len(questions) > 3:
                break

    return questions[:4]  # 파일당 테이블 질문 최대 4개


def generate_definition_questions(parsed: dict) -> list[dict]:
    """정의/규칙에서 질문 생성 (카테고리 A, F)."""
    questions = []
    wb = parsed["workbook"]
    sheet = parsed["sheet"]
    sys_name = wb.replace("PK_", "")

    for defn in parsed["definitions"][:10]:
        text = defn["text"]
        section = defn["section"]

        if len(text) < 15 or len(text) > 200:
            continue

        # 핵심 키워드 추출
        keywords = re.findall(r'[\w가-힣]{2,}', text)
        keywords = [kw for kw in keywords if len(kw) >= 2][:4]

        if not keywords:
            continue

        # 질문 생성
        if section:
            section_clean = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩\s\d.()]+', '', section).strip()
            q = f"{sys_name}의 {section_clean}에 대해 설명해줘"
        else:
            q = f"{sys_name}의 규칙은?"

        questions.append({
            "query": q,
            "category": "A",
            "expected_workbooks": [wb],
            "expected_sheets": [sheet],
            "expected_answer_keywords": keywords,
            "ground_truth_source": f"{wb}/{sheet}/_final/content.md",
            "ground_truth_text": text[:150],
            "section": section,
        })

    return questions[:2]  # 파일당 정의 질문 최대 2개


def generate_mermaid_questions(parsed: dict) -> list[dict]:
    """Mermaid 플로우차트에서 프로세스 질문 생성 (카테고리 D)."""
    questions = []
    wb = parsed["workbook"]
    sheet = parsed["sheet"]
    sys_name = wb.replace("PK_", "")

    for mermaid in parsed["mermaid_blocks"][:3]:
        content = mermaid["content"]
        section = mermaid["section"]

        # 노드 레이블 추출
        node_labels = re.findall(r'[\[\({"](.*?)[\]\)}""]', content)
        node_labels = [l.strip() for l in node_labels if l.strip() and len(l.strip()) > 1]

        if len(node_labels) < 2:
            continue

        # 엣지 레이블 추출
        edge_labels = re.findall(r'-->\|(.+?)\|', content)

        keywords = node_labels[:4]
        if edge_labels:
            keywords.extend(edge_labels[:2])

        section_clean = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩\s\d.()]+', '', section).strip() if section else ""

        q_templates = [
            f"{sys_name}의 {section_clean} 플로우를 설명해줘" if section_clean else f"{sys_name}의 프로세스 흐름은?",
            f"{sys_name}에서 {node_labels[0]}부터의 진행 과정은?",
        ]

        questions.append({
            "query": random.choice(q_templates),
            "category": "D",
            "expected_workbooks": [wb],
            "expected_sheets": [sheet],
            "expected_answer_keywords": keywords[:5],
            "ground_truth_source": f"{wb}/{sheet}/_final/content.md",
            "ground_truth_text": f"플로우: {' → '.join(node_labels[:5])}",
            "section": section,
        })

    return questions[:2]  # 파일당 Mermaid 질문 최대 2개


def generate_ui_questions(parsed: dict) -> list[dict]:
    """UI 관련 질문 생성 (카테고리 E)."""
    if not parsed["has_ui"]:
        return []

    questions = []
    wb = parsed["workbook"]
    sheet = parsed["sheet"]
    sys_name = wb.replace("PK_", "")

    # UI 관련 섹션 찾기
    ui_sections = [s for s in parsed["sections"]
                   if any(kw in s.lower() for kw in ["ui", "hud", "화면", "레이아웃", "표시", "인터페이스"])]

    if not ui_sections:
        ui_sections = parsed["sections"][:2]

    for section in ui_sections[:2]:
        section_clean = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩\s\d.()]+', '', section).strip()
        keywords = re.findall(r'[\w가-힣]{2,}', section_clean)

        q_templates = [
            f"{sys_name}의 {section_clean} UI 구성은?",
            f"{sys_name} 화면에 표시되는 요소 목록은?",
        ]

        questions.append({
            "query": random.choice(q_templates),
            "category": "E",
            "expected_workbooks": [wb],
            "expected_sheets": [sheet],
            "expected_answer_keywords": keywords[:4] + [sys_name.split()[0]],
            "ground_truth_source": f"{wb}/{sheet}/_final/content.md",
            "ground_truth_text": f"{section_clean} UI 사양",
            "section": section,
        })

    return questions[:1]  # 파일당 UI 질문 최대 1개


def generate_section_questions(parsed: dict) -> list[dict]:
    """섹션 제목에서 개요/목적 질문 생성 (카테고리 A, F)."""
    questions = []
    wb = parsed["workbook"]
    sheet = parsed["sheet"]
    sys_name = wb.replace("PK_", "")

    # 목적/개요/정의 섹션 찾기
    for section in parsed["sections"]:
        section_clean = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩\s\d.()]+', '', section).strip()

        if any(kw in section_clean for kw in ["목적", "개요", "정의", "기본 규칙"]):
            q_templates = [
                f"{sys_name}의 {section_clean}은?",
                f"'{sys_name}'이란 무엇인가?",
                f"{sys_name} 시스템의 목적은?",
            ]

            questions.append({
                "query": random.choice(q_templates),
                "category": "F",
                "expected_workbooks": [wb],
                "expected_sheets": [sheet],
                "expected_answer_keywords": [sys_name.split()[0]],
                "ground_truth_source": f"{wb}/{sheet}/_final/content.md",
                "ground_truth_text": f"{sys_name}의 {section_clean}",
                "section": section,
            })

    return questions[:1]


def generate_cross_system_questions(all_parsed: list[dict]) -> list[dict]:
    """시스템 간 연관 질문 생성 (카테고리 B)."""
    questions = []

    # 워크북 → 시트 목록
    wb_sheets = {}
    for p in all_parsed:
        wb = p["workbook"]
        if wb not in wb_sheets:
            wb_sheets[wb] = []
        wb_sheets[wb].append(p["sheet"])

    # 관련 시스템 쌍 정의 (실제 데이터에서 확인된 관계)
    cross_pairs = [
        ("PK_변신 및 스킬 시스템", "PK_스킬 시스템", "변신", "스킬", "변신과 스킬의 연동 방식"),
        ("PK_변신 및 스킬 시스템", "PK_버프 시스템", "변신", "버프", "변신 시 적용되는 버프"),
        ("PK_아이템 시스템", "PK_인벤토리 시스템", "아이템", "인벤토리", "아이템과 인벤토리의 데이터 구조"),
        ("PK_스킬 시스템", "PK_대미지 명중률 계산기", "스킬", "대미지", "스킬 대미지 계산 과정"),
        ("PK_몬스터 시스템", "PK_전투AI시스템", "몬스터", "전투AI", "몬스터의 AI 전투 행동"),
        ("PK_퀘스트", "PK_보상 시스템", "퀘스트", "보상", "퀘스트 보상 지급 방식"),
        ("PK_기본 전투 시스템", "PK_스탯 및 공식", "전투", "스탯", "전투에서 스탯 적용 방식"),
        ("PK_HUD 시스템", "PK_스킬 시스템", "HUD", "스킬", "HUD에서 스킬 표시 방식"),
        ("PK_전투력 시스템", "PK_스탯 및 공식", "전투력", "스탯", "전투력 계산에 사용되는 스탯"),
        ("PK_사망 및 부활 시스템", "PK_기본 전투 시스템", "사망", "전투", "사망 후 페널티와 부활"),
        ("PK_펫 시스템", "PK_버프 시스템", "펫", "버프", "펫이 제공하는 버프 효과"),
        ("PK_스폰 시스템", "PK_몬스터 시스템", "스폰", "몬스터", "몬스터 스폰 규칙과 배치"),
        ("PK_파티 시스템", "PK_기본 전투 시스템", "파티", "전투", "파티 전투 규칙"),
        ("PK_NPC 시스템", "PK_퀘스트", "NPC", "퀘스트", "NPC 퀘스트 연동"),
        ("PK_레벨업 시스템", "PK_캐릭터 성장 밸런스", "레벨업", "성장", "레벨업 밸런스 설계"),
        ("PK_발동 액션 시스템", "PK_스킬 시스템", "발동 액션", "스킬", "발동 액션과 스킬의 관계"),
        ("PK_월드맵 시스템", "PK_텔레포트 시스템", "월드맵", "텔레포트", "월드맵과 텔레포트의 연동"),
        ("PK_로그인 플로우", "PK_캐릭터 선택창&변신", "로그인", "캐릭터", "로그인부터 캐릭터 선택까지"),
        ("PK_피아 식별", "PK_기본 전투 시스템", "PvP", "전투", "PvP에서의 전투 규칙"),
        ("PK_복식 시스템", "PK_변신 및 스킬 시스템", "복식", "변신", "복식과 변신의 관계"),
    ]

    for wb1, wb2, sys1, sys2, topic in cross_pairs:
        if wb1 in wb_sheets and wb2 in wb_sheets:
            q_templates = [
                f"{sys1} 시스템과 {sys2} 시스템은 어떻게 연동되는가?",
                f"{sys1}과(와) {sys2}의 관계를 설명해줘",
                f"{topic}은 어떻게 되어 있나?",
            ]

            questions.append({
                "query": random.choice(q_templates),
                "category": "B",
                "expected_workbooks": [wb1, wb2],
                "expected_sheets": [],
                "expected_answer_keywords": [sys1, sys2],
                "ground_truth_source": f"{wb1} + {wb2}",
                "ground_truth_text": topic,
                "section": "",
            })

    return questions


def generate_hallucination_traps() -> list[dict]:
    """할루시네이션 트랩 질문 생성 (카테고리 H).

    기획서에 존재하지 않는 내용에 대한 질문.
    올바른 답변: "해당 정보를 찾을 수 없습니다."
    """
    traps = [
        # 존재하지 않는 시스템
        {"query": "PvP 레이드 시스템의 매칭 규칙은?", "fake_topic": "PvP 레이드 시스템"},
        {"query": "길드 전쟁 시스템의 참가 조건은?", "fake_topic": "길드 전쟁 시스템"},
        {"query": "하우징 시스템에서 가구 배치 규칙은?", "fake_topic": "하우징 시스템"},
        {"query": "탈것(마운트) 시스템의 속도 보너스 테이블은?", "fake_topic": "탈것 시스템"},
        {"query": "낚시 시스템의 물고기 종류와 등급은?", "fake_topic": "낚시 시스템"},
        {"query": "요리 제작 시스템의 레시피 목록은?", "fake_topic": "요리 시스템"},
        {"query": "펫 진화 시스템의 진화 조건은?", "fake_topic": "펫 진화 시스템"},
        {"query": "날씨 시스템이 전투에 미치는 영향은?", "fake_topic": "날씨 시스템"},
        {"query": "경매장 시스템의 수수료 체계는?", "fake_topic": "경매장 시스템"},
        {"query": "클랜(길드) 레벨업 보상 목록은?", "fake_topic": "클랜 시스템"},
        {"query": "보석 세공 시스템의 강화 확률은?", "fake_topic": "보석 세공 시스템"},
        {"query": "업적 시스템의 칭호 보상 목록은?", "fake_topic": "업적 시스템"},
        {"query": "랭킹 시스템의 시즌 리셋 규칙은?", "fake_topic": "랭킹 시스템"},
        {"query": "직업 전환 시스템의 조건은?", "fake_topic": "직업 전환 시스템"},
        {"query": "우편함 시스템의 보관 기간은?", "fake_topic": "우편함 시스템"},
        {"query": "자동 매크로 감지 시스템의 판별 기준은?", "fake_topic": "매크로 감지 시스템"},
        {"query": "혈맹 시스템의 동맹 규칙은?", "fake_topic": "혈맹 시스템"},
        {"query": "대장장이 NPC에서 아이템 수리 비용 공식은?", "fake_topic": "아이템 수리 시스템"},
        {"query": "듀얼 클래스 시스템에서 부직업 스킬 제한은?", "fake_topic": "듀얼 클래스 시스템"},
        {"query": "월드 보스 소환 조건과 출현 주기는?", "fake_topic": "월드 보스 시스템"},

        # 존재하는 시스템이지만 없는 세부사항
        {"query": "변신 시스템의 PvP 전용 스킬 목록은?", "fake_topic": "변신 PvP 전용 스킬"},
        {"query": "스킬 시스템의 궁극기 연출 프레임 수는?", "fake_topic": "궁극기 연출 프레임"},
        {"query": "몬스터 시스템의 계절별 출현 패턴은?", "fake_topic": "계절별 몬스터 출현"},
        {"query": "인벤토리의 자동 정렬 알고리즘은?", "fake_topic": "인벤토리 자동 정렬"},
        {"query": "HUD 시스템의 컬러 블라인드 모드 설정은?", "fake_topic": "컬러 블라인드 모드"},
        {"query": "퀘스트 시스템의 랜덤 퀘스트 생성 규칙은?", "fake_topic": "랜덤 퀘스트 생성"},
        {"query": "채팅 시스템의 음성 채팅 설정은?", "fake_topic": "음성 채팅"},
        {"query": "전투 시스템의 콤보 공격 입력 판정 프레임은?", "fake_topic": "콤보 공격 프레임"},
        {"query": "파티 시스템의 자동 매칭 알고리즘은?", "fake_topic": "자동 파티 매칭"},
        {"query": "카메라 시스템의 VR 모드 설정은?", "fake_topic": "VR 모드"},

        # 그럴듯한 가짜 수치 질문
        {"query": "변신 등급별 최대 합성 시도 횟수는?", "fake_topic": "합성 시도 횟수 제한"},
        {"query": "스킬 레벨 50 이상 강화 확률은?", "fake_topic": "스킬 50이상 강화"},
        {"query": "골드 밸런스에서 PvP 킬 보상 골드 공식은?", "fake_topic": "PvP 킬 보상"},
        {"query": "장비 초월 강화 시스템의 돌파 성공률은?", "fake_topic": "초월 강화 시스템"},
        {"query": "펫 전투력이 주인 전투력에 기여하는 비율은?", "fake_topic": "펫 전투력 기여"},
        {"query": "몬스터 어그로 감소 스킬의 쿨타임 공식은?", "fake_topic": "어그로 감소 쿨타임"},
        {"query": "인벤토리 확장 최대 슬롯 수와 비용은?", "fake_topic": "인벤토리 확장"},
        {"query": "미니맵에서 적 플레이어 표시 범위(m)는?", "fake_topic": "미니맵 적 표시 범위"},
        {"query": "텔레포트 시전 중 피격 시 캔슬 확률은?", "fake_topic": "텔레포트 캔슬 확률"},
        {"query": "버프 시스템의 디버프 저항 계산 공식은?", "fake_topic": "디버프 저항 공식"},

        # 존재하는 시스템의 미래 계획 (없는 내용)
        {"query": "변신 시스템 2차 업데이트에서 추가되는 등급은?", "fake_topic": "변신 2차 업데이트"},
        {"query": "스킬 시스템의 각성 기능 구현 일정은?", "fake_topic": "스킬 각성 일정"},
        {"query": "아이템 거래소 시스템의 베타 테스트 결과는?", "fake_topic": "거래소 베타 결과"},
        {"query": "몬스터 AI 시스템의 머신러닝 적용 계획은?", "fake_topic": "AI 머신러닝 계획"},
        {"query": "퀘스트 시스템의 브랜치 퀘스트 기획 상세는?", "fake_topic": "브랜치 퀘스트"},
    ]

    questions = []
    for i, trap in enumerate(traps):
        questions.append({
            "id": _make_id("H", i + 1),
            "query": trap["query"],
            "category": "H",
            "expected_workbooks": [],
            "expected_sheets": [],
            "expected_answer_keywords": ["찾을 수 없", "없습니다", "정보가 없"],
            "ground_truth_source": "N/A (할루시네이션 트랩)",
            "ground_truth_text": f"해당 정보 없음 — '{trap['fake_topic']}'은(는) 기획서에 존재하지 않음",
            "section": "",
            "is_hallucination_trap": True,
        })

    return questions


# ── 메인 ──

def scan_all_content_files() -> list[Path]:
    """모든 _final/content.md 파일을 스캔."""
    files = sorted(EXTRACTOR_OUTPUT.glob("**/_final/content.md"))
    return files


def generate_all_questions(dry_run: bool = False) -> dict:
    """전체 QnA 생성."""
    files = scan_all_content_files()
    print(f"스캔된 content.md: {len(files)}개")

    if dry_run:
        # 워크북별 통계
        wb_counts = {}
        for f in files:
            parts = f.relative_to(EXTRACTOR_OUTPUT).parts
            wb = parts[0] if parts else "unknown"
            wb_counts[wb] = wb_counts.get(wb, 0) + 1
        print(f"\n워크북 수: {len(wb_counts)}")
        for wb, count in sorted(wb_counts.items()):
            print(f"  {wb}: {count} 시트")
        return {}

    # 1. 모든 파일 파싱
    print("파싱 중...")
    all_parsed = []
    for f in files:
        try:
            parsed = parse_content_md(f)
            if parsed["total_lines"] > 5:  # 의미 있는 내용이 있는 파일만
                all_parsed.append(parsed)
        except Exception as e:
            print(f"  [WARN] {f}: {e}")

    print(f"유효 파일: {len(all_parsed)}개")

    # 2. 파일별 질문 생성
    all_questions = []
    stats = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0, "F": 0, "H": 0}

    for parsed in all_parsed:
        file_questions = []

        # 테이블 질문 (A, C)
        tq = generate_table_questions(parsed)
        file_questions.extend(tq)

        # 정의 질문 (A, F)
        dq = generate_definition_questions(parsed)
        file_questions.extend(dq)

        # Mermaid 질문 (D)
        mq = generate_mermaid_questions(parsed)
        file_questions.extend(mq)

        # UI 질문 (E)
        uq = generate_ui_questions(parsed)
        file_questions.extend(uq)

        # 섹션 질문 (F)
        sq = generate_section_questions(parsed)
        file_questions.extend(sq)

        all_questions.extend(file_questions)

    # 3. 시스템 간 질문 (B)
    cross_q = generate_cross_system_questions(all_parsed)
    all_questions.extend(cross_q)

    # 4. 중복 제거 (유사 질문 통합)
    all_questions = _deduplicate(all_questions)

    # 5. 목표 수에 맞게 조정
    target = 450  # + 50 할루시네이션 = 500
    if len(all_questions) > target:
        # 카테고리별 균형 맞추기
        all_questions = _balance_categories(all_questions, target)
    elif len(all_questions) < target:
        print(f"  [INFO] 생성된 질문 {len(all_questions)}개 (목표 {target})")

    # 6. ID 부여
    category_counters = {}
    for q in all_questions:
        cat = q["category"]
        category_counters[cat] = category_counters.get(cat, 0) + 1
        q["id"] = _make_id(cat, category_counters[cat])
        q["is_hallucination_trap"] = False
        stats[cat] = stats.get(cat, 0) + 1

    # 7. 할루시네이션 트랩 추가
    traps = generate_hallucination_traps()
    all_questions.extend(traps)
    stats["H"] = len(traps)

    # 8. 셔플
    random.seed(42)
    random.shuffle(all_questions)

    # 9. 결과 구성
    output = {
        "metadata": {
            "total": len(all_questions),
            "hallucination_traps": len(traps),
            "hallucination_ratio": round(len(traps) / len(all_questions), 3),
            "categories": stats,
            "source_files": len(all_parsed),
            "methodology": "Claude Code가 629개 content.md를 규칙 기반 파싱하여 "
                          "테이블/정의/Mermaid/UI/시스템간 연관 질문을 자동 생성. "
                          "10%는 할루시네이션 트랩(존재하지 않는 데이터 질문).",
        },
        "questions": all_questions,
    }

    # 저장
    OUTPUT_PATH.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # 요약 출력
    print(f"\n{'=' * 60}")
    print(f"  Ground Truth QnA 생성 완료")
    print(f"{'=' * 60}")
    print(f"  총 질문: {len(all_questions)}개")
    print(f"  일반 질문: {len(all_questions) - len(traps)}개")
    print(f"  할루시네이션 트랩: {len(traps)}개 ({len(traps)/len(all_questions):.0%})")
    print(f"\n  카테고리별:")
    for cat, count in sorted(stats.items()):
        cat_names = {
            "A": "사실 조회", "B": "시스템 간 연관", "C": "밸런스 수치",
            "D": "프로세스/플로우", "E": "UI 사양", "F": "메타/용어",
            "H": "할루시네이션 트랩",
        }
        print(f"    {cat}. {cat_names.get(cat, '기타')}: {count}개")
    print(f"\n  저장: {OUTPUT_PATH}")

    return output


def _deduplicate(questions: list[dict]) -> list[dict]:
    """유사 질문 중복 제거."""
    seen = set()
    unique = []
    for q in questions:
        # 핵심 키: 워크북 + 섹션 + 카테고리
        key = f"{q.get('expected_workbooks', [''])[0]}|{q.get('section', '')}|{q['category']}"

        # 질문 텍스트 정규화
        norm_query = re.sub(r'\s+', ' ', q["query"]).strip()
        query_hash = hashlib.md5(norm_query.encode()).hexdigest()[:8]
        full_key = f"{key}|{query_hash}"

        if full_key not in seen:
            seen.add(full_key)
            unique.append(q)

    return unique


def _balance_categories(questions: list[dict], target: int) -> list[dict]:
    """카테고리별 균형 조정."""
    by_cat = {}
    for q in questions:
        cat = q["category"]
        if cat not in by_cat:
            by_cat[cat] = []
        by_cat[cat].append(q)

    # 카테고리별 목표 비율
    ratios = {"A": 0.30, "C": 0.25, "D": 0.15, "F": 0.10, "E": 0.08, "B": 0.12}

    result = []
    for cat, ratio in ratios.items():
        cat_target = int(target * ratio)
        cat_items = by_cat.get(cat, [])
        random.seed(42 + ord(cat))
        random.shuffle(cat_items)
        result.extend(cat_items[:cat_target])

    # 남은 수 채우기
    remaining = target - len(result)
    if remaining > 0:
        used_ids = {id(q) for q in result}
        extras = [q for q in questions if id(q) not in used_ids]
        random.shuffle(extras)
        result.extend(extras[:remaining])

    return result


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    generate_all_questions(dry_run=dry_run)
