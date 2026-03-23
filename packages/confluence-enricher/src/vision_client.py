#!/usr/bin/env python3
"""
vision_client.py - AWS Bedrock Claude Vision API 래퍼

xlsx-extractor/src/vision.py의 call_vision() 패턴을 재사용하되,
Confluence 이미지 보강에 맞게 간결하게 구성.
"""

import os
import io
import time
import base64
import requests
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

MAX_IMAGE_DIM = 8000  # Claude Vision API 최대 이미지 차원
MAX_IMAGE_BYTES = 3_900_000  # API 5MB 제한은 base64 문자열 기준 → raw 3.9MB가 한계


MODEL_MAPPING = {
    "claude-sonnet-4-5": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6-v1:0",
    "claude-opus": "global.anthropic.claude-opus-4-5-20251101-v1:0",
    "claude-opus-4-5": "global.anthropic.claude-opus-4-5-20251101-v1:0",
    "claude-opus-4-6": "global.anthropic.claude-opus-4-6-v1",
    "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
}


def _encode_image(img_path: str) -> tuple[str, str, int]:
    """이미지를 base64로 인코딩. 8000px 초과 시 리사이즈.
    Returns: (base64_data, media_type, raw_bytes_size)
    """
    path = Path(img_path)
    with open(path, "rb") as f:
        raw = f.read()

    # 미디어 타입 결정
    suffix = path.suffix.lower()
    media_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    media_type = media_types.get(suffix, "image/png")

    # 크기 체크 & 리사이즈 (픽셀 차원 + 파일 크기)
    if Image:
        img = Image.open(io.BytesIO(raw))
        # GIF → 첫 프레임을 PNG로 변환
        if suffix == ".gif":
            img = img.convert("RGBA")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            raw = buf.getvalue()
            media_type = "image/png"
            print(f"  [gif→png] {path.name}")

        w, h = img.size
        need_resize = (w > MAX_IMAGE_DIM or h > MAX_IMAGE_DIM or len(raw) > MAX_IMAGE_BYTES)

        if need_resize:
            # 픽셀 차원 제한
            if w > MAX_IMAGE_DIM or h > MAX_IMAGE_DIM:
                scale = min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h)
            else:
                scale = 1.0

            # 파일 크기 제한: 반복적으로 축소
            for attempt in range(5):
                new_w, new_h = int(w * scale), int(h * scale)
                img_resized = img.resize((new_w, new_h), Image.LANCZOS)
                buf = io.BytesIO()
                # JPEG이 더 작으므로 큰 이미지는 JPEG으로 변환
                if len(raw) > MAX_IMAGE_BYTES and suffix != ".jpg" and suffix != ".jpeg":
                    img_resized = img_resized.convert("RGB")
                    img_resized.save(buf, format="JPEG", quality=85)
                    media_type = "image/jpeg"
                else:
                    fmt = "JPEG" if suffix in (".jpg", ".jpeg") else "PNG"
                    img_resized.save(buf, format=fmt)
                raw = buf.getvalue()
                if len(raw) <= MAX_IMAGE_BYTES:
                    break
                scale *= 0.7  # 30% 축소 반복
            print(f"  [resize] {path.name}: {w}x{h} -> {new_w}x{new_h} ({len(raw) // 1024}KB)")

    encoded = base64.standard_b64encode(raw).decode("utf-8")
    return encoded, media_type, len(raw)


def call_vision(prompt: str, image_paths: list[str],
                max_tokens: int = 4000,
                model: str = None) -> dict:
    """AWS Bedrock Claude Vision API 호출.

    Args:
        prompt: 텍스트 프롬프트
        image_paths: 이미지 파일 경로 목록
        max_tokens: 최대 출력 토큰
        model: 모델 이름 (None이면 환경변수 VISION_MODEL 사용)

    Returns:
        {
            "text": str,
            "input_tokens": int,
            "output_tokens": int,
            "timing": {"encode_s", "api_s", "parse_s", "total_s"},
            "sizes": {"prompt_chars", "image_bytes": [int]}
        }
    """
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not token:
        raise RuntimeError("AWS_BEARER_TOKEN_BEDROCK 환경변수 미설정")
    region = os.environ.get("AWS_REGION", "us-east-1")
    model_name = model or os.environ.get("VISION_MODEL", "claude-sonnet-4-5")

    model_id = MODEL_MAPPING.get(model_name, f"global.anthropic.{model_name}-v1:0")
    url = f"https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke"

    # ── 이미지 인코딩 ──
    t_encode_start = time.time()
    content = []
    image_sizes = []
    for img_path in image_paths:
        encoded, media_type, raw_size = _encode_image(img_path)
        image_sizes.append(raw_size)
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": encoded},
        })
    t_encode = time.time() - t_encode_start

    content.append({"type": "text", "text": prompt})

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": content}],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    # ── API 호출 ──
    t_api_start = time.time()
    resp = requests.post(url, json=body, headers=headers, timeout=600)
    t_api = time.time() - t_api_start

    if resp.status_code != 200:
        raise RuntimeError(f"Bedrock API error {resp.status_code}: {resp.text[:500]}")

    # ── 응답 파싱 ──
    t_parse_start = time.time()
    result = resp.json()
    text = result["content"][0]["text"]

    # 코드 블록 래핑 제거
    for prefix in ["```markdown\n", "```\n"]:
        if text.startswith(prefix):
            text = text[len(prefix):]
    if text.endswith("\n```"):
        text = text[:-4]
    elif text.endswith("```"):
        text = text[:-3]
    t_parse = time.time() - t_parse_start

    usage = result.get("usage", {})
    return {
        "text": text.strip(),
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "timing": {
            "encode_s": round(t_encode, 3),
            "api_s": round(t_api, 1),
            "parse_s": round(t_parse, 3),
            "total_s": round(t_encode + t_api + t_parse, 1),
        },
        "sizes": {
            "prompt_chars": len(prompt),
            "image_bytes": image_sizes,
        },
    }
