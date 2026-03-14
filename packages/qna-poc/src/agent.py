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

from src.retriever import (
    retrieve,
    extract_system_names,
    get_related_systems,
    _structural_search,
    _build_system_aliases,
    _build_structural_index,
    _load_graph,
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
1. **retrieve** — 하이브리드 검색 (구조적+벡터). 기본 검색 도구.
2. **section_search** — 특정 워크북 내 집중 검색. 워크북명을 알 때 사용.
3. **kg_related** — 지식 그래프에서 관련 시스템 조회. 시스템 간 관계 질문에 사용.

## 분석 항목
1. **핵심 시스템/기능**: 질문이 어떤 시스템/기능에 대한 것인지 (예: "물약 자동 사용 시스템", "스킬 시스템")
2. **질문 유형**: fact(사실 조회), cross_system(시스템 간), flow(플로우/시퀀스), balance(수치/밸런스), ui(UI/UX), trap(존재하지 않는 기능)
3. **검색 키워드**: 검색에 사용할 핵심 키워드 (시스템명 포함)
4. **검색 전략**: 어떤 도구를 어떤 순서로 사용할지

## 중요 규칙
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
  "query_type": "fact|cross_system|flow|balance|ui|trap",
  "search_keywords": ["키워드1", "키워드2"],
  "search_plan": [
    {"tool": "retrieve|section_search|kg_related", "args": {"query": "검색어"}}
  ],
  "reasoning": "1줄 판단 근거"
}
```"""


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


def plan_search(query: str, role: str = None, model: str = "claude-sonnet-4-5") -> dict:
    """LLM으로 질문을 분석하여 검색 전략 수립.

    KG 관계 정보를 함께 제공하여 시스템 간 관계를 파악할 수 있게 함.
    """
    user_msg = f"질문: {query}"
    if role:
        user_msg += f"\n질문자 역할: {role}"

    # 사용 가능한 워크북 목록 제공 (Planning 정확도 향상)
    # Excel(PK_) 워크북은 전체 제공, Confluence는 주요 시스템 디자인만 제공
    index = _build_structural_index()
    all_wbs = sorted(index.keys())
    pk_wbs = [w for w in all_wbs if w.startswith("PK_")]
    conf_wbs = [w for w in all_wbs if w.startswith("Confluence/Design/") and w.count("/") <= 5]
    workbook_list = pk_wbs + conf_wbs
    user_msg += f"\n\n사용 가능한 워크북: {json.dumps(workbook_list, ensure_ascii=False)}"

    # KG 관계 정보 제공 (시스템 간 관계 파악용)
    kg_summary = _get_kg_summary_for_planning()
    if kg_summary:
        user_msg += f"\n\n시스템 간 관계 (Knowledge Graph):\n{kg_summary}"

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=PLANNING_PROMPT,
            model=model,
            max_tokens=1024,
            temperature=0,
        )
        plan = _parse_plan_json(result["text"])
        plan["_tokens"] = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        plan["_api_seconds"] = result.get("api_seconds", 0)
        plan["_raw_response"] = result["text"]  # Planning LLM의 원본 응답 보존
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

def execute_search(plan: dict, query: str, max_chunks: int = 25) -> list[dict]:
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
    for step in search_plan:
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
                    all_chunks[c["id"]]["source"] = "agent_planned"

    # 스코어 순 정렬
    result = sorted(all_chunks.values(), key=lambda x: x.get("score", 0), reverse=True)
    return result[:max_chunks]


# ══════════════════════════════════════════════════════════
#  3. Answer Generation — 증거 기반 답변 생성
# ══════════════════════════════════════════════════════════

AGENT_ANSWER_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가 AI 어시스턴트입니다.
컨텍스트(검색된 기획서)를 기반으로 질문에 답합니다.

## 최우선 원칙: 구체적 수치/비용/조건을 만들어내지 마세요
**구체적 수치, 비용, 배율, 확률 등은 반드시 컨텍스트에서 직접 인용하세요.**
- 컨텍스트에 "크리티컬 배율 1.5배"라는 문구가 없으면 → "1.5배"라고 답하면 안 됩니다
- 컨텍스트에 "비용 없음"이라는 문구가 없으면 → "비용이 없습니다"라고 답하면 안 됩니다
- 컨텍스트에 "거래 가능"이라는 문구가 없으면 → "거래할 수 있습니다"라고 답하면 안 됩니다
- **단, 시스템의 구조/관계/설계 의도에 대한 분석은 컨텍스트 기반으로 추론해도 됩니다.**

## 핵심 원칙 (최우선)
1. **컨텍스트에 관련 정보가 있으면 반드시 답변하세요.** 이것이 가장 중요한 원칙입니다. 컨텍스트에 수치, 테이블, 비율, UI 설명 등이 있으면 반드시 인용하여 답변하세요. 부분적이라도 관련 내용이 있으면 그것을 기반으로 답하세요.
2. **"찾을 수 없습니다" 사용 금지**: 이 표현은 컨텍스트에 질문 주제와 관련된 단어가 **단 하나도 없을 때만** 사용하세요. 컨텍스트에 관련 데이터가 조금이라도 있으면 절대 이 표현을 쓰지 마세요.
3. **컨텍스트에서 질문 키워드가 하나라도 발견되면**, 해당 내용을 중심으로 답변을 구성하세요. 확신이 낮더라도 컨텍스트에 있는 정보는 제공하세요.
4. **[이미지 설명]은 공식 기획 데이터입니다.** 컨텍스트에 `> **[이미지 설명]**:` 형식의 텍스트가 있다면, 이것은 기획서의 다이어그램/도면/표를 AI가 분석한 내용입니다. 테이블이나 본문 텍스트와 동일한 신뢰도로 취급하세요. 이미지 설명에 답이 있으면 반드시 인용하세요.
5. **동의어/유사 표현을 같은 의미로 해석하세요.** 질문의 표현과 컨텍스트의 표현이 다를 수 있습니다:
   - "비활성화" = "선택 불가" = "disabled" = "사용 불가"
   - "Category 값" = 테이블의 "Category" 컬럼
   - "유지되려면" = "적용 조건" = "동작 방식"
   컨텍스트에 정보가 있는데 표현만 다르다면, 그 정보로 답변하세요. 절대 "확인되지 않습니다"라고 하지 마세요.

## 답변 규칙
1. 컨텍스트에 직접 답이 있으면 정확히 인용하세요.
2. **논리적 추론의 범위:** 다음은 OK: 설계 목적·이유·배경 추론, 시스템 간 관계 분석, 엣지 케이스의 예상 동작 분석, UI/UX 설계 포인트 도출, 처리 순서/시퀀스 분석. 다음은 날조: 구체적 수치/배율/비용/확률을 추론으로 생성, 컨텍스트에 없는 테이블 필드명이나 Enum 값 생성.
3. 테이블, 수치, 공식 등 구체적 데이터는 원본 그대로 인용하세요.
4. **답변 후 반드시 출처를 표시하세요.** 형식: `[출처: 워크북명 / 시트명]`
5. 여러 시스템에 걸친 질문은 각 출처를 표시하며 종합 답변하세요.
6. 간결하고 정확하게 답하세요.
7. **절대 지어내지 마세요.** 질문이 특정 기능/NPC/시스템의 존재를 전제하더라도, 컨텍스트에 해당 내용이 전혀 없으면 "해당 내용은 기획서에서 확인되지 않습니다"라고 답하세요. 단, 관련 내용이 조금이라도 있다면 그것을 기반으로 답변을 구성하세요. **핵심 구분: "A 시스템에 대한 내용이 있음" ≠ "A 시스템의 B 기능이 있음"**. 컨텍스트에 A(예: 창고)에 대한 설명이 있더라도, A의 특정 기능 B(예: 내구도 회복)가 언급되지 않았다면 B는 "기획서에 정의되지 않은 기능"입니다.
8. **질문의 전제가 틀렸으면 지적하되, 관련 정보는 계속 제공하세요.** 질문이 특정 사실을 전제하지만 컨텍스트에서 확인되지 않으면:
   - "해당 전제는 기획서에서 확인되지 않습니다"라고 밝힌 후
   - **컨텍스트에 있는 관련 정보를 최대한 활용하여 답변을 이어가세요.**
   - 전제가 틀렸다고 답변 자체를 거부하지 마세요. 질문의 핵심 의도에 관련된 정보가 있다면 반드시 제공하세요.
9. **"기획서에 정의되어 있지 않습니다"와 "아니요/불가능합니다"는 완전히 다릅니다. (이 규칙은 Rule #1~#3보다 우선합니다)**
   - 질문이 특정 비용/수치/조건/기능의 존재를 물을 때, 컨텍스트에 해당 정보가 **명시적으로 기술되어 있지 않다면**:
     - ❌ 잘못된 답변: "비용이 없습니다", "불가능합니다", "해당 기능은 없습니다", "~할 수 있습니다", "~배로 증가합니다", "아니요, ~하지 않습니다"
     - ✅ 올바른 답변: "해당 정보(비용/수치/기능)는 현재 기획서에 명시되어 있지 않습니다"
   - **"언급이 없다"는 곧 "없다/0이다/가능하다"가 아닙니다.** 기획서에 비용이 적혀있지 않다고 해서 무료라고 단정할 수 없습니다. 아직 정의되지 않았을 수 있습니다.
   - 실제로 기획서에 "비용 없음", "해당 없음" 등 **명시적으로 부정**하는 문구가 있을 때만 "~하지 않습니다"로 답하세요.
   - **이 규칙은 구체적 수치/비용/조건을 묻는 질문에 적용됩니다:**
     - "~하면 비용이 얼마나 드나요?" → 비용 수치가 명시되어 있지 않으면 "기획서에 명시되어 있지 않습니다"
     - "~하면 몇 배로 증가하나요?" → 배율이 명시되어 있지 않으면 "기획서에 해당 수치가 정의되어 있지 않습니다"
   - **단, 시스템 분석/설계/충돌 가능성 질문에는 이 규칙을 적용하지 마세요.** 컨텍스트의 정보를 기반으로 분석을 제공하세요.
   - **특히 "~가 되나요?", "~가 회복되나요?", "~이 가능한가요?" 형태의 질문**에서 해당 기능/동작이 컨텍스트에 **한 번도 언급되지 않는다면**, 관련 시스템(예: 창고)에 대한 내용이 있더라도 "해당 기능은 기획서에 정의되어 있지 않습니다"로 답하세요. 관련 시스템의 **정의된** 기능 목록을 함께 제공하여 사용자가 무엇이 가능한지 파악할 수 있게 하세요.
10. **문서에 없는 구체적 수치/Enum 값/테이블 데이터를 지어내지 마세요.**
   - 구체적 ID, Enum 값, 테이블 필드값은 컨텍스트에서 직접 인용해야 합니다.
   - **단, 시스템의 동작 분석, 엣지 케이스 검토, 충돌 가능성 분석은 컨텍스트 기반으로 해도 됩니다.** 이때 "기획서에는 이 케이스에 대한 명시적 규칙이 없으나, 관련 규칙을 종합하면~"과 같이 분석 기반임을 밝히세요.
11. **질문의 모든 측면에 답하세요.** 질문이 "기존이랑 차이점", "A랑 B 두 가지", "어떻게 바뀌는 거야" 등 여러 측면을 묻는다면:
   - 컨텍스트에서 관련된 **모든** 변경사항/항목/비교 포인트를 빠짐없이 포함하세요.
   - 하나의 세부사항만 깊이 파고들고 나머지를 생략하지 마세요.
   - 체크리스트: 답변 작성 후, 컨텍스트에서 질문과 관련된 다른 정보를 놓치지 않았는지 다시 확인하세요.
12. **`[?...?]` 표기는 원본 변환 시 잘린 텍스트입니다.** 문장이 `[?...?]`로 끝나더라도 앞부분의 내용은 유효합니다. 잘린 텍스트의 앞부분을 최대한 활용하고, **문맥상 명백한 경우 잘린 부분을 추론하세요.** 예: "신들을 지원한 대가로 드워프들은 거[?...?]" → "거인이 잠들어 있는 땅을 보장받는다"로 이어질 수 있음. **잘린 텍스트가 있다고 해서 "확인할 수 없다"로 답하지 마세요.** 다른 청크에 동일한 내용이 완전한 형태로 있을 수 있으니, 모든 청크를 확인하세요.
13. **Confluence 문서의 HISTORY 테이블은 문서 수정 이력입니다.** '담당자/내용/일자' 또는 '작성자/수정 내역/수정 날짜' 열이 있습니다. **테이블의 마지막 데이터가 있는 행 = '마지막 수정한 사람/내용/날짜'입니다.** "이 문서 마지막 수정한 사람이 누구야?"라는 질문에 HISTORY 테이블의 마지막 항목을 답변하세요. "수정 정보가 없습니다"라고 하지 마세요.
14. **충돌 가능성/호환성 질문 시 '충돌 없음'으로 단정하지 마세요.** 두 시스템이 동일한 리소스(이벤트, 상태, 입력 등)를 사용한다고 기술되어 있으면: (1) 각 시스템의 관련 동작을 정확히 인용, (2) 충돌 해결 규칙이 문서에 있는지 확인, (3) 없다면 **"문서에 이 케이스에 대한 명시적 처리 규칙이 없다"**고 밝힌 후, (4) 관련 규칙을 종합한 분석/우려사항을 제공하세요. 문서의 침묵 ≠ 문제없음.
15. **'설계해주세요/제시해주세요' 유형 질문:** 관련 시스템의 기존 규칙/템플릿을 컨텍스트에서 인용한 후, 해당 규칙에 맞춰 **구체적 설계안**을 제시하세요. '기획서에 없습니다'로 끝내지 마세요. 컨텍스트의 기존 패턴을 참조하여 설계하세요.
   - **SystemMsg 설계 시 필수 체크리스트**: (1) **display**: Chat(채팅로그)/Toast(상단알림)/둘 다 — 중요 이벤트(보스처치, 희귀 아이템 획득)는 Chat+Toast 복합 설정이 적절, (2) **recipient**: Self(본인만)/Server(서버 전체), (3) **DuplicationAllow**: TRUE(중복 허용, Default)/FALSE(중복 무시) — 4개 필드 모두 명시하세요.
   - **등급 색상**: 반드시 컨텍스트의 등급별 색상표를 인용하세요. 등급 색상이 있는 변수는 자동 bold 처리됩니다.
16. **컨텍스트의 명시적 규칙을 일반적 상식/관례보다 우선하세요.** 게임 개발의 일반적 관행과 컨텍스트의 명시적 기술이 다를 때, 반드시 컨텍스트를 따르세요.
   - 예: 컨텍스트에 "HUD 타겟 표시와 실제 공격 대상이 다를 수 있다"고 되어있으면, 일반적 게임에서 타겟=공격대상이라는 가정을 하지 마세요.
   - 예: 컨텍스트에 "해당 SubType 추가 시 처리사항은 별도 문서 참조"라고 되어있으면, 처리사항을 직접 설계하지 말고 "별도 문서를 참조해야 한다"고 안내하세요.
   - **컨텍스트에 있는 규칙과 모순되는 내용을 절대 생성하지 마세요.**
17. **질문에 사용된 용어를 그대로 사용하세요.** 질문이 "Defense"라고 하면 "Melee Defense"로 바꾸지 마세요. 질문의 용어와 컨텍스트의 정확한 데이터를 매칭하여 답하되, 답변에서는 질문의 표현을 존중하세요.
18. **문서/시트가 비어있거나 미완성이면 명시하세요.** 컨텍스트에서 특정 시스템 문서가 제목만 있고 내용이 없거나, "추후 작성 예정" 등의 표현이 있으면: "해당 문서는 현재 미작성/미정의 상태입니다"라고 명확히 안내하세요. 비어있는 문서에 기반해 추측으로 답변을 채우지 마세요.
19. **OOXML 원본 텍스트는 Excel 셀에서 직접 추출한 확정된 기획 데이터입니다.** 컨텍스트에 `## OOXML 원본 텍스트` 섹션이 있으면, 이것은 기획서 원본에서 직접 추출한 **확정 사실**입니다. OCR 변환된 테이블(깨진 한글, 의미없는 문자열)보다 OOXML 텍스트를 **항상** 신뢰하세요.
   - OOXML에 있는 데이터를 "추정" "가능성" "시사" 등으로 약화시키지 마세요. **OOXML 데이터는 기획서에 명시된 사실입니다.**
   - **셀 위치 포함 형식**: `R행:C열:텍스트` 형식으로 같은 열(C값)에 있는 데이터들은 서로 관련됩니다. 예: R5에 `C5:기본형 | C11:베리1`이고 R6에 `C5:스켈라 | C11:로바르스`이면 → **기본형=스켈라, 베리1=로바르스**입니다 (같은 열이므로).
   - **"기획서에 명확히 정의되어 있지 않다"고 답하기 전에, OOXML 데이터를 다시 확인하세요.** OOXML에 관련 데이터가 있으면 그것이 곧 기획서의 정의입니다.
