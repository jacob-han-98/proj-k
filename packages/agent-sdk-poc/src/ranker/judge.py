"""Stage 4 — LLM-as-Judge 최종 랭킹.

모든 시스템의 차원별 점수 + facts + top evidence 를 한 번의 Sonnet 호출에 넘겨
S/A/B/C 등급과 자연어 rationale을 받는다. Self-Consistency 필요 시 여러 번 샘플.

prompt caching: rubric + 공통 프레이밍 원칙을 system 프롬프트 앞부분에 ephemeral 캐시 배치.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from . import llm

_PKG_ROOT = Path(__file__).resolve().parents[2]
RUBRIC_PATH = _PKG_ROOT / "decisions" / "config" / "ranker_rubric.md"


JUDGE_TOOL: dict[str, Any] = {
    "name": "rank_refactor_targets",
    "description": (
        "각 시스템에 등급(S/A/B/C)과 rationale, blast_radius, effort, confidence_flags 를 "
        "부여해 최종 랭킹을 기록한다."
    ),
    "input_schema": {
        "type": "object",
        "required": ["ranking"],
        "properties": {
            "ranking": {
                "type": "array",
                "description": "등급 우선 → 점수 우선으로 정렬한 랭킹.",
                "items": {
                    "type": "object",
                    "required": ["name", "grade", "rationale"],
                    "properties": {
                        "name": {"type": "string", "description": "시스템 이름 정확 복사"},
                        "grade": {"enum": ["S", "A", "B", "C"]},
                        "rationale": {
                            "type": "string",
                            "description": (
                                "2~3문장 자연어. 왜 이 등급인지. 중립 프레이밍. "
                                "'정리하면 이득' 구도. 책임 귀속 금지."
                            ),
                        },
                        "blast_radius_note": {
                            "type": "string",
                            "description": "고치면 영향받는 범위 짧게 (예: '전투·스탯·HUD 3개 허브에 직접 결합').",
                        },
                        "effort": {"enum": ["S", "M", "L"]},
                        "confidence_flags": {
                            "type": "array",
                            "items": {"enum": ["evidence_sparse", "domain_unclear", "self_consistency_low"]},
                        },
                    },
                },
            }
        },
    },
}


def _build_system_prompt() -> list[dict[str, Any]]:
    rubric = RUBRIC_PATH.read_text(encoding="utf-8")
    # 캐시 블록 (rubric은 거의 불변이라 1h TTL에 적합)
    return [
        {"type": "text", "text": "당신은 기획서 리팩토링 Ranker의 최종 Judge다."},
        {
            "type": "text",
            "text": "---\n\n" + rubric,
            "cache_control": {"type": "ephemeral"},
        },
    ]


def _serialize_candidates(
    dim_scores: dict[str, dict[str, Any]],
    conflict_facts: dict[str, dict[str, Any]],
    hub_facts: dict[str, dict[str, Any]],
    evidence_samples: dict[str, list[dict[str, Any]]],
) -> str:
    lines: list[str] = []
    for name, dims in dim_scores.items():
        lines.append(f"## {name}")
        for dim, score in dims.items():
            lines.append(f"- {dim}: value={score.value}  raw={score.raw:.2f}")
        lines.append(f"- conflict_facts: {conflict_facts.get(name, {})}")
        lines.append(f"- hub_facts: {hub_facts.get(name, {})}")
        samples = evidence_samples.get(name, [])
        if samples:
            lines.append("- top_evidence_samples:")
            for s in samples[:3]:
                lines.append(f"    * [{s.get('dimension', '?')}|{s.get('confidence', '?')}] {s.get('topic', '')}: {s.get('cited_text', '')[:120]}")
        lines.append("")
    return "\n".join(lines)


def rank(
    dim_scores: dict[str, dict[str, Any]],
    *,
    conflict_facts: dict[str, dict[str, Any]],
    hub_facts: dict[str, dict[str, Any]],
    evidence_samples: dict[str, list[dict[str, Any]]],
    feedback_few_shots: list[dict[str, Any]] | None = None,
    model: str = "sonnet",
    max_tokens: int = 12000,
    temperature: float = 0.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """최종 랭킹 생성.

    Returns (ranking, meta). ranking의 각 원소는 JUDGE_TOOL 스키마를 따른다.
    """
    system_blocks = _build_system_prompt()

    few_shot_block = ""
    if feedback_few_shots:
        few_shot_lines = ["## 사용자 피드백(최근)", ""]
        for fb in feedback_few_shots[-8:]:
            few_shot_lines.append(
                f"- [{fb.get('action')}] {fb.get('target_name')}: {fb.get('comment', '')}"
            )
            if fb.get("action") == "regrade" and fb.get("regrade_to"):
                few_shot_lines.append(f"  → 제안 등급: {fb['regrade_to']}")
        few_shot_block = "\n".join(few_shot_lines)

    user_content = (
        "# 입력 — 스캔 대상 시스템의 차원별 점수와 facts, 증거 샘플\n\n"
        f"{_serialize_candidates(dim_scores, conflict_facts, hub_facts, evidence_samples)}\n\n"
        f"{few_shot_block}\n\n"
        "# 작업\n\n"
        "각 시스템에 등급(S/A/B/C) + rationale + blast_radius_note + effort 를 부여하라. "
        "등급 기준은 rubric을 엄수한다. 모든 시스템을 빠짐없이 평가. "
        "reason은 '이 시스템이 나쁘다' 프레이밍 금지, '정리하면 이득' 구도. "
        "반드시 tool `rank_refactor_targets` 로만 기록한다."
    )

    result = llm.call_structured(
        messages=[{"role": "user", "content": user_content}],
        system=system_blocks,
        tool=JUDGE_TOOL,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    ranking = result["tool_input"].get("ranking", [])
    meta = {"usage": result.get("usage", {}), "stop_reason": result.get("stop_reason")}
    return ranking, meta
