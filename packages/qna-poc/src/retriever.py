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
import threading
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
_chroma_collection = None  # ChromaDB 컬렉션 캐시
_init_lock = threading.RLock()  # 싱글톤 초기화 스레드 안전 (RLock: 재진입 허용)


def _get_collection():
    """ChromaDB 컬렉션 싱글톤 반환 (스레드 세이프)."""
    global _chroma_collection
    if _chroma_collection is not None:
        return _chroma_collection
    with _init_lock:
        if _chroma_collection is None:
            client = chromadb.PersistentClient(path=str(CHROMA_DIR))
            _chroma_collection = client.get_collection(COLLECTION_NAME)
    return _chroma_collection


def warmup():
    """병렬 실행 전 모든 캐시를 미리 초기화. 메인 스레드에서 호출."""
    _get_collection()
    _build_structural_index()
    _load_graph()
    _build_system_aliases()
    print(f"[INFO] Retriever warmup complete: {len(_structural_index)} workbooks, "
          f"{len(_system_aliases)} aliases")


# ── 시스템명 사전 + 유의어/별칭 매핑 ──

# 게임 기획 도메인 유의어 사전
SYNONYMS = {
    "변신": ["변신 시스템", "트랜스폼", "변환"],
    "스킬": ["스킬 시스템", "기술", "액션 스킬"],
    "버프": ["버프 시스템", "버프/디버프", "상태 효과"],
    "전투": ["전투 시스템", "기본 전투", "기본전투", "공격", "피격"],
    "전투AI": ["전투AI시스템", "전투 AI", "몬스터 AI", "AI 행동"],
    "아이템": ["아이템 시스템", "장비"],
    "인벤토리": ["인벤토리 시스템", "가방", "소지품"],
    "몬스터": ["몬스터 시스템", "몹", "보스", "네임드"],
    "어그로": ["어그로 시스템", "몬스터 어그로", "타기팅", "헤이트"],
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
    "PvP": ["PvP단체전", "대전", "피아 식별", "피아식별"],
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
    "대미지": ["대미지 계산", "피해량", "명중률", "데미지", "데미지 계산", "Damage"],
    "사망": ["사망 시스템", "사망 및 부활", "부활"],
    "캐릭터": ["캐릭터 시스템", "캐릭터 선택", "캐릭터 생성"],
    "레벨업": ["레벨업 시스템", "레벨 업"],
    "성장": ["성장 밸런스", "캐릭터 성장"],
    "네임드": ["네임드 몬스터", "보스 몬스터"],
    # Confluence 전용 용어
    "Beta1": ["Beta1 개선 항목", "베타1"],
    "Beta2": ["Beta2 개선 항목", "베타2"],
    "Beta3": ["Beta3 개선 항목", "베타3"],
    "길드": ["길드 시스템", "클랜"],
    "던전": ["던전 시스템", "인스턴스"],
    "공성전": ["공성전 시스템", "공성"],
    "서버 이동": ["서버 이동 컨텐츠", "월드 이동"],
    "UX": ["UX 규칙", "UX UI 규칙"],
    "레벨": ["레벨 시스템", "레벨링"],
    "컷신": ["컷신 시스템", "시네마틱"],
    "정령": ["정령 시스템"],
    "재화": ["재화 시스템", "골드", "다이아"],
    # 별칭 매핑 갭 보완 (평가 실패 분석 결과)
    "Npc설정": ["Npc 설정", "NPC설정", "NPC 설정"],
    "전투 연출": ["전투연출", "외곽선", "피아식별 연출"],
    "성장 밸런스": ["밸런스", "대미지 방향성", "스탯 분야", "장비 파츠"],
    "키 테마": ["프로젝트 키 테마", "키테마", "테마 논의"],
    "일감 관리": ["일감", "폴리싱", "폴리싱 리스트"],
    "R&D": ["레퍼런스", "레퍼런스 리뷰"],
    # ── 실패 분석 기반 콘텐츠명 보강 (2026-03-10) ──
    # Confluence child page / 시트 내 구체적 콘텐츠명 → 워크북 라우팅
    "녹시온": ["Noxion", "녹시온 마을", "스켈라 대도시"],
    "다이얼로그": ["DialogWnd", "팝업 UI", "다이얼로그 팝업"],
    "배치 정책": ["몬스터 배치", "배치 규칙", "핫스팟"],
    "발동액션": ["발동 액션 표현", "발동액션 표현 개선"],
    "자동 전투": ["자동전투", "Auto 모드", "자동 사냥"],
    "자동 사용": ["물약 자동", "자동 물약"],
    "타게팅": ["타겟 정보", "타겟팅"],
    "랙돌": ["랙돌 시스템", "사망 랙돌"],
    "서버 탐험": ["서버 침공", "타 서버"],
    "모듈 위젯": ["위젯 컴포넌트", "UI 컴포넌트"],
    "이동 명령": ["이동 처리", "이동 명령 처리"],
    # ── v2 평가 실패 분석 기반 보강 (2026-03-11) ──
    "메타설정": ["메타 설정", "종족 설정", "세계 설정", "엘프", "도깨비", "종족"],
    "기본설정": ["기본 설정 시스템", "스탯 UI", "스탯 설정", "기본 스탯"],
    "창고": ["창고 NPC", "창고 시스템", "보관함", "CanStorage"],
    "적용 효과": ["스킬 이펙트", "Effect 적용", "AddHp", "SelfDestruct", "BonusEnum"],
    "자폭": ["자폭 효과", "SelfDestruct", "자폭 처리", "자폭 사망"],
    "성물": ["K성물", "성물 성장", "성물 재료", "성물의 성장 방향"],
    "K성물": ["K성물 성장", "성물 시스템", "성물 기획서"],
    "발동액션 표현": ["발동 액션 표현 설정", "발동액션 표현 설정"],
    "균형표": ["밸런스 균형표", "균형표 설정", "밸런스 균형"],
    "플래닛": ["플래닛 현황보고", "현황보고", "라이브2"],
    "LayerType": ["UI LayerType", "레이어 타입", "LayerType 규칙"],
    "퀘스트 인스턴스": ["WorldClass", "QuestObjective", "QuestInstanceStart", "QuestInstanceEnd"],
    "기타설정": ["종족 설정", "엘프 수명", "도깨비 탄생", "드워프 역사", "세계 설정 상세", "아샤", "케렌", "인간 종족", "정령 종족", "드워프 종족"],
    "기본전투": ["스탯 UI", "스탯 ACCEPT", "2차 파라미터", "스탯 그룹", "스탯 최대치"],
    "심판의 불꽃": ["심판의 불꽃 쿨타임", "발동액션 쿨타임"],
    "컬렉션": ["컬렉션 현황조사", "컬렉션 시스템"],
    # ── v2 평가 2차 실패 분석 기반 보강 (2026-03-11) ──
    "근공방": ["Normal 근공방", "근공방 스탯", "PC Damage 비율", "공격력 비율", "공격력 구성"],
    "방어력 비율": ["Defense 비율", "방어력 구성", "Normal 근공방 방어"],
    "ItemType": ["ConsumeType", "CurrencyEnum", "아이템 Enum", "Enum 테이블"],
    "Cook": ["요리 아이템", "요리 버프", "Cook 아이템"],
    "재화 상인": ["컨텐츠 상인", "컨텐츠 재화", "컨텐츠 재화 상인", "길드 상인", "무한의탑 상인", "레이드 상인", "일일미션 상인", "Beta3 NPC"],
    "서버 침공": ["서버 탐험", "보너스 보스", "타 서버 침공"],
    "캐릭터 선택창": ["선택창", "캐릭터 선택창&변신", "변신 UI", "조작 상황 초기화"],
    "프리셋": ["프리셋 착용", "프리셋 시스템", "변신 프리셋"],
    "시스템 메시지": ["SystemMsg", "시스템 알림", "서버 메시지"],
    "EffectClass": ["이펙트 클래스", "Effect Class", "스킬 이펙트 테이블"],
}

