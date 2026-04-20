"""Stage 3 — Per-dimension scoring (공식 기반, LLM 없음).

원칙: 점수는 **결정론적 공식**으로 계산해 환각 여지를 없앤다.
rationale(자연어 근거)은 Stage 4 Judge가 LLM으로 종합 작성한다. 여기서는 fact 요약만.

정규화: 스캔 대상 시스템 집합의 max(raw) 기준으로 0~10 스케일.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .conflict import ConflictEvidence
from .hub import HubEvaluation

_CONFLICT_CONFIDENCE_WEIGHT = {"high": 3.0, "medium": 1.5, "low": 0.7}


@dataclass
class DimensionScore:
    value: float  # 0~10 (정규화 후)
    raw: float  # 정규화 전 raw
    facts: dict[str, Any]  # Judge 에 넘길 요약 수치


# ---- Conflict ------------------------------------------------------------

def conflict_raw(verified_evidence: list[ConflictEvidence]) -> tuple[float, dict[str, Any]]:
    """Confidence-weighted verified count (중복 제거: topic 기준).

    같은 topic에 대해 excel/confluence 양쪽 evidence가 짝으로 들어오므로 topic 단위로 집계.
    """
    # topic -> max confidence
    topic_weight: dict[str, float] = {}
    for ev in verified_evidence:
        if ev.verdict not in (None, "confirmed", "uncertain"):
            continue
        w = _CONFLICT_CONFIDENCE_WEIGHT.get(ev.confidence, 0.5)
        key = f"{ev.conflict_type}::{ev.topic}"
        if w > topic_weight.get(key, 0.0):
            topic_weight[key] = w

    raw = sum(topic_weight.values())
    n_topics = len(topic_weight)
    by_conf = {c: 0 for c in ("high", "medium", "low")}
    for ev in verified_evidence:
        if ev.confidence in by_conf:
            by_conf[ev.confidence] += 1

    confirmed = sum(1 for e in verified_evidence if e.verdict == "confirmed")
    uncertain = sum(1 for e in verified_evidence if e.verdict == "uncertain")

    facts = {
        "distinct_topics": n_topics,
        "verified_evidence": len(verified_evidence),
        "confirmed": confirmed,
        "uncertain": uncertain,
        "by_confidence": by_conf,
        "sample_topics": sorted(topic_weight.keys(), key=lambda k: -topic_weight[k])[:5],
    }
    return raw, facts


# ---- Hub -----------------------------------------------------------------

def hub_raw(evaluation: HubEvaluation) -> tuple[float, dict[str, Any]]:
    raw = evaluation.weighted_degree
    facts = {
        "raw_degree": evaluation.raw_degree,
        "weighted_degree": round(raw, 2),
        "strong": evaluation.strong_count,
        "weak": evaluation.weak_count,
        "loose": evaluation.loose_count,
        "top_strong_targets": [e.target for e in evaluation.edges if e.strength == "strong"][:5],
    }
    return raw, facts


# ---- Normalization -------------------------------------------------------

def normalize(raw_by_system: dict[str, float]) -> dict[str, float]:
    """max 기준 0~10 스케일. 모든 raw 가 0이면 모두 0."""
    if not raw_by_system:
        return {}
    top = max(raw_by_system.values())
    if top <= 0:
        return {k: 0.0 for k in raw_by_system}
    return {k: round(v * 10.0 / top, 2) for k, v in raw_by_system.items()}
