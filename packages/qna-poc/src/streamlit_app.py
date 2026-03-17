"""
streamlit_app.py — Project K QnA Streamlit UI

ChatGPT 스타일 대화형 인터페이스.
실행: cd packages/qna-poc && streamlit run src/streamlit_app.py
"""

import os
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


# ── 사이드바 (최소화) ──
with st.sidebar:
    st.title("🎮 Project K QnA")

    if st.button("🗑️ 대화 초기화", use_container_width=True):
        st.session_state.messages = []
        st.session_state.feedback = {}
        st.rerun()

    st.divider()

    if st.button("📊 지식 베이스", use_container_width=True):
        show_kb_viewer()

    st.divider()
    stats = get_stats()
    st.caption(f"총 {stats['total_qna']}건 · 👍 {stats['thumbs_up']} · 👎 {stats['thumbs_down']}")
    st.caption("PoC v0.2.0")

# ── 세션 기본값 ──
MODEL_OPTIONS = ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]
MODEL_LABELS = {"claude-opus-4-5": "Opus", "claude-sonnet-4-5": "Sonnet", "claude-haiku-4-5": "Haiku"}
PROMPT_STYLE_OPTIONS = ["검증세트 최적화", "기본"]
if "role" not in st.session_state:
    st.session_state.role = "기획자"
if "answer_model" not in st.session_state:
    st.session_state.answer_model = "claude-opus-4-5"
if "planning_model" not in st.session_state:
    st.session_state.planning_model = "claude-opus-4-5"
if "reflection_model" not in st.session_state:
    st.session_state.reflection_model = "claude-opus-4-5"
if "prompt_style" not in st.session_state:
    st.session_state.prompt_style = "기본"

# 처리 중 플래그 (chat_input split-rerun 패턴)
_is_processing = "_pending_prompt" in st.session_state


# ── 메인: 웰컴 화면 or 대화 ──
if not st.session_state.messages:
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
    ]
    _pad_l, _center, _pad_r = st.columns([2, 1.5, 2])
    with _center:
        _c1, _c2 = st.columns(2, gap="small")
        for _i, _text in enumerate(_presets):
            with (_c1 if _i % 2 == 0 else _c2):
                if st.button(_text, key=f"preset_{_i}", use_container_width=True):
                    st.session_state.messages.append({"role": "user", "content": _text})
                    st.session_state["_pending_prompt"] = _text
                    st.rerun()

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

# ── 입력 ──
if prompt := st.chat_input("기획 질문을 입력하세요...", disabled=_is_processing):
    st.session_state.messages.append({"role": "user", "content": prompt})
    st.session_state["_pending_prompt"] = prompt
    st.rerun()

