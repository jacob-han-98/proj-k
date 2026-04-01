"""
agent.py — QnA Agent (4원칙: Planning, Tool Use, Reflection, Trace)

단순 RAG(retrieve→answer)에서 Agent 패턴으로 전환.
1. Planning: LLM이 질문을 분석하여 검색 전략 수립
2. Tool Use: 전략에 따라 도구 실행 (retrieve, kg_lookup, section_search)
3. Answer Generation: 수집된 증거로 답변 생성
4. Reflection: 자기 평가 + 보강 (1회 재시도)
"""

import json
import time
from pathlib import Path

from concurrent.futures import ThreadPoolExecutor, as_completed

from src.retriever import (
    retrieve,
    extract_system_names,
    get_related_systems,
    _structural_search,
    _build_system_aliases,
    _build_structural_index,
    _load_graph,
    _get_collection,
    format_context,
)
from src.generator import call_bedrock, SYSTEM_PROMPT as QNA_SYSTEM_PROMPT, get_system_logger

log = get_system_logger()


# ══════════════════════════════════════════════════════════
#  1. Planning — 질문 분석 & 검색 전략 수립
# ══════════════════════════════════════════════════════════

PLANNING_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 QnA 시스템의 검색 전략가입니다.
사용자 질문을 분석하여 최적의 검색 전략을 JSON으로 출력하세요.

## 사용 가능한 검색 도구
1. **retrieve** — 하이브리드 검색 (구조적+벡터). 기획서에서 설계 의도, 규칙, 플로우를 검색. 기본 검색 도구.
2. **section_search** — 특정 워크북 내 집중 검색. 워크북명을 알 때 사용.
3. **kg_related** — 지식 그래프에서 관련 시스템 조회. 시스템 간 관계 질문에 사용.
4. **query_game_data** — 게임 데이터 테이블 직접 조회. 실제 수치, 아이템 목록, 몬스터 스탯, 스킬 데이터 등 **구체적 데이터**를 조회할 때 사용.
   - 기획서 = "왜/어떻게" (설계 의도), 데이터 테이블 = "무엇이/얼마나" (실제 수치)
   - args 형식: {"action": "query", "table": "테이블명", "columns": [...], "filters": [{"column": "컬럼명", "op": "=", "value": "값"}], "order_by": [{"column": "컬럼명", "direction": "DESC"}], "limit": 50}
   - action 종류: "list_tables"(테이블 목록), "describe"(컬럼 정의), "query"(필터/조인 쿼리), "lookup_enum"(Enum 값 조회)
   - 수치/목록/비교/밸런스 질문에 retrieve와 함께 사용하면 정확한 답변 가능
   - 예: "레전더리 무기 목록" → query_game_data(table=ItemEquipClass, filters=[Grade=Legendary])
   - 예: "보스 몬스터 HP" → query_game_data(table=MonsterClass, filters=[Type=Boss])

## 분석 항목
1. **핵심 시스템/기능**: 질문이 어떤 시스템/기능에 대한 것인지 (예: "물약 자동 사용 시스템", "스킬 시스템")
2. **질문 유형**: overview(시스템 전체 설명/개요), fact(사실 조회), cross_system(시스템 간), flow(플로우/시퀀스), balance(수치/밸런스), data_query(구체적 수치/목록 조회), ui(UI/UX), trap(존재하지 않는 기능)
3. **검색 키워드**: 검색에 사용할 핵심 키워드 (시스템명 포함)
4. **검색 전략**: 어떤 도구를 어떤 순서로 사용할지

## ⚠️ "기획" vs "기획서" 구분 (매우 중요!)

**"기획해줘", "기획 진행", "설계해줘", "어떻게 하면 좋겠어"** 같은 요청은:
→ query_type을 **"overview" 또는 적절한 유형**으로 지정 (일반 QnA)
→ 전략적 방향, 분석, 제안을 **답변**으로 제공
→ 이것은 planning/design 관점의 대화이며, 문서 작업이 아님

**"기획서 수정해줘", "기획서 작성해줘", "기획서에 반영해줘", "문서 수정", "문서 작성", "기획서 만들어줘"** 같은 요청은:
→ query_type을 **"proposal"**로 지정
→ 실제 **기획 문서의 수정안(diff)이나 신규 문서 초안**을 생성
→ "기획서"라는 단어가 명시적으로 포함되어야 proposal

proposal 질문의 특징:
- "기획서"(문서)를 직접 수정/생성하라는 명시적 요청
- key_systems에는 수정 대상 워크북을 넣고, search_plan에 해당 워크북의 section_search를 포함
- 추가 필드 `proposal_action`: "modify"(기존 문서 수정) 또는 "create"(신규 문서) 또는 "both"
- 추가 필드 `target_documents`: 수정/생성 대상 [{workbook, sheet}] 목록
- **신규 기획서는 Confluence 페이지로 생성**하는 것이 기획팀 정책 (Excel이 아님)

## ⚠️ overview 질문 판별 (매우 중요)
"~시스템 설명해줘", "~시스템이 뭐야?", "~시스템 전체 개요", "~에 대해 알려줘" 같은 **넓은 범위의 질문**은 query_type을 반드시 **"overview"**로 지정하세요.

overview 질문의 특징:
- 특정 수치나 세부 규칙이 아닌, 시스템의 전체적인 구조/개념/흐름을 묻는 질문
- 이런 질문에는 **관련 워크북을 최대한 많이** (5~8개) key_systems에 넣어야 함
- Excel 워크북과 Confluence 문서가 동일 시스템에 대해 각각 다른 정보를 가지고 있으므로 **둘 다** 포함
- 같은 시스템이라도 여러 워크북에 분산되어 있을 수 있음 (예: "정령" → PK_펫 시스템 + PK_기타설정 + Confluence/정령 + Confluence/정령(기존"펫"))
- search_plan에도 각 key_system별 section_search를 개별로 넣어 폭넓게 검색

## 중요 규칙
- 워크북 목록에 시트(하위 페이지) 정보가 함께 제공됩니다. 시트명을 참고하여 어떤 워크북에 원하는 정보가 있는지 정확히 판단하세요.
- key_systems에는 워크북 목록에서 매칭되는 정확한 워크북명을 넣으세요.
- "물약"이 포함된 질문 → "물약 자동 사용 시스템" (물약 관련 유일한 워크북)
- "트리거"가 게임 메커니즘 맥락(HP 조건, 자동 발동 등)에서 쓰이면 "트리거 시스템"이 아니라 해당 메커니즘의 시스템을 찾아야 함
- 질문에 시스템명이 명시되어 있으면 해당 시스템을 최우선으로 검색
- 시스템 간 비교/관계 질문이면 각 시스템을 개별 검색 후 종합
- key_systems의 값은 가능하면 사용 가능한 워크북 목록의 이름과 정확히 일치시키세요

## ⚠️ 자주 틀리는 워크북 매칭 (반드시 참고)
- **창고/보관함/창고 NPC/CanStorage/창고 확장** → "PK_NPC 시스템" (PK_인벤토리가 아님!)
- **스탯 UI/스탯 찍기/ACCEPT 버튼/2차 파라미터/스탯 그룹 순서/스탯 최대치/스탯 성장 불가/스탯 비활성화** → "PK_기본전투_시스템" (PK_스탯 및 공식이 아님! 스탯 UI는 기본전투 시스템에 포함. '스탯 성장 불가 상태 표현' 섹션에 최대치 도달 시 선택 불가 규칙 있음)
- **종족 설정/엘프 수명/도깨비 탄생/드워프 역사** → "PK_기타설정" (PK_세계관이 아님! 메타설정/종족별 상세는 기타설정에 있음)
- **발동액션 표현/심판의 불꽃/발동액션 쿨타임 변경/스킬 자동 사용/스킬 자동 발동** → "PK_발동액션 표현 개선" (④ 스킬 자동 사용 기능 개선 섹션에 '현재 vs 변경' 비교표 있음. "기존이랑 차이점" 질문 시 반드시 이 비교표를 참조)
- **WorldClass 테이블/QuestObjective 테이블/퀘스트 인스턴스** → "PK_퀘스트 인스턴스" (PK_퀘스트가 아님!)
- **K성물/성물 성장/성물 재료** → Confluence 검색 키워드 "K성물"
- **시아 폴리싱/일감 담당** → Confluence 검색 키워드 "시아 폴리싱"
- **레이븐2 컬렉션/타 게임 조사** → "Confluence/Design/R&D 및 레퍼런스" 하위 페이지
- **근공방/Normal 근공방/PC Damage 비율/공격력 비율** → "PK_대미지 명중률 계산기" (스탯 및 공식이 아님!)
- **방어력 비율/Defense 비율** → "PK_대미지 명중률 계산기"
- **ItemType/ConsumeType/CurrencyEnum/Cook/아이템 Enum** → "PK_아이템 시스템" (Enum 시트에 있음)
- **재화 상인/컨텐츠 상인/컨텐츠 재화 상인/길드 상인/무한의탑 상인/레이드 상인/일일미션 상인** → "PK_NPC 시스템" (Beta3 NPC 개선 시트에 상인 종류별 재화 정보 있음. search_keywords에 반드시 "Beta3 NPC 개선 컨텐츠 재화" 포함. 4종 재화: 길드 주화, 성장의 증표, 정복의 증표, 승리의 훈장)
- **서버 침공/보너스 보스/타 서버 침공** → Confluence "서버 이동 컨텐츠" 하위 페이지
- **시스템 메시지/SystemMsg** → "PK_시스템 메시지" (개요 및 공통 규칙 시트에 recipient/Display/DuplicationAllow 정의. Display 타입: Chat(채팅로그)+Toast(상단알림) 복합 가능. 아이템 등급별 색상은 자동 적용(전설=주황색, bold 자동))
- **시스템 메시지 설계 + 특정 컨텐츠** → 반드시 "PK_시스템 메시지" **AND** 해당 컨텐츠 워크북 두 개를 key_systems에 넣으세요. search_keywords에 "등급 색상" "DuplicationAllow" 포함
- **EffectClass/BonusEnum/자폭** → Confluence "스킬 이펙트" 하위 페이지
- **HUD 타겟/타게팅/네임 플레이트/자동 전투 타겟/타겟 정보 UI** → "PK_타게팅 시스템" + "PK_기본 전투 시스템" (둘 다 key_systems에 넣으세요)
- **Cook/요리 버프/ConsumeType/던전 버프 유지** → "PK_아이템 시스템" + Confluence "던전" (크로스 시스템)
- **퀘스트 텔레포트/퀘스트 이동/50m 제한** → "PK_퀘스트" + "PK_월드맵 시스템" (둘 다 key_systems에 넣으세요. 텔레포트 50m 제한은 PK_월드맵 시스템 텔레포트 시트에 있음)
- **QuestInstanceTrigger/RepeatSpawn/반복 스폰/스폰 볼륨** → "PK_퀘스트 인스턴스" (시스템 처리 시트 5-4항에 RepeatSpawn 상세 규칙: 0=한번만 스폰, 1이상=추가 반복 스폰 횟수. search_keywords에 "RepeatSpawn 반복 스폰 횟수" 포함)
- **마우스 이벤트/mouseup/클릭 충돌/터치 이벤트** → "PK_마우스 이벤트 처리"
- **마일스톤/M1/M2/Proto/기능 구현 일정** → "PK_MileStone_Proto"
- **변신 강화/안전 강화/프리셋 착용** → "PK_변신 및 스킬 시스템" + Confluence "변신" (변신 강화는 UI_변신_강화 문서 참조)
- **캐릭터 선택창/변신 UI/조작 초기화/변신 전환/프리셋** → "PK_캐릭터 선택창&변신" (변신 및 스킬 시스템과 다른 워크북!)
- **변신 UI 충돌/변신 + M1 M2 기능** → "PK_캐릭터 선택창&변신" + "PK_MileStone_Proto" (둘 다 key_systems에 넣으세요)
- **HISTORY/수정 이력/마지막 수정/최종 수정자** → 해당 Confluence 문서의 HISTORY 테이블에서 마지막 행 확인 (search_keywords에 "HISTORY 담당자 수정" 포함)

