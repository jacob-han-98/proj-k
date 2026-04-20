"""Anthropic Citations 응답 파서.

Citations가 enabled 인 응답은 각 텍스트 블록에 `citations` 배열이 붙는다. 이를 Evidence
구조로 매핑한다. cited_text는 원문 그대로라 환각 탐지에 핵심.

참조: https://docs.anthropic.com/en/docs/build-with-claude/citations
"""
from __future__ import annotations

from typing import Any


def extract_citations(response_block: dict[str, Any]) -> list[dict[str, Any]]:
    """Citations 응답 블록에서 cited_text + document 위치를 추출한다.

    반환 형식: `[{"cited_text": str, "document_index": int, "start": int, "end": int}, ...]`
    이후 document_index를 실제 source (workbook/sheet 또는 space/page)로 역매핑.
    """
    # TODO: Stage 1 호출 시 실제 응답 포맷 기반으로 구현.
    raise NotImplementedError("citations extractor — to be implemented with stage 1")