# ── 질문 처리 (split-rerun: 옵션 비활성 상태에서 실행) ──
if "_pending_prompt" in st.session_state:
    prompt = st.session_state.pop("_pending_prompt")

    # 이전 대화 히스토리 수집 (최근 3턴, 현재 질문 제외)
    conv_history = []
    msgs = st.session_state.messages[:-1]  # 현재 user 메시지 제외
    for i in range(0, len(msgs) - 1, 2):
        if msgs[i]["role"] == "user" and i + 1 < len(msgs) and msgs[i + 1]["role"] == "assistant":
            conv_history.append((msgs[i]["content"], msgs[i + 1]["content"]))
    conv_history = conv_history[-3:]  # 최근 3턴

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
            t2 = time.time()
            with st.spinner("🔎 기획서에서 관련 내용을 검색하고 있습니다..."):
                chunks = execute_search(plan, prompt)
            search_time = time.time() - t2

            # 컨텍스트 토큰 계산 → 토큰 버짓 기반 자동 분기 결정
            context_tokens = sum(c.get("tokens", 0) for c in chunks)
            workbooks_found = sorted(set(c.get("workbook", "?") for c in chunks))
            wb_short = [w.replace("PK_", "") for w in workbooks_found[:4]]
            _use_deep_research = context_tokens > TOKEN_BUDGET

            if _use_deep_research:
                st.write(
                    f"📊 **{len(chunks)}개** 청크, **{context_tokens:,}** 토큰 "
                    f"(버짓 {TOKEN_BUDGET:,} 초과) → 딥 리서치 자동 전환"
                )
            else:
                st.write(f"✅ **{len(chunks)}개** 청크 발견 — {', '.join(wb_short)} ({search_time:.1f}초)")

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

            trace.append({
                "step": "search", "model": None,
                "description": "하이브리드 4레이어 검색",
                "tools_used": tools_used,
                "chunks_count": len(chunks),
                "context_tokens": context_tokens,
                "token_budget": TOKEN_BUDGET,
                "auto_deep_research": _use_deep_research,
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

            # ── 딥 리서치 / 일반 답변 자동 분기 ──
            _dr_sources = None
            if _use_deep_research:
                # ── 딥 리서치 경로: Scratchpad Loop ──
                with st.spinner("📚 전체 관련 문서를 스캔하고 있습니다..."):
                    scan = scan_all_related_chunks(prompt, plan)
                total_related = scan["total_chunks"]
                wb_count = len(scan["workbook_summary"])

                src = scan.get("source_stats", {})
                ks_count = len(src.get("key_systems", []))
                kw_count = len(src.get("keyword", []))
                vec_count = len(src.get("vector", []))
                parts = []
                if ks_count:
                    parts.append(f"Planning {ks_count}개")
                if kw_count:
                    parts.append(f"키워드 {kw_count}개")
                if vec_count:
                    parts.append(f"벡터 {vec_count}개")
                source_detail = f" ({' + '.join(parts)})" if parts else ""
                st.write(f"🔬 **딥 리서치 시작** — {wb_count}개 문서{source_detail}, {total_related}개 청크 전체 분석")

                # Scratchpad 진행 상황 표시
                _progress_placeholder = st.empty()

                def _progress(step_name, detail):
                    _progress_placeholder.caption(f"📝 {detail}")

                dr_result = deep_research(prompt, plan, scan, progress_callback=_progress,
                                          model=answer_model, prompt_style=prompt_style)
                _progress_placeholder.empty()

                # 전략 표시
                strategy = dr_result.get("strategy", "scratchpad")
                est_tokens = dr_result.get("estimated_context_tokens", 0)
                if strategy == "direct":
                    st.write(f"⚡ **원본 직접 분석** — {est_tokens:,} 토큰을 직접 전달")
                else:
                    st.write(f"📝 **Scratchpad 분석** — {est_tokens:,} 토큰 (순차 분석 + 교차 참조)")

                answer = dr_result["answer"]
                chunks = dr_result["chunks"]
                trace.extend(dr_result["trace"])
                total_tokens += dr_result["total_tokens"]
                confidence = dr_result["confidence"]

                _dr_sources = []
                for gs in dr_result["group_summaries"]:
                    _dr_sources.append({
                        "workbook": gs["workbook"],
                        "sheet": f"{gs['chunks_count']}개 청크 분석",
                        "section_path": "",
                        "score": 0,
                    })
                chunks = []

                st.write(
                    f"✅ 딥 리서치 완료 — "
                    f"**{dr_result['workbooks_analyzed']}개 문서**, "
                    f"**{dr_result['chunks_analyzed']}건** 분석 "
                    f"({dr_result['total_api_seconds']:.1f}초)"
                )

                with st.expander(f"📊 워크북별 분석 ({len(dr_result['group_summaries'])}개)", expanded=False):
                    for gs in dr_result["group_summaries"]:
                        wb_name = gs["workbook"].replace("PK_", "").split("/")[-1]
                        st.markdown(f"**{wb_name}** ({gs['chunks_count']}청크, {gs['seconds']:.1f}s)")
                        st.caption(gs["summary"][:300] + "..." if len(gs["summary"]) > 300 else gs["summary"])
                        st.divider()

            else:
                # ── 일반 답변 경로 ──

                # ── Step 3: Answer Generation ──
                t3 = time.time()
                with st.spinner("✍️ 답변을 생성하고 있습니다..."):
                    gen_result = generate_agent_answer(prompt, chunks, role, key_systems=key_systems, model=answer_model,
                                                        conversation_history=conv_history or None,
                                                        prompt_style=prompt_style)
                gen_time = time.time() - t3
                total_tokens += gen_result.get("tokens", 0)

                answer = gen_result["answer"]
                st.write(f"✅ 답변 생성 완료 ({gen_time:.1f}초)")

                trace.append({
                    "step": "answer_generation", "model": answer_model,
                    "description": "검색 결과 기반 답변 생성",
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
                        "retry_query": reflection.get("retry_query", ""),
                        "retry_systems": reflection.get("retry_systems", []),
                    },
                    "tokens": reflection.get("_tokens", 0),
                    "raw_response": reflection.get("_raw_response", ""),
                    "system_prompt": reflection.get("_system_prompt", ""),
                    "user_prompt": reflection.get("_user_prompt", ""),
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

                        gen_result2 = generate_agent_answer(prompt, chunks, role, key_systems=key_systems, model=answer_model,
                                                            conversation_history=conv_history or None,
                                                            prompt_style=prompt_style)
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

        # 소스 추출 (딥 리서치: 워크북 단위 / 일반: 청크 단위)
        if _dr_sources:
            sources = _dr_sources
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

        api_seconds = round(total_time, 1)
        meta = {
            "confidence": confidence,
            "total_tokens": total_tokens,
            "api_seconds": api_seconds,
            "sources": sources,
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
        render_sources(sources)
        render_trace(trace)

        # DB에 QnA 이력 저장
        qna_id = save_qna(
            question=prompt, answer=answer, role=role,
            confidence=confidence, total_tokens=total_tokens,
            api_seconds=api_seconds, sources=sources, trace=trace,
            planning_model=planning_model, answer_model=answer_model,
            reflection_model=reflection_model,
        )

        # 세션에 저장
        msg_idx = len(st.session_state.messages)
        st.session_state.messages.append({
            "role": "assistant",
            "content": answer,
            "meta": meta,
            "qna_id": qna_id,
            "_chunks": chunks,
            "_key_systems": key_systems,
            "_question": prompt,
            "_used_model": answer_model,
            "_used_prompt_style": prompt_style,
        })
        render_feedback(msg_idx)
        render_retry_panel(msg_idx)

    # 답변 완료 → rerun하여 chat_input 다시 활성화
    st.rerun()