## 출력 형식 (JSON만 출력)
```json
{
  "key_systems": ["시스템명1", "시스템명2"],
  "query_type": "fact|cross_system|flow|balance|ui|trap|proposal",
  "search_keywords": ["키워드1", "키워드2"],
  "search_plan": [
    {"tool": "retrieve|section_search|kg_related", "args": {"query": "검색어"}}
  ],
  "reasoning": "1줄 판단 근거",
  "proposal_action": "modify|create|both (proposal일 때만)",
  "target_documents": [{"workbook": "워크북명", "sheet": "시트명"}]
}
```
※ proposal_action과 target_documents는 query_type이 "proposal"일 때만 포함"""


# Planning에서 제외할 Excel 시트 이름 패턴
_NOISE_SHEET_EXACT = {
    "Sheet1", "Sheet2", "Sheet3", "Sheet4", "Sheet5",
    "temp", "temp2", "목표", "미사용",
}
_NOISE_SHEET_PREFIXES = ("History_", "히스토리", "history_")


def _is_noise_sheet(name: str) -> bool:
    """의미 없는 시트 이름인지 판별 (Excel 전용)."""
    if name in _NOISE_SHEET_EXACT:
        return True
    for prefix in _NOISE_SHEET_PREFIXES:
        if name.startswith(prefix):
            return True
    # "Sheet" + 숫자 패턴
    if name.startswith("Sheet") and name[5:].isdigit():
        return True
    return False


def _build_workbook_sheet_listing() -> str:
    """Planning 입력용 워크북+시트 목록 생성.

    Excel(PK_): 노이즈 시트 필터링, 시트 2개 이상일 때만 시트 표시
    Confluence: 시트=페이지 제목이므로 전부 표시
    """
    index = _build_structural_index()
    all_wbs = sorted(index.keys())
    pk_wbs = [w for w in all_wbs if w.startswith("PK_")]
    conf_wbs = [w for w in all_wbs if w.startswith("Confluence/Design/") and w.count("/") <= 5]

    lines = []
    for wb in pk_wbs + conf_wbs:
        info = index.get(wb, {})
        all_sheets = sorted(info.get("sheets", {}).keys())

        if wb.startswith("PK_"):
            # Excel: 노이즈 시트 제거
            useful = [s for s in all_sheets if not _is_noise_sheet(s)]
            if len(useful) >= 2:
                lines.append(f"{wb}: [{', '.join(useful)}]")
            else:
                lines.append(wb)
        else:
            # Confluence: 시트=페이지 제목, 모두 유용
            if len(all_sheets) >= 2:
                lines.append(f"{wb}: [{', '.join(all_sheets)}]")
            else:
                lines.append(wb)

    return "\n".join(lines)


def _get_kg_summary_for_planning() -> str:
    """Knowledge Graph에서 Planning에 제공할 시스템 간 관계 요약 생성.

    형식: "시스템A -> 관련1, 관련2, 관련3" (한 줄에 하나씩)
    Planning LLM이 시스템 간 관계를 파악하여 cross-system 질문에 대응할 수 있게 함.
    """
    graph = _load_graph()
    if not graph or graph.number_of_nodes() == 0:
        return ""

    lines = []
    for node in sorted(graph.nodes()):
        neighbors = sorted(graph.neighbors(node))
        if neighbors:
            # Confluence 경로는 마지막 세그먼트만 표시 (간결성)
            short_neighbors = []
            for n in neighbors[:5]:  # 최대 5개 관계만
                if n.startswith("Confluence/"):
                    short_neighbors.append(n.split("/")[-1])
                else:
                    short_neighbors.append(n)
            lines.append(f"  {node} -> {', '.join(short_neighbors)}")

    return "\n".join(lines)


# 게임 데이터 스키마 캐시
_game_data_schema_cache: str | None = None
_game_data_module = None  # data-pipeline의 game_data 모듈 (importlib 로드)


def _load_game_data_module():
    """data-pipeline/src/game_data.py를 importlib로 로드.

    qna-poc의 src 패키지와 네임스페이스 충돌 방지.
    """
    global _game_data_module
    if _game_data_module is not None:
        return _game_data_module

    import importlib.util
    gd_path = Path(__file__).resolve().parent.parent.parent / "data-pipeline" / "src" / "game_data.py"
    if not gd_path.exists():
        return None
    spec = importlib.util.spec_from_file_location("game_data_dp", str(gd_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _game_data_module = mod
    return mod


def _get_game_data_schema() -> str:
    """게임 데이터 테이블 스키마 요약 (Planning LLM 주입용). 캐시됨."""
    global _game_data_schema_cache
    if _game_data_schema_cache is not None:
        return _game_data_schema_cache

    try:
        mod = _load_game_data_module()
        if mod and mod.is_db_ready():
            _game_data_schema_cache = mod.get_schema_summary(mod.get_db_path())
            return _game_data_schema_cache
    except Exception as e:
        log.warning(f"게임 데이터 스키마 로드 실패: {e}")

    _game_data_schema_cache = ""
    return ""


def plan_search(query: str, role: str = None, model: str = "claude-opus-4-6",
                conversation_history: list[tuple[str, str]] = None,
                prompt_overrides: dict[str, str] | None = None) -> dict:
    """LLM으로 질문을 분석하여 검색 전략 수립.

    KG 관계 정보를 함께 제공하여 시스템 간 관계를 파악할 수 있게 함.
    """
    user_msg = f"질문: {query}"
    if role:
        user_msg += f"\n질문자 역할: {role}"

    # proposal 판별을 위해 대화 이력 포함
    if conversation_history:
        history_text = "\n".join(
            f"  Q: {q[:200]}\n  A: {a[:300]}" for q, a in conversation_history[-3:]
        )
        user_msg += f"\n\n이전 대화 맥락 (최근 {len(conversation_history[-3:])}턴):\n{history_text}"

    # 워크북 + 시트 목록 제공 (Planning 정확도 향상)
    # Excel: 노이즈 시트 필터링, Confluence: 페이지 제목 전부 포함
    wb_sheet_listing = _build_workbook_sheet_listing()
    user_msg += f"\n\n사용 가능한 워크북과 시트:\n{wb_sheet_listing}"

    # KG 관계 정보 제공 (시스템 간 관계 파악용)
    kg_summary = _get_kg_summary_for_planning()
    if kg_summary:
        user_msg += f"\n\n시스템 간 관계 (Knowledge Graph):\n{kg_summary}"

    # 게임 데이터 테이블 스키마 제공 (query_game_data 도구용)
    game_data_schema = _get_game_data_schema()
    if game_data_schema:
        user_msg += f"\n\n{game_data_schema}"

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=_resolve_prompt("planning", prompt_overrides),
            model=model,
            max_tokens=1024,
            temperature=0,
        )
        planning_prompt_used = _resolve_prompt("planning", prompt_overrides)
        plan = _parse_plan_json(result["text"])
        plan["_tokens"] = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        plan["_api_seconds"] = result.get("api_seconds", 0)
        plan["_raw_response"] = result["text"]  # Planning LLM의 원본 응답 보존
        plan["_system_prompt"] = planning_prompt_used
        plan["_user_prompt"] = user_msg
        return plan
    except Exception as e:
        # Planning 실패 시 기본 전략
        return {
            "key_systems": extract_system_names(query),
            "query_type": "fact",
            "search_keywords": [query],
            "search_plan": [{"tool": "retrieve", "args": {"query": query}}],
            "reasoning": f"Planning 실패 ({e}), 기본 retrieve 사용",
            "_tokens": 0,
            "_api_seconds": 0,
        }


def _parse_plan_json(text: str) -> dict:
    """Planning 응답에서 JSON 추출."""
    text = text.strip()
    if "```json" in text:
        start = text.index("```json") + 7
        end = text.find("```", start)
        text = text[start:end].strip() if end >= 0 else text[start:].strip()
    elif "```" in text:
        start = text.index("```") + 3
        end = text.find("```", start)
        text = text[start:end].strip() if end >= 0 else text[start:].strip()

    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start >= 0 and brace_end > brace_start:
        text = text[brace_start:brace_end + 1]

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "key_systems": [],
            "query_type": "fact",
            "search_keywords": [],
            "search_plan": [{"tool": "retrieve", "args": {"query": ""}}],
            "reasoning": "JSON 파싱 실패",
        }


# ══════════════════════════════════════════════════════════
#  2. Tool Use — 검색 도구 실행
# ══════════════════════════════════════════════════════════

def execute_search(plan: dict, query: str, max_chunks: int = 200) -> list[dict]:
    """Planning 결과에 따라 검색 도구를 실행하고 결과를 병합.

    항상 기본 하이브리드 검색(retrieve)을 실행하고,
    Planning 전략으로 보강하는 구조.
    """
    all_chunks = {}  # id → chunk (중복 제거)

    # ── 1. 기본 하이브리드 검색 (항상 실행) ──
    base_chunks, _ = retrieve(query, top_k=15)
    for c in base_chunks:
        all_chunks[c["id"]] = c

    # ── 2. Planning 전략 실행 (보강) ──
    search_plan = plan.get("search_plan", [])
    for step_idx, step in enumerate(search_plan):
        tool = step.get("tool", "retrieve")
        args = step.get("args", {})

        if tool == "retrieve":
            search_query = args.get("query", query)
            if search_query != query:  # 기본 검색과 다른 쿼리인 경우만
                chunks, _ = retrieve(search_query, top_k=10)
                for c in chunks:
                    if c["id"] not in all_chunks:
                        all_chunks[c["id"]] = c

        elif tool == "section_search":
            workbook = args.get("workbook", "") or args.get("section", "")  # planner가 section으로 보낼 수 있음
            search_query = args.get("query", query)
            if workbook:
                chunks = _structural_search(workbook, search_query)
                for c in chunks[:10]:
                    c["score"] = max(c.get("score", 0), 1.2)  # Planning 지시 검색 → 높은 점수
                    c["source"] = "section_search"
                    if c["id"] not in all_chunks:
                        all_chunks[c["id"]] = c
                    else:
                        # 이미 있으면 스코어 갱신
                        all_chunks[c["id"]]["score"] = max(all_chunks[c["id"]]["score"], c["score"])

        elif tool == "kg_related":
            system_name = args.get("system", "")
            if system_name:
                related = get_related_systems(system_name, depth=1)
                for rel in related[:3]:
                    aliases = _build_system_aliases()
                    wb_list = aliases.get(rel.lower(), [])
                    for wb in wb_list[:1]:
                        chunks = _structural_search(wb, query)
                        for c in chunks[:3]:
                            c["score"] *= 0.7
                            c["source"] = "kg_agent"
                            if c["id"] not in all_chunks:
                                all_chunks[c["id"]] = c

        elif tool == "query_game_data":
            try:
                mod = _load_game_data_module()
                if mod and mod.is_db_ready():
                    gd_result = mod.execute_game_query(args, mod.get_db_path())
                    formatted = mod.format_game_data_result(gd_result)
                    gd_chunk = {
                        "id": f"gamedata_{step_idx}",
                        "workbook": f"GameData/{args.get('table', '')}",
                        "sheet": "query_result",
                        "text": formatted,
                        "score": 1.5,
                        "source": "game_data_query",
                        "tokens": len(formatted) // 4,
                        "_game_data": True,
                    }
                    all_chunks[gd_chunk["id"]] = gd_chunk
                    log.info(f"  game_data 쿼리: table={args.get('table')}, "
                             f"rows={gd_result.total_matched}, {gd_result.execution_ms:.0f}ms")
            except Exception as e:
                log.warning(f"  game_data 쿼리 실패: {e}")

    # ── 3. Planning key_systems 직접 검색 보강 ──
    key_systems = plan.get("key_systems", [])
    aliases = _build_system_aliases()
    for sys_name in key_systems[:3]:
        # 워크북명 매칭
        wb_matches = aliases.get(sys_name.lower(), [])
        if not wb_matches:
            # PK_ 접두사 추가 시도
            wb_matches = aliases.get(f"pk_{sys_name.lower()}", [])
        if not wb_matches:
            # 부분 매칭
            for alias_key, alias_wbs in aliases.items():
                if sys_name.lower() in alias_key.lower():
                    wb_matches = alias_wbs
                    break

        for wb in wb_matches[:2]:
            chunks = _structural_search(wb, query)
            # search_keywords로도 추가 검색 (시트 매칭 정확도 향상)
            search_kws = plan.get("search_keywords", [])
            if search_kws:
                kw_query = " ".join(search_kws[:6])
                kw_chunks = _structural_search(wb, kw_query)
                seen_ids = {c["id"] for c in chunks}
                for c in kw_chunks:
                    if c["id"] not in seen_ids:
                        c["score"] = max(c.get("score", 0), 0.9)  # keyword 매칭 보너스
                        chunks.append(c)
                        seen_ids.add(c["id"])
                # keyword 검색에서 높은 점수를 받은 청크를 앞으로 이동
                chunks.sort(key=lambda x: x.get("score", 0), reverse=True)
            for c in chunks[:10]:
                c["score"] = max(c.get("score", 0), 1.2)  # Planning이 지목한 워크북 → 높은 기본 점수
                c["source"] = "agent_planned"
                if c["id"] not in all_chunks:
                    all_chunks[c["id"]] = c
                else:
                    # 이미 base retrieve에서 발견된 청크 → key_systems 보너스 추가
                    all_chunks[c["id"]]["score"] += 0.3
                    # source는 "vector+agent_planned" 등으로 보존 (디버그 추적용)
                    orig_src = all_chunks[c["id"]].get("source", "")
                    all_chunks[c["id"]]["source"] = f"{orig_src}+agent_planned" if orig_src else "agent_planned"

    # 스코어 순 정렬
    all_sorted = sorted(all_chunks.values(), key=lambda x: x.get("score", 0), reverse=True)

    # ── 워크북 다양성 보장 ──
    # overview 질문이나 넓은 검색에서 특정 워크북이 결과를 독점하는 것을 방지
    # 워크북당 최대 max_per_wb개까지만 우선 선발, 나머지는 후순위로
    query_type = plan.get("query_type", "fact")
    max_per_wb = 5 if query_type == "overview" else 8
    wb_count: dict[str, int] = {}
    primary = []
    overflow = []
    for c in all_sorted:
        wb = c.get("workbook", "")
        wb_count[wb] = wb_count.get(wb, 0) + 1
        if wb_count[wb] <= max_per_wb:
            primary.append(c)
        else:
            overflow.append(c)
    result = (primary + overflow)[:max_chunks]
    return result


# ══════════════════════════════════════════════════════════
#  3. Answer Generation — 증거 기반 답변 생성
# ══════════════════════════════════════════════════════════

AGENT_ANSWER_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가 AI 어시스턴트입니다.
검색된 기획서(컨텍스트)를 기반으로 질문에 체계적으로 답변합니다.

## [1] 핵심 원칙

1. **대화 연속성**: 이전 대화가 있으면 **그 맥락을 이어서** 답변하세요. 이미 설명한 내용을 반복하지 마세요. 이전 턴에서 다룬 시스템 분석, 제안 등은 "앞서 논의한 대로" 정도로 참조하고, **새로운 관점이나 추가 내용에 집중**하세요.
2. **컨텍스트 기반 완전 답변**: 컨텍스트에 관련 정보가 있으면 **반드시, 빠짐없이** 답변하세요. 부분적이라도 관련 내용이 있으면 그것을 기반으로 답하세요. 동의어/유사 표현("비활성화"="선택 불가", "Category 값"="Category 컬럼")도 같은 의미로 매칭하세요.
3. **구체적 데이터 정확 인용**: 수치, 비용, 배율, 확률, 테이블, Enum 값은 반드시 컨텍스트에서 직접 인용하세요. 컨텍스트에 없는 구체적 수치/데이터를 절대 만들어내지 마세요. 단, 시스템 구조/관계/설계 의도에 대한 분석적 추론은 허용됩니다.
4. **출처 명시**: 답변에 사용한 정보의 출처를 표시하세요. 형식: `[출처: 워크북명 / 시트명]`
5. **기획서 + 데이터 테이블 교차 참조 (최우선 필수)**: "게임 데이터 조회 결과"가 포함된 경우:
   - **게임 데이터 조회 결과는 클라이언트/서버에서 실제로 사용되는 확정 데이터**입니다. 기획서보다 우선합니다.
   - 게임 데이터의 핵심 행/컬럼을 **반드시 본문에 Markdown 테이블로 포함**하고, 해당 테이블 바로 아래에 `[출처: GameData/테이블명]`을 표기하세요.
   - 50행 이상이면 대표적인 10~20행을 선별하여 표시하고 "외 N건" 표기.
   - 기획서에서는 설계 의도/규칙을 인용하고, 데이터시트에서는 실제 구현 수치를 인용하여 **두 소스를 결합**하세요.
   - **게임 데이터가 제공되었는데 본문에서 전혀 언급하지 않는 것은 금지**입니다.

## [2] 답변 구조 가이드

체계적이고 완전한 답변을 위해 다음 구조를 따르세요:

### 서술 순서
1. **핵심 개념 요약** — 1~2문장으로 시스템/기능의 핵심을 먼저 정의
2. **구성 요소** — 주요 구성 요소를 계층적으로 정리 (상위 → 하위)
3. **동작 메커니즘** — 작동 방식, 조건, 시퀀스를 구체적으로 서술
4. **핵심 데이터** — 수치, 조건표, 공식 등을 Markdown 테이블로 정리
5. **관련 시스템** — 다른 시스템과의 연결점, 상호작용을 명시
6. **미정의 영역** — 기획서에 아직 정의되지 않은 부분이 있으면 명시

### 형식 규칙
- **Markdown 적극 활용**: 헤더(##, ###), 테이블, 리스트, 볼드를 사용하여 가독성을 높이세요
- **테이블/수치 데이터**: 원본의 표 구조를 Markdown 테이블로 재구성하세요
- **여러 시스템 질문**: 시스템별로 분리 정리 후 관계/차이점을 분석하세요
- **질문의 모든 측면에 답변**: 질문이 여러 측면을 묻는다면 빠짐없이 포함하세요. 답변 작성 후 컨텍스트에서 놓친 관련 정보가 없는지 재확인하세요
- **질문 용어 존중**: 질문에 사용된 용어를 그대로 사용하세요 ("Defense" → "Melee Defense"로 바꾸지 마세요)
- **설계 요청**: "설계해주세요" 유형 질문에는 컨텍스트의 기존 패턴/템플릿을 참조하여 구체적 설계안을 제시하세요

## [3] 가드레일

### G1. 날조 금지 + "미정의" 구분
- 구체적 수치/비용/Enum 값/테이블 데이터는 컨텍스트에서 직접 인용만 허용
- **"언급 없음" ≠ "없다/0이다/불가능하다"**: 컨텍스트에 비용 정보가 없다고 "무료"라고 단정하지 마세요. "해당 정보는 기획서에 명시되어 있지 않습니다"가 올바른 답변입니다
- 실제로 "비용 없음", "해당 없음" 등 **명시적 부정** 문구가 있을 때만 "~하지 않습니다"로 답하세요
- **질문이 전제하는 기능/시스템이 컨텍스트에 전혀 없으면**: "기획서에 정의되어 있지 않습니다"로 답하되, 관련 시스템의 정의된 기능 목록을 함께 제공하세요
- 질문의 전제가 틀렸어도 관련 정보가 있으면 제공을 이어가세요

### G2. 데이터 소스 신뢰도
- **[이미지 설명]**: 기획서 다이어그램/도면/표의 AI 분석 결과. 본문 텍스트와 동일한 신뢰도
- **OOXML 원본 텍스트**: Excel 셀에서 직접 추출한 확정 데이터. OCR 변환보다 **항상** 우선. "추정/가능성/시사" 등으로 약화시키지 마세요. `R행:C열:텍스트` 형식에서 같은 열(C값)은 관련 데이터입니다
- **`[?...?]`**: 원본 변환 시 잘린 텍스트. 앞부분은 유효하며, 다른 청크에 완전한 형태가 있을 수 있으니 전체를 확인하세요
- **HISTORY 테이블**: Confluence 문서 수정 이력. 마지막 행 = 최종 수정자/내용/날짜

### G3. 컨텍스트 우선 원칙
- 컨텍스트의 명시적 규칙 > 게임 개발 일반 상식/관례
- 컨텍스트에 있는 규칙과 모순되는 내용을 절대 생성하지 마세요
- "별도 문서 참조"로 되어있으면 임의로 설계하지 말고 그대로 안내하세요

### G4. 분석 질문 대응
- **충돌/호환성 질문**: "충돌 없음" 단정 금지. 각 시스템 동작 인용 → 충돌 해결 규칙 확인 → 없으면 "명시적 처리 규칙 없음" + 분석/우려사항 제공. 문서의 침묵 ≠ 문제없음
- **추론 허용 범위**: 설계 의도/배경 추론, 시스템 간 관계 분석, 엣지 케이스 검토, 처리 순서 분석은 OK. 단 분석 기반임을 밝히세요
- **세계관 vs 시스템**: "종족 탄생/역사/세계관" 질문에는 `PK_기타설정/종족` 등 세계관 문서로 답변. 동일 키워드의 시스템 메커니즘 문서와 혼동하지 마세요
- **미완성 문서**: 문서가 비어있거나 "추후 작성 예정"이면 명확히 안내하세요

### G5. SystemMsg 설계 체크리스트
설계 요청 시: (1) display: Chat/Toast/둘 다, (2) recipient: Self/Server, (3) DuplicationAllow: TRUE/FALSE — 모두 명시. 등급 색상은 컨텍스트의 색상표를 인용하세요.

## 역할별 답변 스타일
- **기획자**: 시스템 규칙, 상호작용, 설계 의도 중심
- **프로그래머**: 데이터 구조, 공식, 시퀀스, 조건 분기 중심
- **QA**: 엣지 케이스, 조건 분기, 상태 전이, 예외 상황 중심
- **PD**: 전체 그림, 시스템 간 관계, 진행 현황 중심
"""


