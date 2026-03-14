"""
streamlit_app.py — Project K QnA Streamlit UI

ChatGPT 스타일 대화형 인터페이스.
실행: cd packages/qna-poc && streamlit run src/streamlit_app.py
"""

import re
import sys
import time
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

# 프로젝트 루트를 path에 추가 (src.agent 임포트용)
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from dotenv import load_dotenv
load_dotenv(_project_root / ".env")

from src.agent import (
    plan_search,
    execute_search,
    generate_agent_answer,
    reflect_on_answer,
    execute_retry_search,
    _build_structural_index,
)
from src.retriever import extract_system_names
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

/* 채팅 입력란을 위로 올려서 옵션 바 공간 확보 */
div[data-testid="stBottom"] {
    bottom: 32px !important;
}
/* stBottom 내부 하단 여백 줄이기 */
div[data-testid="stBottomBlockContainer"] {
    padding-bottom: 4px !important;
}

/* 옵션 바: 채팅 입력란 아래에 고정 (Claude 스타일) */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) {
    position: fixed !important;
    bottom: 0 !important;
    right: 0 !important;
    z-index: 1000 !important;
    padding: 0 5rem 0 4rem !important;  /* 텍스트 박스 좌우에 맞춤 */
    background: transparent !important;
    height: 34px !important;
    align-items: center !important;
    left: auto !important;
    width: calc(100vw - 300px - 17px) !important;  /* sidebar + scrollbar */
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

/* ＋ 버튼 스타일 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stPopover"] button {
    background: transparent !important;
    border: 1px solid #9ca3af !important;
    border-radius: 16px !important;
    padding: 0 6px !important;
    min-height: 30px !important;
    height: 30px !important;
    font-size: 18px !important;
    color: #6b7280 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 0 !important;
}
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stPopover"] button:hover {
    background: #f3f4f6 !important;
    border-color: #6b7280 !important;
    color: #374151 !important;
}
/* ＋ 버튼 내부 expand_more 아이콘 숨기기 */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) [data-testid="stPopover"] button span[data-testid="stIconMaterial"] {
    display: none !important;
}

/* 모델 선택 셀렉트박스 slim */
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox > div {
    min-height: 30px !important;
}
div[data-testid="stHorizontalBlock"]:has([data-testid="stPopover"]) .stSelectbox [data-baseweb="select"] {
    height: 30px !important;
    min-height: 30px !important;
    border-color: #9ca3af !important;
}

