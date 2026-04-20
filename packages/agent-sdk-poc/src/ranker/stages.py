"""Ranker Pipeline Stages (1~5)

각 Stage는 독립적으로 호출 가능하게 설계한다 (테스트·재시도 용이).
실제 구현은 차원별 후속 커밋에서 추가된다. 현재는 인터페이스 정의 + TODO 스켈레톤.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Dimension = Literal["conflict", "hub", "staleness", "confusion", "term_drift"]
Confidence = Literal["high", "medium", "low"]


@dataclass
class Evidence:
    dimension: Dimension
    cited_text: str
    source: dict[str, Any]
    reason: str
    confidence: Confidence
    verified_by_cov: bool = False


@dataclass
class DimensionScore:
    value: float  # 0~10
    rationale: str
    evidence: list[Evidence] = field(default_factory=list)


@dataclass
class SystemEvaluation:
    name: str
    scores: dict[Dimension, DimensionScore] = field(default_factory=dict)


# ---- Stage 1: Evidence collection ----------------------------------------

def collect_evidence(
    systems: list[str],
    dimension: Dimension,
) -> dict[str, list[Evidence]]:
    """Stage 1 — 시스템별 해당 차원의 raw evidence 수집.

    Sonnet + extended thinking + Anthropic Citations 조합. Structured Output(tool_use) 필수.
    Prompt caching으로 코퍼스 컨텍스트 1h TTL 캐시.
    """
    raise NotImplementedError("stage 1 per dimension — to be implemented")


# ---- Stage 2: Chain-of-Verification --------------------------------------

def verify_evidence(raw: dict[str, list[Evidence]]) -> dict[str, list[Evidence]]:
    """Stage 2 — CoV. 각 evidence를 Sonnet이 재검증.
    '정말 문제인가 / 의도된 설계인가 / 이미 해결되었는가'. False positive 필터링."""
    raise NotImplementedError("stage 2 CoV — to be implemented")


# ---- Stage 3: Per-dimension scoring --------------------------------------

def score_dimensions(
    verified: dict[Dimension, dict[str, list[Evidence]]],
) -> dict[str, SystemEvaluation]:
    """Stage 3 — verified_evidence → 0~10 점수 + 자연어 rationale."""
    raise NotImplementedError("stage 3 scoring — to be implemented")


# ---- Stage 4: LLM-as-Judge -----------------------------------------------

def judge_ranking(
    evaluations: dict[str, SystemEvaluation],
    feedback_few_shots: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Stage 4 — Sonnet + thinking이 전체 시스템을 비교해 최종 랭킹 + S/A/B/C 등급.

    Rubric: `decisions/config/ranker_rubric.md` 를 시스템 프롬프트에 포함.
    feedback.jsonl의 최근 유효한 레코드를 few-shot으로 주입.
    """
    raise NotImplementedError("stage 4 judge — to be implemented")


# ---- Stage 5: Self-Consistency -------------------------------------------

def self_consistency(
    evaluations: dict[str, SystemEvaluation],
    feedback_few_shots: list[dict[str, Any]],
    samples: int = 3,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Stage 5 — Stage 4를 서로 다른 seed/temperature로 N회 샘플링.

    상위 K 일치율이 낮은 타겟은 confidence_flags에 'self_consistency_low' 추가.
    """
    raise NotImplementedError("stage 5 self-consistency — to be implemented")