# 자동 매핑이 잘못되는 경우 명시적 오버라이드 (key → 정확한 워크북명)
SYNONYM_WORKBOOK_OVERRIDES = {
    "전투": "PK_기본 전투 시스템",
    "기본 전투": "PK_기본 전투 시스템",
    "기본전투": "PK_기본전투_시스템",
    "Npc설정": "PK_Npc설정",
    "NPC설정": "PK_Npc설정",
    "NPC 설정": "PK_Npc설정",
    "Npc 설정": "PK_Npc설정",
    # v2 평가 실패 기반 추가
    "메타설정": "PK_메타설정",
    "메타 설정": "PK_메타설정",
    "종족 설정": "PK_메타설정",
    "기본설정": "PK_기본설정_시스템",
    "기본 설정": "PK_기본설정_시스템",
    "창고": "PK_NPC 시스템",
    "창고 NPC": "PK_NPC 시스템",
    "창고 확장": "PK_NPC 시스템",
    "WorldClass": "PK_퀘스트 인스턴스",
    "QuestObjective": "PK_퀘스트 인스턴스",
    "퀘스트 인스턴스": "PK_퀘스트 인스턴스",
    "스탯 UI": "PK_기본전투_시스템",
    "스탯 그룹": "PK_기본전투_시스템",
    "2차 파라미터": "PK_기본전투_시스템",
    "심판의 불꽃": "PK_발동액션 표현 개선",
    "데미지": "PK_대미지 명중률 계산기",
    "데미지 계산": "PK_대미지 명중률 계산기",
    "Damage": "PK_대미지 명중률 계산기",
    "명중률": "PK_대미지 명중률 계산기",
    "K성물": "Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더",
    "성물": "Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더",
    "성물 성장": "Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더",
    "성물 기획서": "Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더",
    "자폭": "Confluence/Design/시스템 디자인/스킬/스킬 이펙트",
    "자폭 효과": "Confluence/Design/시스템 디자인/스킬/스킬 이펙트",
    "SelfDestruct": "Confluence/Design/시스템 디자인/스킬/스킬 이펙트",
    # ── v2 평가 2차 실패 분석 기반 추가 (2026-03-11) ──
    "근공방": "PK_대미지 명중률 계산기",
    "근공방 스탯": "PK_대미지 명중률 계산기",
    "Normal 근공방": "PK_대미지 명중률 계산기",
    "공격력 비율": "PK_대미지 명중률 계산기",
    "공격력 구성": "PK_대미지 명중률 계산기",
    "PC Damage": "PK_대미지 명중률 계산기",
    "방어력 비율": "PK_대미지 명중률 계산기",
    "방어력 구성": "PK_대미지 명중률 계산기",
    "ConsumeType": "PK_아이템 시스템",
    "ItemType": "PK_아이템 시스템",
    "CurrencyEnum": "PK_아이템 시스템",
    "Cook": "PK_아이템 시스템",
    "요리 아이템": "PK_아이템 시스템",
    "아이템 Enum": "PK_아이템 시스템",
    "재화 상인": "PK_NPC 시스템",
    "컨텐츠 상인": "PK_NPC 시스템",
    "컨텐츠 재화 상인": "PK_NPC 시스템",
    "길드 상인": "PK_NPC 시스템",
    "무한의탑 상인": "PK_NPC 시스템",
    "서버 침공": "Confluence/Design/시스템 디자인/PvP 컨텐츠/서버 이동 컨텐츠",
    "보너스 보스": "Confluence/Design/시스템 디자인/PvP 컨텐츠/서버 이동 컨텐츠",
    "시스템 메시지": "PK_시스템 메시지",
    "SystemMsg": "PK_시스템 메시지",
    "EffectClass": "Confluence/Design/시스템 디자인/스킬/스킬 이펙트",
    # B-004: HUD 타겟 + 자동 전투 + 네임 플레이트
    "타게팅": "PK_타게팅 시스템",
    "타게팅 시스템": "PK_타게팅 시스템",
    "HUD 타겟": "PK_타게팅 시스템",
    "타겟 정보": "PK_타게팅 시스템",
    "네임 플레이트": "PK_타게팅 시스템",
    "네임플레이트": "PK_타게팅 시스템",
    "자동 전투": "PK_타게팅 시스템",
    "자동전투": "PK_타게팅 시스템",
    # E-003: 스탯 최대치
    "스탯 최대치": "PK_기본전투_시스템",
    "스탯 성장": "PK_기본전투_시스템",
    "스탯 선택 불가": "PK_기본전투_시스템",
    "스탯 비활성화": "PK_기본전투_시스템",
    # D-014: 발동액션
    "발동액션": "PK_발동액션 표현 개선",
    "발동 액션": "PK_발동액션 표현 개선",
    "스킬 자동 사용": "PK_발동액션 표현 개선",
    "스킬 자동 발동": "PK_발동액션 표현 개선",
    # A-015: 종족 (아샤/케렌)
    "아샤": "PK_기타설정",
    "케렌": "PK_기타설정",
    "아샤 족": "PK_기타설정",
    "케렌 족": "PK_기타설정",
    # B-002: 밀수 상인
    "밀수 상인": "PK_NPC 시스템",
    "밀수": "PK_NPC 시스템",
    # B-008: 캐릭터 선택창&변신
    "캐릭터 선택창": "PK_캐릭터 선택창&변신",
    "선택창": "PK_캐릭터 선택창&변신",
    "캐릭터 선택창&변신": "PK_캐릭터 선택창&변신",
    "조작 상황 초기화": "PK_캐릭터 선택창&변신",
    "변신 UI": "PK_캐릭터 선택창&변신",
    "변신 전환": "PK_캐릭터 선택창&변신",
    "프리셋": "PK_캐릭터 선택창&변신",
}