/* 채팅 영역 하단 여백 */
section[data-testid="stMain"] > div {
    padding-bottom: 130px;
}
</style>
""", unsafe_allow_html=True)


# ── 세션 상태 초기화 ──
if "messages" not in st.session_state:
    st.session_state.messages = []
if "feedback" not in st.session_state:
    st.session_state.feedback = {}  # msg_idx -> "up" | "down"


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


def render_mermaid_block(code: str):
    """Mermaid 코드를 components.html (iframe + mermaid.js CDN)로 렌더링."""
    # 줄 수 기반 높이 자동 추정 (축소: 노드 × 45px + 여백, 최대 500px)
    lines = code.strip().count('\n') + 1
    estimated_height = min(500, max(150, lines * 45 + 60))
    escaped = code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    components.html(f"""
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <style>
        body {{ margin:0; padding:4px 0; background:transparent; font-family:sans-serif; }}
        .mermaid {{ display:flex; justify-content:center; transform:scale(0.85); transform-origin:top center; }}
        .mermaid svg {{ max-width:100%; }}
    </style>
    <div class="mermaid">{escaped}</div>
    <script>
    mermaid.initialize({{ startOnLoad:true, theme:'default', securityLevel:'loose' }});
    </script>
    """, height=estimated_height)


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


def _find_sheet_images(workbook: str, sheet: str) -> list[Path]:
    """워크북/시트에 해당하는 스크린샷 이미지 검색."""
    if not workbook.startswith("PK_") or not sheet:
        return []
    sheet_dir = XLSX_OUTPUT / workbook / sheet / "_vision_input"
    if not sheet_dir.exists():
        return []
    images = sorted(sheet_dir.glob("detail_r*.png"))
    return images[:5]  # 최대 5장


def render_sources(sources: list[dict]):
    """출처 목록 렌더링. Confluence는 웹 링크, Excel은 아이콘 표시."""
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
            icon = "🔗" if is_confluence else "📊"

            # 표시 경로
            display = wb
            if sheet:
                display += f" / {sheet}"
            if section:
                display += f" / {section}"

            # Confluence: 클릭 가능한 링크
            if is_confluence:
                search_term = sheet or wb.split("/")[-1]
                link = f"{CONFLUENCE_BASE}/search?text={search_term}&where=PK"
                name_html = f'<a href="{link}" target="_blank" style="text-decoration:none;color:inherit"><strong>{icon} {display}</strong></a>'
            else:
                name_html = f'<strong>{icon} {display}</strong>'

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


def render_trace(trace: list[dict]):
    """Agent 실행 트레이스 렌더링."""
    if not trace:
        return
    with st.expander("🔍 Agent 실행 과정 (디버그)", expanded=False):
        for step in trace:
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

            cols = st.columns(3)
            with cols[0]:
                st.caption(f"모델: {model or 'N/A'}")
            with cols[1]:
                st.caption(f"토큰: {tokens:,}")
            with cols[2]:
                st.caption(f"시간: {seconds:.1f}s")

            # 단계별 상세 정보
            if step_name == "planning":
                output = step.get("output", {})
                st.code(
                    f"key_systems: {output.get('key_systems', [])}\n"
                    f"query_type: {output.get('query_type', '?')}\n"
                    f"search_keywords: {output.get('search_keywords', [])}\n"
                    f"reasoning: {output.get('reasoning', '')}",
                    language=None,
                )
            elif step_name == "search":
                st.caption(
                    f"청크: {step.get('chunks_count', 0)}개 | "
                    f"워크북: {', '.join(step.get('workbooks_found', [])[:5])}"
                )
            elif step_name == "reflection":
                output = step.get("output", {})
                st.caption(
                    f"충분: {output.get('is_sufficient', '?')} | "
                    f"신뢰도: {output.get('confidence', '?')}"
                )
                if output.get("missing_info"):
                    st.caption(f"부족: {output['missing_info']}")

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


# ── 사이드바 (최소화) ──
with st.sidebar:
    st.title("🎮 Project K QnA")

    if st.button("🗑️ 대화 초기화", use_container_width=True):
        st.session_state.messages = []
        st.session_state.feedback = {}
        st.rerun()

    st.divider()
    stats = get_stats()
    st.caption(f"총 {stats['total_qna']}건 · 👍 {stats['thumbs_up']} · 👎 {stats['thumbs_down']}")
    st.caption("PoC v0.2.0")

# ── 세션 기본값 ──
MODEL_OPTIONS = ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"]
MODEL_LABELS = {"claude-sonnet-4-5": "Sonnet", "claude-opus-4-5": "Opus", "claude-haiku-4-5": "Haiku"}
if "role" not in st.session_state:
    st.session_state.role = "기획자"
if "max_chunks" not in st.session_state:
    st.session_state.max_chunks = 25
if "answer_model" not in st.session_state:
    st.session_state.answer_model = "claude-sonnet-4-5"
if "planning_model" not in st.session_state:
    st.session_state.planning_model = "claude-sonnet-4-5"
if "reflection_model" not in st.session_state:
    st.session_state.reflection_model = "claude-haiku-4-5"


# ── 메인 헤더 ──
st.title("🎮 Project K 기획 QnA")
st.caption("Project K 기획서에 대해 무엇이든 물어보세요. Agent가 기획서를 검색하고 답변합니다.")

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

# ── 입력 영역 옵션 바 (Claude 스타일: + 옵션 | 모델선택) ──
with st.container():
    c_left, c_spacer, c_right = st.columns([1, 4, 1.5])

    with c_left:
        with st.popover("＋"):
            st.session_state.role = st.radio(
                "역할",
                options=["기획자", "프로그래머", "QA", "PD"],
                index=["기획자", "프로그래머", "QA", "PD"].index(
                    st.session_state.role if st.session_state.role in ["기획자", "프로그래머", "QA", "PD"] else "기획자"
                ),
                horizontal=True,
            )
            st.session_state.max_chunks = st.slider(
                "검색 청크 수", min_value=5, max_value=50,
                value=st.session_state.max_chunks, step=5,
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
        )

# 세션에서 값 읽기 (아래 Agent 호출에서 사용)
role = st.session_state.role
max_chunks = st.session_state.max_chunks
planning_model = st.session_state.planning_model
answer_model = st.session_state.answer_model
reflection_model = st.session_state.reflection_model

# ── 입력 ──
if prompt := st.chat_input("기획 질문을 입력하세요..."):
    # 사용자 메시지 추가
    st.session_state.messages.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)

    # Agent 호출 — 각 단계를 개별 실행하며 실시간 상태 표시
    with st.chat_message("assistant"):
        status = st.status("Agent가 답변을 준비하고 있습니다...", expanded=True)
        trace = []
        total_tokens = 0
        t0 = time.time()

        with status:
            # ── Step 1: Planning ──
            t1 = time.time()
            with st.spinner("🧠 질문을 분석하고 있습니다..."):
                plan = plan_search(prompt, role=role, model=planning_model)
            plan_time = time.time() - t1
            total_tokens += plan.get("_tokens", 0)

            key_systems = plan.get("key_systems", [])
            query_type = plan.get("query_type", "?")
            sys_display = ", ".join(key_systems[:3]) if key_systems else "자동 검색"
            st.write(f"✅ 분석 완료 — **{sys_display}** 검색 예정 ({plan_time:.1f}초)")

            trace.append({
                "step": "planning", "model": planning_model,
                "description": "질문 분석 + 워크북 선택 + KG 관계 참조",
                "output": {
                    "key_systems": key_systems,
                    "query_type": query_type,
                    "search_keywords": plan.get("search_keywords", []),
                    "reasoning": plan.get("reasoning", ""),
                },
                "tokens": plan.get("_tokens", 0),
                "seconds": round(plan_time, 1),
            })

            # ── Step 2: Search ──
            t2 = time.time()
            with st.spinner("🔎 기획서에서 관련 내용을 검색하고 있습니다..."):
                chunks = execute_search(plan, prompt, max_chunks=max_chunks)
            search_time = time.time() - t2

            workbooks_found = sorted(set(c.get("workbook", "?") for c in chunks))
            wb_short = [w.replace("PK_", "") for w in workbooks_found[:4]]
            st.write(f"✅ **{len(chunks)}개** 청크 발견 — {', '.join(wb_short)} ({search_time:.1f}초)")

            trace.append({
                "step": "search", "model": None,
                "description": "하이브리드 4레이어 검색",
                "chunks_count": len(chunks),
                "workbooks_found": workbooks_found,
                "seconds": round(search_time, 1),
            })

            # ── Step 3: Answer Generation ──
            t3 = time.time()
            with st.spinner("✍️ 답변을 생성하고 있습니다..."):
                gen_result = generate_agent_answer(prompt, chunks, role, key_systems=key_systems, model=answer_model)
            gen_time = time.time() - t3
            total_tokens += gen_result.get("tokens", 0)

            answer = gen_result["answer"]
            st.write(f"✅ 답변 생성 완료 ({gen_time:.1f}초)")

            trace.append({
                "step": "answer_generation", "model": answer_model,
                "description": "검색 결과 기반 답변 생성",
                "answer_preview": answer[:200] + "..." if len(answer) > 200 else answer,
                "tokens": gen_result.get("tokens", 0),
                "seconds": round(gen_time, 1),
            })

            # ── Step 4: Reflection ──
            t4 = time.time()
            with st.spinner("🪞 답변 품질을 검증하고 있습니다..."):
                reflection = reflect_on_answer(prompt, answer, chunks, plan, model=reflection_model)
            ref_time = time.time() - t4
            total_tokens += reflection.get("_tokens", 0)

            confidence = reflection.get("confidence", "medium")

            trace.append({
                "step": "reflection", "model": reflection_model,
                "description": "자체 품질 검증",
                "output": {
                    "is_sufficient": reflection.get("is_sufficient", True),
                    "confidence": confidence,
                    "missing_info": reflection.get("missing_info", ""),
                },
                "tokens": reflection.get("_tokens", 0),
                "seconds": round(ref_time, 1),
            })

            # ── Step 4b: Retry if needed ──
            if not reflection.get("is_sufficient", True):
                t5 = time.time()
                with st.spinner("🔄 정보가 부족합니다. 재검색 중..."):
                    extra_chunks = execute_retry_search(reflection, prompt, chunks)
                    if extra_chunks:
                        merged = {c["id"]: c for c in chunks}
                        for c in extra_chunks:
                            if c["id"] not in merged:
                                merged[c["id"]] = c
                        chunks = sorted(merged.values(), key=lambda x: x.get("score", 0), reverse=True)[:20]

                    gen_result2 = generate_agent_answer(prompt, chunks, role, key_systems=key_systems, model=answer_model)
                retry_time = time.time() - t5
                total_tokens += gen_result2.get("tokens", 0)
                answer = gen_result2["answer"]

                st.write(f"✅ 재검색 완료 — +{len(extra_chunks)}개 청크 추가 ({retry_time:.1f}초)")

                trace.append({
                    "step": "retry", "model": answer_model,
                    "description": "재검색 + 재답변",
                    "extra_chunks": len(extra_chunks),
                    "tokens": gen_result2.get("tokens", 0),
                    "seconds": round(retry_time, 1),
                })
            else:
                st.write(f"✅ 검증 통과 — 신뢰도: {confidence}")

        total_time = time.time() - t0
        status.update(label=f"완료 ({total_time:.1f}초)", state="complete", expanded=False)

        # 답변 렌더링
        render_answer_markdown(answer)

        # 소스 추출
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

        api_seconds = round(total_time, 1)
        meta = {
            "confidence": confidence,
            "total_tokens": total_tokens,
            "api_seconds": api_seconds,
            "sources": sources[:10],
            "trace": trace,
        }

        st.markdown(
            f'<div class="metric-bar">'
            f'신뢰도: {format_confidence(confidence)} · '
            f'토큰: {total_tokens:,} · '
            f'응답: {api_seconds}초'
            f'</div>',
            unsafe_allow_html=True,
        )
        render_sources(sources[:10])
        render_trace(trace)

        # DB에 QnA 이력 저장
        qna_id = save_qna(
            question=prompt, answer=answer, role=role,
            confidence=confidence, total_tokens=total_tokens,
            api_seconds=api_seconds, sources=sources[:10], trace=trace,
            planning_model=planning_model, answer_model=answer_model,
            reflection_model=reflection_model, max_chunks=max_chunks,
        )

        # 세션에 저장
        msg_idx = len(st.session_state.messages)
        st.session_state.messages.append({
            "role": "assistant",
            "content": answer,
            "meta": meta,
            "qna_id": qna_id,
        })
        render_feedback(msg_idx)