BASIC_ANSWER_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가입니다.
아래 기획 문서를 읽고 질문에 체계적으로 답변하세요.

## 답변 원칙
- 관련 정보를 **빠짐없이** 포함
- 구조화된 Markdown 형식 (헤더, 테이블, 리스트 적극 활용)
- 출처(워크북/시트)를 답변 내에 명시
- 시스템 개요 → 핵심 메커니즘 → 세부 규칙 → 관련 시스템 순으로 서술
- 수치, 조건, 규칙 등 구체적 데이터는 반드시 포함
- 기획서에 없는 내용은 만들어내지 마세요
"""


# 프롬프트 스타일 설정
_PROMPT_STYLE_CONFIG = {
    "검증세트 최적화": AGENT_ANSWER_PROMPT,
    "기본": BASIC_ANSWER_PROMPT,
}

# ── 프롬프트 레지스트리 (커스텀 프롬프트 기능용) ──
# 각 단계별 기본 프롬프트를 key로 관리. 프론트엔드에서 override 가능.
# NOTE: _SYNTHESIS_PROMPT, _BASIC_SYNTHESIS_PROMPT는 아래(deep_research 부근)에서 정의되므로
#       모듈 로드 후 _init_default_prompts()로 등록한다.
DEFAULT_PROMPTS: dict[str, str] = {}

PROMPT_LABELS = {
    "planning": "계획 (Planning)",
    "answer": "답변 (Answer)",
    "answer_basic": "답변 - 기본",
    "reflection": "검증 (Reflection)",
    "proposal": "기획서 (Proposal)",
    "synthesis": "종합 (Deep Research)",
    "synthesis_basic": "종합 - 기본",
    "review": "리뷰 (Review)",
}


def _init_default_prompts():
    """모듈 내 모든 프롬프트 상수가 정의된 후 호출. DEFAULT_PROMPTS를 채운다."""
    DEFAULT_PROMPTS.update({
        "planning": PLANNING_PROMPT,
        "answer": AGENT_ANSWER_PROMPT,
        "answer_basic": BASIC_ANSWER_PROMPT,
        "reflection": REFLECTION_PROMPT,
        "proposal": PROPOSAL_PROMPT,
        "synthesis": _SYNTHESIS_PROMPT,
        "synthesis_basic": _BASIC_SYNTHESIS_PROMPT,
    })


def _resolve_prompt(key: str, overrides: dict[str, str] | None = None) -> str:
    """override가 있으면 사용, 없으면 기본 프롬프트 반환."""
    if overrides and key in overrides:
        return overrides[key]
    return DEFAULT_PROMPTS[key]


# 모델별 최대 출력 토큰
_MODEL_MAX_OUTPUT = {
    "claude-opus-4-6": 32768,
    "claude-sonnet-4-6": 64000,
    "claude-haiku-4-5": 8192,
}

_DETAIL_LEVEL_CONFIG = {
    "간결": {
        "max_tokens_ratio": 0.125,  # 모델 최대의 12.5%
        "prompt_suffix": "\n\n## 출력 길이 지시\n핵심만 간결하게 답변하세요. 1,000자 이내로 작성하세요. 불필요한 부연 설명 없이 질문에 대한 직접적인 답만 제공하세요.",
    },
    "보통": {
        "max_tokens_ratio": 0.25,  # 모델 최대의 25%
        "prompt_suffix": "\n\n## 출력 길이 지시\n적절한 분량으로 답변하세요. 2,000~3,000자 내외로 작성하세요. 핵심 내용을 빠짐없이 포함하되, 과도하게 길지 않게 작성하세요.",
    },
    "상세": {
        "max_tokens_ratio": 0.5,  # 모델 최대의 50%
        "prompt_suffix": "\n\n## 출력 길이 지시\n상세하고 포괄적으로 답변하세요. 5,000자 이상도 괜찮습니다. 관련된 모든 세부사항, 테이블, 조건, 예외 상황을 포함하세요. 필요하면 다이어그램(mermaid)도 활용하세요.",
    },
}


def _get_max_tokens(model: str, detail_level: str) -> int:
    """모델의 최대 출력 토큰에 비례하여 max_tokens 결정."""
    model_max = _MODEL_MAX_OUTPUT.get(model, 16384)
    ratio = _DETAIL_LEVEL_CONFIG.get(detail_level, _DETAIL_LEVEL_CONFIG["보통"])["max_tokens_ratio"]
    return int(model_max * ratio)


def _load_full_sheets(chunks: list[dict], max_context_tokens: int = 80000) -> list[dict]:
    """검색된 청크에서 시트를 식별하고, 해당 시트의 전체 청크를 ChromaDB에서 로드.

    Claude 웹앱처럼 시트(문서) 단위로 완전한 컨텍스트를 제공.
    청크 조각이 아닌 시트 전체를 LLM에 넣어 맥락 손실을 제거.

    Args:
        chunks: 검색으로 찾은 청크 목록 (시트 식별용)
        max_context_tokens: 최대 컨텍스트 토큰 수 (기본 80K)
            메타데이터 토큰 추정치 vs 실제 API 토큰의 증폭률이 ~1.5-2x이므로
            80K 추정 → ~120-160K 실제, Sonnet 200K 한계 이내.

    Returns:
        시트 전체 청크 목록 (시트별 정렬, 원본 순서 유지)
    """
    if not chunks:
        return []

    # 1) 검색된 청크에서 고유 시트 식별 (워크북+시트 조합, 검색 점수순)
    sheet_keys_ordered = []  # (workbook, sheet) 순서 유지
    sheet_scores = {}  # (wb, sheet) → max score
    seen_sheets = set()
    for c in chunks:
        wb = c.get("workbook", "")
        sh = c.get("sheet", "")
        key = (wb, sh)
        score = c.get("score", 0)
        if key not in seen_sheets:
            seen_sheets.add(key)
            sheet_keys_ordered.append(key)
            sheet_scores[key] = score
        else:
            sheet_scores[key] = max(sheet_scores[key], score)

    # 점수순 정렬 (높은 점수의 시트 우선)
    sheet_keys_ordered.sort(key=lambda k: sheet_scores.get(k, 0), reverse=True)

    # 2) ChromaDB에서 시트 전체 청크 로드
    collection = _get_collection()
    full_sheets = []  # [{sheet_key, chunks, total_tokens}]
    total_tokens = 0

    for wb, sh in sheet_keys_ordered:
        # ChromaDB where 필터로 시트 전체 청크 가져오기
        try:
            result = collection.get(
                where={"$and": [{"workbook": wb}, {"sheet": sh}]},
                include=["documents", "metadatas"],
            )
        except Exception:
            # $and 미지원 시 workbook만으로 필터 후 sheet 매칭
            result = collection.get(
                where={"workbook": wb},
                include=["documents", "metadatas"],
            )
            # sheet 필터링
            filtered_ids = []
            filtered_docs = []
            filtered_metas = []
            for idx, meta in enumerate(result["metadatas"]):
                if meta.get("sheet", "") == sh:
                    filtered_ids.append(result["ids"][idx])
                    filtered_docs.append(result["documents"][idx])
                    filtered_metas.append(meta)
            result = {"ids": filtered_ids, "documents": filtered_docs, "metadatas": filtered_metas}

        if not result["ids"]:
            continue

        # 시트 청크를 section_path 순으로 정렬 (원본 문서 순서 유지)
        sheet_chunks = []
        sheet_tokens = 0
        for idx in range(len(result["ids"])):
            meta = result["metadatas"][idx]
            doc = result["documents"][idx] if idx < len(result["documents"]) else ""
            tokens = meta.get("tokens", int(len(doc) * 0.5))
            sheet_tokens += tokens
            sheet_chunks.append({
                "id": result["ids"][idx],
                "workbook": wb,
                "sheet": sh,
                "section_path": meta.get("section_path", ""),
                "text": doc,
                "tokens": tokens,
                "source_url": meta.get("source_url", ""),
                "score": sheet_scores.get((wb, sh), 0),
            })

        # section_path 순 정렬
        sheet_chunks.sort(key=lambda c: c.get("section_path", ""))

        # 토큰 제한 확인
        if total_tokens + sheet_tokens > max_context_tokens:
            # 남은 공간에 맞는 청크만 추가
            remaining = max_context_tokens - total_tokens
            if remaining < 500:
                break
            partial_tokens = 0
            for c in sheet_chunks:
                if partial_tokens + c["tokens"] > remaining:
                    break
                full_sheets.append(c)
                partial_tokens += c["tokens"]
            total_tokens += partial_tokens
            break

        for c in sheet_chunks:
            full_sheets.append(c)
        total_tokens += sheet_tokens

    return full_sheets


def generate_agent_answer(query: str, chunks: list[dict], role: str = None,
                          key_systems: list[str] = None, model: str = "claude-opus-4-6",
                          conversation_history: list[tuple[str, str]] = None,
                          detail_level: str = "상세",
                          prompt_style: str = "검증세트 최적화",
                          prompt_overrides: dict[str, str] | None = None) -> dict:
    """수집된 증거로 답변 생성.

    검색된 청크에서 시트를 식별 → 해당 시트 전체를 로드하여 완전한 컨텍스트 제공.
    key_systems가 주어지면 해당 시스템의 시트를 우선 배치.
    conversation_history: [(question, answer), ...] 이전 대화 (최근 3턴)
    detail_level: "간결" | "보통" | "상세" — 답변 길이 조절
    """
    if not chunks:
        return {"answer": "(검색 결과 없음 - 답변 생성 불가)", "tokens": 0}

    # key_systems 시트 우선 정렬
    if key_systems:
        key_lower = [s.lower() for s in key_systems]
        for c in chunks:
            wb = c.get("workbook", "").lower()
            if any(k in wb for k in key_lower):
                c["score"] = max(c.get("score", 0), 1.5)  # key_systems 보너스

    # 시트 전체 로드 (청크 조각 → 완전한 시트 컨텍스트)
    # game_data 청크는 ChromaDB가 아닌 실시간 쿼리 결과이므로 별도 보존
    game_data_chunks = [c for c in chunks if c.get("_game_data")]
    non_game_chunks = [c for c in chunks if not c.get("_game_data")]
    full_sheet_chunks = _load_full_sheets(non_game_chunks)
    # game_data 청크를 다시 합류
    full_sheet_chunks.extend(game_data_chunks)

    # 시트별로 그룹화하여 컨텍스트 구성
    sheet_groups = {}  # (wb, sheet) → [chunks]
    for c in full_sheet_chunks:
        key = (c.get("workbook", ""), c.get("sheet", ""))
        sheet_groups.setdefault(key, []).append(c)

    context_parts = []
    for (wb, sheet), s_chunks in sheet_groups.items():
        # 시트 헤더
        sheet_text_parts = []
        for c in s_chunks:
            sec = c.get("section_path", "")
            text = c.get("text", "")
            if sec:
                sheet_text_parts.append(f"### {sec}\n{text}")
            else:
                sheet_text_parts.append(text)
        sheet_content = "\n\n".join(sheet_text_parts)
        context_parts.append(f"## [{wb} / {sheet}]\n\n{sheet_content}")

    context = "\n\n---\n\n".join(context_parts)

    # 게임 데이터 쿼리 결과가 있으면 별도 섹션으로 분리
    game_data_parts = []
    for c in full_sheet_chunks:
        if c.get("_game_data"):
            table_name = c.get("workbook", "GameData").replace("GameData/", "")
            game_data_parts.append(
                f"### [출처: GameData/{table_name}]\n\n{c.get('text', '')}"
            )

    if game_data_parts:
        game_data_section = "\n\n".join(game_data_parts)
        user_msg = (
            f"## 질문\n{query}\n\n---\n\n"
            f"## 참조 기획서 (설계 의도/규칙)\n\n{context}\n\n---\n\n"
            f"## 게임 데이터시트 조회 결과\n\n"
            f"아래는 게임 클라이언트/서버에서 실제 사용되는 데이터시트 조회 결과입니다.\n"
            f"이 데이터를 답변의 **별도 섹션**(예: '## 데이터시트 조회 결과')에 포함하고 "
            f"`[출처: GameData/테이블명]`을 표기하세요.\n\n"
            f"{game_data_section}"
        )
    else:
        user_msg = f"## 컨텍스트 (검색된 기획서)\n\n{context}\n\n---\n\n## 질문\n{query}"
    if role:
        user_msg = f"[질문자 역할: {role}]\n\n" + user_msg

    # 대화 히스토리 → messages 배열 (최근 3턴)
    messages = []
    if conversation_history:
        for prev_q, prev_a in conversation_history[-5:]:
            messages.append({"role": "user", "content": prev_q})
            messages.append({"role": "assistant", "content": prev_a})
    messages.append({"role": "user", "content": user_msg})

    detail_cfg = _DETAIL_LEVEL_CONFIG.get(detail_level, _DETAIL_LEVEL_CONFIG["보통"])
    # prompt_overrides > prompt_style 우선순위
    answer_key = "answer_basic" if prompt_style == "기본" else "answer"
    if prompt_overrides and answer_key in prompt_overrides:
        base_prompt = prompt_overrides[answer_key]
    else:
        base_prompt = _PROMPT_STYLE_CONFIG.get(prompt_style, AGENT_ANSWER_PROMPT)
    system_prompt = base_prompt + detail_cfg["prompt_suffix"]
    max_tokens = _get_max_tokens(model, detail_level)

    try:
        result = call_bedrock(
            messages=messages,
            system=system_prompt,
            model=model,
            max_tokens=max_tokens,
            temperature=0,
        )
        return {
            "answer": result["text"],
            "tokens": result.get("input_tokens", 0) + result.get("output_tokens", 0),
            "input_tokens": result.get("input_tokens", 0),
            "output_tokens": result.get("output_tokens", 0),
            "api_seconds": result.get("api_seconds", 0),
            "_system_prompt": system_prompt,
            "_user_prompt": user_msg,
            "_detail_level": detail_level,
            "_prompt_style": prompt_style,
            "_max_tokens": max_tokens,
            "_context_sheets": len(sheet_groups),
            "_context_chunks": len(full_sheet_chunks),
        }
    except Exception as e:
        return {"answer": f"(답변 생성 실패: {e})", "tokens": 0, "api_seconds": 0}


# ══════════════════════════════════════════════════════════
#  4. Reflection — 자기 평가 & 보강
# ══════════════════════════════════════════════════════════

REFLECTION_PROMPT = """당신은 QnA 시스템의 품질 검증관입니다.
생성된 답변이 질문에 충분히 답하는지 평가하세요.

