"""Ranker 전용 Bedrock 호출 헬퍼.

scripts/bedrock_client.py는 text-only 응답 파서라 structured output(tool_use)과 citations을
지원하지 않는다. Ranker는 둘 다 필수이므로 여기서 별도 함수로 제공한다.

환경변수: AWS_BEARER_TOKEN_BEDROCK, AWS_REGION (bedrock_client.py와 공유).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

# .env 로드 (agent-sdk-poc/.env → qna-poc/.env fallback)
_PKG_ROOT = Path(__file__).resolve().parents[2]
for _env in [_PKG_ROOT / ".env", _PKG_ROOT.parent / "qna-poc" / ".env"]:
    if _env.exists():
        for line in _env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())
        break

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
AWS_BEARER_TOKEN = os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "")

MODEL_IDS = {
    "haiku": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "sonnet": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "opus": "global.anthropic.claude-opus-4-6-v1",
}


class BedrockError(Exception):
    pass


def _invoke(body: dict, *, timeout: float, retries: int) -> dict:
    if not AWS_BEARER_TOKEN:
        raise BedrockError("AWS_BEARER_TOKEN_BEDROCK not set")

    model_id = MODEL_IDS.get(body.pop("_model", "sonnet"))
    if not model_id:
        raise BedrockError("unknown model alias")

    url = f"https://bedrock-runtime.{AWS_REGION}.amazonaws.com/model/{model_id}/invoke"
    headers = {
        "Authorization": f"Bearer {AWS_BEARER_TOKEN}",
        "Content-Type": "application/json",
    }

    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with httpx.Client(timeout=timeout) as client:
                r = client.post(url, headers=headers, json=body)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503, 504):
                last_err = BedrockError(f"HTTP {r.status_code}: {r.text[:200]}")
                time.sleep(1.5 * (attempt + 1))
                continue
            raise BedrockError(f"HTTP {r.status_code}: {r.text[:300]}")
        except httpx.HTTPError as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise BedrockError(f"bedrock call failed after {retries} attempts: {last_err}")


def call_structured(
    *,
    messages: list[dict],
    system: str | list | None,
    tool: dict,
    model: str = "sonnet",
    max_tokens: int = 4096,
    temperature: float = 0.0,
    thinking_budget: int | None = None,
    timeout: float = 120.0,
    retries: int = 3,
) -> dict:
    """Structured output 강제 호출.

    `tool` 은 `{"name", "description", "input_schema"}` 형태의 Anthropic tool 스펙.
    응답의 tool_use 블록에서 input(dict)을 추출해 반환.

    Returns:
        {
          "tool_input": dict,     # 강제된 구조화 결과
          "text": str,            # tool 호출 전 Claude가 출력한 보조 텍스트(있으면)
          "thinking": str,        # extended thinking 결과(활성화 시)
          "usage": dict,          # 토큰/캐시 통계
          "stop_reason": str,
          "raw": dict,            # 전체 응답 (디버깅용)
        }
    """
    body: dict[str, Any] = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
        "tools": [tool],
        "tool_choice": {"type": "tool", "name": tool["name"]},
        "_model": model,
    }
    if system is not None:
        body["system"] = system
    if thinking_budget:
        body["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
        # thinking 활성화 시 temperature=1 강제 (Anthropic 제약)
        body["temperature"] = 1.0

    payload = _invoke(body, timeout=timeout, retries=retries)
    content = payload.get("content", [])

    tool_input: dict | None = None
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    for block in content:
        btype = block.get("type")
        if btype == "tool_use" and block.get("name") == tool["name"]:
            tool_input = block.get("input", {})
        elif btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "thinking":
            thinking_parts.append(block.get("thinking", ""))

    if tool_input is None:
        raise BedrockError(
            f"no tool_use '{tool['name']}' block in response; stop_reason={payload.get('stop_reason')}"
        )

    return {
        "tool_input": tool_input,
        "text": "".join(text_parts),
        "thinking": "\n".join(thinking_parts),
        "usage": payload.get("usage", {}),
        "stop_reason": payload.get("stop_reason", ""),
        "raw": payload,
    }


def call_with_documents(
    *,
    messages: list[dict],
    system: str | list | None,
    documents: list[dict],
    model: str = "sonnet",
    max_tokens: int = 4096,
    temperature: float = 0.0,
    thinking_budget: int | None = None,
    enable_citations: bool = True,
    tool: dict | None = None,
    timeout: float = 180.0,
    retries: int = 3,
) -> dict:
    """Documents + (optional) Citations + (optional) tool_use 결합 호출.

    documents: [{"title": str, "text": str, "source_id": str}] 형태. 내부적으로 Anthropic
    document content block으로 변환해 user 메시지 앞에 prepend 한다.

    Citations 활성화 시 Claude 응답의 각 text 블록에 `citations` 배열이 붙는다.
    Bedrock 지원 여부는 모델 버전에 따라 다르므로 실패 시 그대로 에러 전파 (상위에서 fallback).
    """
    doc_blocks = []
    for i, doc in enumerate(documents):
        block: dict[str, Any] = {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": doc["text"]},
            "title": doc.get("title", f"document-{i}"),
            "context": doc.get("context"),
        }
        if enable_citations:
            block["citations"] = {"enabled": True}
        # context None이면 제거
        if block.get("context") is None:
            block.pop("context", None)
        doc_blocks.append(block)

    # messages 의 첫 user 메시지 content 앞에 documents prepend
    patched_messages: list[dict] = []
    prepended = False
    for m in messages:
        if m["role"] == "user" and not prepended:
            orig_content = m["content"]
            if isinstance(orig_content, str):
                orig_content = [{"type": "text", "text": orig_content}]
            patched_messages.append({"role": "user", "content": doc_blocks + orig_content})
            prepended = True
        else:
            patched_messages.append(m)
    if not prepended:
        patched_messages.insert(0, {"role": "user", "content": doc_blocks})

    body: dict[str, Any] = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": patched_messages,
        "_model": model,
    }
    if system is not None:
        body["system"] = system
    if thinking_budget:
        body["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
        body["temperature"] = 1.0
    if tool is not None:
        body["tools"] = [tool]
        body["tool_choice"] = {"type": "tool", "name": tool["name"]}

    payload = _invoke(body, timeout=timeout, retries=retries)
    content = payload.get("content", [])

    tool_input: dict | None = None
    text_blocks: list[dict] = []  # keep citation arrays
    thinking_parts: list[str] = []
    for block in content:
        btype = block.get("type")
        if btype == "tool_use" and tool is not None and block.get("name") == tool["name"]:
            tool_input = block.get("input", {})
        elif btype == "text":
            text_blocks.append(
                {"text": block.get("text", ""), "citations": block.get("citations", [])}
            )
        elif btype == "thinking":
            thinking_parts.append(block.get("thinking", ""))

    if tool is not None and tool_input is None:
        raise BedrockError(
            f"no tool_use '{tool['name']}' in response; stop_reason={payload.get('stop_reason')}"
        )

    return {
        "tool_input": tool_input,
        "text_blocks": text_blocks,
        "thinking": "\n".join(thinking_parts),
        "usage": payload.get("usage", {}),
        "stop_reason": payload.get("stop_reason", ""),
        "raw": payload,
    }


# ---- 간단한 self-test --------------------------------------------------------

if __name__ == "__main__":
    if not AWS_BEARER_TOKEN:
        print("AWS_BEARER_TOKEN_BEDROCK not set — cannot self-test")
        sys.exit(2)
    # ping: 단순 tool_use 한 번
    tool = {
        "name": "ping",
        "description": "Echo back a greeting.",
        "input_schema": {
            "type": "object",
            "required": ["greeting"],
            "properties": {"greeting": {"type": "string"}},
        },
    }
    result = call_structured(
        messages=[{"role": "user", "content": "Reply with greeting='hello'"}],
        system=None,
        tool=tool,
        model="haiku",
        max_tokens=200,
    )
    print("self-test:", result["tool_input"], "usage:", result["usage"])
