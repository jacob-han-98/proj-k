"""
streamlit_app.py — Project K QnA Streamlit UI

ChatGPT 스타일 대화형 인터페이스.
실행: cd packages/qna-poc && streamlit run src/streamlit_app.py
"""

import logging
import os
import re
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

# 프로젝트 루트를 path에 추가 (src.agent 임포트용)
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from dotenv import load_dotenv
load_dotenv(_project_root / ".env")

from collections import Counter

from src.agent import (
    plan_search,
    execute_search,
    generate_agent_answer,
    reflect_on_answer,
    execute_retry_search,
    scan_all_related_chunks,
    deep_research,
    _build_structural_index,
    TOKEN_BUDGET,
)
from src.retriever import extract_system_names, _get_collection
from src.qna_db import save_qna, save_feedback, get_stats

# ── 페이지 설정 ──
st.set_page_config(
    page_title="Project K QnA",
    page_icon="🎮",
    layout="wide",
)

# ── 커스텀 CSS ──
st.markdown("""
<style>
/* 신뢰도 배지 */
.confidence-high { color: #22c55e; font-weight: bold; }
.confidence-medium { color: #f59e0b; font-weight: bold; }
.confidence-low { color: #ef4444; font-weight: bold; }
.confidence-none { color: #6b7280; font-weight: bold; }

/* 출처 카드 */
.source-card {
    background: #f8f9fa;
    border-left: 3px solid #3b82f6;
    padding: 6px 12px;
    margin: 4px 0;
    border-radius: 4px;
    font-size: 0.85em;
}

/* 메트릭 바 */
.metric-bar {
    display: flex;
    gap: 16px;
    padding: 8px 0;
    font-size: 0.85em;
    color: #6b7280;
}

/* ── 채팅 입력 영역: Claude 스타일 라운드 ── */

/* stBottom: 하단 고정 + 배경 + 콘텐츠 가림 */
div[data-testid="stBottom"] {
    bottom: 0 !important;
    background: #f0f2f6 !important;
    z-index: 999 !important;
}
div[data-testid="stBottomBlockContainer"] {
    padding: 8px 1rem 14px 1rem !important;
    max-width: none !important;
}

/* 채팅 입력: 라운드 + 하단 옵션 공간 확보 */
div[data-testid="stChatInput"] > div {
    border-radius: 24px !important;
    border-color: #d1d5db !important;
    padding-bottom: 36px !important;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06) !important;
    background: white !important;
}
/* 채팅 입력 textarea: 높이 50% 증가 + 흰색 배경 */
div[data-testid="stChatInput"] textarea {
    min-height: 54px !important;
    background: white !important;
}

/* 옵션 바: JS가 동적으로 위치를 설정 (syncOptionsBar) — 초기 숨김 후 JS가 표시 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) {
    position: fixed !important;
    z-index: 1000 !important;
    padding: 0 !important;
    background: transparent !important;
    height: 28px !important;
    align-items: center !important;
    width: auto !important;
    visibility: hidden;
}

/* 옵션 바 내부 컬럼 간격 최소화 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stColumn"] {
    padding: 0 !important;
}

/* 옵션 바 위젯 라벨 숨기기 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stWidgetLabel"] {
    display: none !important;
}
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox {
    margin: 0 !important;
    padding: 0 !important;
}

/* ＋ 버튼: 보더 없이 아이콘만 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stPopover"] button {
    background: transparent !important;
    border: none !important;
    padding: 0 6px !important;
    min-height: 26px !important;
    height: 26px !important;
    font-size: 18px !important;
    color: #9ca3af !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 0 !important;
}
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stPopover"] button:hover {
    background: #f3f4f6 !important;
    border-radius: 8px !important;
    color: #374151 !important;
}
/* ＋ 버튼 내부 expand_more 아이콘 숨기기 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stPopover"] button span[data-testid="stIconMaterial"] {
    display: none !important;
}

/* 모델 선택: 컴팩트 사이즈 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox > div {
    min-height: 22px !important;
    max-width: 120px !important;
}
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox [data-baseweb="select"] {
    height: 22px !important;
    min-height: 22px !important;
    border: none !important;
    background: transparent !important;
    font-size: 0.8rem !important;
}
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox [data-baseweb="select"] > div {
    padding: 0 28px 0 6px !important;
    font-size: 0.8rem !important;
}

/* 채팅 영역 하단 여백 */
section[data-testid="stMain"] > div {
    padding-bottom: 120px;
}

/* 사이드바 스레드 버튼: 컴팩트 + 말줄임 */
[data-testid="stSidebar"] .stButton > button {
    font-size: 0.85rem !important;
    padding: 6px 12px !important;
    text-align: left !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
/* 삭제 버튼: 작게 */
[data-testid="stSidebar"] [data-testid="stColumn"]:last-child .stButton > button {
    padding: 6px 4px !important;
    min-height: 0 !important;
    font-size: 0.9rem !important;
    color: #9ca3af !important;
    background: transparent !important;
    border: none !important;
}
[data-testid="stSidebar"] [data-testid="stColumn"]:last-child .stButton > button:hover {
    color: #ef4444 !important;
}
</style>
""", unsafe_allow_html=True)


# ── 스레드 관리 ──
def _create_thread() -> dict:
    """새 대화 스레드 생성."""
    tid = str(uuid.uuid4())[:8]
    return {
        "id": tid,
        "title": "...",
        "created_at": datetime.now().isoformat(),
        "messages": [],
        "feedback": {},
        "processing": None,
    }


def _sync_active_thread():
    """messages/feedback를 활성 스레드에 연결 (alias)."""
    tid = st.session_state.active_thread_id
    thread = st.session_state.threads[tid]
    st.session_state.messages = thread["messages"]
    st.session_state.feedback = thread["feedback"]


def _auto_title(question: str, max_len: int = 20) -> str:
    """첫 질문에서 스레드 제목 자동 생성."""
    title = question.strip().replace("\n", " ")
    return title[:max_len] + "…" if len(title) > max_len else title


