"""Refactor Target Ranker

5개 차원(Conflict / Hub / Staleness / Confusion / Term Drift)으로 기획서 리팩토링 대상을
LLM 기반으로 판정해 Top N 후보를 등급과 함께 제시한다.

Pipeline:
    Stage 1 — Evidence collection (per-dimension, Sonnet + thinking, Structured Output, Citations)
    Stage 2 — Chain-of-Verification (false positive 제거)
    Stage 3 — Per-dimension scoring (0~10 + rationale)
    Stage 4 — LLM-as-Judge (최종 랭킹 + S/A/B/C 등급)
    Stage 5 — Self-Consistency (3회 샘플링, 상위 K 일치율 측정)

상세 설계: docs 루트 계획서 및 `decisions/config/ranker_rubric.md`.
"""

__version__ = "0.1.0-skeleton"