## 평가 기준
1. 질문의 핵심 의도에 답했는가?
2. 구체적인 수치/조건/규칙을 포함하는가?
3. "찾을 수 없다"고 하지만 실제로는 검색 범위가 잘못된 것이 아닌가?

## 재검색 전략 (is_sufficient=false일 때 중요)
- 검색된 출처를 분석하여 **어떤 문서를 찾지 못했는지** 파악하세요.
- retry_query에는 **다른 검색어**를 사용하세요 (같은 검색어 반복 금지).
  - 유의어, 상위 개념, 하위 개념으로 변환
  - 시스템명을 더 정확하게 지정
- retry_systems에는 **탐색되지 않은 워크북**을 지정하세요.

## 출력 (JSON만)
```json
{
  "is_sufficient": true/false,
  "confidence": "high|medium|low|none",
  "missing_info": "부족한 정보 설명 (없으면 빈 문자열)",
  "retry_query": "재검색 쿼리 (불필요하면 빈 문자열)",
  "retry_systems": ["재검색 대상 시스템명"]
}
```"""


def reflect_on_answer(query: str, answer: str, chunks: list[dict], plan: dict, model: str = "claude-opus-4-6",
                      prompt_overrides: dict[str, str] | None = None) -> dict:
    """생성된 답변의 품질을 자체 검증.

    검색 실패 시 검색 컨텍스트(어떤 문서를 찾았는지, 어떤 키워드를 사용했는지)를
    Reflection에 전달하여 더 스마트한 재검색 전략을 수립하게 함.
    """
    # 답변이 명백히 실패인 경우 빠르게 판단
    FAIL_PATTERNS = [
        "찾을 수 없습니다", "정보가 없습니다", "답변 생성 불가",
        "확인되지 않습니다", "확인할 수 없습니다",
        "언급되지 않았습니다", "언급되어 있지 않습니다",
        "직접적인 언급이 없", "명시적으로 언급되지",
    ]
    is_cant_find = any(p in answer for p in FAIL_PATTERNS)

    # FAIL_PATTERNS이 매칭되면 항상 재시도 (의도적 거부보다 우선)
    # "찾을 수 없습니다"가 포함된 답변은 검색 범위 문제일 수 있음
    if is_cant_find:
        search_keywords = plan.get("search_keywords", [])
        retry_query = " ".join(search_keywords) if search_keywords else query
        return {
            "is_sufficient": False,
            "confidence": "none",
            "missing_info": "답변에 '찾을 수 없습니다' 포함 - 재검색 필요",
            "retry_query": retry_query,
            "retry_systems": plan.get("key_systems", []),
            "_tokens": 0,
            "_api_seconds": 0,
        }

    # FAIL_PATTERNS에 해당 없으면, 의도적 거부 패턴 체크 (트랩 질문 대응)
    INTENTIONAL_REFUSAL_PATTERNS = [
        "기획서에 정의되어 있지 않습니다",
        "기획서에 명시되어 있지 않습니다",
        "기획서에 해당 정보가 없습니다",
        "기획서에 해당 기능에 대한 정의가 없습니다",
        "기획서에 해당 수치가 정의되어 있지 않습니다",
        "기획서에 해당 획득 경로가 정의되어 있지 않습니다",
        "명시적 처리 규칙이 없습니다",
    ]
    is_intentional_refusal = any(p in answer for p in INTENTIONAL_REFUSAL_PATTERNS)

    if is_intentional_refusal:
        return {
            "is_sufficient": True,
            "confidence": "medium",
            "missing_info": "",
            "retry_query": "",
            "retry_systems": [],
            "_tokens": 0,
            "_api_seconds": 0,
        }

    # 검색 컨텍스트 구성 (Reflection에 전달하여 스마트 재검색 유도)
    chunk_summary = ", ".join(
        f"{c.get('workbook', '?')}/{c.get('sheet', '?')}" for c in chunks[:5]
    )
    search_context = f"검색된 출처: {chunk_summary}"
    search_context += f"\nPlanning이 지목한 시스템: {plan.get('key_systems', [])}"
    search_context += f"\n사용된 검색 키워드: {plan.get('search_keywords', [])}"
    search_context += f"\n질문 유형: {plan.get('query_type', '?')}"

    user_msg = f"""## 원래 질문
{query}

## 시스템 답변
{answer}

## 검색 컨텍스트
{search_context}

위 답변의 품질을 평가하세요. 부족하다면, 검색 컨텍스트를 참고하여 **다른 검색 전략**을 제안하세요."""

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=_resolve_prompt("reflection", prompt_overrides),
            model=model,
            max_tokens=256,
            temperature=0,
        )
        reflection_prompt_used = _resolve_prompt("reflection", prompt_overrides)
        reflection = _parse_plan_json(result["text"])  # 같은 파서 재사용
        reflection["_tokens"] = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        reflection["_api_seconds"] = result.get("api_seconds", 0)
        reflection["_raw_response"] = result["text"]
        reflection["_system_prompt"] = reflection_prompt_used
        reflection["_user_prompt"] = user_msg
        return reflection
    except Exception as e:
        return {
            "is_sufficient": True,  # 실패 시 보수적으로 통과
            "confidence": "medium",
            "missing_info": "",
            "retry_query": "",
            "retry_systems": [],
            "_tokens": 0,
            "_api_seconds": 0,
        }


def execute_retry_search(reflection: dict, query: str, existing_chunks: list[dict]) -> list[dict]:
    """Reflection 결과에 따라 재검색 실행."""
    retry_query = reflection.get("retry_query", query)
    retry_systems = reflection.get("retry_systems", [])

    existing_ids = {c["id"] for c in existing_chunks}
    new_chunks = []

    # 1. 재검색 쿼리로 retrieve
    chunks, _ = retrieve(retry_query, top_k=15)
    for c in chunks:
        if c["id"] not in existing_ids:
            c["source"] = "retry_retrieve"
            new_chunks.append(c)
            existing_ids.add(c["id"])

    # 2. 지정된 시스템 직접 검색
    aliases = _build_system_aliases()
    for sys_name in retry_systems[:3]:
        wb_matches = aliases.get(sys_name.lower(), [])
        if not wb_matches:
            wb_matches = aliases.get(f"pk_{sys_name.lower()}", [])
        if not wb_matches:
            # 부분 매칭
            for alias_key, alias_wbs in aliases.items():
                if sys_name.lower() in alias_key.lower():
                    wb_matches = alias_wbs
                    break
        for wb in wb_matches[:2]:
            chunks = _structural_search(wb, retry_query)
            for c in chunks[:5]:
                if c["id"] not in existing_ids:
                    c["source"] = "retry_structural"
                    c["score"] = max(c.get("score", 0), 0.8)
                    new_chunks.append(c)
                    existing_ids.add(c["id"])

    return new_chunks


# ══════════════════════════════════════════════════════════
#  Proposal — 기획서 수정/생성 제안
# ══════════════════════════════════════════════════════════

PROPOSAL_PROMPT = """당신은 모바일 MMORPG "Project K"의 수석 기획자입니다.
사용자와의 대화 내용을 바탕으로, 기존 기획서의 수정안 또는 신규 기획서를 제안합니다.

## 규칙
1. **기존 기획서 수정(modify) 제안을 최우선으로 작성** — 아래 기존 기획서에서 변경해야 할 부분을 찾아 before/after를 반드시 제시
2. "변경 전(before)" 내용은 반드시 아래 기존 기획서에서 **직접 인용** (Markdown 테이블, 목록 등 원본 양식 그대로 복사)
3. "변경 후(after)" 내용은 기존 양식을 유지하면서 **구체적 수치와 함께** 수정 (예: 경험치 1/10, 레벨 조건 변경 등)
4. **신규 기획서(create)는 반드시 Confluence 페이지로 생성** — 기획팀 정책상 신규 문서는 Confluence가 기본. workbook 필드에 "Confluence/Design/적절한 카테고리" 경로를 지정
5. 각 제안의 이유를 **대화에서 논의한 내용**과 명확히 연결
6. 제안은 구체적이고 실행 가능해야 함 — 모호한 "검토 필요" 수준이 아닌 **실제 수치와 테이블 포함**
7. 관련 시스템에 미치는 사이드이펙트를 명시
8. **테이블은 반드시 GFM Markdown 테이블 형식 사용** — `| 헤더1 | 헤더2 |` + `|---|---|` + `| 값1 | 값2 |` 형태. ASCII 박스(`+---+`, `|   |`)는 사용하지 마세요

{quality_criteria_section}

