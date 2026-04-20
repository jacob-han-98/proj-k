"""Prompt caching 블록 구성.

코퍼스 컨텍스트(MASTER_INDEX 발췌 + knowledge_graph 축약 + rubric)를 시스템 프롬프트 앞부분에
`cache_control: {type: "ephemeral"}` 로 배치해 1시간 TTL 캐시. 여러 차원 분석이 같은 코퍼스를
반복 참조하므로 비용·지연 대폭 감소.

실제 블록 생성은 Stage 1 구현 시 채움. 현재는 인터페이스.
"""
from __future__ import annotations

from typing import Any


def build_system_blocks(include_rubric: bool = True) -> list[dict[str, Any]]:
    """시스템 프롬프트 content block 리스트 생성.

    구조:
        [0] 코퍼스 개요 (MASTER_INDEX 발췌)  ← cached
        [1] knowledge_graph 축약판          ← cached
        [2] rubric (if include_rubric)       ← cached
        [3] 동적 컨텍스트 (caller가 append)  ← not cached
    """
    # TODO: 실제 코퍼스 발췌 로직은 Stage 1 구현 시.
    raise NotImplementedError("cache block builder — to be implemented with stage 1")
