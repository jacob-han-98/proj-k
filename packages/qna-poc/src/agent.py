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
    format_context,
)
from src.generator import call_bedrock, SYSTEM_PROMPT as QNA_SYSTEM_PROMPT


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


def plan_search(query: str, role: str = None) -> dict:
    """LLM으로 질문을 분석하여 검색 전략 수립."""
    user_msg = f"질문: {query}"
    if role:
        user_msg += f"\n질문자 역할: {role}"

    # 사용 가능한 워크북 목록 제공 (Planning 정확도 향상)
    # Excel(PK_) 워크북은 전체 제공, Confluence는 주요 시스템 디자인만 제공
    index = _build_structural_index()
    all_wbs = sorted(index.keys())
    pk_wbs = [w for w in all_wbs if w.startswith("PK_")]
    conf_wbs = [w for w in all_wbs if w.startswith("Confluence/Design/") and w.count("/") <= 4]
    workbook_list = pk_wbs + conf_wbs
    user_msg += f"\n\n사용 가능한 워크북: {json.dumps(workbook_list, ensure_ascii=False)}"

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=PLANNING_PROMPT,
            model="claude-haiku-4-5",
            max_tokens=512,
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

def execute_search(plan: dict, query: str) -> list[dict]:
    """Planning 결과에 따라 검색 도구를 실행하고 결과를 병합."""
    all_chunks = {}  # id → chunk (중복 제거)

    search_plan = plan.get("search_plan", [])
    if not search_plan:
        search_plan = [{"tool": "retrieve", "args": {"query": query}}]

    for step in search_plan:
        tool = step.get("tool", "retrieve")
        args = step.get("args", {})

        if tool == "retrieve":
            search_query = args.get("query", query)
            chunks, _ = retrieve(search_query, top_k=15)
            for c in chunks:
                if c["id"] not in all_chunks:
                    all_chunks[c["id"]] = c

        elif tool == "section_search":
            workbook = args.get("workbook", "")
            search_query = args.get("query", query)
            if workbook:
                chunks = _structural_search(workbook, search_query)
                for c in chunks[:10]:
                    if c["id"] not in all_chunks:
                        all_chunks[c["id"]] = c

        elif tool == "kg_related":
            system_name = args.get("system", "")
            if system_name:
                related = get_related_systems(system_name, depth=1)
                # 관련 시스템에서 검색
                for rel in related[:3]:
                    aliases = _build_system_aliases()
                    wb_list = aliases.get(rel.lower(), [])
                    for wb in wb_list[:1]:
                        chunks = _structural_search(wb, query)
                        for c in chunks[:3]:
                            c["score"] *= 0.7  # 간접 관련 가중치
                            c["source"] = "kg_agent"
                            if c["id"] not in all_chunks:
                                all_chunks[c["id"]] = c

    # Planning에서 감지한 시스템을 직접 검색 보강
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
            for c in chunks[:5]:
                c["score"] = max(c.get("score", 0), 0.85)  # Planning이 지목한 시스템은 높은 점수
                c["source"] = "agent_planned"
                if c["id"] not in all_chunks:
                    all_chunks[c["id"]] = c

    # 스코어 순 정렬
    result = sorted(all_chunks.values(), key=lambda x: x.get("score", 0), reverse=True)
    return result[:20]  # 상위 20개


# ══════════════════════════════════════════════════════════
#  3. Answer Generation — 증거 기반 답변 생성
# ══════════════════════════════════════════════════════════

AGENT_ANSWER_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가 AI 어시스턴트입니다.

## 규칙
1. **제공된 컨텍스트를 꼼꼼히 읽고 답변하세요.** 컨텍스트에 답이 있으면 반드시 추출하여 답하세요.
2. 명시적 규칙에서 논리적으로 추론 가능한 경우도 답변하세요. 예: "상급으로 대체" → 소형 다음은 중형.
3. **답변 후 반드시 출처를 표시하세요.** 형식: `[출처: 워크북명 / 시트명 / 섹션명]`
4. 컨텍스트에 정말로 관련 정보가 전혀 없을 때만 "찾을 수 없습니다"라고 답하세요.
5. 테이블, 수치, 공식 등 구체적 데이터는 원본 그대로 인용하세요.
6. 여러 시스템에 걸친 질문은 각 출처를 표시하며 종합 답변하세요.
7. 간결하고 정확하게 답하세요.

