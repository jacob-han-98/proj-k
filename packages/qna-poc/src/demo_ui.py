"""
demo_ui.py — Gradio 채팅 인터페이스

Usage:
    python -m src.demo_ui
"""

import os
import sys
from pathlib import Path

import gradio as gr
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from src.retriever import retrieve, format_context, extract_system_names, get_related_systems
from src.generator import generate_answer


# 대화 상태
conversations = {}


def chat(message: str, history: list, role: str):
    """채팅 핸들러."""
    if not message.strip():
        return ""

    # 검색
    chunks, retrieval_info = retrieve(message, top_k=12)
    if not chunks:
        return "관련 기획서를 찾을 수 없습니다. 질문을 다시 표현해 주세요."

    context = format_context(chunks)

    # 대화 히스토리 변환
    conv_history = []
    for prev in history[-3:]:
        if isinstance(prev, (list, tuple)) and len(prev) == 2:
            conv_history.append((prev[0], prev[1]))

    # 답변 생성
    try:
        result = generate_answer(
            question=message,
            context=context,
            role=role if role != "선택 안 함" else None,
            conversation_history=conv_history,
        )
    except Exception as e:
        return f"답변 생성 오류: {str(e)}"

    # 출처 정보 포맷
    answer = result["answer"]

    # 메타 정보 추가
    meta_parts = []
    if result.get("sources"):
        source_strs = []
        for s in result["sources"][:5]:
            source_strs.append(f"  - {s.get('workbook', '')} / {s.get('sheet', '')}")
        if source_strs:
            meta_parts.append("**참조한 기획서:**\n" + "\n".join(source_strs))

    # 관련 시스템
    detected = extract_system_names(message)
    related = []
    for sys_name in detected[:2]:
        related.extend(get_related_systems(sys_name, depth=1))
    related = sorted(set(related) - set(detected))[:5]
    if related:
        meta_parts.append(f"**관련 시스템:** {', '.join(related)}")

    # 검색 해석 정보
    if retrieval_info:
        ri_parts = []
        if retrieval_info.get("detected_systems"):
            ri_parts.append(f"감지 시스템: {', '.join(retrieval_info['detected_systems'])}")
        if retrieval_info.get("layers_used"):
            ri_parts.append(f"검색 레이어: {', '.join(retrieval_info['layers_used'])}")
        dist = retrieval_info.get("final_source_distribution", {})
        if dist:
            dist_str = ", ".join(f"{k}:{v}" for k, v in dist.items())
            ri_parts.append(f"결과 구성: {dist_str}")
        if ri_parts:
            meta_parts.append("**검색 해석:** " + " | ".join(ri_parts))

    meta_parts.append(
        f"*토큰: {result['tokens_used']['input']:,} in / {result['tokens_used']['output']:,} out "
        f"| 응답: {result['api_seconds']}초 | 신뢰도: {result['confidence']}*"
    )

    if meta_parts:
        answer += "\n\n---\n" + "\n".join(meta_parts)

    return answer


def main():
    demo = gr.ChatInterface(
        fn=chat,
        title="Project K 기획 QnA PoC",
        description="104개 Excel 기획서 (623시트) 기반 AI QnA. 질문을 입력하세요.",
        additional_inputs=[
            gr.Dropdown(
                choices=["선택 안 함", "기획자", "프로그래머", "QA", "PD"],
                value="선택 안 함",
                label="역할",
                info="역할에 따라 답변 스타일이 달라집니다.",
            ),
        ],
        examples=[
            ["변신 에픽 등급의 적용 스텟 수와 스킬 개수는?"],
            ["스킬 시전에서 명중 판정까지의 전체 시퀀스를 설명해줘"],
            ["변신 시스템과 스킬 시스템은 어떻게 연동되는가?"],
            ["NPC 상인의 구매/판매 플로우 차이점은?"],
            ["현재 기획서가 존재하는 시스템 전체 리스트는?"],
        ],
        retry_btn=None,
        undo_btn=None,
    )

    demo.launch(server_name="0.0.0.0", server_port=7860, share=False)


if __name__ == "__main__":
    main()
