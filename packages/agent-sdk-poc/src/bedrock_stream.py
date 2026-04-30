"""Bedrock invoke-with-response-stream — async token streaming.

ranker/llm.py 와 동일한 bearer-token + httpx 패턴. boto3 / awscrt 의존 없음.
AWS event-stream 바이너리 프레임을 직접 파싱해 Anthropic 스트림 이벤트(dict)를
async generator 로 yield 한다.

사용처: /review_stream, /suggest_edits — 단일 LLM 호출이지만 토큰 단위 진행이
사용자에게 보여야 하는 경우.
"""
from __future__ import annotations

import base64
import json
import os
import struct
from pathlib import Path
from typing import AsyncIterator

import httpx

# .env 로드 — agent-sdk-poc/.env 가 우선, qna-poc/.env 가 fallback.
# (setdefault 라 먼저 set 한 값이 유지됨)
_PKG_ROOT = Path(__file__).resolve().parents[1]
for _env in [_PKG_ROOT / ".env", _PKG_ROOT.parent / "qna-poc" / ".env"]:
    if _env.exists():
        for line in _env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
AWS_BEARER_TOKEN = os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "")

MODEL_IDS = {
    "haiku": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "sonnet": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "opus": "global.anthropic.claude-opus-4-6-v1",
}


def normalize_model(name: str | None) -> str:
    """프론트엔드/extension 이 보내는 자유 표기 → MODEL_IDS 키.

    'claude-opus-4-6', 'opus', 'OPUS' 등 다양한 표기를 허용.
    """
    if not name:
        return "sonnet"
    n = name.lower().strip()
    if "haiku" in n:
        return "haiku"
    if "opus" in n:
        return "opus"
    if "sonnet" in n:
        return "sonnet"
    return n if n in MODEL_IDS else "sonnet"


class BedrockStreamError(Exception):
    pass


def _parse_event_stream_frames(buffer: bytearray) -> tuple[list[bytes], bytearray]:
    """AWS event-stream 프레임 디코더.

    Frame layout:
        4B  total length (big-endian, includes everything)
        4B  headers length
        4B  prelude CRC32
        NB  headers
        MB  payload  (M = total - 16 - N)
        4B  message CRC32

    완성된 프레임의 payload 들과, 미완성 trailing 바이트를 반환.
    """
    payloads: list[bytes] = []
    pos = 0
    while True:
        if len(buffer) - pos < 12:
            break
        total_len = struct.unpack_from(">I", buffer, pos)[0]
        if total_len < 16 or total_len > 16 * 1024 * 1024:
            # corrupt — bail. 호출자가 leftover 를 버려야 함.
            raise BedrockStreamError(f"invalid frame length {total_len}")
        if len(buffer) - pos < total_len:
            break
        headers_len = struct.unpack_from(">I", buffer, pos + 4)[0]
        payload_start = pos + 12 + headers_len
        payload_end = pos + total_len - 4
        if payload_start <= payload_end <= pos + total_len:
            payloads.append(bytes(buffer[payload_start:payload_end]))
        pos += total_len
    leftover = bytearray(buffer[pos:])
    return payloads, leftover


async def stream_messages(
    *,
    messages: list[dict],
    system: str | list | None,
    model: str = "sonnet",
    max_tokens: int = 8192,
    temperature: float = 0.0,
    timeout: float = 180.0,
) -> AsyncIterator[dict]:
    """Bedrock invoke-with-response-stream 호출.

    Yields Anthropic 스트림 이벤트 dict 그대로:
        {"type": "message_start", "message": {...}}
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", ...}}
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "..."}}
        {"type": "content_block_stop", "index": 0}
        {"type": "message_delta", "delta": {"stop_reason": "..."}, "usage": {...}}
        {"type": "message_stop"}
    """
    if not AWS_BEARER_TOKEN:
        raise BedrockStreamError("AWS_BEARER_TOKEN_BEDROCK not set")

    model_alias = normalize_model(model)
    model_id = MODEL_IDS[model_alias]

    url = (
        f"https://bedrock-runtime.{AWS_REGION}.amazonaws.com"
        f"/model/{model_id}/invoke-with-response-stream"
    )
    headers = {
        "Authorization": f"Bearer {AWS_BEARER_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/vnd.amazon.eventstream",
    }
    body: dict = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if system is not None:
        body["system"] = system

    buf = bytearray()
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                raise BedrockStreamError(
                    f"HTTP {resp.status_code}: {err.decode('utf-8', 'ignore')[:300]}"
                )
            async for chunk in resp.aiter_bytes():
                if not chunk:
                    continue
                buf.extend(chunk)
                payloads, buf = _parse_event_stream_frames(buf)
                for raw in payloads:
                    try:
                        outer = json.loads(raw)
                    except Exception:
                        continue
                    inner_b64 = outer.get("bytes")
                    if inner_b64:
                        try:
                            inner = json.loads(base64.b64decode(inner_b64))
                        except Exception:
                            continue
                        yield inner
                        continue
                    # 에러 프레임 (modelStreamErrorException 등)
                    msg = (
                        outer.get("message")
                        or outer.get("Message")
                        or outer.get("modelErrorException")
                        or str(outer)[:300]
                    )
                    raise BedrockStreamError(f"bedrock stream error: {msg}")


# ---- self-test ---------------------------------------------------------------

if __name__ == "__main__":
    import asyncio
    import sys

    if not AWS_BEARER_TOKEN:
        print("AWS_BEARER_TOKEN_BEDROCK not set — cannot self-test")
        sys.exit(2)

    async def _main():
        text_acc = []
        async for ev in stream_messages(
            messages=[{"role": "user", "content": "Count 1 to 5 in Korean, one per line."}],
            system=None,
            model="haiku",
            max_tokens=200,
        ):
            t = ev.get("type")
            if t == "content_block_delta":
                d = ev.get("delta", {})
                if d.get("type") == "text_delta":
                    sys.stdout.write(d.get("text", ""))
                    sys.stdout.flush()
                    text_acc.append(d.get("text", ""))
            elif t == "message_stop":
                print("\n---END---")
            elif t == "message_delta":
                print(f"\n[usage] {ev.get('usage')}")
        print(f"total chars: {sum(len(s) for s in text_acc)}")

    asyncio.run(_main())