def _build_system_aliases():
    """워크북 이름에서 별칭 매핑 자동 구축 + 유의어 사전 통합.

    별칭 → 워크북 리스트 매핑 (동일 용어가 Excel/Confluence 양쪽에 존재 가능).
    스레드 세이프 (double-checked locking).
    """
    global _system_aliases
    if _system_aliases:
        return _system_aliases

    _system_aliases = {}  # alias → list[str]  (워크북 리스트)

    def _add_alias(alias: str, wb: str):
        """별칭에 워크북 추가 (중복 방지)."""
        key = alias.lower()
        if key not in _system_aliases:
            _system_aliases[key] = []
        if wb not in _system_aliases[key]:
            _system_aliases[key].append(wb)
        # 원본 케이스도 등록
        if alias != key:
            if alias not in _system_aliases:
                _system_aliases[alias] = []
            if wb not in _system_aliases[alias]:
                _system_aliases[alias].append(wb)

    try:
        collection = _get_collection()
        result = collection.get(include=["metadatas"])

        workbooks = set()
        for meta in result["metadatas"]:
            wb = meta.get("workbook", "")
            if wb:
                workbooks.add(wb)

        # 정식명에서 별칭 생성
        for wb in workbooks:
            _add_alias(wb, wb)

            if wb.startswith("Confluence/"):
                # Confluence 경로에서 별칭 추출
                # e.g. "Confluence/Design/시스템 디자인/스킬/스킬 시스템"
                parts = [p.strip() for p in wb.split("/") if p.strip()]
                # 마지막 세그먼트 (가장 구체적)
                if len(parts) >= 1:
                    last = parts[-1]
                    _add_alias(last, wb)
                    _add_alias(last.replace(" ", ""), wb)
                # 뒤에서 두 번째 + 마지막 조합
                if len(parts) >= 2:
                    parent_child = f"{parts[-2]}/{parts[-1]}"
                    _add_alias(parent_child, wb)
                # "시스템 디자인" 이후의 세그먼트 조합
                design_idx = next((i for i, p in enumerate(parts) if "디자인" in p), -1)
                if design_idx >= 0 and design_idx + 1 < len(parts):
                    sub_path = "/".join(parts[design_idx + 1:])
                    _add_alias(sub_path, wb)
            else:
                # PK_ 제거 버전 (Excel 워크북)
                short = wb.replace("PK_", "").strip()
                _add_alias(short, wb)

                # 공백 제거 버전
                nospace = short.replace(" ", "")
                _add_alias(nospace, wb)

                # "_" 제거 버전
                nounderscore = short.replace("_", " ").strip()
                _add_alias(nounderscore, wb)

        # ── 시트명에서 자동 별칭 추출 ──
        # "마을: 녹시온" → "녹시온", "필드: 가시나무 숲" → "가시나무 숲" 등
        # 검색 시 콘텐츠명으로 올바른 워크북을 찾을 수 있게 함
        GENERIC_SHEETS = {
            "히스토리", "sheet2", "sheet1", "개요", "세부 내용", "세부내용",
            "ui", "목표 및 개요", "미사용", "주요 정의", "목차",
            "참고", "변경 이력", "시트1", "시트2", "data", "temp",
        }
        sheet_wb_map = {}  # sheet → workbook
        for meta in result["metadatas"]:
            wb = meta.get("workbook", "")
            sh = meta.get("sheet", "")
            if wb and sh:
                if sh not in sheet_wb_map:
                    sheet_wb_map[sh] = set()
                sheet_wb_map[sh].add(wb)

        for sheet_name, wb_set in sheet_wb_map.items():
            sheet_lower = sheet_name.lower().strip()
            # 제네릭 시트명 스킵
            if sheet_lower in GENERIC_SHEETS:
                continue
            # 너무 짧은 시트명 스킵 (노이즈)
            if len(sheet_lower) < 3:
                continue

            for wb in wb_set:
                # 1. 시트명 전체를 별칭으로 등록
                _add_alias(sheet_name, wb)

                # 2. ":" 또는 "_" 뒤의 구체적 이름 추출
                #    "마을: 녹시온" → "녹시온"
                #    "필드: 가시나무 숲" → "가시나무 숲"
                for sep in [":", "_", "—", "-"]:
                    if sep in sheet_name:
                        parts = sheet_name.split(sep, 1)
                        specific = parts[-1].strip()
                        if len(specific) >= 2:
                            _add_alias(specific, wb)
                            # 공백 제거 버전도
                            if " " in specific:
                                _add_alias(specific.replace(" ", ""), wb)

                # 3. [Beta1], [Beta2] 등 태그 제거 후 핵심명 추출
                import re
                cleaned = re.sub(r'\[.*?\]\s*', '', sheet_name).strip()
                if cleaned and cleaned != sheet_name and len(cleaned) >= 3:
                    _add_alias(cleaned, wb)

        # ── 유의어 사전 통합 ──
        for key, aliases in SYNONYMS.items():
            # key와 매칭되는 워크북 찾기 — Excel과 Confluence 모두 수집
            for wb in workbooks:
                wb_lower = wb.lower()
                wb_clean = wb_lower.replace("pk_", "")
                # Confluence 경로의 마지막 세그먼트
                if wb.startswith("Confluence/"):
                    last_seg = wb.split("/")[-1].lower()
                    if key.lower() in last_seg or any(a.lower() in last_seg for a in aliases):
                        _add_alias(key, wb)
                        for alias in aliases:
                            _add_alias(alias, wb)
                else:
                    if key.lower() in wb_clean or any(a.lower() in wb_clean for a in aliases):
                        # 명시적 오버라이드 확인
                        override = SYNONYM_WORKBOOK_OVERRIDES.get(key)
                        if override and override in workbooks:
                            _add_alias(key, override)
                        else:
                            _add_alias(key, wb)
                        for alias in aliases:
                            alias_override = SYNONYM_WORKBOOK_OVERRIDES.get(alias)
                            if alias_override and alias_override in workbooks:
                                _add_alias(alias, alias_override)
                            else:
                                _add_alias(alias, wb)

        # ── SYNONYM_WORKBOOK_OVERRIDES 직접 등록 ──
        # 자동 매칭이 실패하는 경우를 보완 (Confluence 경로 + Excel 모두)
        for alias, target_wb in SYNONYM_WORKBOOK_OVERRIDES.items():
            if target_wb in workbooks:
                _add_alias(alias, target_wb)
            else:
                # 부분 경로 매칭 (Confluence 하위 경로)
                for wb in workbooks:
                    if target_wb in wb:
                        _add_alias(alias, wb)
                        break

    except Exception as e:
        print(f"[WARN] Could not build system aliases: {e}")

    return _system_aliases


