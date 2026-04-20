"""Stage별 / 차원별 프롬프트 템플릿.

실제 프롬프트 본문은 차원 구현 시 채워진다. 프레이밍 원칙은 decisions/config/ranker_rubric.md 참조.
"""
from __future__ import annotations

# Rubric 파일 로더 (Judge 시스템 프롬프트에 삽입)
from pathlib import Path

RUBRIC_PATH = Path(__file__).resolve().parents[2] / "decisions" / "config" / "ranker_rubric.md"


def load_rubric() -> str:
    return RUBRIC_PATH.read_text(encoding="utf-8")


# Stage별 프롬프트 placeholder — 차원 구현 시 채움
STAGE1_CONFLICT_PROMPT = ""  # TODO
STAGE1_HUB_PROMPT = ""  # TODO
STAGE1_STALENESS_PROMPT = ""  # TODO
STAGE1_CONFUSION_PROMPT_HAIKU = ""  # TODO (1차 스크리닝)
STAGE1_CONFUSION_PROMPT_SONNET = ""  # TODO (2차 정독)
STAGE1_TERM_DRIFT_PROMPT = ""  # TODO

STAGE2_COV_PROMPT = ""  # TODO
STAGE3_SCORING_PROMPT = ""  # TODO
STAGE4_JUDGE_PROMPT = ""  # TODO