## 출력 형식 (JSON만 출력)
먼저 ```json 블록 안에 제안을 출력하고, 그 아래에 요약 설명을 작성하세요.
```json
{
  "summary": "전체 제안 요약 (1~2문장)",
  "proposals": [
    {
      "type": "modify",
      "workbook": "대상 워크북명",
      "sheet": "대상 시트명",
      "section": "대상 섹션명 (있으면)",
      "reason": "변경 이유 (대화 맥락 참조)",
      "before": "기존 내용 (원문 그대로 인용, Markdown 유지)",
      "after": "변경 후 내용 (Markdown 유지)",
      "diff_summary": "변경 핵심 요약 1줄"
    },
    {
      "type": "create",
      "workbook": "소속 워크북명 (기존 워크북에 추가하거나 신규)",
      "sheet": "(신규) 시트/문서명",
      "reason": "생성 이유 (대화 맥락 참조)",
      "content": "전체 내용 (Markdown, 테이블/목록 포함)",
      "diff_summary": "신규 문서 핵심 요약 1줄"
    }
  ]
}
```

## 요약 설명
JSON 아래에 다음 내용을 Markdown으로 작성:
1. 전체 제안 개요
2. 각 제안의 핵심 변경 사항
3. 사이드이펙트 또는 추가 검토 필요 사항
"""


def generate_document_proposal(
    query: str,
    chunks: list[dict],
    conversation_history: list[tuple[str, str]],
    plan: dict,
    model: str = "claude-opus-4-6",
    status_callback=None,
    prompt_overrides: dict[str, str] | None = None,
) -> dict:
    """대화 맥락 기반 기획서 수정/생성 제안 생성.

    Returns:
        {
            "answer": str (Markdown 요약),
            "proposals": list[dict],
            "tokens": int,
            "input_tokens": int,
            "output_tokens": int,
        }
    """
    # 1. 대상 문서 전체 로드
    if status_callback:
        status_callback("📑 대상 기획서 전문을 로드하고 있습니다...")

    full_sheet_chunks = _load_full_sheets(chunks, max_context_tokens=80000)

    # 시트별로 그룹핑 (_load_full_sheets는 flat list 반환)
    from collections import OrderedDict
    sheet_groups = OrderedDict()
    for c in full_sheet_chunks:
        key = (c.get("workbook", ""), c.get("sheet", ""))
        if key not in sheet_groups:
            sheet_groups[key] = []
        sheet_groups[key].append(c)

    # 시트별 컨텍스트 구성
    context_parts = []
    for (wb, sh), group_chunks in sheet_groups.items():
        text = "\n".join(c.get("text", "") for c in group_chunks)
        context_parts.append(f"### {wb} / {sh}\n{text}")

    doc_context = "\n\n---\n\n".join(context_parts)
    if len(doc_context) > 120000:
        doc_context = doc_context[:120000] + "\n...(truncated)"

    # 2. 대화 이력 구성
    history_text = ""
    if conversation_history:
        turns = []
        for q, a in conversation_history:
            turns.append(f"**질문**: {q}\n**답변**: {a}")
        history_text = "\n\n---\n\n".join(turns)

    # 3. 프롬프트 구성
    user_msg = f"""## 대화 맥락
{history_text}

## 현재 요청
{query}

## 참조할 기존 기획서
{doc_context}"""

    if status_callback:
        status_callback("📝 기획서 수정/생성 제안을 작성하고 있습니다...")

    # 4. 품질 기준 동적 로드 → 프롬프트에 삽입
    criteria_section = ""
    criteria_file = Path(__file__).resolve().parent.parent / "data" / "quality_criteria.json"
    if criteria_file.exists():
        try:
            criteria_data = json.loads(criteria_file.read_text(encoding="utf-8"))
            items = criteria_data.get("criteria", [])
            if items:
                lines = ["## 기획서 품질 기준 (필수 준수)", "좋은 기획서의 필수 요소 — 신규 기획서(create)는 아래 항목을 최대한 포함해야 합니다:", ""]
                for i, c in enumerate(items, 1):
                    lines.append(f"{i}. **{c['title']}**: {c['description']}")
                # 참고 문서 구조
                ref_docs = criteria_data.get("reference_docs", [])
                if ref_docs:
                    lines.append("")
                    lines.append(f"참고 문서: {ref_docs[0]['title']} — {ref_docs[0].get('note', '')}")
                criteria_section = "\n".join(lines)
        except Exception as e:
            log.warning(f"품질 기준 로드 실패: {e}")

    proposal_base = _resolve_prompt("proposal", prompt_overrides)
    system_prompt = proposal_base.replace("{quality_criteria_section}", criteria_section)

    # 5. LLM 호출 (큰 max_tokens — 제안은 길 수 있음)
    result = call_bedrock(
        messages=[{"role": "user", "content": [{"type": "text", "text": user_msg}]}],
        system=system_prompt,
        model=model,
        max_tokens=16384,
        temperature=0,
    )

    raw_text = result["text"]

    # 5. JSON 파싱 (코드 펜스 / raw JSON 모두 처리)
    proposals = []
    summary = ""
    answer_text = raw_text  # fallback

    import re as _re

    parsed = None
    json_start = 0
    json_end = len(raw_text)

    # 시도 1: ```json ... ``` 코드 펜스
    fence_match = _re.search(r"```json\s*(.*?)\s*```", raw_text, _re.DOTALL)
    if fence_match:
        try:
            parsed = json.loads(fence_match.group(1))
            json_start = fence_match.start()
            json_end = fence_match.end()
        except json.JSONDecodeError:
            pass

    # 시도 2: raw JSON — { 로 시작하는 위치에서 raw_decode 시도
    if not parsed:
        decoder = json.JSONDecoder()
        for i, ch in enumerate(raw_text):
            if ch == '{':
                try:
                    parsed, end_idx = decoder.raw_decode(raw_text, i)
                    if isinstance(parsed, dict) and ("proposals" in parsed or "summary" in parsed):
                        json_start = i
                        json_end = i + end_idx
                        break
                    else:
                        parsed = None  # proposals/summary 없으면 다음 { 시도
                except json.JSONDecodeError:
                    continue

    if parsed:
        proposals = parsed.get("proposals", [])
        summary = parsed.get("summary", "")
        before_json = raw_text[:json_start].strip()
        after_json = raw_text[json_end:].strip()
        # 코드 펜스 잔여물 제거 (```json, ```, --- 등)
        before_json = _re.sub(r'```\w*\s*$', '', before_json).strip()
        after_json = _re.sub(r'^```\s*', '', after_json).strip()
        after_json = _re.sub(r'^---\s*', '', after_json).strip()
        remaining = (before_json + "\n\n" + after_json).strip()
        if remaining:
            answer_text = remaining
        elif summary:
            answer_text = f"## 기획서 제안 요약\n\n{summary}"
        log.info(f"PROPOSAL: JSON 파싱 성공 (start={json_start}, end={json_end})")
    else:
        log.warning("PROPOSAL: JSON 파싱 실패, 전체 텍스트를 answer로 사용")

    log.info(f"PROPOSAL: {len(proposals)}건 제안 생성 ({result['input_tokens']}+{result['output_tokens']} tokens)")

    return {
        "answer": answer_text,
        "proposals": proposals,
        "summary": summary,
        "tokens": result["input_tokens"] + result["output_tokens"],
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "api_seconds": result["api_seconds"],
        "_system_prompt": PROPOSAL_PROMPT[:200],
        "_user_prompt": user_msg[:500],
    }


# ══════════════════════════════════════════════════════════
#  Agent 메인 엔트리포인트
# ══════════════════════════════════════════════════════════

def agent_answer(query: str, role: str = None,
                 conversation_history: list[tuple[str, str]] = None,
                 model: str = "claude-opus-4-6",
                 prompt_style: str = "검증세트 최적화",
                 status_callback=None,
                 prompt_overrides: dict[str, str] | None = None) -> dict:
    """Agent QnA 파이프라인.

    Args:
        query: 사용자 질문
        role: 질문자 역할
        conversation_history: [(question, answer), ...] 이전 대화 (최근 3턴)
        model: 답변 생성 모델 (claude-opus-4-6, claude-opus-4-6 등)
        prompt_style: "검증세트 최적화" (3단 구조) 또는 "기본" (최소 프롬프트)

    Returns:
        {
            "answer": str,
            "chunks": list[dict],
            "trace": list[dict],   # 디버깅용 전체 수행 이력
            "confidence": str,
            "total_tokens": int,
            "total_api_seconds": float,
        }
    """
    trace = []
    total_tokens = 0
    t0 = time.time()

    log.debug(f"AGENT_START query='{query[:60]}' role={role}")

    # ── Step 1: Planning ──
    if status_callback: status_callback("🧠 질문을 분석하고 있습니다... (Step 1/4: Planning)")
    t_plan = time.time()
    plan = plan_search(query, role, conversation_history=conversation_history,
                       prompt_overrides=prompt_overrides)
    plan_time = time.time() - t_plan
    total_tokens += plan.get("_tokens", 0)
    log.debug(f"  PLANNING: key_systems={plan.get('key_systems',[])} "
              f"type={plan.get('query_type','?')} time={plan_time:.1f}s")

    trace.append({
        "step": "planning",
        "model": "claude-opus-4-6",
        "description": "Opus가 질문을 분석하여 어떤 기획서(워크북)를 참고할지 결정 (KG 관계 활용)",
        "input": {"query": query, "role": role, "workbook_count": len(_build_structural_index())},
        "output": {
            "key_systems": plan.get("key_systems", []),
            "query_type": plan.get("query_type", "?"),
            "search_keywords": plan.get("search_keywords", []),
            "search_plan": plan.get("search_plan", []),
            "reasoning": plan.get("reasoning", ""),
        },
        "llm_raw_response": plan.get("_raw_response", ""),
        "system_prompt": plan.get("_system_prompt", ""),
        "user_prompt": plan.get("_user_prompt", ""),
        "tokens": plan.get("_tokens", 0),
        "seconds": round(plan_time, 1),
    })

    # ── Step 2: Tool Use (Search) ──
    key_sys_str = ', '.join(plan.get('key_systems', [])[:3]) or '전체'
    if status_callback: status_callback(f"🔎 기획서에서 검색 중... (Step 2/4: Search — {key_sys_str})")
    t_search = time.time()
    chunks = execute_search(plan, query)
    search_time = time.time() - t_search

    # 검색 결과 요약
    source_dist = {}
    for c in chunks:
        src = c.get("source", "unknown")
        source_dist[src] = source_dist.get(src, 0) + 1

    workbooks_found = sorted(set(c.get("workbook", "?") for c in chunks))
    log.debug(f"  SEARCH: {len(chunks)} chunks from {workbooks_found[:3]} time={search_time:.1f}s")

    # 사용된 도구 목록 추출
    tools_used = ["retrieve(hybrid)"]  # 항상 실행
    for step in plan.get("search_plan", []):
        tool_name = step.get("tool", "retrieve")
        tool_args = step.get("args", {})
        if tool_name == "section_search":
            tools_used.append(f"section_search(workbook={tool_args.get('workbook', '?')})")
        elif tool_name == "kg_related":
            tools_used.append(f"kg_related(system={tool_args.get('system', '?')})")
        elif tool_name == "retrieve" and tool_args.get("query", "") != query:
            tools_used.append(f"retrieve(query='{tool_args.get('query', '')[:30]}')")
    if plan.get("key_systems"):
        tools_used.append(f"key_systems_search({plan['key_systems']})")

    trace.append({
        "step": "search",
        "model": None,  # 검색은 LLM 사용 안 함
        "description": "Planning이 지목한 워크북에서 관련 청크를 검색",
        "tools_used": tools_used,
        "chunks_count": len(chunks),
        "workbooks_found": workbooks_found,
        "source_distribution": source_dist,
        "all_chunks": [
            {
                "rank": idx + 1,
                "workbook": c.get("workbook", "?"),
                "sheet": c.get("sheet", "?"),
                "section_path": c.get("section_path", ""),
                "score": round(c.get("score", 0), 4),
                "source": c.get("source", "?"),
                "tokens": c.get("tokens", 0),
                "has_mermaid": c.get("has_mermaid", False),
                "has_table": c.get("has_table", False),
                "has_images": c.get("has_images", False),
                "source_url": c.get("source_url", ""),
                "text_preview": c.get("text", "")[:150],
            }
            for idx, c in enumerate(chunks)
        ],
        "seconds": round(search_time, 1),
    })

    # ── Proposal 분기: query_type이 proposal이면 별도 파이프라인 ──
    if plan.get("query_type") == "proposal":
        t_prop = time.time()
        prop_result = generate_document_proposal(
            query, chunks, conversation_history or [],
            plan, model=model, status_callback=status_callback,
            prompt_overrides=prompt_overrides,
        )
        prop_time = time.time() - t_prop
        total_tokens += prop_result.get("tokens", 0)

        trace.append({
            "step": "proposal_generation",
            "model": model,
            "description": "대화 맥락 기반 기획서 수정/생성 제안",
            "proposal_count": len(prop_result.get("proposals", [])),
            "tokens": prop_result.get("tokens", 0),
            "seconds": round(prop_time, 1),
        })

        total_time = time.time() - t0
        result = {
            "answer": prop_result["answer"],
            "mode": "proposal",
            "proposals": prop_result.get("proposals", []),
            "chunks": chunks,
            "trace": trace,
            "confidence": "high",
            "total_tokens": total_tokens,
            "total_api_seconds": round(total_time, 1),
        }
        if prompt_overrides:
            result["prompt_overrides_used"] = {k: v for k, v in prompt_overrides.items() if k in DEFAULT_PROMPTS}
        return result

    # ── Step 3: Answer Generation ──
    elapsed = int(time.time() - t0)
    wb_list = ', '.join(workbooks_found[:3])
    if status_callback: status_callback(f"✍️ 답변 생성 중... (Step 3/4: {len(chunks)}개 청크, {wb_list} — {elapsed}초 경과)")
    t_gen = time.time()
    key_systems = plan.get("key_systems", [])
    gen_result = generate_agent_answer(query, chunks, role, key_systems=key_systems,
                                       model=model, conversation_history=conversation_history,
                                       prompt_style=prompt_style,
                                       prompt_overrides=prompt_overrides)
    gen_time = time.time() - t_gen
    total_tokens += gen_result.get("tokens", 0)

    answer = gen_result["answer"]
    log.debug(f"  ANSWER: {len(answer)} chars, {gen_result.get('tokens',0)} tokens, time={gen_time:.1f}s")

    trace.append({
        "step": "answer_generation",
        "model": model,
        "description": f"{model}이 답변 생성 (prompt_style={prompt_style})",
        "input": {
            "chunks_count": min(10, len(chunks)),
            "key_systems_priority": key_systems,
            "role": role,
            "detail_level": gen_result.get("_detail_level", "보통"),
            "prompt_style": gen_result.get("_prompt_style", "검증세트 최적화"),
            "max_tokens": gen_result.get("_max_tokens", 2048),
        },
        "answer_preview": answer[:200] + "..." if len(answer) > 200 else answer,
        "tokens": gen_result.get("tokens", 0),
        "input_tokens": gen_result.get("input_tokens", 0),
        "output_tokens": gen_result.get("output_tokens", 0),
        "system_prompt": gen_result.get("_system_prompt", ""),
        "user_prompt": gen_result.get("_user_prompt", ""),
        "seconds": round(gen_time, 1),
    })

    # ── Step 4: Reflection ──
    elapsed = int(time.time() - t0)
    if status_callback: status_callback(f"🔍 답변 품질 검증 중... (Step 4/4: Reflection — {elapsed}초 경과)")
    t_ref = time.time()
    reflection = reflect_on_answer(query, answer, chunks, plan,
                                   prompt_overrides=prompt_overrides)
    ref_time = time.time() - t_ref
    total_tokens += reflection.get("_tokens", 0)

    trace.append({
        "step": "reflection",
        "model": "claude-opus-4-6",
        "description": "Opus가 생성된 답변의 품질을 자체 검증",
        "output": {
            "is_sufficient": reflection.get("is_sufficient", True),
            "confidence": reflection.get("confidence", "medium"),
            "missing_info": reflection.get("missing_info", ""),
            "retry_query": reflection.get("retry_query", ""),
            "retry_systems": reflection.get("retry_systems", []),
        },
        "tokens": reflection.get("_tokens", 0),
        "raw_response": reflection.get("_raw_response", ""),
        "system_prompt": reflection.get("_system_prompt", ""),
        "user_prompt": reflection.get("_user_prompt", ""),
        "seconds": round(ref_time, 1),
    })

    log.debug(f"  REFLECTION: sufficient={reflection.get('is_sufficient',True)} "
              f"confidence={reflection.get('confidence','?')}")

    # ── Step 4b: Retry if needed ──
    if not reflection.get("is_sufficient", True):
        elapsed = int(time.time() - t0)
        missing = reflection.get("missing_info", "")[:50]
        if status_callback: status_callback(f"🔄 보충 검색 + 재답변 중... (Retry: {missing} — {elapsed}초 경과)")
        t_retry = time.time()

        # 재검색
        extra_chunks = execute_retry_search(reflection, query, chunks)
        if extra_chunks:
            # 기존 + 신규 청크 병합, 스코어 순 정렬
            merged = {c["id"]: c for c in chunks}
            for c in extra_chunks:
                if c["id"] not in merged:
                    merged[c["id"]] = c
            chunks = sorted(merged.values(), key=lambda x: x.get("score", 0), reverse=True)[:20]

        # 재답변 (더 적극적으로)
        gen_result2 = generate_agent_answer(query, chunks, role, key_systems=key_systems,
                                            model=model, conversation_history=conversation_history,
                                            prompt_style=prompt_style,
                                            prompt_overrides=prompt_overrides)
        retry_time = time.time() - t_retry
        total_tokens += gen_result2.get("tokens", 0)

        # 재답변은 항상 채택 (기존 답변이 "찾을 수 없습니다"였으므로)
        retry_answer = gen_result2["answer"]
        answer = retry_answer
        log.debug(f"  RETRY: +{len(extra_chunks)} chunks, new answer={len(retry_answer)} chars")

        trace.append({
            "step": "retry",
            "model": "claude-opus-4-6",
            "description": "Reflection에서 부족하다고 판단 -> 재검색 + 재답변",
            "tools_used": ["retrieve(retry)", f"key_systems_search({key_systems})"],
            "extra_chunks": len(extra_chunks),
            "answer_preview": retry_answer[:200] + "..." if len(retry_answer) > 200 else retry_answer,
            "adopted": answer == retry_answer,
            "tokens": gen_result2.get("tokens", 0),
            "seconds": round(retry_time, 1),
        })

    total_time = time.time() - t0

    result = {
        "answer": answer,
        "chunks": chunks,
        "trace": trace,
        "confidence": reflection.get("confidence", "medium"),
        "total_tokens": total_tokens,
        "total_api_seconds": round(total_time, 1),
    }
    if prompt_overrides:
        result["prompt_overrides_used"] = {k: v for k, v in prompt_overrides.items() if k in DEFAULT_PROMPTS}
    return result


