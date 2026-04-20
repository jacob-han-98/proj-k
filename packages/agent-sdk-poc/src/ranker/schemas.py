"""Anthropic tool_use 로 강제할 JSON Schema (Structured Output).

각 Stage의 출력을 스키마로 묶어 파싱 실패·환각을 방지한다. `tool_choice` 로 강제.
decisions/schema/*.schema.json 과는 별개 — 이쪽은 LLM 호출 시 전달하는 tool 스펙이다.
"""
from __future__ import annotations

from typing import Any

# Stage 1 — Evidence collection output
STAGE1_EVIDENCE_TOOL: dict[str, Any] = {
    "name": "record_evidence",
    "description": "차원별 raw evidence 리스트를 기록한다. 각 evidence는 Citations의 cited_text를 반드시 포함.",
    "input_schema": {
        "type": "object",
        "required": ["system_name", "dimension", "evidence"],
        "properties": {
            "system_name": {"type": "string"},
            "dimension": {"enum": ["conflict", "hub", "staleness", "confusion", "term_drift"]},
            "evidence": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["cited_text", "source", "reason", "confidence"],
                    "properties": {
                        "cited_text": {"type": "string"},
                        "source": {
                            "type": "object",
                            "properties": {
                                "kind": {"enum": ["excel", "confluence"]},
                                "workbook": {"type": "string"},
                                "sheet": {"type": "string"},
                                "space": {"type": "string"},
                                "page_path": {"type": "string"},
                                "section_path": {"type": "string"},
                            },
                        },
                        "reason": {"type": "string"},
                        "confidence": {"enum": ["high", "medium", "low"]},
                    },
                },
            },
        },
    },
}

# Stage 2 — CoV verdict
STAGE2_COV_TOOL: dict[str, Any] = {
    "name": "verify_evidence",
    "description": "각 evidence를 재검증해 verdict와 최종 confidence를 기록한다.",
    "input_schema": {
        "type": "object",
        "required": ["verdicts"],
        "properties": {
            "verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["evidence_id", "verdict", "final_confidence", "reason"],
                    "properties": {
                        "evidence_id": {"type": "string"},
                        "verdict": {"enum": ["confirmed", "rejected", "uncertain"]},
                        "final_confidence": {"enum": ["high", "medium", "low"]},
                        "reason": {"type": "string"},
                    },
                },
            }
        },
    },
}

# Stage 3 — Per-dimension scoring
STAGE3_SCORING_TOOL: dict[str, Any] = {
    "name": "score_dimension",
    "description": "한 시스템의 한 차원에 대해 0~10 점수와 자연어 rationale을 기록한다.",
    "input_schema": {
        "type": "object",
        "required": ["system_name", "dimension", "value", "rationale"],
        "properties": {
            "system_name": {"type": "string"},
            "dimension": {"enum": ["conflict", "hub", "staleness", "confusion", "term_drift"]},
            "value": {"type": "number", "minimum": 0, "maximum": 10},
            "rationale": {"type": "string"},
        },
    },
}

# Stage 4 — Judge output
STAGE4_JUDGE_TOOL: dict[str, Any] = {
    "name": "rank_targets",
    "description": (
        "차원별 점수와 evidence를 종합해 최종 랭킹과 등급을 부여한다. "
        "rationale은 2~3문장 자연어. 절대 원칙: '작업물이 나쁘다' 프레이밍 금지, "
        "책임 귀속 금지, 모든 주장은 evidence로 뒷받침."
    ),
    "input_schema": {
        "type": "object",
        "required": ["ranking"],
        "properties": {
            "ranking": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["name", "grade", "rationale"],
                    "properties": {
                        "name": {"type": "string"},
                        "grade": {"enum": ["S", "A", "B", "C"]},
                        "rationale": {"type": "string"},
                        "blast_radius": {
                            "type": "object",
                            "properties": {
                                "affected_count": {"type": "integer"},
                                "top_affected": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                        "effort": {"enum": ["S", "M", "L"]},
                        "confidence_flags": {
                            "type": "array",
                            "items": {
                                "enum": [
                                    "self_consistency_low",
                                    "evidence_sparse",
                                    "domain_unclear",
                                ]
                            },
                        },
                    },
                },
            }
        },
    },
}