## 역할별 답변 스타일
- **기획자**: 시스템 규칙, 상호작용, 설계 의도 중심
- **프로그래머**: 데이터 구조, 공식, 시퀀스, 조건 분기 중심
- **QA**: 엣지 케이스, 조건 분기, 상태 전이, 예외 상황 중심
- **PD**: 전체 그림, 시스템 간 관계, 진행 현황 중심
"""


def generate_agent_answer(query: str, chunks: list[dict], role: str = None,
                          key_systems: list[str] = None) -> dict:
    """수집된 증거로 답변 생성.

    key_systems가 주어지면 해당 시스템의 청크를 우선 배치.
    """
    if not chunks:
        return {"answer": "(검색 결과 없음 - 답변 생성 불가)", "tokens": 0}

    # key_systems 청크 우선 배치
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
        ordered = priority + rest
    else:
        ordered = chunks

    # 컨텍스트 조합 (상위 10개 청크, key_systems 우선)
    context_parts = []
    for i, c in enumerate(ordered[:10]):
        wb = c.get("workbook", "?")
        sheet = c.get("sheet", "?")
        section = c.get("section_path", "")
        text = c.get("text", "")[:3000]
        context_parts.append(f"[출처 {i+1}: {wb} / {sheet} / {section}]\n{text}")

    context = "\n\n---\n\n".join(context_parts)

    user_msg = f"## 컨텍스트 (검색된 기획서)\n\n{context}\n\n---\n\n## 질문\n{query}"
    if role:
        user_msg = f"[질문자 역할: {role}]\n\n" + user_msg

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=AGENT_ANSWER_PROMPT,
            model="claude-sonnet-4-5",
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


def reflect_on_answer(query: str, answer: str, chunks: list[dict], plan: dict) -> dict:
    """생성된 답변의 품질을 자체 검증."""
    # 답변이 명백히 실패인 경우 빠르게 판단
    # 단, "찾을 수 없습니다" 뒤에 실질적 내용이 있으면 부분 성공으로 간주
    is_cant_find = "찾을 수 없습니다" in answer or "정보가 없습니다" in answer or "답변 생성 불가" in answer
    has_substance = len(answer) > 200 and ("[출처" in answer or "기획서" in answer)

    if is_cant_find and not has_substance:
        # 완전 실패 → 재검색
        return {
            "is_sufficient": False,
            "confidence": "none",
            "missing_info": "답변 실패 - 검색 범위 재조정 필요",
            "retry_query": query,
            "retry_systems": plan.get("key_systems", []),
            "_tokens": 0,
            "_api_seconds": 0,
        }

    chunk_summary = ", ".join(
        f"{c.get('workbook', '?')}/{c.get('sheet', '?')}" for c in chunks[:5]
    )

    user_msg = f"""## 원래 질문
{query}

## 시스템 답변
{answer}

## 검색된 출처
{chunk_summary}

위 답변의 품질을 평가하세요."""

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=REFLECTION_PROMPT,
            model="claude-haiku-4-5",
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

def agent_answer(query: str, role: str = None) -> dict:
    """Agent QnA 파이프라인.

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

    # ── Step 1: Planning ──
    t_plan = time.time()
    plan = plan_search(query, role)
    plan_time = time.time() - t_plan
    total_tokens += plan.get("_tokens", 0)

    trace.append({
        "step": "planning",
        "description": "LLM이 질문을 분석하여 어떤 기획서(워크북)를 참고할지 결정",
        "key_systems": plan.get("key_systems", []),
        "query_type": plan.get("query_type", "?"),
        "search_keywords": plan.get("search_keywords", []),
        "search_plan": plan.get("search_plan", []),
        "reasoning": plan.get("reasoning", ""),
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

    trace.append({
        "step": "search",
        "description": "Planning이 지목한 워크북에서 관련 청크를 검색",
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
    gen_result = generate_agent_answer(query, chunks, role, key_systems=key_systems)
    gen_time = time.time() - t_gen
    total_tokens += gen_result.get("tokens", 0)

    answer = gen_result["answer"]

    trace.append({
        "step": "answer_generation",
        "description": "검색된 청크를 기반으로 Sonnet이 답변 생성",
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
        "description": "Haiku가 생성된 답변의 품질을 자체 검증",
        "is_sufficient": reflection.get("is_sufficient", True),
        "confidence": reflection.get("confidence", "medium"),
        "missing_info": reflection.get("missing_info", ""),
        "tokens": reflection.get("_tokens", 0),
        "seconds": round(ref_time, 1),
    })

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

        # 재답변
        gen_result2 = generate_agent_answer(query, chunks, role, key_systems=key_systems)
        retry_time = time.time() - t_retry
        total_tokens += gen_result2.get("tokens", 0)

        # 재답변이 더 나은지 판단 (답변 실패가 아니면 채택)
        retry_answer = gen_result2["answer"]
        if "찾을 수 없습니다" not in retry_answer and "답변 생성 불가" not in retry_answer:
            answer = retry_answer

        trace.append({
            "step": "retry",
            "description": "Reflection에서 부족하다고 판단 -> 재검색 + 재답변",
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