# ══════════════════════════════════════════════════════════
#  Deep Research — 전체 자료 종합 분석
# ══════════════════════════════════════════════════════════

def scan_all_related_chunks(query: str, plan: dict) -> dict:
    """질문과 관련된 전체 청크를 인덱스에서 스캔.

    매칭 전략 (3단계):
    1. key_systems 워크북 → 무조건 포함 (Planning이 지정한 핵심 문서)
    2. 메타데이터(워크북/시트/섹션명)에 키워드 포함 → 포함
    3. 벡터 검색으로 관련 워크북 추가 발견 → 해당 워크북 전체 청크 포함
    ※ 워크북 수 제한 없음 — Haiku Map-Reduce로 효율적 처리

    Returns:
        {
            "total_chunks": int,
            "workbook_groups": {workbook: [chunk, ...], ...},
            "workbook_summary": {workbook: int, ...},
        }
    """
    collection = _get_collection()
    result = collection.get(include=["metadatas", "documents"])
    all_meta = result["metadatas"]
    all_docs = result["documents"]
    all_ids = result["ids"]

    # Planning에서 추출한 키워드로 관련 청크 필터링
    keywords = plan.get("search_keywords", [])
    key_systems = plan.get("key_systems", [])

    # 키워드 정규화 (소문자)
    kw_lower = [kw.lower() for kw in keywords]
    # key_systems에서 워크북명 추출
    sys_names = [ks.lower() for ks in key_systems]

    # ── 3) 벡터 검색으로 관련 워크북 추가 발견 ──
    # 이름에 키워드가 없어도 내용적으로 관련된 워크북을 찾음
    vector_workbooks: set[str] = set()
    try:
        vec_result = collection.query(
            query_texts=[query],
            n_results=50,
            include=["metadatas"],
        )
        if vec_result and vec_result["metadatas"]:
            for meta in vec_result["metadatas"][0]:
                wb = meta.get("workbook", "")
                if wb:
                    vector_workbooks.add(wb)
    except Exception:
        pass  # 벡터 검색 실패 시 기존 로직만 사용

    groups: dict[str, list[dict]] = {}
    # 워크북별 매칭 소스 추적
    wb_match_source: dict[str, str] = {}  # workbook → "key_systems" | "keyword" | "vector"

    for i, meta in enumerate(all_meta):
        wb = meta.get("workbook", "")
        sh = meta.get("sheet", "")
        sec = meta.get("section_path", "")
        doc = all_docs[i] if i < len(all_docs) else ""
        wb_lower = wb.lower()

        # 1) key_systems 워크북에 속하는 청크 → 무조건 포함
        matched = any(sn in wb_lower for sn in sys_names)
        if matched and wb not in wb_match_source:
            wb_match_source[wb] = "key_systems"

        # 2) 메타데이터(워크북/시트/섹션명)에 키워드 매칭
        if not matched:
            meta_searchable = f"{wb} {sh} {sec}".lower()
            matched = any(kw in meta_searchable for kw in kw_lower)
            if matched and wb not in wb_match_source:
                wb_match_source[wb] = "keyword"

        # 3) 벡터 검색에서 발견된 워크북 → 해당 워크북 전체 청크 포함
        if not matched and wb in vector_workbooks:
            matched = True
            if wb not in wb_match_source:
                wb_match_source[wb] = "vector"

        if matched:
            chunk = {
                "id": all_ids[i],
                "workbook": wb,
                "sheet": sh,
                "section_path": sec,
                "text": doc,
                "tokens": meta.get("tokens", 0),
                "source_url": meta.get("source_url", ""),
            }
            groups.setdefault(wb, []).append(chunk)

    summary = {wb: len(chunks) for wb, chunks in groups.items()}

    # 매칭 소스별 통계
    source_stats = {"key_systems": [], "keyword": [], "vector": []}
    for wb, src in wb_match_source.items():
        source_stats[src].append(wb)

    return {
        "total_chunks": sum(summary.values()),
        "workbook_groups": groups,
        "workbook_summary": summary,
        "match_sources": wb_match_source,
        "source_stats": source_stats,
        "vector_top_chunks": len(vector_workbooks),
    }


_SCRATCHPAD_ANALYZE_PROMPT = """당신은 게임 기획 문서 분석 전문가입니다.

## 임무
"{query}"에 대해 "{workbook}" 워크북의 기획 내용을 분석하세요.

{scratchpad_section}

## 분석 규칙
- 이 워크북에서 질문과 관련된 **모든 정보**를 추출하세요
- 구체적인 수치, 규칙, 조건, 테이블은 **반드시 포함**
- 시스템 흐름, 획득 경로, UI 구성 등 구조적 정보 포함
- 이전 메모에서 발견된 정보와 **연결되는 부분**을 명시하세요
  (예: "→ [변신 시스템]의 레벨 30 해금 조건과 연결")
- 이전 메모와 완전히 중복되는 내용은 "기존 메모 참조"로 대체
- **새롭게 발견한 정보**에 집중하세요
- Markdown 형식, 2000자 이내"""


def _analyze_workbook_with_scratchpad(query: str, workbook: str,
                                      chunks: list[dict], scratchpad: str) -> dict:
    """하나의 워크북을 스크래치패드 컨텍스트와 함께 분석.

    이전 워크북 분석 결과(scratchpad)를 참조하여 교차 분석이 가능.
    """
    t0 = time.time()

    # 청크를 시트별로 정렬하여 컨텍스트 구성
    chunks_sorted = sorted(chunks, key=lambda c: (c.get("sheet", ""), c.get("section_path", "")))
    context_parts = []
    for c in chunks_sorted:
        sh = c.get("sheet", "?")
        sec = c.get("section_path", "")
        text = c.get("text", "")[:4000]
        context_parts.append(f"[{sh} / {sec}]\n{text}")

    context = "\n\n---\n\n".join(context_parts)
    if len(context) > 60000:
        context = context[:60000] + "\n\n... (이하 생략)"

    # 스크래치패드 섹션 구성
    if scratchpad.strip():
        scratchpad_section = (
            "## 이전 문서에서 발견한 내용 (스크래치패드)\n"
            "아래는 이전 문서들에서 발견한 내용입니다. "
            "이 내용과 연결되는 정보가 있다면 반드시 명시해주세요.\n\n"
            f"{scratchpad}"
        )
    else:
        scratchpad_section = (
            "## 이전 발견 사항\n"
            "(첫 번째 문서입니다. 질문과 관련된 모든 발견을 기록하세요.)"
        )

    system_prompt = _SCRATCHPAD_ANALYZE_PROMPT.format(
        query=query, workbook=workbook, scratchpad_section=scratchpad_section,
    )

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": context}],
            system=system_prompt,
            model="claude-opus-4-6",
            max_tokens=4096,
            temperature=0,
        )
        return {
            "workbook": workbook,
            "summary": result["text"],
            "chunks_count": len(chunks),
            "tokens": result.get("input_tokens", 0) + result.get("output_tokens", 0),
            "seconds": round(time.time() - t0, 1),
            "status": "ok",
        }
    except Exception as e:
        return {
            "workbook": workbook,
            "summary": f"(분석 실패: {e})",
            "chunks_count": len(chunks),
            "tokens": 0,
            "seconds": round(time.time() - t0, 1),
            "status": "error",
        }


_SYNTHESIS_PROMPT = """당신은 모바일 MMORPG "Project K"의 수석 기획 전문가입니다.
아래는 여러 기획 문서에서 추출한 "{query}" 관련 정보입니다.
이 정보를 종합하여 질문에 대한 **체계적이고 완전한 답변**을 작성하세요.

## 답변 구조 (이 순서를 따르세요)

1. **핵심 정의** — 시스템/기능을 1~2문장으로 요약
2. **구성 요소** — 주요 구성을 계층적으로 정리 (상위 개념 → 하위 요소)
3. **동작 메커니즘** — 작동 방식, 조건, 시퀀스를 구체적으로 서술. 필요 시 단계별 플로우로 표현
4. **핵심 데이터** — 수치, 조건표, 공식, 밸런스 테이블 등을 Markdown 테이블로 정리. 원본의 구체적 수치를 빠짐없이 포함
5. **관련 시스템** — 다른 시스템과의 연결점, 상호작용, 교차 참조를 명시
6. **UI/UX** — 관련 UI 동작, 표시 규칙, 사용자 경험 포인트 (있으면)
7. **미정의/참고** — 기획서에 아직 정의되지 않은 부분, 추후 결정 사항

## 작성 규칙
- 모든 문서의 정보를 **빠짐없이** 종합 — 정보 누락은 최악의 실수
- 수치, 조건, 테이블 등 구체적 데이터는 원본 그대로 인용
- Markdown 적극 활용: 헤더(##), 테이블(|), 리스트(-), 볼드(**) 로 가독성 확보
- 여러 시스템이 관련되면 시스템별로 분리 정리 후 관계를 분석
- 기획서에 없는 수치/데이터를 만들어내지 마세요
- 참조한 워크북/시트 목록을 마지막에 `[출처: ...]` 형식으로 정리"""


_BASIC_SYNTHESIS_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가입니다.
아래 기획 문서를 읽고 "{query}"에 대해 체계적으로 답변하세요.