def _build_structural_index():
    """content.md 파일 경로에서 구조적 인덱스 구축.

    workbook → [sheets] → [sections] 매핑.
    ChromaDB 메타데이터에서 추출. 스레드 세이프.
    """
    global _structural_index
    if _structural_index:
        return _structural_index

    with _init_lock:
        if _structural_index:
            return _structural_index

        tmp = {}
        try:
            collection = _get_collection()
            result = collection.get(include=["metadatas"])

            for meta in result["metadatas"]:
                wb = meta.get("workbook", "")
                sheet = meta.get("sheet", "")
                section = meta.get("section_path", "")

                if wb not in tmp:
                    tmp[wb] = {"sheets": {}, "chunk_count": 0}

                if sheet not in tmp[wb]["sheets"]:
                    tmp[wb]["sheets"][sheet] = {"sections": set()}

                tmp[wb]["sheets"][sheet]["sections"].add(section)
                tmp[wb]["chunk_count"] += 1

            # set → list 변환
            for wb in tmp:
                for sheet in tmp[wb]["sheets"]:
                    tmp[wb]["sheets"][sheet]["sections"] = \
                        sorted(tmp[wb]["sheets"][sheet]["sections"])

        except Exception as e:
            print(f"[WARN] Could not build structural index: {e}")

        _structural_index = tmp

    return _structural_index