20. **세계관/종족 설정 질문과 시스템 메커니즘 문서를 구분하세요.** 질문이 "종족 설정", "탄생", "기원", "역사", "전쟁", "세계관" 등 세계관/로어를 묻는 경우:
   - 컨텍스트에 `PK_기타설정/종족` 시트 내용이 있으면 그것이 **세계관 정답**입니다.
   - 동일 키워드(예: "정령", "도깨비")로 검색된 **시스템 메커니즘 문서**(정령 시스템, 변신 시스템 등)는 세계관 답변에 사용하지 마세요. 시스템 메커니즘은 게임 내 구현 규칙이고, 세계관 설정은 스토리/배경입니다.
   - 예: "도깨비가 어떻게 탄생했나?"는 종족 기원 질문 → `PK_기타설정/종족` 시트에서 답변. `정령 시스템`의 "각인 정령" 메커니즘과 혼동하지 마세요.

## 역할별 답변 스타일
- **기획자**: 시스템 규칙, 상호작용, 설계 의도 중심
- **프로그래머**: 데이터 구조, 공식, 시퀀스, 조건 분기 중심
- **QA**: 엣지 케이스, 조건 분기, 상태 전이, 예외 상황 중심
- **PD**: 전체 그림, 시스템 간 관계, 진행 현황 중심
"""


def generate_agent_answer(query: str, chunks: list[dict], role: str = None,
                          key_systems: list[str] = None, model: str = "claude-sonnet-4-5",
                          conversation_history: list[tuple[str, str]] = None) -> dict:
    """수집된 증거로 답변 생성.

    key_systems가 주어지면 해당 시스템의 청크를 우선 배치.
    conversation_history: [(question, answer), ...] 이전 대화 (최근 3턴)
    """
    if not chunks:
        return {"answer": "(검색 결과 없음 - 답변 생성 불가)", "tokens": 0}

    # key_systems 청크 우선 배치 + 시트당 최대 3개로 다양성 보장
    if key_systems:
        priority = []
        rest = []
        key_lower = [s.lower() for s in key_systems]
        for c in chunks:
            wb = c.get("workbook", "").lower()
            if any(k in wb for k in key_lower):
                priority.append(c)
            else:
                rest.append(c)
        # 시트당 최대 3개로 제한 (다양한 시트를 커버, 같은 시트 과다 방지)
        sheet_count = {}
        diverse_priority = []
        overflow = []
        for c in priority:
            sheet_key = f"{c.get('workbook', '')}|{c.get('sheet', '')}"
            sheet_count[sheet_key] = sheet_count.get(sheet_key, 0) + 1
            if sheet_count[sheet_key] <= 3:
                diverse_priority.append(c)
            else:
                overflow.append(c)
        ordered = diverse_priority + rest + overflow
    else:
        ordered = chunks

    # 컨텍스트 조합 (상위 15개 청크, key_systems 우선)
    # OOXML 청크는 6000자 이상일 수 있으므로 여유 있게 7000자 허용
    context_parts = []
    for i, c in enumerate(ordered[:15]):
        wb = c.get("workbook", "?")
        sheet = c.get("sheet", "?")
        section = c.get("section_path", "")
        text = c.get("text", "")[:7000]
        context_parts.append(f"[출처 {i+1}: {wb} / {sheet} / {section}]\n{text}")

    context = "\n\n---\n\n".join(context_parts)

    user_msg = f"## 컨텍스트 (검색된 기획서)\n\n{context}\n\n---\n\n## 질문\n{query}"
    if role:
        user_msg = f"[질문자 역할: {role}]\n\n" + user_msg

    # 대화 히스토리 → messages 배열 (최근 3턴)
    messages = []
    if conversation_history:
        for prev_q, prev_a in conversation_history[-3:]:
            messages.append({"role": "user", "content": prev_q})
            summary = prev_a[:500] + "..." if len(prev_a) > 500 else prev_a
            messages.append({"role": "assistant", "content": summary})
    messages.append({"role": "user", "content": user_msg})

    try:
        result = call_bedrock(
            messages=messages,
            system=AGENT_ANSWER_PROMPT,
            model=model,
            max_tokens=2048,
            temperature=0,
        )
        return {
            "answer": result["text"],
            "tokens": result.get("input_tokens", 0) + result.get("output_tokens", 0),
            "api_seconds": result.get("api_seconds", 0),
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


def reflect_on_answer(query: str, answer: str, chunks: list[dict], plan: dict, model: str = "claude-haiku-4-5") -> dict:
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
            system=REFLECTION_PROMPT,
            model=model,
            max_tokens=256,
            temperature=0,
        )
        reflection = _parse_plan_json(result["text"])  # 같은 파서 재사용
        reflection["_tokens"] = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        reflection["_api_seconds"] = result.get("api_seconds", 0)
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
#  Agent 메인 엔트리포인트
# ══════════════════════════════════════════════════════════

def agent_answer(query: str, role: str = None,
                 conversation_history: list[tuple[str, str]] = None) -> dict:
    """Agent QnA 파이프라인.

    Args:
        query: 사용자 질문
        role: 질문자 역할
        conversation_history: [(question, answer), ...] 이전 대화 (최근 3턴)

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
    t_plan = time.time()
    plan = plan_search(query, role)
    plan_time = time.time() - t_plan
    total_tokens += plan.get("_tokens", 0)
    log.debug(f"  PLANNING: key_systems={plan.get('key_systems',[])} "
              f"type={plan.get('query_type','?')} time={plan_time:.1f}s")

    trace.append({
        "step": "planning",
        "model": "claude-sonnet-4-5",
        "description": "Sonnet이 질문을 분석하여 어떤 기획서(워크북)를 참고할지 결정 (KG 관계 활용)",
        "input": {"query": query, "role": role, "workbook_count": len(_build_structural_index())},
        "output": {
            "key_systems": plan.get("key_systems", []),
            "query_type": plan.get("query_type", "?"),
            "search_keywords": plan.get("search_keywords", []),
            "search_plan": plan.get("search_plan", []),
            "reasoning": plan.get("reasoning", ""),
        },
        "llm_raw_response": plan.get("_raw_response", ""),
        "tokens": plan.get("_tokens", 0),
        "seconds": round(plan_time, 1),
    })

    # ── Step 2: Tool Use (Search) ──
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
        "top3_chunks": [
            {"workbook": c.get("workbook", "?"), "sheet": c.get("sheet", "?"),
             "score": round(c.get("score", 0), 3), "source": c.get("source", "?")}
            for c in chunks[:3]
        ],
        "seconds": round(search_time, 1),
    })

    # ── Step 3: Answer Generation ──
    t_gen = time.time()
    key_systems = plan.get("key_systems", [])
    gen_result = generate_agent_answer(query, chunks, role, key_systems=key_systems,
                                       conversation_history=conversation_history)
    gen_time = time.time() - t_gen
    total_tokens += gen_result.get("tokens", 0)

    answer = gen_result["answer"]
    log.debug(f"  ANSWER: {len(answer)} chars, {gen_result.get('tokens',0)} tokens, time={gen_time:.1f}s")

    trace.append({
        "step": "answer_generation",
        "model": "claude-sonnet-4-5",
        "description": "검색된 청크를 기반으로 Sonnet이 답변 생성",
        "input": {
            "chunks_count": min(10, len(chunks)),
            "key_systems_priority": key_systems,
            "role": role,
        },
        "answer_preview": answer[:200] + "..." if len(answer) > 200 else answer,
        "tokens": gen_result.get("tokens", 0),
        "seconds": round(gen_time, 1),
    })

    # ── Step 4: Reflection ──
    t_ref = time.time()
    reflection = reflect_on_answer(query, answer, chunks, plan)
    ref_time = time.time() - t_ref
    total_tokens += reflection.get("_tokens", 0)

    trace.append({
        "step": "reflection",
        "model": "claude-haiku-4-5",
        "description": "Haiku가 생성된 답변의 품질을 자체 검증",
        "output": {
            "is_sufficient": reflection.get("is_sufficient", True),
            "confidence": reflection.get("confidence", "medium"),
            "missing_info": reflection.get("missing_info", ""),
        },
        "tokens": reflection.get("_tokens", 0),
        "seconds": round(ref_time, 1),
    })

    log.debug(f"  REFLECTION: sufficient={reflection.get('is_sufficient',True)} "
              f"confidence={reflection.get('confidence','?')}")

    # ── Step 4b: Retry if needed ──
    if not reflection.get("is_sufficient", True):
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
                                            conversation_history=conversation_history)
        retry_time = time.time() - t_retry
        total_tokens += gen_result2.get("tokens", 0)

        # 재답변은 항상 채택 (기존 답변이 "찾을 수 없습니다"였으므로)
        retry_answer = gen_result2["answer"]
        answer = retry_answer
        log.debug(f"  RETRY: +{len(extra_chunks)} chunks, new answer={len(retry_answer)} chars")

        trace.append({
            "step": "retry",
            "model": "claude-sonnet-4-5",
            "description": "Reflection에서 부족하다고 판단 -> 재검색 + 재답변",
            "tools_used": ["retrieve(retry)", f"key_systems_search({key_systems})"],
            "extra_chunks": len(extra_chunks),
            "answer_preview": retry_answer[:200] + "..." if len(retry_answer) > 200 else retry_answer,
            "adopted": answer == retry_answer,
            "tokens": gen_result2.get("tokens", 0),
            "seconds": round(retry_time, 1),
        })

    total_time = time.time() - t0

    return {
        "answer": answer,
        "chunks": chunks,
        "trace": trace,
        "confidence": reflection.get("confidence", "medium"),
        "total_tokens": total_tokens,
        "total_api_seconds": round(total_time, 1),
    }