## 답변 원칙
- 관련 정보를 **빠짐없이** 포함
- 구조화된 Markdown 형식 (헤더, 테이블, 리스트 적극 활용)
- 출처(워크북/시트)를 답변 내에 명시
- 시스템 개요 → 핵심 메커니즘 → 세부 규칙 → 관련 시스템 순으로 서술
- 수치, 조건, 규칙 등 구체적 데이터는 반드시 포함
- 기획서에 없는 내용은 만들어내지 마세요"""

# ── 모듈 내 모든 프롬프트 상수 정의 완료 → 레지스트리 초기화 ──
_init_default_prompts()


def _estimate_scan_tokens(scan_result: dict) -> int:
    """scan 결과의 전체 토큰 수 추정."""
    total = 0
    for wb, chunks in scan_result["workbook_groups"].items():
        for c in chunks:
            total += c.get("tokens", int(len(c.get("text", "")) * 0.5))
    return total


# 토큰 버짓: 검색된 청크의 토큰 합이 이 값을 초과하면 딥 리서치로 자동 전환
# 이유: 청크 68K → _load_full_sheets()로 전체 시트 로드 시 ~219K (증폭 ~3x)
#       → Sonnet 200K 한계 초과. 50K 이하면 전체 시트 로드해도 ~150K로 안전.
TOKEN_BUDGET = 50000

# Sonnet 200K 컨텍스트에서 문서 할당 한계
# 200K - 시스템프롬프트(5K) - 출력(16K) - 여유(3K) ≈ 175K → 안전하게 160K
_DIRECT_CONTEXT_LIMIT = 160000


def deep_research(query: str, plan: dict, scan_result: dict,
                  progress_callback=None,
                  model: str = "claude-opus-4-6",
                  prompt_style: str = "검증세트 최적화",
                  prompt_overrides: dict[str, str] | None = None) -> dict:
    """딥 리서치 파이프라인.

    전략 자동 선택:
    - 전체 토큰 ≤ 160K → 시트 원본을 Sonnet에 직접 전달 (품질 최고)
    - 전체 토큰 > 160K → Scratchpad Loop (순차 Haiku 분석 + 누적 메모 → Sonnet 종합)
      각 워크북을 순차적으로 분석하면서 이전 발견 내용을 스크래치패드에 누적.
      3번째 워크북 분석 시 1~2번 결과를 알고 있으므로 교차 참조가 자연스럽게 수행됨.

    Args:
        query: 사용자 질문
        plan: Planning 결과
        scan_result: scan_all_related_chunks()의 결과
        progress_callback: fn(step_name, detail) — 진행 상황 콜백 (Streamlit용)
        model: 답변 생성 모델
        prompt_style: "검증세트 최적화" 또는 "기본"
    """
    trace = []
    total_tokens = 0
    t0 = time.time()

    groups = scan_result["workbook_groups"]
    sorted_wbs = sorted(groups.keys(), key=lambda wb: len(groups[wb]), reverse=True)

    # ── 전략 결정: 직접 로드 vs Scratchpad Loop ──
    estimated_tokens = _estimate_scan_tokens(scan_result)
    use_direct = estimated_tokens <= _DIRECT_CONTEXT_LIMIT

    if use_direct:
        # ════════════════════════════════════════
        #  전략 A: 시트 원본 직접 Sonnet에 전달
        # ════════════════════════════════════════
        if progress_callback:
            progress_callback("direct_load", f"{len(sorted_wbs)}개 문서 원본 직접 분석 (~{estimated_tokens:,} 토큰)")

        # 워크북별 → 시트별로 원본 청크를 조합
        context_parts = []
        for wb in sorted_wbs:
            wb_chunks = sorted(groups[wb], key=lambda c: (c.get("sheet", ""), c.get("section_path", "")))
            # 시트별 그룹화
            sheet_sections = {}
            for c in wb_chunks:
                sh = c.get("sheet", "")
                sheet_sections.setdefault(sh, []).append(c)

            wb_parts = []
            for sh, s_chunks in sheet_sections.items():
                text_parts = []
                for c in s_chunks:
                    sec = c.get("section_path", "")
                    text = c.get("text", "")
                    if sec:
                        text_parts.append(f"### {sec}\n{text}")
                    else:
                        text_parts.append(text)
                wb_parts.append(f"### 📄 {sh}\n\n" + "\n\n".join(text_parts))

            context_parts.append(f"## 📁 {wb}\n\n" + "\n\n---\n\n".join(wb_parts))

        synthesis_context = "\n\n════════════════════\n\n".join(context_parts)

        trace.append({
            "step": "deep_research_direct_load",
            "description": f"{len(sorted_wbs)}개 워크북 시트 원본 직접 로드 ({estimated_tokens:,} 토큰, Haiku 요약 생략)",
            "workbooks": len(sorted_wbs),
            "chunks": scan_result["total_chunks"],
            "estimated_tokens": estimated_tokens,
            "seconds": round(time.time() - t0, 1),
        })

        # LLM에 직접 전달
        if progress_callback:
            progress_callback("synthesis", f"{model}이 {len(sorted_wbs)}개 문서 원본을 직접 분석 중...")

        t_synth = time.time()
        synth_key = "synthesis_basic" if prompt_style == "기본" else "synthesis"
        synth_base = _resolve_prompt(synth_key, prompt_overrides)
        system_prompt = synth_base.format(query=query)
        user_msg = f"## 질문\n{query}\n\n## 관련 문서 원본 ({len(sorted_wbs)}개 문서, {scan_result['total_chunks']}개 청크)\n\n{synthesis_context}"

        try:
            result = call_bedrock(
                messages=[{"role": "user", "content": user_msg}],
                system=system_prompt,
                model=model,
                max_tokens=16384,
                temperature=0,
            )
            answer = result["text"]
            synth_tokens = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        except Exception as e:
            answer = f"(종합 실패: {e})\n\n문서 원본:\n\n" + synthesis_context[:5000]
            synth_tokens = 0

        total_tokens += synth_tokens
        synth_time = time.time() - t_synth

        trace.append({
            "step": "deep_research_synthesis",
            "model": model,
            "description": f"{len(sorted_wbs)}개 문서 원본을 {model}이 직접 분석하여 답변 생성 (prompt_style={prompt_style})",
            "system_prompt": system_prompt,
            "user_prompt": user_msg[:3000] + "..." if len(user_msg) > 3000 else user_msg,
            "tokens": synth_tokens,
            "seconds": round(synth_time, 1),
        })

        # group_summaries는 빈 리스트 (직접 분석이므로 중간 요약 없음)
        group_results = [
            {"workbook": wb, "summary": "(직접 분석)", "chunks_count": len(groups[wb]),
             "tokens": 0, "seconds": 0, "status": "direct"}
            for wb in sorted_wbs
        ]

    else:
        # ════════════════════════════════════════
        #  전략 B: Scratchpad Loop (순차 분석 + 누적 메모)
        #  Gemini/Claude 연구 기능처럼 각 워크북을 순차적으로 분석하며
        #  이전 발견 내용을 스크래치패드에 누적 → 교차 참조 가능
        # ════════════════════════════════════════
        if progress_callback:
            progress_callback("scratchpad_start",
                              f"{len(sorted_wbs)}개 워크북 Scratchpad 순차 분석 시작 (~{estimated_tokens:,} 토큰)")

        group_results = []
        scratchpad = ""
        t_group = time.time()

        for idx, wb in enumerate(sorted_wbs):
            if progress_callback:
                progress_callback("scratchpad_step",
                                  f"[{idx + 1}/{len(sorted_wbs)}] {wb} 분석 중... ({len(groups[wb])}청크)")

            result = _analyze_workbook_with_scratchpad(query, wb, groups[wb], scratchpad)
            group_results.append(result)
            total_tokens += result.get("tokens", 0)

            # 스크래치패드에 이번 분석 결과 누적
            if result["status"] == "ok":
                scratchpad += f"\n\n### 📁 {wb} ({result['chunks_count']}청크)\n{result['summary']}"

            if progress_callback:
                progress_callback("scratchpad_done",
                                  f"[{idx + 1}/{len(sorted_wbs)}] {wb}: {result['chunks_count']}청크 → {result['status']}")

        group_time = time.time() - t_group

        trace.append({
            "step": "deep_research_scratchpad",
            "model": "claude-opus-4-6",
            "description": f"{len(sorted_wbs)}개 워크북을 Scratchpad Loop로 순차 분석 ({estimated_tokens:,} 토큰 > {_DIRECT_CONTEXT_LIMIT:,} 한계)",
            "groups": [
                {
                    "workbook": r["workbook"],
                    "chunks_count": r["chunks_count"],
                    "tokens": r["tokens"],
                    "seconds": r["seconds"],
                    "status": r["status"],
                    "summary_preview": r["summary"][:200],
                }
                for r in group_results
            ],
            "tokens": sum(r["tokens"] for r in group_results),
            "seconds": round(group_time, 1),
        })

        # Step 2: 스크래치패드 전체를 기반으로 최종 종합
        if progress_callback:
            progress_callback("synthesis", f"{model}이 스크래치패드 기반 최종 답변 생성 중...")

        t_synth = time.time()

        synth_key = "synthesis_basic" if prompt_style == "기본" else "synthesis"
        synth_base = _resolve_prompt(synth_key, prompt_overrides)
        system_prompt = synth_base.format(query=query)
        user_msg = (
            f"## 질문\n{query}\n\n"
            f"## 분석 노트 (Scratchpad) — {len(group_results)}개 문서 순차 분석 결과\n"
            f"아래는 각 문서를 순차적으로 분석하며 누적한 발견 내용입니다. "
            f"교차 참조와 연결 관계가 이미 식별되어 있습니다.\n"
            f"{scratchpad}"
        )

        try:
            result = call_bedrock(
                messages=[{"role": "user", "content": user_msg}],
                system=system_prompt,
                model=model,
                max_tokens=16384,
                temperature=0,
            )
            answer = result["text"]
            synth_tokens = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        except Exception as e:
            answer = f"(종합 실패: {e})\n\n스크래치패드:\n\n" + scratchpad
            synth_tokens = 0

        total_tokens += synth_tokens
        synth_time = time.time() - t_synth

        trace.append({
            "step": "deep_research_synthesis",
            "model": model,
            "description": f"Scratchpad ({len(group_results)}개 문서 분석 노트)를 {model}이 종합하여 최종 답변 생성",
            "system_prompt": system_prompt,
            "user_prompt": user_msg[:3000] + "..." if len(user_msg) > 3000 else user_msg,
            "tokens": synth_tokens,
            "seconds": round(synth_time, 1),
        })

    total_time = time.time() - t0

    all_source_chunks = []
    for wb in sorted_wbs:
        for c in groups[wb]:
            all_source_chunks.append(c)

    return {
        "answer": answer,
        "chunks": all_source_chunks,
        "group_summaries": group_results,
        "trace": trace,
        "confidence": "high",
        "total_tokens": total_tokens,
        "total_api_seconds": round(total_time, 1),
        "chunks_analyzed": scan_result["total_chunks"],
        "workbooks_analyzed": len(sorted_wbs),
        "strategy": "direct" if use_direct else "scratchpad",
        "estimated_context_tokens": estimated_tokens,
    }


# ══════════════════════════════════════════════════════════
#  기획서 리뷰 파이프라인
# ══════════════════════════════════════════════════════════

REVIEW_PLANNING_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획서 리뷰를 준비하는 분석가입니다.
아래에 리뷰 대상 기획 문서 전문이 제공됩니다. 이 문서를 리뷰하기 위해 **어떤 관련 기획서와 데이터시트를 참조해야 하는지** 분석하세요.

## 분석 항목

1. **이 문서가 다루는 핵심 시스템**: 문서의 주제가 되는 시스템명 (워크북 목록에서 매칭)
2. **교차 검증이 필요한 관련 시스템**: 이 문서에서 언급하거나 상호작용하는 다른 시스템 (예: 물약 → HUD, 인벤토리, PVP, 버프 등)
3. **ContentSetting/데이터 키**: 문서에서 참조하는 ContentSetting Enum, 테이블명, 데이터 키
4. **검색 키워드**: 관련 기획서를 찾기 위한 핵심 키워드

## 출력 형식 (JSON만 출력)
```json
{
  "primary_systems": ["이 문서의 핵심 시스템 워크북명"],
  "related_systems": ["교차 검증 대상 워크북명 (최대 8개)"],
  "data_keys": ["ContentSetting Enum 키", "테이블명"],
  "search_keywords": ["검색 키워드"],
  "reasoning": "1줄 판단 근거"
}
```"""

REVIEW_PROMPT = """당신은 모바일 MMORPG "Project K"의 수석 기획 리뷰어입니다.
아래에 **리뷰 대상 문서**와 **관련 기획서/데이터시트 참조 자료**가 제공됩니다.

## 리뷰 규칙

1. **관련 기획서 교차 검증**: 참조 자료에 있는 다른 기획서와 리뷰 대상 문서의 규칙/수치/용어가 일치하는지 확인. 불일치가 있으면 구체적으로 지적.
2. **데이터시트 교차 검증 (최우선 — 반드시 수행)**: 참조 자료에 `[GameData]`로 표시된 데이터시트 조회 결과가 있으면, **반드시 모든 행을 확인**하고 리뷰 대상 문서와 비교하세요.
   - 기획서에 "ItemId입력", "n% 이하값 입력" 등 **플레이스홀더**가 있는데 데이터시트에 **실제 값**이 있으면: "기획서에는 'ItemId입력'으로 되어 있지만, ContentSetting 실제 값은 1000001(소형 체력 포션)입니다. 기획서에 실제 값을 반영해야 합니다." 형식으로 지적.
   - 기획서의 수치와 데이터시트 수치가 **불일치**하면: "기획서에는 X로 적혀있지만 ContentSetting 실제 값은 Y입니다." 형식.
   - 데이터시트에 값이 있는데 리뷰에서 "[TODO]"로 처리하는 것은 **금지**. 실제 값을 반드시 인용하세요.
   - **GameData 값 인용 형식**: "ContentSetting 실제 데이터: HudHpPotion01=1000001(소형 체력 포션), HpPotionGlobalCoolTime=1000(=1초)" 처럼 **Enum명=값(설명)** 형식으로 구체적 수치를 본문에 포함하세요.
3. **관련 시스템 누락 감지**: 참조 자료에서 이 시스템과 연결된 다른 시스템이 보이면, 리뷰 대상 문서에서 해당 상호작용이 기술되어 있는지 확인.
4. **기획서에 값이 없고 데이터시트에도 없으면**: "[TODO: 값 정의 필요]"로 표기.

## 리뷰 관점 (perspective)

모든 issues/verifications 항목에 관점을 명시:
- **"기획팀장"**: 기획 의도, 시스템 설계, 콘텐츠 방향성, 다른 시스템과의 정합성
- **"프로그래머"**: 구현 가능성, 기술적 명세 부족, 서버/클라 처리, 데이터 타입/단위, 예외 처리

## 카테고리 규칙

- **"issues"**: 반드시 있어야 하는데 빠진 것. 구현자가 작업할 수 없는 수준의 누락. 다른 기획서와의 불일치도 포함.
- **"verifications"**: 적혀 있지만 확인 필요. 오타/오류 의심, 모호한 표현, 데이터시트와 수치 불일치 가능성.
- **"suggestions"**: 추가하면 문서 품질이 올라가는 것. 다른 기획서의 좋은 패턴 참조 제안 포함.

## 추가 섹션

- **"flow"**: 시스템의 전체 동작 로직을 텍스트 순서도로 정리. 조건 분기: "→ [조건] → 결과A / [아니면] → 결과B"
- **"qa_checklist"**: QA 테스트 케이스. 기본 흐름(Happy Path) 최우선, 이후 엣지/경계값.
- **"readability"**: 문서 가독성 평가. 논리 흐름, 계층 구조, 용어 일관성, 조건문 명확성, 독립성 평가.
- **"cross_refs"**: 이 문서와 관련된 다른 기획서/데이터시트 목록 (참조 자료에서 발견된 것).

## 출력 형식 (JSON만 출력)
```json
{
  "score": 0-100,
  "issues": [{"text": "...", "perspective": "기획팀장|프로그래머"}],
  "verifications": [{"text": "...", "perspective": "기획팀장|프로그래머"}],
  "suggestions": ["..."],
  "flow": "1. 사용자가 ... → 2. 시스템이 ... → ...",
  "qa_checklist": ["테스트 항목 1", "..."],
  "readability": {"score": 0-100, "issues": ["..."]},
  "cross_refs": [{"document": "문서명", "relevance": "관련성 설명"}]
}
```"""

# REVIEW_PROMPT는 _init_default_prompts() 이후에 정의되므로 여기서 등록
DEFAULT_PROMPTS["review"] = REVIEW_PROMPT