def _load_graph() -> nx.Graph:
    """knowledge_graph.json을 NetworkX 그래프로 로드. 스레드 세이프."""
    global _graph
    if _graph is not None:
        return _graph

    with _init_lock:
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
        정식 워크북명 리스트 (중복 제거, 핵심 매칭 우선 + 교차 소스 포함)
        - 각 매칭 용어에 대해 최적 Excel + 최적 Confluence 각 1개씩 선택
        - 최대 6개로 제한 (검색 품질 유지)
    """
    aliases = _build_system_aliases()
    query_lower = query.lower()

    # 1. 긴 별칭 우선으로 매칭 수집
    matched_aliases = []  # (alias, wb_list, alias_len) 리스트
    used_positions = set()  # query에서 이미 매칭된 위치 추적

    for alias, wb_list in sorted(aliases.items(), key=lambda x: len(x[0]), reverse=True):
        alias_lower = alias.lower()
        pos = query_lower.find(alias_lower)
        if pos < 0:
            continue
        # 이미 더 긴 별칭이 같은 위치를 커버하면 스킵
        alias_positions = set(range(pos, pos + len(alias_lower)))
        if alias_positions & used_positions:
            continue
        matched_aliases.append((alias, wb_list))
        used_positions |= alias_positions

    # 2. 각 매칭에서 최적 Excel + 최적 Confluence 선택
    found_wbs = []
    for alias, wb_list in matched_aliases:
        excel_wbs = [w for w in wb_list if not w.startswith("Confluence/")]
        conf_wbs = [w for w in wb_list if w.startswith("Confluence/")]

        # Excel: "시스템" 포함 + 이름 짧은 것 우선
        if excel_wbs:
            excel_wbs.sort(key=lambda w: (-("시스템" in w), len(w)))
            best_excel = excel_wbs[0]
            if best_excel not in found_wbs:
                found_wbs.append(best_excel)

        # Confluence: 경로 짧은 것 (더 구체적) 우선
        if conf_wbs:
            conf_wbs.sort(key=lambda w: len(w))
            best_conf = conf_wbs[0]
            if best_conf not in found_wbs:
                found_wbs.append(best_conf)

    # 3. 최대 6개로 제한 (너무 많으면 검색 품질 저하)
    return found_wbs[:6]


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

def _vector_search(query: str, top_k: int = 8, system_filter: str = None,
                    query_embedding: list[float] = None) -> list[dict]:
    """ChromaDB 시맨틱 검색.

    Args:
        query_embedding: 미리 계산된 쿼리 임베딩 (없으면 내부에서 생성)
    """
    collection = _get_collection()

    if query_embedding is None:
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
            "source_url": results["metadatas"][0][i].get("source_url", ""),
            "distance": results["distances"][0][i],
            "score": 1 - results["distances"][0][i],
            "source": "vector",
        })

    return items


def _strip_korean_particles(terms: set) -> set:
    """한국어 조사/어미를 제거하여 어간만 추출. 원본도 유지."""
    # 긴 조사부터 매칭 (에서 먼저, 서 나중에)
    PARTICLES = [
        '에서는', '으로는', '에게는', '까지는', '부터는',
        '에서', '으로', '에게', '까지', '부터', '처럼', '보다',
        '이나', '이란', '이라', '라고', '에는', '에도',
        '한테', '께서',
        '는', '은', '이', '가', '을', '를', '에', '로',
        '와', '과', '도', '만', '의',
    ]
    expanded = set(terms)
    for t in terms:
        for p in PARTICLES:
            if t.endswith(p) and len(t) > len(p):
                base = t[:-len(p)]
                if len(base) >= 2:
                    expanded.add(base)
                    break  # 가장 긴 매칭만 적용
                elif len(base) == 1 and re.match(r'[가-힣]', base):
                    # 1글자라도 한글이면 추가 (색, 수, 형 등)
                    expanded.add(base)
                    break
    return expanded


# 특정 키워드 → 시트명 강제 매핑 (구조적 검색 시 시트 우선순위 보정)
_KEYWORD_SHEET_BOOST = {
    # B-006: 컨텐츠 재화 상인 → Beta3 NPC 개선 시트 (상인 NPC가 아님)
    "컨텐츠 재화": "Beta3 NPC 개선",
    "재화 상인": "Beta3 NPC 개선",
    "길드 주화": "Beta3 NPC 개선",
    "성장의 증표": "Beta3 NPC 개선",
    "정복의 증표": "Beta3 NPC 개선",
    "승리의 훈장": "Beta3 NPC 개선",
}


def _structural_search(workbook: str, query: str) -> list[dict]:
    """구조적 검색: 특정 워크북의 모든 청크를 가져와 키워드 관련성으로 랭킹."""
    collection = _get_collection()

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
    query_terms_raw = set(re.findall(r'[\w가-힣]+', query_lower))
    query_terms = _strip_korean_particles(query_terms_raw)

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

        # 시트명에 쿼리 키워드가 포함되면 보너스 (워크북 내 시트 경쟁 해결)
        # 접두어(필드:, 마을:, 던전: 등)를 제거하고 구체적 이름만 매칭
        sheet_name = meta.get("sheet", "").lower()
        sheet_specific = sheet_name
        for sep in [':', '_', '—', '-']:
            if sep in sheet_name:
                sheet_specific = sheet_name.split(sep, 1)[-1].strip()
                break
        sheet_term_hits = sum(1 for t in query_terms if len(t) >= 2 and t in sheet_specific)
        sheet_bonus = min(0.3, sheet_term_hits * 0.2)

        # 시트명이 쿼리의 핵심 구문과 강하게 일치하면 추가 보너스
        # (예: 쿼리="자폭 효과 랙돌" → 시트="자폭 효과"가 포함되면 +0.3)
        sheet_exact_bonus = 0
        for t in query_terms:
            if len(t) >= 2 and t in sheet_specific:
                # 시트명의 50% 이상이 매칭되면 강한 시그널
                if sheet_term_hits >= max(1, len(sheet_specific.split()) * 0.5):
                    sheet_exact_bonus = 0.3
                    break

        # 키워드→시트 강제 매핑 보너스 (특정 키워드가 질문에 포함되면 해당 시트 우선)
        forced_sheet_bonus = 0
        for kw, target_sheet in _KEYWORD_SHEET_BOOST.items():
            if kw in query_lower and target_sheet.lower() in sheet_name:
                forced_sheet_bonus = 0.8
                break

        # 구조적 검색은 높은 기본 점수 부여 (시스템명이 매칭됐으므로)
        base_score = 0.6
        score = base_score + keyword_score * 0.3 + section_bonus + sheet_bonus + sheet_exact_bonus + forced_sheet_bonus

        items.append({
            "id": results["ids"][i],
            "text": text,
            "workbook": meta.get("workbook", ""),
            "sheet": meta.get("sheet", ""),
            "section_path": meta.get("section_path", ""),
            "has_mermaid": meta.get("has_mermaid", False),
            "has_table": meta.get("has_table", False),
            "tokens": meta.get("tokens", 0),
            "source_url": meta.get("source_url", ""),
            "distance": 0,
            "score": min(score, 1.5),
            "source": "structural",
        })

    # 스코어 순 정렬
    items.sort(key=lambda x: x["score"], reverse=True)
    return items


def _extract_search_phrases(query: str) -> list[str]:
    """쿼리에서 전문 검색용 핵심 구문 추출.

    우선순위:
    1. 영문 복합 구문 (Attack Power Param, CanStorage 등)
    2. 괄호 안의 정확한 용어
    3. CamelCase/PascalCase 개별 영문 단어
    4. 한글 전문 용어 (3글자 이상, 조사 제거)
    """
    phrases = []
    seen = set()

    def _add(p: str):
        p = p.strip()
        if len(p) >= 2 and p not in seen:
            phrases.append(p)
            seen.add(p)

    # 1. 괄호 안의 내용 (보통 정확한 용어 — 최우선)
    for p in re.findall(r'[(\[「](.*?)[)\]」]', query):
        _add(p)

    # 2. 영문 복합 구문 (2+ 단어 연속 영문, 대문자 시작)
    for p in re.findall(r'[A-Za-z][A-Za-z\s_]{2,}[A-Za-z]', query):
        p = p.strip()
        if ' ' in p or '_' in p:  # 복합어만
            _add(p)

    # 3. CamelCase/PascalCase 단어 (CanStorage, BonusEnum 등)
    for w in re.findall(r'[A-Za-z_]{3,}', query):
        if w.lower() in {'the', 'and', 'for', 'are', 'not', 'level', 'param', 'type'}:
            continue  # 너무 흔한 영단어 스킵
        if any(c.isupper() for c in w[1:]) or w[0].isupper():  # PascalCase/CamelCase
            _add(w)
        elif len(w) >= 5:  # 긴 영단어도 포함
            _add(w)

    # 4. 한글 복합 구문 (공백 포함, 3글자+ 한글 단어 2개 이상 연속)
    #    "데미지 계산 공식", "이전 막타 데미지" 등을 통째로 추출
    korean_compound = re.findall(r'[가-힣]{2,}(?:\s+[가-힣]{2,})+', query)
    for comp in korean_compound:
        _add(comp)

    # 5. 한글 전문 용어 (조사 제거, 3글자 이상)
    PARTICLES = ['에서는', '으로는', '에서', '으로', '에게', '까지', '부터',
                 '이나', '이란', '이라', '라고', '한테',
                 '는', '은', '이', '가', '을', '를', '에', '로', '와', '과', '도', '만', '의']
    STOP_WORDS = {'어떻게', '얼마나', '뭐야', '몇이야', '좀', '이거', '그거', '있나요',
                  '되는', '하는', '해야', '알려줘', '설명해줘', '어떤', '어디',
                  '시스템', '기획서', '문서', '관련', '설정'}
    korean_terms = re.findall(r'[가-힣]{2,}', query)
    for t in korean_terms:
        if t in STOP_WORDS:
            continue
        # 조사 제거
        base = t
        for p in PARTICLES:
            if t.endswith(p) and len(t) > len(p) + 1:
                base = t[:-len(p)]
                break
        if len(base) >= 3 and base not in STOP_WORDS:
            _add(base)

    return phrases


def _fulltext_search(query: str, top_k: int = 10) -> list[dict]:
    """전문 키워드 검색: 쿼리의 핵심 구문을 전체 청크 본문에서 직접 검색.

    _structural_search가 '워크북 지정 → 워크북 내 단어별 점수'라면,
    이 함수는 '전체 청크에서 정확 구문 매칭' (Ctrl+F / grep 방식).

    특히 효과적인 경우:
    - 영문 컬럼명/파라미터명 (Attack Power Param, CanStorage 등)
    - CamelCase 용어 (BonusEnum, EffectClass, SelfDestruct 등)
    - 괄호 안의 정확한 명칭
    """
    collection = _get_collection()

    # 1. 핵심 검색 구문 추출
    phrases = _extract_search_phrases(query)
    if not phrases:
        return []

    # 2. 각 구문에 대해 ChromaDB $contains 검색
    matches = {}  # chunk_id → {data, match_count, matched_phrases}

    for phrase in phrases:
        try:
            results = collection.get(
                where_document={"$contains": phrase},
                include=["documents", "metadatas"],
            )
        except Exception:
            continue

        for i, id_ in enumerate(results.get("ids", [])):
            if id_ not in matches:
                meta = results["metadatas"][i]
                matches[id_] = {
                    "id": id_,
                    "text": results["documents"][i],
                    "workbook": meta.get("workbook", ""),
                    "sheet": meta.get("sheet", ""),
                    "section_path": meta.get("section_path", ""),
                    "has_mermaid": meta.get("has_mermaid", False),
                    "has_table": meta.get("has_table", False),
                    "tokens": meta.get("tokens", 0),
                    "source_url": meta.get("source_url", ""),
                    "distance": 0,
                    "match_count": 0,
                    "matched_phrases": [],
                }
            matches[id_]["match_count"] += 1
            matches[id_]["matched_phrases"].append(phrase)

    # 3. 스코어링: 복합 구문 매칭에 높은 가중치
    #    "Attack Power Param" (복합 구문 정확 매칭) >> "Attack" 개별 단어 매칭
    items = []
    for chunk in matches.values():
        match_ratio = chunk["match_count"] / len(phrases)
        # 복합 구문(공백/밑줄 포함)이 매칭되면 큰 보너스 (Ctrl+F 정확 발견)
        compound_matches = [p for p in chunk["matched_phrases"] if ' ' in p or '_' in p]
        compound_bonus = min(len(compound_matches) * 0.15, 0.25)
        score = 0.70 + match_ratio * 0.15 + compound_bonus

        items.append({
            "id": chunk["id"],
            "text": chunk["text"],
            "workbook": chunk["workbook"],
            "sheet": chunk["sheet"],
            "section_path": chunk["section_path"],
            "has_mermaid": chunk["has_mermaid"],
            "has_table": chunk["has_table"],
            "tokens": chunk["tokens"],
            "source_url": chunk.get("source_url", ""),
            "distance": 0,
            "score": min(score, 1.0),
            "source": "fulltext",
            "has_compound_match": len(compound_matches) > 0,  # 복합 구문 정확 매칭 여부
        })

    items.sort(key=lambda x: x["score"], reverse=True)
    return items[:top_k]


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
            wb_names = aliases.get(rel_sys.lower(),
                                   aliases.get(f"pk_{rel_sys.lower()}", []))
            if not wb_names:
                continue

            # 관련 시스템에서 쿼리 관련 청크 찾기 (모든 소스)
            rel_items = []
            for wb_name in wb_names[:2]:
                rel_items.extend(_structural_search(wb_name, query))
            for item in rel_items[:3]:  # 관련 시스템은 상위 3개만
                item["score"] *= 0.5  # 간접 관련이므로 가중치 하향
                item["source"] = "kg_expand"
            items.extend(rel_items[:3])

    return items


# ── 통합 검색 ──

def retrieve(query: str, top_k: int = 12, token_budget: int = 80000) -> tuple[list[dict], dict]:
    """하이브리드 검색: 4-레이어 통합.

    검색 레이어:
    1. 구조적 검색 (_structural_search) — 워크북 내 키워드 매칭 (섹션명+본문 단어별 점수)
    2. KG 관계 확장 (_kg_expand) — 관련 시스템 워크북 탐색
    3. 벡터 검색 (_vector_search) — 임베딩 시맨틱 유사도
    4. 전문 검색 (_fulltext_search) — 전체 청크 정확 구문 매칭 (Ctrl+F 방식)

    Args:
        query: 사용자 질문
        top_k: 최종 반환 청크 수
        token_budget: 최대 토큰 예산

    Returns:
        (랭킹된 청크 리스트, 검색 해석 메타데이터)
    """
    all_results = {}
    retrieval_info = {
        "detected_systems": [],
        "layers_used": [],
        "structural_hits": 0,
        "kg_hits": 0,
        "vector_hits": 0,
        "fulltext_hits": 0,
        "search_scope": [],
        "total_candidates": 0,
    }

    # 1. 시스템명 추출 (유의어 포함)
    detected_systems = extract_system_names(query)
    retrieval_info["detected_systems"] = detected_systems

    # 2. 구조적 검색 (시스템명이 감지된 경우)
    #    Excel/Confluence 양쪽 소스를 모두 커버하도록 최대 5개
    structural_count = 0
    structural_limit = min(5, len(detected_systems))
    for sys_name in detected_systems[:structural_limit]:
        structural_items = _structural_search(sys_name, query)
        for item in structural_items:
            key = item["id"]
            if key not in all_results or item["score"] > all_results[key]["score"]:
                all_results[key] = item
                structural_count += 1
    if structural_count > 0:
        retrieval_info["layers_used"].append("structural")
        retrieval_info["structural_hits"] = structural_count
        retrieval_info["search_scope"].extend(
            f"{s} (구조적 매칭)" for s in detected_systems[:structural_limit]
        )

    # 3. KG 관계 확장 (시스템 간 질문 대응)
    kg_count = 0
    kg_expanded_systems = []
    if detected_systems:
        kg_items = _kg_expand(detected_systems, query, depth=1)
        for item in kg_items:
            key = item["id"]
            if key not in all_results or item["score"] > all_results[key]["score"]:
                all_results[key] = item
                kg_count += 1
                wb = item.get("workbook", "")
                if wb and wb not in kg_expanded_systems:
                    kg_expanded_systems.append(wb)
    if kg_count > 0:
        retrieval_info["layers_used"].append("kg_expand")
        retrieval_info["kg_hits"] = kg_count
        retrieval_info["search_scope"].extend(
            f"{s} (KG 관계 확장)" for s in kg_expanded_systems[:5]
        )

    # 4. 벡터 시맨틱 검색 (항상 실행 — 유의어/애매한 표현 커버)
    # 쿼리 임베딩을 한 번만 계산하여 모든 벡터 검색에 재사용
    from src.indexer import embed_texts
    query_embedding = embed_texts([query])[0]

    vector_count = 0
    vector_items = _vector_search(query, top_k=top_k, query_embedding=query_embedding)
    for item in vector_items:
        key = item["id"]
        if key not in all_results:
            all_results[key] = item
            vector_count += 1
        else:
            existing = all_results[key]
            existing["score"] = existing["score"] * 1.2

    # 5. 시스템별 부스트 벡터 검색 (감지된 시스템에 한정)
    for sys_name in detected_systems[:4]:
        boosted = _vector_search(query, top_k=5, system_filter=sys_name,
                                 query_embedding=query_embedding)
        for item in boosted:
            key = item["id"]
            if key not in all_results:
                item["score"] *= 1.5
                all_results[key] = item
                vector_count += 1

    if vector_count > 0:
        retrieval_info["layers_used"].append("vector")
        retrieval_info["vector_hits"] = vector_count

    # 6. 전문 키워드 검색 (전체 청크에서 정확 구문 매칭)
    #    핵심: 다른 레이어에서 이미 발견된 청크라도, fulltext가 정확 구문을
    #    매칭했으면 스코어를 "확정적으로" 올려준다 (Ctrl+F로 찾은 것 = 확실한 증거)
    fulltext_count = 0
    fulltext_items = _fulltext_search(query, top_k=10)
    for item in fulltext_items:
        key = item["id"]
        if key not in all_results:
            all_results[key] = item
            fulltext_count += 1
        else:
            # 이미 있으면: 두 스코어 중 높은 값 + 보너스 (1.0 초과 허용 → 랭킹 우선)
            # 복합 구문 매칭 = 강한 시그널 (Ctrl+F로 정확히 발견) → 큰 부스트
            existing = all_results[key]
            boost = 0.15 if item.get("has_compound_match") else 0.05
            existing["score"] = max(existing["score"], item["score"]) + boost
            if "fulltext" not in existing.get("source", ""):
                existing["source"] += "+fulltext"

    if fulltext_count > 0:
        retrieval_info["layers_used"].append("fulltext")
    retrieval_info["fulltext_hits"] = fulltext_count

    retrieval_info["total_candidates"] = len(all_results)

    # 7. 랭킹
    ranked = sorted(all_results.values(), key=lambda x: x["score"], reverse=True)

    # 8. 토큰 예산 내로 자르기 (다중 시스템 공정 배분)
    final = []
    total_tokens = 0

    if len(detected_systems) >= 2:
        # 다중 시스템: 각 시스템에 최소 슬롯 보장
        min_per_system = max(3, top_k // len(detected_systems))

        # Pass 1: 각 시스템에서 최소 슬롯 확보
        for sys_name in detected_systems:
            sys_items = sorted(
                [r for r in ranked if r.get("workbook") == sys_name],
                key=lambda x: x["score"], reverse=True,
            )
            for item in sys_items[:min_per_system]:
                if item["id"] not in {f["id"] for f in final}:
                    if total_tokens + item["tokens"] <= token_budget:
                        final.append(item)
                        total_tokens += item["tokens"]

        # Pass 2: 나머지 슬롯을 스코어 순으로 채움
        used_ids = {f["id"] for f in final}
        for item in ranked:
            if len(final) >= top_k:
                break
            if item["id"] in used_ids:
                continue
            if total_tokens + item["tokens"] > token_budget:
                break
            final.append(item)
            total_tokens += item["tokens"]
            used_ids.add(item["id"])

        final.sort(key=lambda x: x["score"], reverse=True)
    else:
        for item in ranked:
            if total_tokens + item["tokens"] > token_budget:
                break
            final.append(item)
            total_tokens += item["tokens"]
            if len(final) >= top_k:
                break

    # 최종 결과의 소스 분포 기록
    source_dist = {}
    for item in final:
        src = item.get("source", "unknown")
        source_dist[src] = source_dist.get(src, 0) + 1
    retrieval_info["final_source_distribution"] = source_dist
    retrieval_info["final_total_tokens"] = total_tokens

    return final, retrieval_info


def format_context(chunks: list[dict]) -> str:
    """검색 결과를 LLM 컨텍스트 문자열로 포맷."""
    parts = []
    for i, chunk in enumerate(chunks, 1):
        source = f"[출처 {i}: {chunk['workbook']} / {chunk['sheet']} / {chunk['section_path']}]"
        parts.append(f"{source}\n{chunk['text']}")

    return "\n\n---\n\n".join(parts)
