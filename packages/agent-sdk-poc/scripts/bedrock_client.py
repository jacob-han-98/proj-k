"""
Thin Bedrock HTTP client — Haiku/Sonnet 호출용.
qna-poc/src/generator.py의 call_bedrock 로직을 인덱스 빌드 전용으로 축소.
AWS_BEARER_TOKEN_BEDROCK 기반 인증 (SigV4 아님).
"""

import json
import os
import time
from pathlib import Path

import httpx

# .env 로드 (agent-sdk-poc/.env → 없으면 qna-poc/.env)
_HERE = Path(__file__).resolve().parent
for _env in [_HERE.parent / ".env", _HERE.parent.parent / "qna-poc" / ".env"]:
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


def call(
    messages: list[dict],
    *,
    model: str = "haiku",
    max_tokens: int = 1024,
    temperature: float = 0.0,
    system: str | list | None = None,
    timeout: float = 60.0,
    retries: int = 3,
) -> dict:
    """
    Returns {"text": str, "input_tokens": int, "output_tokens": int, "stop_reason": str}
    """
    if not AWS_BEARER_TOKEN:
        raise BedrockError("AWS_BEARER_TOKEN_BEDROCK not set")

    model_id = MODEL_IDS.get(model, model)
    url = f"https://bedrock-runtime.{AWS_REGION}.amazonaws.com/model/{model_id}/invoke"
    body: dict = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if system is not None:
        body["system"] = system

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
                payload = r.json()
                content = payload.get("content", [])
                text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
                usage = payload.get("usage", {})
                return {
                    "text": text,
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                    "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
                    "stop_reason": payload.get("stop_reason", ""),
                }
            if r.status_code in (429, 500, 502, 503, 504):
                last_err = BedrockError(f"HTTP {r.status_code}: {r.text[:200]}")
                time.sleep(1.5 * (attempt + 1))
                continue
            raise BedrockError(f"HTTP {r.status_code}: {r.text[:200]}")
        except httpx.HTTPError as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))

    raise BedrockError(f"bedrock call failed after {retries} attempts: {last_err}")