def _agent_worker(proc: dict):
    """백그라운드 스레드에서 Agent 파이프라인 실행. st.* 절대 사용 금지."""
    try:
        prompt = proc["prompt"]
        role = proc["role"]
        p_model = proc["planning_model"]
        a_model = proc["answer_model"]
        r_model = proc["reflection_model"]
        p_style = proc["prompt_style"]
        conv_hist = proc["conv_history"]

        # ── Step 1: Planning ──
        proc["status"] = "planning"
        proc["step_detail"] = "🧠 질문을 분석하고 있습니다..."
        t1 = time.time()
        plan = plan_search(prompt, role=role, model=p_model)
        plan_time = time.time() - t1
        proc["plan"] = plan
        proc["total_tokens"] += plan.get("_tokens", 0)

        key_systems = plan.get("key_systems", [])
        query_type = plan.get("query_type", "?")
        sys_display = ", ".join(key_systems[:3]) if key_systems else "자동 검색"

        proc["trace"].append({
            "step": "planning", "model": p_model,
            "description": f"질문 분석 → {sys_display}",
            "output": {
                "key_systems": key_systems, "query_type": query_type,
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

        # ── Step 2: Search ──
        proc["status"] = "searching"
        proc["step_detail"] = "🔎 기획서에서 관련 내용을 검색하고 있습니다..."
        t2 = time.time()
        chunks = execute_search(plan, prompt)
        search_time = time.time() - t2

        context_tokens = sum(c.get("tokens", 0) for c in chunks)
        workbooks_found = sorted(set(c.get("workbook", "?") for c in chunks))
        use_deep = context_tokens > TOKEN_BUDGET
        proc["chunks"] = chunks
        proc["context_tokens"] = context_tokens
        proc["use_deep_research"] = use_deep

        source_dist = {}
        for c in chunks:
            src = c.get("source", "unknown")
            source_dist[src] = source_dist.get(src, 0) + 1

        tools_used = ["retrieve(hybrid)"]
        for step in plan.get("search_plan", []):
            tool_name = step.get("tool", "retrieve")
            tool_args = step.get("args", {})
            if tool_name == "section_search":
                tools_used.append(f"section_search(workbook={tool_args.get('workbook', '?')})")
            elif tool_name == "kg_related":
                tools_used.append(f"kg_related(system={tool_args.get('system', '?')})")

        proc["trace"].append({
            "step": "search", "model": None,
            "description": f"하이브리드 검색 → {len(chunks)}개 청크",
            "tools_used": tools_used,
            "chunks_count": len(chunks),
            "context_tokens": context_tokens,
            "token_budget": TOKEN_BUDGET,
            "auto_deep_research": use_deep,
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
                    "text_preview": c.get("text", "")[:150],
                }
                for idx, c in enumerate(chunks)
            ],
            "seconds": round(search_time, 1),
        })

        # ── Deep Research / 일반 답변 분기 ──
        dr_sources = None
        if use_deep:
            proc["status"] = "deep_scan"
            proc["step_detail"] = "📚 전체 관련 문서를 스캔하고 있습니다..."
            scan = scan_all_related_chunks(prompt, plan)

            proc["status"] = "deep_research"
            wb_count = len(scan["workbook_summary"])
            total_related = scan["total_chunks"]
            proc["step_detail"] = f"🔬 딥 리서치 — {wb_count}개 문서, {total_related}개 청크 분석 중..."

            def _progress(step_name, detail):
                proc["step_detail"] = f"📝 {detail}"

            dr_result = deep_research(prompt, plan, scan, progress_callback=_progress,
                                      model=a_model, prompt_style=p_style)
            answer = dr_result["answer"]
            chunks = dr_result["chunks"]
            proc["trace"].extend(dr_result["trace"])
            proc["total_tokens"] += dr_result["total_tokens"]
            confidence = dr_result["confidence"]

            dr_sources = []
            for gs in dr_result["group_summaries"]:
                dr_sources.append({
                    "workbook": gs["workbook"],
                    "sheet": f"{gs['chunks_count']}개 청크 분석",
                    "section_path": "", "score": 0,
                })
            chunks = []
            proc["dr_result"] = dr_result
        else:
            # ── Step 3: Answer ──
            proc["status"] = "answering"
            proc["step_detail"] = "✍️ 답변을 생성하고 있습니다..."
            t3 = time.time()
            gen_result = generate_agent_answer(
                prompt, chunks, role, key_systems=key_systems, model=a_model,
                conversation_history=conv_hist or None, prompt_style=p_style,
            )
            gen_time = time.time() - t3
            proc["total_tokens"] += gen_result.get("tokens", 0)
            answer = gen_result["answer"]

            proc["trace"].append({
                "step": "answer_generation", "model": a_model,
                "description": f"답변 생성 ({gen_time:.1f}초)",
                "input": {
                    "chunks_count": min(10, len(chunks)),
                    "key_systems_priority": key_systems,
                    "role": role,
                    "detail_level": gen_result.get("_detail_level", "상세"),
                    "max_tokens": gen_result.get("_max_tokens", 4096),
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
            proc["status"] = "reflecting"
            proc["step_detail"] = "🪞 답변 품질을 검증하고 있습니다..."
            t4 = time.time()
            reflection = reflect_on_answer(prompt, answer, chunks, plan, model=r_model)
            ref_time = time.time() - t4
            proc["total_tokens"] += reflection.get("_tokens", 0)
            confidence = reflection.get("confidence", "medium")

            # short-circuit인 경우 (LLM 미호출, FAIL_PATTERNS 매칭) 별도 표시
            _is_shortcircuit = reflection.get("_tokens", 0) == 0 and not reflection.get("is_sufficient", True)
            if _is_shortcircuit:
                _ref_desc = "답변 내 정보 부족 감지 — 재검색 결정"
            else:
                _ref_desc = f"자체 검증 — 신뢰도: {confidence}"

            proc["trace"].append({
                "step": "reflection", "model": r_model if not _is_shortcircuit else None,
                "description": _ref_desc,
                "output": {
                    "is_sufficient": reflection.get("is_sufficient", True),
                    "confidence": confidence,
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

            # ── Step 4b: Retry ──
            if not reflection.get("is_sufficient", True):
                proc["status"] = "retrying"
                proc["step_detail"] = "🔄 정보가 부족합니다. 재검색 중..."
                t5 = time.time()
                extra_chunks = execute_retry_search(reflection, prompt, chunks)
                if extra_chunks:
                    merged = {c["id"]: c for c in chunks}
                    for c in extra_chunks:
                        if c["id"] not in merged:
                            merged[c["id"]] = c
                    chunks = sorted(merged.values(), key=lambda x: x.get("score", 0), reverse=True)[:20]
                gen_result2 = generate_agent_answer(
                    prompt, chunks, role, key_systems=key_systems, model=a_model,
                    conversation_history=conv_hist or None, prompt_style=p_style,
                )
                retry_time = time.time() - t5
                proc["total_tokens"] += gen_result2.get("tokens", 0)
                answer = gen_result2["answer"]
                proc["trace"].append({
                    "step": "retry", "model": a_model,
                    "description": f"재검색 + 재답변 (+{len(extra_chunks)}개)",
                    "extra_chunks": len(extra_chunks),
                    "tokens": gen_result2.get("tokens", 0),
                    "seconds": round(retry_time, 1),
                })

        # ── 완료: 결과 조립 ──
        total_time = time.time() - proc["started_at"]
        if dr_sources:
            sources = dr_sources
        else:
            sources = []
            seen = set()
            for chunk in chunks:
                key = f"{chunk.get('workbook', '')}/{chunk.get('sheet', '')}"
                if key not in seen:
                    seen.add(key)
                    sources.append({
                        "workbook": chunk.get("workbook", ""),
                        "sheet": chunk.get("sheet", ""),
                        "section_path": chunk.get("section_path", ""),
                        "score": round(chunk.get("combined_score", chunk.get("score", 0)), 3),
                    })

        meta = {
            "confidence": confidence,
            "total_tokens": proc["total_tokens"],
            "api_seconds": round(total_time, 1),
            "sources": sources,
            "trace": proc["trace"],
        }

        # DB 저장
        qna_id = save_qna(
            question=prompt, answer=answer, role=role,
            confidence=confidence, total_tokens=proc["total_tokens"],
            api_seconds=round(total_time, 1), sources=sources, trace=proc["trace"],
            planning_model=p_model, answer_model=a_model, reflection_model=r_model,
        )

        proc["final_message"] = {
            "role": "assistant",
            "content": answer,
            "meta": meta,
            "qna_id": qna_id,
            "_chunks": chunks,
            "_key_systems": key_systems,
            "_question": prompt,
            "_used_model": a_model,
            "_used_prompt_style": p_style,
        }
        proc["finished_at"] = time.time()
        proc["status"] = "done"

    except Exception as e:
        proc["status"] = "error"
        proc["error"] = traceback.format_exc()
        proc["finished_at"] = time.time()
        logging.getLogger(__name__).error(f"Agent worker error: {e}", exc_info=True)


if "threads" not in st.session_state:
    initial = _create_thread()
    st.session_state.threads = {initial["id"]: initial}
    st.session_state.thread_order = [initial["id"]]
    st.session_state.active_thread_id = initial["id"]
if "_workers" not in st.session_state:
    st.session_state._workers = {}  # tid -> threading.Thread

_sync_active_thread()

log = logging.getLogger(__name__)


def format_confidence(conf: str) -> str:
    """신뢰도를 한국어 + 색상 배지로 변환."""
    labels = {
        "high": ("높음", "confidence-high"),
        "medium": ("보통", "confidence-medium"),
        "low": ("낮음", "confidence-low"),
        "none": ("없음", "confidence-none"),
    }
    label, css = labels.get(conf, ("보통", "confidence-medium"))
    return f'<span class="{css}">{label}</span>'


def fix_mermaid_blocks(text: str) -> str:
    """코드블록 중 flowchart/graph/sequenceDiagram을 mermaid로 변환."""
    MERMAID_LANGS = {"flowchart", "graph", "sequencediagram", "classdiagram", "statediagram", "gantt", "pie"}
    MERMAID_STARTS = ["flowchart", "graph ", "graph\n", "sequenceDiagram", "classDiagram", "stateDiagram", "gantt", "pie"]

    def _replace(m):
        lang = (m.group(1) or "").strip()
        code = m.group(2)
        # 이미 mermaid면 그대로
        if lang.lower() == "mermaid":
            return m.group(0)
        # Case 1: ```flowchart\nTB\n... → lang이 mermaid 키워드
        if lang.lower() in MERMAID_LANGS:
            return f"```mermaid\n{lang} {code}```"
        # Case 2: ```\nflowchart TB\n... → 첫 줄이 mermaid 키워드
        if not lang:
            first_line = code.strip().split("\n")[0].strip()
            if any(first_line.startswith(kw) for kw in MERMAID_STARTS):
                return f"```mermaid\n{code}```"
        return m.group(0)

    return re.sub(r"```(\w*)\n(.*?)```", _replace, text, flags=re.DOTALL)


def _estimate_mermaid_height(code: str) -> int:
    """Mermaid 코드에서 방향과 노드 수를 파악하여 초기 높이 추정.

    JS가 렌더링 후 실제 SVG 높이로 조정하므로, 여기서는 약간 넉넉하게 잡아
    잠깐 잘리는 현상을 방지한다. (JS가 줄여주는 건 눈에 안 띔)
    """
    first_line = code.strip().split('\n')[0].strip().lower()
    arrow_count = code.count('-->')

    if 'sequencediagram' in first_line:
        msg_count = sum(1 for line in code.split('\n')
                        if '->>' in line or '-->>' in line or '-->' in line)
        return max(300, msg_count * 55 + 150)

    if any(d in first_line for d in ['lr', 'rl']):
        # 가로: 병렬 분기 수만큼 세로가 늘어남
        branch_count = code.count('-->|') + code.count('--|')
        return max(250, min(800, branch_count * 70 + 200))

    # TB/TD (세로): 화살표 수 ≈ 계층 깊이
    return max(300, min(3000, arrow_count * 80 + 150))


def render_mermaid_block(code: str):
    """Mermaid 코드를 components.html (iframe + mermaid.js CDN)로 렌더링.

    초기 높이를 넉넉하게 잡고, 렌더링 후 실제 SVG 크기로 iframe을 축소.
    """
    escaped = code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    initial_height = _estimate_mermaid_height(code)
    components.html(f"""
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <style>
        body {{ margin:0; padding:4px 0; background:white; font-family:'Malgun Gothic','맑은 고딕',sans-serif; overflow:hidden; }}
        .mermaid {{ display:flex; justify-content:flex-start; }}
        .mermaid svg {{ height:auto; }}
        .mermaid .node rect, .mermaid .node circle, .mermaid .node polygon {{
            rx: 5px; ry: 5px;
        }}
        .mermaid .nodeLabel, .mermaid .label {{
            padding: 8px 16px !important;
            font-family: 'Malgun Gothic','맑은 고딕',sans-serif !important;
        }}
    </style>
    <div class="mermaid">{escaped}</div>
    <script>
    mermaid.initialize({{
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: {{
            padding: 20,
            nodeSpacing: 30,
            rankSpacing: 40,
            useMaxWidth: false,
            htmlLabels: true,
            wrappingWidth: 200
        }}
    }});
    mermaid.run().then(() => {{
        let attempts = 0;
        function fitHeight() {{
            const svg = document.querySelector('.mermaid svg');
            if (svg) {{
                const h = svg.getBoundingClientRect().height;
                if (h > 10) {{
                    const newH = Math.ceil(h) + 20;
                    const fe = window.frameElement;
                    if (fe) {{
                        fe.style.height = newH + 'px';
                        if (fe.hasAttribute('height')) fe.setAttribute('height', newH);
                        let p = fe.parentElement;
                        for (let i = 0; i < 5 && p; i++) {{
                            if (p.style.height || p.hasAttribute('height')) {{
                                p.style.height = newH + 'px';
                                if (p.hasAttribute('height')) p.setAttribute('height', newH + 'px');
                            }}
                            p = p.parentElement;
                        }}
                    }}
                    return;
                }}
            }}
            if (attempts++ < 50) requestAnimationFrame(fitHeight);
        }}
        setTimeout(fitHeight, 150);
    }});
    </script>
    """, height=initial_height)


def render_answer_markdown(text: str):
    """텍스트를 일반 마크다운과 Mermaid 블록으로 분리하여 각각 렌더링.

    Mermaid 블록은 components.html()로 렌더링하여 다이어그램으로 표시.
    """
    text = fix_mermaid_blocks(text)
    # split with capturing group → [text, mermaid_code, text, mermaid_code, ...]
    parts = re.split(r'```mermaid\n(.*?)```', text, flags=re.DOTALL)
    for i, part in enumerate(parts):
        stripped = part.strip()
        if not stripped:
            continue
        if i % 2 == 0:
            st.markdown(stripped)
        else:
            render_mermaid_block(stripped)


CONFLUENCE_BASE = "https://bighitcorp.atlassian.net/wiki"
XLSX_OUTPUT = Path(__file__).resolve().parent.parent.parent / "xlsx-extractor" / "output"
CONFLUENCE_OUTPUT = Path(__file__).resolve().parent.parent.parent / "confluence-downloader" / "output"


def _find_confluence_url(workbook: str, sheet: str) -> str | None:
    """Confluence 출처의 실제 페이지 URL을 content.md frontmatter에서 추출."""
    # workbook: "Confluence/Design/시스템 디자인/PvP 컨텐츠" → path: Design/시스템 디자인/PvP 컨텐츠
    # sheet: "서버 이동 컨텐츠" → 폴더명
    path_part = workbook.replace("Confluence/", "", 1) if "/" in workbook else ""
    search_dir = CONFLUENCE_OUTPUT / path_part / sheet if path_part else CONFLUENCE_OUTPUT
    for name in ("content_enriched.md", "content.md"):
        candidate = search_dir / name
        if candidate.exists():
            try:
                for line in candidate.read_text(encoding="utf-8").split("\n")[:10]:
                    if line.startswith("source:"):
                        return line.split("source:", 1)[1].strip()
            except Exception:
                pass
    return None

# Microsoft Excel 녹색 아이콘 (인라인 이미지)
_EXCEL_ICON = (
    '<img src="data:image/svg+xml;base64,'
    'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBhdGg'
    'gZD0iTTI4LjggM0gxOHYyNmgxMC44YzEuMiAwIDIuMi0xIDIuMi0yLjJWNS4yQzMxIDQgMzAgMyAyOC44IDN6'
    'IiBmaWxsPSIjMTg1QzM3Ii8+PHBhdGggZD0iTTE4IDN2MjZIOC4yQzcgMjkgNiAyOCA2IDI2LjhWNS4yQzYgN'
    'CA3IDMgOC4yIDNIMTh6IiBmaWxsPSIjMjFBMzY2Ii8+PHJlY3QgeD0iMSIgeT0iNyIgd2lkdGg9IjE4IiBoZW'
    'lnaHQ9IjE4IiByeD0iMS41IiBmaWxsPSIjMTA3QzQxIi8+PHBhdGggZD0iTTcuNiAyMUwxMC44IDE2IDcuOCA'
    'xMWgzbDEuNyAzLjRjLjIuMy4zLjYuMy42cy4yLS4zLjMtLjZMMTUgMTFoMi44bC0zLjEgNSAzLjIgNWgtMi45'
    'bC0xLjktMy42Yy0uMS0uMi0uMi0uNC0uMy0uNi0uMS4yLS4yLjQtLjMuNkwxMC41IDIxSDcuNnoiIGZpbGw9'
    'IndoaXRlIi8+PC9zdmc+" '
    'width="16" height="16" style="vertical-align:text-bottom;display:inline">'
)


def _find_sheet_images(workbook: str, sheet: str) -> list[Path]:
    """워크북/시트에 해당하는 전체 스크린샷 이미지 검색.

    우선순위: overview.png (빈 공간 제외 축소본) > full_original.png > detail 타일
    """
    if not workbook.startswith("PK_") or not sheet:
        return []
    sheet_dir = XLSX_OUTPUT / workbook / sheet / "_vision_input"
    if not sheet_dir.exists():
        return []
    # 전체 시트 이미지 우선 (빈 공간 제외, 축소된 한 장)
    overview = sheet_dir / "overview.png"
    if overview.exists():
        return [overview]
    full_orig = sheet_dir / "full_original.png"
    if full_orig.exists():
        return [full_orig]
    # fallback: Vision AI용 타일
    images = sorted(sheet_dir.glob("detail_r*.png"))
    return images[:5]


def _build_depot_path(workbook: str) -> str:
    """워크북명으로부터 Perforce depot 경로를 생성."""
    return f"//main/ProjectK/Design/7_System/{workbook}.xlsx"


# 파일 서빙 base URL (개발서버 배포 시 설정)
_FILE_SERVER_BASE = os.environ.get("FILE_SERVER_BASE", "")  # e.g. "https://dev-server/files/excel"


def render_sources(sources: list[dict]):
    """출처 목록 렌더링. Confluence는 웹 링크, Excel은 스크린샷+링크."""
    if not sources:
        return
    with st.expander(f"📋 출처 ({len(sources)}건)", expanded=False):
        for s in sources:
            wb = s.get("workbook", "?")
            sheet = s.get("sheet", "")
            section = s.get("section_path", "")
            score = s.get("score", 0)

            is_confluence = wb.startswith("Confluence")

            # 아이콘
            icon = "🔗" if is_confluence else _EXCEL_ICON

            # 표시 경로
            display = wb
            if sheet:
                display += f" / {sheet}"
            if section:
                display += f" / {section}"

            # 메타데이터의 source_url 우선 사용
            meta_url = s.get("source_url", "")

            # Confluence: 클릭 가능한 링크 (실제 페이지 URL 우선)
            if is_confluence:
                link = meta_url or _find_confluence_url(wb, sheet)
                if not link:
                    search_term = sheet or wb.split("/")[-1]
                    link = f"{CONFLUENCE_BASE}/search?text={search_term}&where=PK"
                name_html = f'<a href="{link}" target="_blank" style="text-decoration:none;color:inherit"><strong>{icon} {display}</strong></a>'
            else:
                # Excel: depot 경로 + 웹 다운로드 링크
                depot = meta_url or _build_depot_path(wb)
                links_parts = [f'<code style="font-size:0.75em;color:#6b7280">{depot}</code>']
                if _FILE_SERVER_BASE:
                    dl_url = f"{_FILE_SERVER_BASE}/{wb}.xlsx"
                    links_parts.append(f'<a href="{dl_url}" target="_blank" style="font-size:0.75em">📥 다운로드</a>')
                extra_html = " &nbsp;".join(links_parts)
                name_html = f'<strong>{icon} {display}</strong><br>{extra_html}'

            st.markdown(
                f'<div class="source-card">'
                f'{name_html}'
                f' <span style="color:#9ca3af">(score: {score:.3f})</span>'
                f'</div>',
                unsafe_allow_html=True,
            )

            # Excel 출처: 스크린샷 이미지 펼치기
            if not is_confluence:
                images = _find_sheet_images(wb, sheet)
                if images:
                    with st.expander(f"🖼️ {sheet} 원본 스크린샷 ({len(images)}장)", expanded=False):
                        for img in images:
                            st.image(str(img), use_container_width=True)



def _render_prompt_expander(label: str, step: dict, key_suffix: str):
    """시스템 프롬프트 + 유저 프롬프트 + LLM 응답을 expander로 표시."""
    sys_prompt = step.get("system_prompt", "")
    user_prompt = step.get("user_prompt", "")
    raw_resp = step.get("llm_raw_response", "") or step.get("raw_response", "")
    if not sys_prompt and not user_prompt and not raw_resp:
        return
    with st.expander(label, expanded=False):
        if sys_prompt:
            st.markdown("**System Prompt**")
            st.code(sys_prompt[:3000] + ("..." if len(sys_prompt) > 3000 else ""), language=None)
        if user_prompt:
            st.markdown(f"**User Prompt** ({len(user_prompt):,} chars)")
            st.code(user_prompt[:5000] + ("..." if len(user_prompt) > 5000 else ""), language=None)
        if raw_resp:
            st.markdown("**LLM Raw Response**")
            st.code(raw_resp[:3000] + ("..." if len(raw_resp) > 3000 else ""), language=None)


def render_trace(trace: list[dict]):
    """Agent 실행 트레이스 렌더링."""
    if not trace:
        return
    with st.expander("🔍 Agent 실행 과정 (디버그)", expanded=False):
        # 전체 요약 (토큰 합계, 총 시간)
        total_tokens = sum(s.get("tokens", 0) for s in trace)
        total_secs = sum(s.get("seconds", 0) for s in trace)
        input_tokens_total = sum(s.get("input_tokens", 0) for s in trace)
        output_tokens_total = sum(s.get("output_tokens", 0) for s in trace)
        st.caption(
            f"총 토큰: {total_tokens:,}"
            + (f" (in:{input_tokens_total:,} / out:{output_tokens_total:,})" if input_tokens_total else "")
            + f" | 총 시간: {total_secs:.1f}s | 단계: {len(trace)}개"
        )

        for step_idx, step in enumerate(trace):
            step_name = step.get("step", "?")
            model = step.get("model", "-")
            seconds = step.get("seconds", 0)
            tokens = step.get("tokens", 0)
            desc = step.get("description", "")

            # 단계별 아이콘
            icons = {
                "planning": "🧠",
                "search": "🔎",
                "answer_generation": "✍️",
                "reflection": "🪞",
                "retry": "🔄",
            }
            icon = icons.get(step_name, "▶️")

            st.markdown(f"**{icon} {step_name}** — {desc}")

            # 토큰 상세 (input/output 분리)
            in_tok = step.get("input_tokens", 0)
            out_tok = step.get("output_tokens", 0)
            token_detail = f"토큰: {tokens:,}"
            if in_tok or out_tok:
                token_detail += f" (in:{in_tok:,} / out:{out_tok:,})"

            cols = st.columns(3)
            with cols[0]:
                st.caption(f"모델: {model or 'N/A'}")
            with cols[1]:
                st.caption(token_detail)
            with cols[2]:
                st.caption(f"시간: {seconds:.1f}s")

            # 단계별 상세 정보
            if step_name == "planning":
                output = step.get("output", {})
                st.code(
                    f"key_systems: {output.get('key_systems', [])}\n"
                    f"query_type: {output.get('query_type', '?')}\n"
                    f"search_keywords: {output.get('search_keywords', [])}\n"
                    f"search_plan: {output.get('search_plan', [])}\n"
                    f"reasoning: {output.get('reasoning', '')}",
                    language=None,
                )
                _render_prompt_expander(
                    f"📝 Planning 프롬프트/응답", step, f"plan_{step_idx}")

            elif step_name == "search":
                # 요약 정보
                source_dist = step.get("source_distribution", {})
                dist_str = ", ".join(f"{k}:{v}" for k, v in source_dist.items())
                st.caption(
                    f"청크: {step.get('chunks_count', 0)}개 | "
                    f"워크북: {', '.join(step.get('workbooks_found', [])[:8])} | "
                    f"검색 레이어: {dist_str}"
                )
                # 사용된 도구
                tools_used = step.get("tools_used", [])
                if tools_used:
                    st.caption(f"도구: {' → '.join(tools_used)}")
                # 전체 청크 상세
                all_chunks = step.get("all_chunks", [])
                if all_chunks:
                    with st.expander(f"📦 검색된 청크 상세 ({len(all_chunks)}건)", expanded=False):
                        for c in all_chunks:
                            rank = c.get("rank", "?")
                            wb = c.get("workbook", "?")
                            sh = c.get("sheet", "?")
                            sec = c.get("section_path", "")
                            sc = c.get("score", 0)
                            src = c.get("source", "?")
                            tk = c.get("tokens", 0)
                            flags = []
                            if c.get("has_table"):
                                flags.append("TABLE")
                            if c.get("has_mermaid"):
                                flags.append("MERMAID")
                            if c.get("has_images"):
                                flags.append("IMAGE")
                            flags_str = f" [{', '.join(flags)}]" if flags else ""
                            preview = c.get("text_preview", "").replace("\n", " ")

                            st.markdown(
                                f"**#{rank}** `{src}` **{sc:.4f}** — "
                                f"{wb} / {sh}"
                                + (f" / {sec}" if sec else "")
                                + f" ({tk} tokens){flags_str}"
                            )
                            if preview:
                                st.caption(preview)

            elif step_name == "answer_generation":
                inp = step.get("input", {})
                st.caption(
                    f"청크: {inp.get('chunks_count', '?')}개 | "
                    f"우선 시스템: {inp.get('key_systems_priority', [])} | "
                    f"역할: {inp.get('role', 'N/A')} | "
                    f"상세도: {inp.get('detail_level', '?')} | "
                    f"max_tokens: {inp.get('max_tokens', '?')}"
                )
                _render_prompt_expander(
                    f"📝 Answer Generation 프롬프트", step, f"gen_{step_idx}")

            elif step_name == "reflection":
                output = step.get("output", {})
                st.caption(
                    f"충분: {output.get('is_sufficient', '?')} | "
                    f"신뢰도: {output.get('confidence', '?')}"
                )
                if output.get("missing_info"):
                    st.caption(f"부족: {output['missing_info']}")
                if output.get("retry_query"):
                    st.caption(f"재검색: {output['retry_query']} → {output.get('retry_systems', [])}")
                _render_prompt_expander(
                    f"📝 Reflection 프롬프트/응답", step, f"ref_{step_idx}")

            elif step_name == "retry":
                _render_prompt_expander(
                    f"📝 Retry 프롬프트/응답", step, f"retry_{step_idx}")

            st.divider()


def render_feedback(msg_idx: int):
    """피드백 버튼 렌더링. 부정확 클릭 시 상세 입력 표시."""
    msg = st.session_state.messages[msg_idx]
    qna_id = msg.get("qna_id")
    current = st.session_state.feedback.get(msg_idx, {})
    rating = current.get("rating") if isinstance(current, dict) else current

    col1, col2, col3 = st.columns([1, 1, 20])
    with col1:
        if st.button(
            "👍" if rating != "up" else "👍✓",
            key=f"up_{msg_idx}",
            help="정확한 답변",
        ):
            st.session_state.feedback[msg_idx] = {"rating": "up"}
            if qna_id:
                save_feedback(qna_id, "up")
            st.rerun()
    with col2:
        if st.button(
            "👎" if rating != "down" else "👎✓",
            key=f"down_{msg_idx}",
            help="부정확한 답변",
        ):
            st.session_state.feedback[msg_idx] = {"rating": "down", "show_input": True}
            if qna_id:
                save_feedback(qna_id, "down")
            st.rerun()

    # 부정확 피드백 시 상세 입력
    if isinstance(current, dict) and current.get("show_input"):
        st.info("피드백을 남겨주시면 시스템 품질 향상에 큰 도움이 됩니다! 🙏")
        comment = st.text_area(
            "어떤 부분이 부정확한가요?",
            key=f"comment_{msg_idx}",
            placeholder="예: 합성 재료 개수가 4개가 아니라 3개입니다",
            height=80,
        )
        if st.button("피드백 제출", key=f"submit_{msg_idx}"):
            if qna_id and comment:
                save_feedback(qna_id, "down", comment=comment)
            st.session_state.feedback[msg_idx] = {"rating": "down", "submitted": True}
            st.rerun()
        if isinstance(current, dict) and current.get("submitted"):
            st.success("감사합니다! 피드백이 시스템 품질 개선에 반영됩니다.")


def render_retry_panel(msg_idx: int):
    """다른 옵션으로 답변 재생성 패널."""
    msg = st.session_state.messages[msg_idx]
    if "_chunks" not in msg:
        return

    # 이 답변에 사용된 옵션을 기본값으로
    used_model = msg.get("_used_model", MODEL_OPTIONS[0])
    used_prompt_style = msg.get("_used_prompt_style", "검증세트 최적화")

    with st.expander("🔄 다른 옵션으로 다시 답변", expanded=False):
        retry_model = st.selectbox(
            "답변 모델", options=MODEL_OPTIONS,
            index=MODEL_OPTIONS.index(used_model) if used_model in MODEL_OPTIONS else 0,
            format_func=lambda x: MODEL_LABELS.get(x, x),
            key=f"retry_model_{msg_idx}",
        )
        retry_prompt_style = st.radio(
            "프롬프트", options=PROMPT_STYLE_OPTIONS,
            index=PROMPT_STYLE_OPTIONS.index(used_prompt_style) if used_prompt_style in PROMPT_STYLE_OPTIONS else 0,
            horizontal=True,
            key=f"retry_prompt_style_{msg_idx}",
        )
        # 옵션이 변경되었을 때만 재생성 버튼 활성화
        options_changed = (retry_model != used_model) or (retry_prompt_style != used_prompt_style)
        if st.button("재생성", key=f"retry_go_{msg_idx}", type="primary",
                     use_container_width=True, disabled=not options_changed):
            st.session_state.pending_retry = {
                "msg_idx": msg_idx,
                "model": retry_model,
                "prompt_style": retry_prompt_style,
            }


# ── 지식 베이스 뷰어 ──

@st.cache_data(ttl=300)
def _load_kb_stats():
    """ChromaDB에서 지식 베이스 통계를 로드 (5분 캐시)."""
    collection = _get_collection()
    total = collection.count()
    result = collection.get(include=["metadatas"])
    metas = result["metadatas"]

    wb_counts = Counter(m.get("workbook", "") for m in metas)
    tokens = [m.get("tokens", 0) for m in metas]

    excel_wbs = {wb: c for wb, c in wb_counts.items() if not wb.startswith("Confluence/")}
    conf_wbs = {wb: c for wb, c in wb_counts.items() if wb.startswith("Confluence/")}

    # 시트 분포
    sheet_counts = Counter(f"{m.get('workbook', '')}|{m.get('sheet', '')}" for m in metas)

    # 메타데이터 필드 커버리지
    fields = ["workbook", "sheet", "section_path", "tokens", "source_path", "has_table", "has_images", "has_mermaid"]
    field_coverage = {}
    for f in fields:
        has = sum(1 for m in metas if m.get(f) not in (None, "", 0, False))
        field_coverage[f] = has

    # 토큰 구간 분포
    token_buckets = {"< 200": 0, "200~500": 0, "500~1000": 0, "1000~2000": 0, "> 2000": 0}
    for t in tokens:
        if t < 200:
            token_buckets["< 200"] += 1
        elif t < 500:
            token_buckets["200~500"] += 1
        elif t < 1000:
            token_buckets["500~1000"] += 1
        elif t <= 2000:
            token_buckets["1000~2000"] += 1
        else:
            token_buckets["> 2000"] += 1

    return {
        "total": total,
        "wb_counts": dict(wb_counts.most_common()),
        "excel_wbs": len(excel_wbs),
        "excel_chunks": sum(excel_wbs.values()),
        "conf_wbs": len(conf_wbs),
        "conf_chunks": sum(conf_wbs.values()),
        "token_min": min(tokens) if tokens else 0,
        "token_max": max(tokens) if tokens else 0,
        "token_avg": sum(tokens) / len(tokens) if tokens else 0,
        "token_total": sum(tokens),
        "token_buckets": token_buckets,
        "field_coverage": field_coverage,
        "sheet_counts": dict(sheet_counts.most_common()),
        "total_metas": len(metas),
    }


@st.dialog("지식 베이스 상세", width="large")
def show_kb_viewer():
    """ChromaDB 지식 베이스 통계를 상세하게 보여주는 다이얼로그."""
    with st.spinner("ChromaDB 통계 로딩 중..."):
        stats = _load_kb_stats()

    # ── 탭 구성 ──
    tab_overview, tab_workbooks, tab_tokens, tab_meta = st.tabs(
        ["개요", "워크북 상세", "토큰 분포", "메타데이터"]
    )

    # ── 개요 탭 ──
    with tab_overview:
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("총 청크", f"{stats['total']:,}")
        c2.metric("총 워크북", f"{stats['excel_wbs'] + stats['conf_wbs']}")
        c3.metric("총 토큰", f"{stats['token_total']:,}")
        c4.metric("평균 토큰/청크", f"{stats['token_avg']:.0f}")

        st.divider()

        col1, col2 = st.columns(2)
        with col1:
            st.subheader("Excel")
            st.write(f"**{stats['excel_wbs']}** 워크북 · **{stats['excel_chunks']:,}** 청크 ({stats['excel_chunks']/stats['total']*100:.0f}%)")
            # 상위 10 Excel 워크북
            excel_top = [(wb, c) for wb, c in stats["wb_counts"].items() if not wb.startswith("Confluence/")][:10]
            if excel_top:
                st.caption("상위 10 워크북")
                for wb, cnt in excel_top:
                    pct = cnt / stats["total"] * 100
                    st.progress(pct / 10, text=f"{wb} ({cnt})")

        with col2:
            st.subheader("Confluence")
            st.write(f"**{stats['conf_wbs']}** 워크북 · **{stats['conf_chunks']:,}** 청크 ({stats['conf_chunks']/stats['total']*100:.0f}%)")
            conf_top = [(wb, c) for wb, c in stats["wb_counts"].items() if wb.startswith("Confluence/")][:10]
            if conf_top:
                st.caption("상위 10 워크북")
                for wb, cnt in conf_top:
                    pct = cnt / stats["total"] * 100
                    st.progress(pct / 10, text=f"{wb.split('/')[-1]} ({cnt})")

    # ── 워크북 상세 탭 ──
    with tab_workbooks:
        # 필터
        source_filter = st.radio("소스 필터", ["전체", "Excel", "Confluence"], horizontal=True)

        filtered = stats["wb_counts"]
        if source_filter == "Excel":
            filtered = {wb: c for wb, c in filtered.items() if not wb.startswith("Confluence/")}
        elif source_filter == "Confluence":
            filtered = {wb: c for wb, c in filtered.items() if wb.startswith("Confluence/")}

        # 검색
        search = st.text_input("워크북 검색", placeholder="워크북명 입력...")
        if search:
            search_lower = search.lower()
            filtered = {wb: c for wb, c in filtered.items() if search_lower in wb.lower()}

        st.caption(f"{len(filtered)}개 워크북 표시")

        # 테이블 데이터
        rows = []
        for wb, cnt in filtered.items():
            source = "Confluence" if wb.startswith("Confluence/") else "Excel"
            # 시트 수 카운트
            sheets = sum(1 for k in stats["sheet_counts"] if k.startswith(f"{wb}|"))
            rows.append({"워크북": wb, "소스": source, "청크": cnt, "시트": sheets})

        if rows:
            st.dataframe(
                rows,
                column_config={
                    "워크북": st.column_config.TextColumn("워크북", width="large"),
                    "소스": st.column_config.TextColumn("소스", width="small"),
                    "청크": st.column_config.NumberColumn("청크 수", width="small"),
                    "시트": st.column_config.NumberColumn("시트 수", width="small"),
                },
                use_container_width=True,
                hide_index=True,
                height=400,
            )

        # 워크북 상세 드릴다운
        st.divider()
        selected_wb = st.selectbox(
            "워크북 선택 (시트별 청크 확인)",
            options=[""] + list(filtered.keys()),
            format_func=lambda x: x if x else "워크북을 선택하세요...",
        )
        if selected_wb:
            wb_sheets = {k.split("|", 1)[1]: v for k, v in stats["sheet_counts"].items()
                         if k.startswith(f"{selected_wb}|")}
            if wb_sheets:
                st.caption(f"{selected_wb} — {len(wb_sheets)}개 시트, {sum(wb_sheets.values())}개 청크")
                sheet_rows = [{"시트": sh, "청크": cnt} for sh, cnt in
                              sorted(wb_sheets.items(), key=lambda x: x[1], reverse=True)]
                st.dataframe(sheet_rows, use_container_width=True, hide_index=True)

    # ── 토큰 분포 탭 ──
    with tab_tokens:
        c1, c2, c3 = st.columns(3)
        c1.metric("최소 토큰", stats["token_min"])
        c2.metric("최대 토큰", stats["token_max"])
        c3.metric("평균 토큰", f"{stats['token_avg']:.0f}")

        st.divider()
        st.subheader("토큰 구간별 분포")
        for bucket, cnt in stats["token_buckets"].items():
            pct = cnt / stats["total"] * 100
            st.progress(min(pct / 100, 1.0), text=f"{bucket} 토큰: {cnt}개 ({pct:.1f}%)")

        st.divider()
        st.subheader("품질 지표")
        small = stats["token_buckets"].get("< 200", 0)
        large = stats["token_buckets"].get("> 2000", 0)
        optimal = stats["total"] - small - large
        st.write(f"- 너무 짧은 청크 (< 200 토큰): **{small}** ({small/stats['total']*100:.1f}%)")
        st.write(f"- 적정 범위 (200~2000 토큰): **{optimal}** ({optimal/stats['total']*100:.1f}%)")
        st.write(f"- 너무 큰 청크 (> 2000 토큰): **{large}** ({large/stats['total']*100:.1f}%)")

    # ── 메타데이터 탭 ──
    with tab_meta:
        st.subheader("필드 커버리지")
        for field, cnt in stats["field_coverage"].items():
            pct = cnt / stats["total_metas"] * 100
            status = "pass" if pct > 90 else ("warning" if pct > 50 else "fail")
            icon = {"pass": "✅", "warning": "⚠️", "fail": "❌"}[status]
            st.progress(pct / 100, text=f"{icon} {field}: {cnt}/{stats['total_metas']} ({pct:.1f}%)")


# ── 사이드바: 스레드 관리 ──
with st.sidebar:
    st.title("🎮 Project K QnA")

    # 새 대화 버튼
    if st.button("➕ 새 대화", use_container_width=True):
        new_thread = _create_thread()
        st.session_state.threads[new_thread["id"]] = new_thread
        st.session_state.thread_order.insert(0, new_thread["id"])
        st.session_state.active_thread_id = new_thread["id"]
        st.rerun()

    st.divider()

    # 스레드 목록
    for _tid in list(st.session_state.thread_order):
        _thread = st.session_state.threads.get(_tid)
        if not _thread:
            continue
        _is_active = (_tid == st.session_state.active_thread_id)
        _title = _thread["title"]
        _has_msgs = len(_thread["messages"]) > 0
        _is_thread_busy = bool(
            _thread.get("processing") and _thread["processing"]["status"] not in ("done", "error")
        )

        _col_btn, _col_del = st.columns([5, 1])
        with _col_btn:
            _prefix = "⏳ " if _is_thread_busy else ("💬 " if _is_active else "")
            if st.button(
                f"{_prefix}{_title}",
                key=f"thread_{_tid}",
                use_container_width=True,
                type="secondary",
            ):
                if not _is_active:
                    st.session_state.active_thread_id = _tid
                    st.rerun()
        with _col_del:
            if _has_msgs and st.button("×", key=f"del_{_tid}", help="삭제"):
                del st.session_state.threads[_tid]
                st.session_state.thread_order.remove(_tid)
                if _tid == st.session_state.active_thread_id:
                    if st.session_state.thread_order:
                        st.session_state.active_thread_id = st.session_state.thread_order[0]
                    else:
                        _new = _create_thread()
                        st.session_state.threads[_new["id"]] = _new
                        st.session_state.thread_order = [_new["id"]]
                        st.session_state.active_thread_id = _new["id"]
                st.rerun()

    st.divider()

    if st.button("📊 지식 베이스", use_container_width=True):
        show_kb_viewer()

    st.divider()
    stats = get_stats()
    st.caption(f"총 {stats['total_qna']}건 · 👍 {stats['thumbs_up']} · 👎 {stats['thumbs_down']}")
    st.caption("PoC v0.2.0")

# ── 세션 기본값 ──
MODEL_OPTIONS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]
MODEL_LABELS = {"claude-opus-4-6": "Opus 4.6", "claude-sonnet-4-6": "Sonnet 4.6", "claude-haiku-4-5": "Haiku 4.5"}
PROMPT_STYLE_OPTIONS = ["검증세트 최적화", "기본"]
if "role" not in st.session_state:
    st.session_state.role = "기획자"
if "answer_model" not in st.session_state:
    st.session_state.answer_model = "claude-opus-4-6"
if "planning_model" not in st.session_state:
    st.session_state.planning_model = "claude-opus-4-6"
if "reflection_model" not in st.session_state:
    st.session_state.reflection_model = "claude-opus-4-6"
if "prompt_style" not in st.session_state:
    st.session_state.prompt_style = "기본"

# 처리 중 플래그 (활성 스레드 기준)
_active_proc = st.session_state.threads[st.session_state.active_thread_id].get("processing")
_is_processing = bool(_active_proc and _active_proc["status"] not in ("done", "error"))


def _start_agent(question: str):
    """질문을 받아 백그라운드 Agent 워커를 시작한다."""
    tid = st.session_state.active_thread_id
    thread = st.session_state.threads[tid]
    thread["messages"].append({"role": "user", "content": question})
    if thread["title"] == "...":
        thread["title"] = _auto_title(question)

    # 이전 대화 히스토리 수집 (최근 3턴)
    conv_history = []
    msgs = thread["messages"][:-1]
    for i in range(0, len(msgs) - 1, 2):
        if msgs[i]["role"] == "user" and i + 1 < len(msgs) and msgs[i + 1]["role"] == "assistant":
            conv_history.append((msgs[i]["content"], msgs[i + 1]["content"]))
    conv_history = conv_history[-3:]

    proc = {
        "status": "pending", "step_detail": "시작 중...",
        "prompt": question, "role": st.session_state.role,
        "planning_model": st.session_state.planning_model,
        "answer_model": st.session_state.answer_model,
        "reflection_model": st.session_state.reflection_model,
        "prompt_style": st.session_state.prompt_style,
        "conv_history": conv_history,
        "started_at": time.time(), "finished_at": None,
        "plan": None, "chunks": None, "context_tokens": 0,
        "use_deep_research": False, "dr_result": None,
        "total_tokens": 0, "trace": [],
        "final_message": None, "error": None,
    }
    thread["processing"] = proc

    worker = threading.Thread(target=_agent_worker, args=(proc,), daemon=True)
    st.session_state._workers[tid] = worker
    worker.start()
    st.rerun()


# ── 메인: 웰컴 화면 or 대화 ──
_sync_active_thread()  # 사이드바에서 스레드 전환 후 messages 동기화 보장
_active_thread_ref = st.session_state.threads[st.session_state.active_thread_id]
_has_messages = len(_active_thread_ref["messages"]) > 0 or _active_thread_ref.get("processing")
if not _has_messages:
    # 웰컴 전용 CSS
    st.markdown("""<style>
    /* 웰컴: 입력 박스를 프리셋 바로 아래로 올리기
       타이틀 시작: 30vh, 콘텐츠 높이 ~220px → 끝: 30vh+220px
       입력 박스 bottom = 100vh - (30vh+220px+30px gap+104px) = 70vh - 374px */
    div[data-testid="stBottom"] {
        bottom: calc(70vh - 474px) !important;
    }
    div[data-testid="stBottomBlockContainer"] {
        max-width: 700px !important;
        margin-left: auto !important;
        margin-right: auto !important;
    }
    /* 프리셋 버튼: 라운드 카드 스타일 */
    [data-testid="stAppViewContainer"] .stButton > button,
    .stButton > button[kind="secondary"] {
        border: 1px solid #e0e0e0 !important;
        border-radius: 16px !important;
        background: white !important;
        color: #374151 !important;
        padding: 10px 16px !important;
        font-size: 0.88rem !important;
        transition: background 0.15s, border-color 0.15s !important;
        box-shadow: none !important;
        font-weight: 400 !important;
    }
    [data-testid="stAppViewContainer"] .stButton > button:hover,
    .stButton > button[kind="secondary"]:hover {
        background: #f9fafb !important;
        border-color: #9ca3af !important;
    }
    [data-testid="stAppViewContainer"] .stButton > button:active,
    [data-testid="stAppViewContainer"] .stButton > button:focus {
        background: #f3f4f6 !important;
        border-color: #9ca3af !important;
        box-shadow: none !important;
    }
    /* 웰컴: 모델 선택 배경색 흰색 */
    div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox [data-baseweb="select"] > div {
        background: white !important;
    }
    </style>""", unsafe_allow_html=True)

    # 웰컴 타이틀
    st.markdown("""
    <div style="display:flex; flex-direction:column; align-items:center; padding: 30vh 0 2vh 0;">
        <p style="font-size: 2rem; font-weight: 600; color: #1a1a1a; margin-bottom: 6px; letter-spacing: -0.02em;">
            Project K 기획 QnA
        </p>
        <p style="color: #9ca3af; font-size: 0.95rem; margin: 0;">
            기획서에 대해 무엇이든 물어보세요
        </p>
    </div>
    """, unsafe_allow_html=True)

    # 프리셋 제안 (2×2 그리드, 60% 폭, 자연스러운 요청문)
    _presets = [
        "변신 시스템 정리해줘",
        "스킬 시스템 설명해줘",
        "전투 시스템 알려줘",
        "캐릭터 성장 정리해줘",
        '텔레포트 시도 시 "거리가 짧아 텔레포트를 이용하지 않았습니다"라는 메시지가 나오는 조건은?',
    ]
    _pad_l, _center, _pad_r = st.columns([2, 1.5, 2])
    with _center:
        _c1, _c2 = st.columns(2, gap="small")
        for _i, _text in enumerate(_presets):
            with (_c1 if _i % 2 == 0 else _c2):
                if st.button(_text, key=f"preset_{_i}", use_container_width=True):
                    _start_agent(_text)

else:
    # 채팅 모드 전용 CSS — 입력 영역 하단 고정 + 너비 제한
    st.markdown("""<style>
    div[data-testid="stBottom"] {
        position: fixed !important;
    }
    div[data-testid="stBottomBlockContainer"] {
        max-width: 900px !important;
        margin-left: auto !important;
        margin-right: auto !important;
    }
    /* 입력창이 고정되므로 콘텐츠 하단 여백 확보 */
    section[data-testid="stMain"] .block-container {
        padding-bottom: 120px !important;
    }
    </style>""", unsafe_allow_html=True)

# ── 대화 히스토리 렌더링 ──
for i, msg in enumerate(st.session_state.messages):
    with st.chat_message(msg["role"]):
        render_answer_markdown(msg["content"])
        if msg["role"] == "assistant":
            # 메타데이터가 있으면 추가 렌더링
            meta = msg.get("meta", {})
            if meta:
                conf = meta.get("confidence", "medium")
                tokens = meta.get("total_tokens", 0)
                seconds = meta.get("api_seconds", 0)
                st.markdown(
                    f'<div class="metric-bar">'
                    f'신뢰도: {format_confidence(conf)} · '
                    f'토큰: {tokens:,} · '
                    f'응답: {seconds:.1f}초'
                    f'</div>',
                    unsafe_allow_html=True,
                )
                render_sources(meta.get("sources", []))
                render_trace(meta.get("trace", []))
                render_feedback(i)
                render_retry_panel(i)

# ── 재생성 요청 처리 ──
if "pending_retry" in st.session_state:
    _retry = st.session_state.pop("pending_retry")
    _orig = st.session_state.messages[_retry["msg_idx"]]
    _question = _orig.get("_question", "")
    _chunks = _orig.get("_chunks", [])
    _key_systems = _orig.get("_key_systems", [])
    _r_model = _retry["model"]

    with st.chat_message("assistant"):
        _label = f"재생성 중... (모델: {MODEL_LABELS.get(_r_model, _r_model)})"
        _status = st.status(_label, expanded=True)
        with _status:
            _t0 = time.time()
            with st.spinner("✍️ 답변을 재생성하고 있습니다..."):
                _gen = generate_agent_answer(
                    _question, _chunks, role=st.session_state.role,
                    key_systems=_key_systems, model=_r_model,
                    prompt_style=_retry.get("prompt_style", "검증세트 최적화"),
                )
            _gen_time = time.time() - _t0
            st.write(f"✅ 재생성 완료 ({_gen_time:.1f}초)")

        _status.update(label=f"재생성 완료 ({_gen_time:.1f}초, {MODEL_LABELS.get(_r_model, _r_model)})", state="complete", expanded=False)

        _answer = _gen["answer"]
        render_answer_markdown(_answer)

        _tokens = _gen.get("tokens", 0)
        st.markdown(
            f'<div class="metric-bar">'
            f'토큰: {_tokens:,} · '
            f'응답: {_gen_time:.1f}초 · '
            f'모델: {MODEL_LABELS.get(_r_model, _r_model)}'
            f'</div>',
            unsafe_allow_html=True,
        )
        # 기존 출처 재사용
        render_sources(_orig.get("meta", {}).get("sources", []))

        _new_idx = len(st.session_state.messages)
        st.session_state.messages.append({
            "role": "assistant",
            "content": _answer,
            "meta": {
                "total_tokens": _tokens,
                "api_seconds": round(_gen_time, 1),
                "sources": _orig.get("meta", {}).get("sources", []),
                "trace": [{"step": "retry_generation", "model": _r_model,
                           "description": "재생성",
                           "tokens": _tokens, "seconds": round(_gen_time, 1)}],
            },
            "qna_id": None,
            "_chunks": _chunks,
            "_key_systems": _key_systems,
            "_question": _question,
            "_used_model": _r_model,
            "_used_prompt_style": _retry.get("prompt_style", "검증세트 최적화"),
        })
        render_feedback(_new_idx)
        render_retry_panel(_new_idx)

# ── 입력 영역 옵션 바 (Claude 스타일: + 옵션 | 모델선택) ──
with st.container():
    c_left, c_spacer, c_right = st.columns([1, 4, 1.5])

    with c_left:
        with st.popover("＋", disabled=_is_processing):
            if not _is_processing:
                st.session_state.role = st.radio(
                    "역할",
                    options=["기획자", "프로그래머", "QA", "PD"],
                    index=["기획자", "프로그래머", "QA", "PD"].index(
                        st.session_state.role if st.session_state.role in ["기획자", "프로그래머", "QA", "PD"] else "기획자"
                    ),
                    horizontal=True,
                )
                st.session_state.prompt_style = st.radio(
                    "프롬프트 스타일",
                    options=PROMPT_STYLE_OPTIONS,
                    index=PROMPT_STYLE_OPTIONS.index(st.session_state.prompt_style),
                    horizontal=True,
                )
                st.divider()
                st.caption("모델 상세 설정")
                st.session_state.planning_model = st.selectbox(
                    "질문해석", options=MODEL_OPTIONS,
                    index=MODEL_OPTIONS.index(st.session_state.planning_model),
                    format_func=lambda x: MODEL_LABELS.get(x, x),
                )
                st.session_state.reflection_model = st.selectbox(
                    "리뷰", options=MODEL_OPTIONS,
                    index=MODEL_OPTIONS.index(st.session_state.reflection_model),
                    format_func=lambda x: MODEL_LABELS.get(x, x),
                )

    with c_right:
        st.session_state.answer_model = st.selectbox(
            "모델", options=MODEL_OPTIONS,
            index=MODEL_OPTIONS.index(st.session_state.answer_model),
            format_func=lambda x: MODEL_LABELS.get(x, x),
            label_visibility="collapsed",
            disabled=_is_processing,
        )

# ── 옵션 바 위치 동기화 JS: 채팅 입력 라운드 박스 안쪽에 고정 ──
components.html("""<script>
const doc = window.parent.document;
const win = window.parent;

function syncOptionsBar() {
    const chatInputDiv = doc.querySelector('[data-testid="stChatInput"] > div');
    if (!chatInputDiv) return;

    const allBlocks = doc.querySelectorAll('[data-testid="stHorizontalBlock"]');
    let optionsBar = null;
    for (const block of allBlocks) {
        if (block.querySelector('[data-testid="stPopover"]')) {
            optionsBar = block;
            break;
        }
    }
    if (!optionsBar) return;

    const rect = chatInputDiv.getBoundingClientRect();
    const inset = 16;

    optionsBar.style.position = 'fixed';
    optionsBar.style.bottom = (win.innerHeight - rect.bottom + 8) + 'px';
    optionsBar.style.left = (rect.left + inset) + 'px';
    optionsBar.style.right = (win.innerWidth - rect.right + inset) + 'px';
    optionsBar.style.width = 'auto';
    optionsBar.style.visibility = 'visible';
}

// 초기 + 지연 동기화
setTimeout(syncOptionsBar, 100);
setTimeout(syncOptionsBar, 500);
setTimeout(syncOptionsBar, 1500);

// 자동 포커스
setTimeout(() => {
    const ta = doc.querySelector('[data-testid="stChatInput"] textarea');
    if (ta) ta.focus();
}, 300);

// 리사이즈
win.addEventListener('resize', syncOptionsBar);

// DOM 변경 감시 (답변 렌더링 중에도 위치 유지)
new MutationObserver(() => requestAnimationFrame(syncOptionsBar))
    .observe(doc.querySelector('[data-testid="stBottom"]') || doc.body,
             { childList: true, subtree: true, attributes: true });

// 주기적 동기화 (폴백, 5초간 0.5초마다)
let count = 0;
const interval = setInterval(() => {
    syncOptionsBar();
    if (++count >= 10) clearInterval(interval);
}, 500);
</script>
""", height=0)

# 세션에서 값 읽기 (아래 Agent 호출에서 사용)
role = st.session_state.role
planning_model = st.session_state.planning_model
answer_model = st.session_state.answer_model
reflection_model = st.session_state.reflection_model
prompt_style = st.session_state.prompt_style

# ── 입력 (스레드별 독립 key로 입력 내용 격리) ──
if prompt := st.chat_input("기획 질문을 입력하세요...", disabled=_is_processing, key=f"chat_{st.session_state.active_thread_id}"):
    _start_agent(prompt)

# ── 백그라운드 처리 상태 확인 + 완료 결과 반영 ──
_active_thread = st.session_state.threads[st.session_state.active_thread_id]
_proc = _active_thread.get("processing")

if _proc is not None:
    if _proc["status"] == "done":
        # 완료: 결과를 messages로 이동, processing 제거
        _active_thread["messages"].append(_proc["final_message"])
        _active_thread["processing"] = None
        st.session_state._workers.pop(st.session_state.active_thread_id, None)
        st.rerun()

    elif _proc["status"] == "error":
        # 에러 표시
        with st.chat_message("assistant"):
            st.error(f"오류 발생: {_proc.get('error', '알 수 없는 오류')}")
        _active_thread["processing"] = None
        st.session_state._workers.pop(st.session_state.active_thread_id, None)

    else:
        # 처리 중: st.fragment로 2초마다 자동 업데이트
        # time.sleep() 대신 fragment(run_every=2) 사용 → 스크립트 즉시 완료 → 이전 렌더 잔존 방지
        @st.fragment(run_every=2)
        def _show_processing():
            _at = st.session_state.threads[st.session_state.active_thread_id]
            _p = _at.get("processing")
            if not _p or _p["status"] in ("done", "error"):
                st.rerun(scope="app")  # 완료/에러 → 전체 앱 리런
                return
            _elapsed = time.time() - _p["started_at"]
            _status_labels = {
                "pending": "시작 중...",
                "planning": "🧠 질문을 분석하고 있습니다...",
                "searching": "🔎 기획서에서 관련 내용을 검색하고 있습니다...",
                "deep_scan": "📚 전체 관련 문서를 스캔하고 있습니다...",
                "deep_research": "🔬 딥 리서치 진행 중...",
                "answering": "✍️ 답변을 생성하고 있습니다...",
                "reflecting": "🪞 답변 품질을 검증하고 있습니다...",
                "retrying": "🔄 재검색 중...",
                "finalizing": "💾 저장 중...",
            }
            _label = _status_labels.get(_p["status"], _p["status"])
            with st.chat_message("assistant"):
                with st.status(f"Agent가 답변을 준비하고 있습니다... ({_elapsed:.0f}초)", expanded=True):
                    for _step in _p["trace"]:
                        st.write(f"✅ {_step.get('description', _step['step'])} ({_step.get('seconds', 0):.1f}초)")
                    _detail = _p.get("step_detail", "")
                    st.write(f"⏳ {_detail}" if _detail else f"⏳ {_label}")
        _show_processing()