def review_document(title: str, text: str,
                    model: str = "claude-opus-4-6",
                    status_callback=None,
                    prompt_overrides: dict[str, str] | None = None) -> dict:
    """기획서 리뷰 파이프라인 — RAG + game_data + KG 기반 교차 검증 리뷰.

    Args:
        title: Confluence 페이지 제목
        text: 페이지 본문 텍스트
        model: LLM 모델
        status_callback: 진행 상황 콜백
        prompt_overrides: 커스텀 프롬프트 (키 "review" 사용)

    Returns:
        {
            "review": str (JSON),
            "chunks": list[dict],
            "trace": list[dict],
            "total_tokens": int,
            "total_api_seconds": float,
        }
    """
    trace = []
    total_tokens = 0
    t0 = time.time()

    log.info(f"REVIEW_START title='{title[:60]}' text_len={len(text)}")

    # ── Step 1: 리뷰 전용 Planning (문서 전문을 LLM에 전달) ──
    if status_callback:
        status_callback("🧠 기획 문서를 분석하고 있습니다... (Step 1/3: 문서 분석)")

    t_plan = time.time()

    # 워크북 목록 + KG 관계 요약 제공 (QnA Planning과 동일)
    wb_list = _build_workbook_sheet_listing()
    kg_summary = _get_kg_summary_for_planning()

    # 리뷰 전용 Planning — 문서 전문(최대 50K자)을 전달
    review_plan_user = f"""## 리뷰 대상 기획 문서

제목: {title}

{text[:50000]}

════════════════════════════════════

## 사용 가능한 워크북 목록
{wb_list[:8000]}

## 시스템 간 관계 (Knowledge Graph)
{kg_summary[:3000]}

위 기획 문서를 리뷰하기 위해 참조해야 할 관련 시스템과 데이터를 분석해주세요. JSON만 출력:"""

    from src.generator import call_bedrock
    plan_result = call_bedrock(
        messages=[{"role": "user", "content": review_plan_user}],
        system=REVIEW_PLANNING_PROMPT,
        model="claude-sonnet-4-6",  # Planning은 Sonnet으로 빠르게
        max_tokens=1024,
        temperature=0,
    )

    # Planning 결과 파싱
    import re, json as _json
    plan_text = plan_result.get("text", "")
    plan_tokens = plan_result.get("input_tokens", 0) + plan_result.get("output_tokens", 0)
    total_tokens += plan_tokens

    review_plan = {}
    try:
        cleaned = re.sub(r'```json\s*', '', plan_text)
        cleaned = re.sub(r'```\s*', '', cleaned).strip()
        match = re.search(r'\{[\s\S]*\}', cleaned)
        if match:
            review_plan = _json.loads(match.group(0))
    except Exception as e:
        log.warning(f"Review planning parse failed: {e}")

    primary_systems = review_plan.get("primary_systems", [])
    related_systems = review_plan.get("related_systems", [])
    data_keys = review_plan.get("data_keys", [])
    search_keywords = review_plan.get("search_keywords", [])
    all_systems = primary_systems + related_systems

    plan_time = time.time() - t_plan
    log.info(f"  REVIEW_PLANNING: primary={primary_systems}, related={related_systems[:5]}, "
             f"data_keys={data_keys[:5]}, time={plan_time:.1f}s")

    trace.append({
        "step": "review_planning",
        "description": f"리뷰 전용 분석 — primary={primary_systems}, related={related_systems}, data_keys={data_keys}",
        "primary_systems": primary_systems,
        "related_systems": related_systems,
        "data_keys": data_keys,
        "search_keywords": search_keywords,
        "reasoning": review_plan.get("reasoning", ""),
        "tokens": plan_tokens,
        "seconds": round(plan_time, 1),
    })

    # ── Step 2: 관련 기획서 + 데이터시트 검색 ──
    if status_callback:
        sys_str = ', '.join(all_systems[:3]) or '전체'
        status_callback(f"🔎 관련 기획서/데이터시트 검색 중... (Step 2/3: {sys_str})")

    t_search = time.time()

    # 2-1) primary/related 시스템 워크북에서 집중 검색
    from src.retriever import retrieve, get_related_systems
    chunks = []
    aliases = _build_system_aliases()

    for sys_name in all_systems[:12]:
        wb_list_for_sys = aliases.get(sys_name.lower(), [])
        if not wb_list_for_sys:
            # 부분 매칭 시도
            for alias_key, alias_wbs in aliases.items():
                if sys_name.lower() in alias_key or alias_key in sys_name.lower():
                    wb_list_for_sys = alias_wbs
                    break

        for wb in wb_list_for_sys[:2]:
            try:
                wb_chunks = _structural_search(wb, title)
                for c in wb_chunks[:5]:
                    c["source"] = "review_system_search"
                    if sys_name in primary_systems:
                        c["score"] *= 1.2
                chunks.extend(wb_chunks[:5])
            except Exception as e:
                log.warning(f"system search failed for {wb}: {e}")

    # 2-2) 키워드 기반 벡터 검색 (보충)
    if search_keywords:
        kw_query = ' '.join(search_keywords[:5])
        try:
            kw_chunks, _ = retrieve(kw_query, top_k=10)
            for c in kw_chunks:
                c["source"] = "review_keyword_search"
            chunks.extend(kw_chunks)
        except Exception as e:
            log.warning(f"keyword search failed: {e}")

    # 중복 제거
    seen_ids = set()
    unique_chunks = []
    for c in chunks:
        cid = c.get("id", id(c))
        if cid not in seen_ids:
            seen_ids.add(cid)
            unique_chunks.append(c)
    chunks = sorted(unique_chunks, key=lambda c: c.get("score", 0), reverse=True)[:40]

    # 2-3) 데이터시트 조회 (data_keys + 문서 내 파싱된 키)
    import re as _re
    # 문서에서 추가 키 파싱 (Planning이 놓칠 수 있으므로)
    regex_keys = list(set(_re.findall(
        r'[A-Z][a-zA-Z0-9_]{4,}(?:Setting|Condition|CoolTime|Default|Enable|Disable|Count|Rate|Ratio|Level|Max|Min|Prob|Time|Limit)',
        text
    )))
    regex_tables = list(set(_re.findall(r'[A-Z][a-zA-Z]{2,}Class(?:Info)?|ContentSetting|[A-Z][a-zA-Z]+Enum', text)))
    all_data_keys = list(set(data_keys + regex_keys))
    all_table_refs = list(set(regex_tables))

    gd_chunks = []
    try:
        mod = _load_game_data_module()
        if mod and mod.is_db_ready():
            db_path = mod.get_db_path()

            # ContentSetting 일괄 조회 (LIKE 대신 OR로 한번에)
            for key in all_data_keys[:20]:
                try:
                    result = mod.execute_game_query({
                        "action": "query",
                        "table": "ContentSetting",
                        "filters": [{"column": "ContentSettingEnum", "op": "LIKE", "value": f"%{key}%"}],
                        "limit": 10,
                    }, db_path)
                    if getattr(result, "rows", None):
                        formatted = mod.format_game_data_result(result)
                        gd_chunks.append({
                            "id": f"gamedata_cs_{key}",
                            "workbook": "GameData/ContentSetting",
                            "sheet": key,
                            "text": formatted,
                            "score": 1.5,
                            "source": "game_data_review",
                            "_game_data": True,
                        })
                except Exception as e:
                    log.debug(f"game_data query for {key}: {e}")

            # 참조 테이블 조회 (스키마 + 샘플)
            for tbl in all_table_refs[:8]:
                if tbl == "ContentSetting":
                    continue
                try:
                    result = mod.execute_game_query({"action": "describe", "table": tbl}, db_path)
                    if getattr(result, "columns", None):
                        formatted = mod.format_game_data_result(result)
                        sample = mod.execute_game_query({"action": "query", "table": tbl, "limit": 5}, db_path)
                        if getattr(sample, "rows", None):
                            formatted += "\n\n샘플 데이터:\n" + mod.format_game_data_result(sample)
                        gd_chunks.append({
                            "id": f"gamedata_tbl_{tbl}",
                            "workbook": f"GameData/{tbl}",
                            "sheet": "schema+sample",
                            "text": formatted,
                            "score": 1.3,
                            "source": "game_data_review",
                            "_game_data": True,
                        })
                except Exception as e:
                    log.debug(f"game_data describe for {tbl}: {e}")
    except Exception as e:
        log.warning(f"game_data module load failed: {e}")

    all_chunks = chunks + gd_chunks
    search_time = time.time() - t_search

    workbooks_found = sorted(set(c.get("workbook", "?") for c in all_chunks))
    log.info(f"  REVIEW_SEARCH: {len(chunks)} docs + {len(gd_chunks)} gamedata = {len(all_chunks)} total "
             f"({len(workbooks_found)} workbooks) time={search_time:.1f}s")

    trace.append({
        "step": "review_search",
        "description": f"관련 문서 {len(chunks)}개 + 데이터시트 {len(gd_chunks)}개 검색 완료",
        "chunks_count": len(chunks),
        "game_data_chunks": len(gd_chunks),
        "workbooks_found": workbooks_found,
        "data_keys_queried": all_data_keys[:15],
        "tables_queried": all_table_refs[:8],
        "seconds": round(search_time, 1),
    })

    # ── Step 3: 리뷰 생성 ──
    if status_callback:
        status_callback(f"📝 리뷰를 작성하고 있습니다... (Step 3/3: 리뷰 — {len(all_chunks)}개 참조)")

    t_review = time.time()

    # 컨텍스트 구성 — GameData를 상단에 배치하여 LLM이 반드시 참조하도록
    gd_parts = []
    doc_parts = []
    for c in all_chunks[:40]:
        wb = c.get("workbook", "?")
        sh = c.get("sheet", "")
        if c.get("_game_data"):
            gd_parts.append(f"--- ⚡ [GameData 실제 값] {wb}/{sh} ---\n{c['text'][:3000]}")
        else:
            doc_parts.append(f"--- [기획서] {wb}/{sh} ---\n{c['text'][:3000]}")

    context_parts = []
    if gd_parts:
        context_parts.append("═══ 데이터시트 실제 값 (아래 값을 기획서와 반드시 교차 비교하세요) ═══\n\n" + "\n\n".join(gd_parts))
    if doc_parts:
        context_parts.append("═══ 관련 기획서 ═══\n\n" + "\n\n".join(doc_parts))

    context_text = "\n\n\n".join(context_parts)

    # 공통 컨텍스트 (모든 섹션에 동일하게 전달)
    base_user_msg = f"""## 리뷰 대상 문서: {title}

{text[:80000]}

════════════════════════════════════

## 참조 자료 (관련 기획서 + 데이터시트)

{context_text[:60000]}

════════════════════════════════════
"""

    review_prompt = REVIEW_PROMPT
    if prompt_overrides and "review" in prompt_overrides:
        review_prompt = prompt_overrides["review"]

    from src.generator import call_bedrock

    # 섹션별 분할 호출
    sections = [
        {
            "key": "issues_verifications",
            "label": "보강 필요 + 검증 필요",
            "instruction": '위 문서를 리뷰하여 issues(보강 필요)와 verifications(검증 필요) 항목만 생성하세요. 각 항목에 perspective(기획팀장/프로그래머)를 명시하세요.\n\n출력: {"issues": [{"text":"...","perspective":"기획팀장|프로그래머"}], "verifications": [{"text":"...","perspective":"기획팀장|프로그래머"}]}',
            "max_tokens": 6144,
        },
        {
            "key": "suggestions_flow",
            "label": "제안 + 로직 플로우",
            "instruction": '위 문서를 리뷰하여 suggestions(제안 사항)과 flow(전체 동작 로직 텍스트 순서도)를 생성하세요.\n\n출력: {"suggestions": ["..."], "flow": "1. → 2. → 3. ..."}',
            "max_tokens": 4096,
        },
        {
            "key": "qa_readability",
            "label": "QA 체크리스트 + 가독성 + 관련 문서",
            "instruction": '위 문서를 리뷰하여 qa_checklist(QA 테스트 케이스, Happy Path 최우선), readability(문서 가독성 평가), cross_refs(관련 문서 목록)를 생성하세요.\n\n출력: {"qa_checklist": ["..."], "readability": {"score": 0-100, "issues": ["..."]}, "cross_refs": [{"document":"...","relevance":"..."}]}',
            "max_tokens": 6144,
        },
    ]

    merged_review = {"score": 0}
    section_tokens = 0

    for si, section in enumerate(sections):
        section_label = section["label"]
        if status_callback:
            status_callback(f"📝 리뷰 작성 중... (Step 3: {section_label} — {si+1}/{len(sections)})")

        t_section = time.time()
        user_msg = base_user_msg + section["instruction"]

        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=review_prompt,
            model=model,
            max_tokens=section["max_tokens"],
            temperature=0,
        )

        section_text = result.get("text", "")
        section_tok = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        section_tokens += section_tok
        section_time = time.time() - t_section

        log.info(f"  REVIEW_SECTION {section['key']}: {section_tok:,} tok, {section_time:.1f}s")

        # JSON 파싱 + 머지
        try:
            cleaned = re.sub(r'```json\s*', '', section_text)
            cleaned = re.sub(r'```\s*', '', cleaned).strip()
            match = re.search(r'\{[\s\S]*\}', cleaned)
            if match:
                parsed = _json.loads(match.group(0))
                merged_review.update(parsed)
        except Exception as e:
            log.warning(f"  REVIEW_SECTION {section['key']} parse failed: {e}")

        # 중간 결과를 status_callback으로 전달 (SSE partial result)
        if status_callback:
            import json as _json2
            partial_json = _json2.dumps(merged_review, ensure_ascii=False)
            status_callback(f"__PARTIAL_REVIEW__{partial_json}")

        trace.append({
            "step": f"review_{section['key']}",
            "description": f"{section_label} — {section_tok:,} 토큰",
            "model": model,
            "tokens": section_tok,
            "seconds": round(section_time, 1),
        })

    # 전체 점수 계산 (issues/verifications 수 기반)
    n_issues = len(merged_review.get("issues", []))
    n_verif = len(merged_review.get("verifications", []))
    readability_score = merged_review.get("readability", {}).get("score", 50)
    # 점수 = (100 - issues*3 - verifications*2 + readability_score) / 2, clamped 0-100
    merged_review["score"] = max(0, min(100, int((100 - n_issues * 3 - n_verif * 2 + readability_score) / 2)))

    total_tokens += section_tokens
    review_time = time.time() - t_review

    # 최종 JSON 문자열로 변환
    review_text = _json.dumps(merged_review, ensure_ascii=False, indent=2)

    trace.append({
        "step": "review_generation",
        "description": f"리뷰 생성 완료 — {section_tokens:,} 토큰 ({len(sections)}단계 분할)",
        "model": model,
        "tokens": section_tokens,
        "context_chunks": len(all_chunks),
        "seconds": round(review_time, 1),
    })

    total_time = time.time() - t0
    log.info(f"REVIEW_DONE title='{title[:40]}' tokens={total_tokens} time={total_time:.1f}s")

    return {
        "review": review_text,
        "chunks": [{
            "workbook": c.get("workbook", "?"),
            "sheet": c.get("sheet", ""),
            "score": round(c.get("score", 0), 3),
            "source": c.get("source", ""),
            "text_preview": c.get("text", "")[:200],
        } for c in all_chunks[:20]],
        "trace": trace,
        "total_tokens": total_tokens,
        "total_api_seconds": round(total_time, 1),
    }
