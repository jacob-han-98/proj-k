"""Conversation-scoped document context — Klaud "일반 Agent 모드" backend.

frontend 가 webview innerText 를 stash 하면 같은 conversation 의 ask_stream 안에서
agent 가 read_current_doc tool 을 호출해 본문을 가져올 수 있다.

설계:
- store: in-memory dict[conv_id -> {title, page_id, doc_type, content, stashed_at}]
  - 재시작 시 휘발 OK (frontend 가 webview 에서 다시 추출 가능)
- conv_id 바인딩: contextvar — ask_stream 진입 시 set, in-process MCP tool 안에서 get
  - in-process (create_sdk_mcp_server) 라 동일 Python 프로세스에서 동작
"""
from __future__ import annotations

import time
from contextvars import ContextVar
from typing import TypedDict

from claude_agent_sdk import tool


CONTENT_CAP = 100_000


class DocEntry(TypedDict, total=False):
    title: str
    page_id: str | None
    doc_type: str | None
    content: str
    stashed_at: float
    truncated: bool


_store: dict[str, DocEntry] = {}

# 현재 ask_stream 이 처리 중인 conv_id. tool 호출 시 어떤 doc 을 반환할지 결정.
current_conv_id: ContextVar[str | None] = ContextVar("current_conv_id", default=None)


def stash(
    conv_id: str,
    *,
    content: str,
    title: str = "",
    page_id: str | None = None,
    doc_type: str | None = None,
) -> DocEntry:
    """conv_id 의 doc_context 를 저장 (덮어씀)."""
    truncated = len(content) > CONTENT_CAP
    entry: DocEntry = {
        "title": title or "",
        "page_id": page_id,
        "doc_type": doc_type,
        "content": content[:CONTENT_CAP],
        "stashed_at": time.time(),
        "truncated": truncated,
    }
    _store[conv_id] = entry
    return entry


def get(conv_id: str) -> DocEntry | None:
    return _store.get(conv_id)


def clear(conv_id: str) -> bool:
    return _store.pop(conv_id, None) is not None


def has(conv_id: str) -> bool:
    return conv_id in _store


@tool(
    name="read_current_doc",
    description=(
        "사용자가 Klaud 에서 지금 열어 보고 있는 문서의 전체 본문을 반환한다.\n"
        "이 문서가 우선 컨텍스트지만, 추가 정보가 필요하면 KB 검색 도구도 사용할 수 있다.\n"
        "문서가 stash 되어 있지 않으면 status='no_doc' 을 반환 — 그때는 일반 KB 검색만으로 답하라.\n"
        "반환: {status, title, doc_type, page_id, content_chars, content, truncated}."
    ),
    input_schema={
        "type": "object",
        "properties": {},
    },
)
async def read_current_doc(args: dict):
    import json

    conv_id = current_conv_id.get()
    if not conv_id:
        # 컨텍스트가 안 잡힌 비정상 상황 — 디버깅 단서를 남기되 빈 응답.
        payload = {"status": "no_context", "content": ""}
    else:
        entry = _store.get(conv_id)
        if not entry:
            payload = {"status": "no_doc", "content": ""}
        else:
            payload = {
                "status": "ok",
                "title": entry.get("title", ""),
                "doc_type": entry.get("doc_type"),
                "page_id": entry.get("page_id"),
                "content_chars": len(entry.get("content", "")),
                "truncated": entry.get("truncated", False),
                "content": entry.get("content", ""),
            }
    text = json.dumps(payload, ensure_ascii=False)
    return {"content": [{"type": "text", "text": text}]}
