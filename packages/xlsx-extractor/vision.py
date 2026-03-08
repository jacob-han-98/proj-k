#!/usr/bin/env python3
"""
vision.py - Stage 2: Vision AI로 시트 이미지에서 지식 추출

capture.py가 생성한 이미지(overview + detail tiles)를 Claude Opus Vision API에
전달하여 구조화된 텍스트로 변환한다.

해석 우선순위:
  1. 텍스트/테이블 → Markdown 테이블
  2. 플로우차트/다이어그램 → Mermaid 코드
  3. 도식/수식적 관계 → 수학적 표현, 의사코드, ASCII art
  4. 위 방법으로 불가능한 시각 요소 → 서브 이미지 발췌 + 참조 + 요약

사용법:
    python vision.py <capture_output_dir>
    python vision.py <capture_output_dir> --sheet "시트이름"
"""

import sys
import os
import io
import json
import time
import base64
import requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv

# .env 로드 (이 파일과 같은 디렉토리)
load_dotenv(Path(__file__).parent / ".env")

# ── 설정 ──
VISION_MODEL = os.environ.get("VISION_MODEL", "claude-opus")
VISION_MAX_TOKENS = 16000


# ── Bedrock API ──

def call_vision(prompt, image_paths, max_tokens=VISION_MAX_TOKENS):
    """AWS Bedrock Claude Vision API 호출 (2-이미지 전략)
    Returns: dict with text, tokens, timing breakdown
    """
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not token:
        raise RuntimeError("AWS_BEARER_TOKEN_BEDROCK 환경변수 미설정")
    region = os.environ.get("AWS_REGION", "us-east-1")

    model_mapping = {
        "claude-opus": "global.anthropic.claude-opus-4-5-20251101-v1:0",
        "claude-opus-4-5": "global.anthropic.claude-opus-4-5-20251101-v1:0",
        "claude-sonnet-4-5": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    }
    model_id = model_mapping.get(VISION_MODEL, f"global.anthropic.{VISION_MODEL}-v1:0")

    if "opus" not in model_id.lower():
        print(f"  [WARNING] Opus 외 모델 사용: {VISION_MODEL}")

    url = f"https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke"

    # ── Phase: 이미지 인코딩 ──
    t_encode_start = time.time()
    content = []
    image_sizes_bytes = []
    MAX_IMAGE_DIM = 8000  # Claude Vision API 최대 이미지 차원
    for img_path in image_paths:
        with open(img_path, "rb") as f:
            raw = f.read()
        # 이미지 크기 체크 → 8000px 초과 시 자동 리사이즈
        img_check = Image.open(img_path)
        w, h = img_check.size
        if w > MAX_IMAGE_DIM or h > MAX_IMAGE_DIM:
            scale = min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h)
            new_w, new_h = int(w * scale), int(h * scale)
            img_resized = img_check.resize((new_w, new_h), Image.LANCZOS)
            buf = io.BytesIO()
            img_resized.save(buf, format="PNG")
            raw = buf.getvalue()
            print(f"  [resize] {os.path.basename(img_path)}: {w}x{h} -> {new_w}x{new_h}")
        image_sizes_bytes.append(len(raw))
        img_data = base64.standard_b64encode(raw).decode("utf-8")
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": img_data},
        })
    t_encode = time.time() - t_encode_start

    content.append({"type": "text", "text": prompt})
    prompt_chars = len(prompt)

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": content}],
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    # ── Phase: API 호출 ──
    t_api_start = time.time()
    resp = requests.post(url, json=body, headers=headers, timeout=600)
    t_api = time.time() - t_api_start

    if resp.status_code != 200:
        raise RuntimeError(f"Bedrock API error {resp.status_code}: {resp.text[:500]}")

    # ── Phase: 응답 파싱 ──
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
            "prompt_chars": prompt_chars,
            "image_bytes": image_sizes_bytes,
        },
    }


# ── 프롬프트 ──

SYSTEM_CONTEXT = """당신은 게임 기획서 분석 전문가입니다. Excel 기획서 시트의 이미지를 분석하여
AI 지식 베이스에 저장할 수 있는 구조화된 텍스트로 변환합니다.

⚠️ **최우선 원칙 — 할루시네이션 절대 금지**:
- 당신의 역할은 **이미지를 읽는 것**이지, 기획서를 **작성하는 것이 아닙니다**.
- 출력하는 모든 텍스트, 테이블, 수치, 다이어그램은 반드시 **제공된 이미지에서 직접 읽은 것**이어야 합니다.
- 이미지에 보이지 않는 섹션, 테이블, 규칙, 수치를 **절대 생성하지 마세요**.
- "분석 결과", "변환 결과" 같은 메타 코멘트를 작성하지 마세요.
- 이전 섹션의 내용을 기반으로 새로운 규칙, 체계, 수치를 추론/생성하는 것은 **절대 금지**입니다.
- 이미지의 모든 내용이 이전 섹션과 겹치더라도, 새 내용을 만들어내지 말고 겹치는 부분만 간략히 출력하세요."""

def build_tile_prompt(sheet_name, tile_info, total_tiles, is_single=False,
                      tile_index=0, previous_md=""):
    """타일별 Vision 프롬프트 생성 (이전 타일 MD 컨텍스트 포함)"""

    position = tile_info.get("position_description", "")

    if is_single:
        location_hint = "이 이미지는 시트의 전체 내용입니다."
    else:
        location_hint = (
            f"2장의 이미지가 제공됩니다.\n"
            f"- **Image 1 (개요)**: 시트 전체를 축소한 저해상도 썸네일입니다. "
            f"**Image 1에서 텍스트를 읽으려 하지 마세요** — 해상도가 낮아 부정확합니다. "
            f"다만, 시트 전체 구조와 현재 섹션의 위치를 파악하는 데 참고하세요. "
            f"특히 테이블이나 콘텐츠가 이미지 경계에서 잘려 있을 경우, "
            f"Image 1을 통해 해당 내용이 이전/이후 섹션에서 이어지는 것임을 이해하는 데 활용하세요.\n"
            f"- **Image 2 (상세)**: '{position}' 영역의 고해상도 이미지입니다. "
            f"**모든 텍스트 추출은 반드시 Image 2에서만** 수행하세요.\n"
            f"- 총 {total_tiles}개 섹션 중 {tile_index + 1}번째입니다."
        )

    # 이전 타일 컨텍스트 (2번째 타일부터)
    continuity_section = ""
    if previous_md:
        continuity_section = f"""
## 이전 섹션까지의 해석 결과 (참고용)

아래는 이 시트의 이전 섹션(들)을 해석한 결과입니다. **참고용일 뿐**이며, 이를 기반으로 새 내용을 만들면 안 됩니다.
- 이미지가 분할되면서 **이전 섹션의 마지막 내용이 현재 이미지의 상단(약 10%)에 중복**될 수 있습니다. 이미 해석된 내용은 건너뛰세요.
- 현재 이미지의 상단에 테이블/콘텐츠가 잘린 채 시작된다면, 이전 섹션의 해석 결과와 Image 1(개요)을 함께 참고하여 해당 내용이 이어지는 것임을 이해하세요.
- **이전 결과의 마지막 항목 이후부터** 새로운 내용만 출력하세요.
- **헤딩 계층 유지**: 이전 섹션에서 사용 중이던 헤딩 구조(##, ###, #### 등)를 이어서 사용하세요.
- **⚠️ 절대 금지**: 이전 결과를 보고 "다음에 올 법한" 내용을 추측하여 생성하지 마세요. **Image 2에 물리적으로 보이는 텍스트만** 출력하세요.
- 이미지 내용이 이전 결과와 대부분 겹친다면, 새로운 부분만 출력하거나 "[이전 섹션과 동일 — 신규 내용 없음]"으로 표기하세요.

<previous_sections>
{previous_md}
</previous_sections>
"""

    # UI 시트 특별 규칙
    ui_section = ""
    if sheet_name.startswith("UI_") or sheet_name.startswith("UI "):
        ui_section = """
### UI 목업 시트 규칙
이 시트는 게임 UI 목업/와이어프레임을 포함합니다.
- UI 스크린샷의 구성요소를 텍스트로 **상세히** 해석하세요 (레이아웃 구조, 번호별 설명, 버튼/영역/텍스트)
- 동시에 각 UI 스크린샷 영역에 `[SUB_IMAGE: UI설명]` 마커를 남겨 원본 이미지를 보존하세요
- UI에 표시된 번호(①②③ 등)는 각각의 의미와 기능을 상세히 설명하세요
"""

    prompt = f"""{SYSTEM_CONTEXT}

## 분석 대상
- 시트명: {sheet_name}
- {location_hint}
{continuity_section}
## 출력 규칙

### 1. 텍스트/테이블 (최우선)
- 테이블은 반드시 **Markdown 테이블**로 변환
- 모든 셀 값을 정확히 기록 (숫자, 텍스트, 수식 설명)
- 병합 셀은 해당 범위를 명시
- 열 헤더와 행 번호를 보존

### 2. 플로우차트/다이어그램
- **Mermaid** 코드 블록으로 **간략하게** 변환 (정밀 분석은 별도 후처리에서 수행)
- 노드 텍스트와 화살표 방향을 빠르게 파악하여 `\`\`\`mermaid ... \`\`\`` 블록 작성
- 상세 분석 절차(Step 1~4, 노드 테이블, 화살표 추적 테이블)는 **출력하지 마세요** — 후처리에서 자동 수행됨
- **절대 금지**: 이미지에 없는 화살표를 추측하여 추가하지 마세요
- **주변 주석/참조 텍스트 연결**: 플로우차트 노드 근처의 주석 텍스트는 Mermaid 코드 블록 바로 아래에 `> **[노드명] 주석**: 내용` 형식으로 기록
- **⚠️ 중요**: 플로우차트 외에 같은 이미지에 다른 텍스트/테이블/섹션이 있다면 **반드시 모두 출력**하세요. 플로우차트만 출력하고 나머지를 생략하면 안 됩니다.

### 3. 복잡한 도식/관계도
텍스트로 직접 표현이 어려운 도식은 다음 순서로 시도:
- **수학적 표현**: 공식, 수식, 비율 관계, 좌표계, 도형 파라미터 (Pivot, Radius, Height, Width 등)
- **의사코드**: if/else, 루프 등의 로직 표현
- **구조화된 목록**: 계층적 관계를 들여쓰기로 표현
- **ASCII art**: 간단한 도식을 텍스트로 그림
- **주사위 아이콘**: 주사위(🎲) 모양 아이콘은 확률 기반 시스템을 뜻합니다. "확률(주사위)" 로 해석

### 4. 텍스트 변환 불가능한 시각 요소
UI 스크린샷, 게임 화면, 복잡한 일러스트, 수학적 표현이 곤란한 도식 등:
- `[SUB_IMAGE: 설명]` 마커를 남김 (설명은 해당 이미지가 무엇인지 간결하게)
- 마커와 함께 텍스트 설명도 최대한 기록:
  - 요소 내 텍스트가 있다면 모두 기록
  - 위치, 크기, 색상 등 시각적 속성도 기술
  - UI 요소: 레이아웃 구조, 번호 매핑, 버튼/영역 설명
{ui_section}
### 5. 연속성 규칙
- 이전 섹션 결과가 제공된 경우, **중복 내용을 절대 반복하지 마세요**
- 이전 결과의 마지막 행/항목 이후부터 이어서 작성하세요
- 테이블이 이어지는 경우, 헤더를 다시 쓰지 말고 행만 계속하세요
- 빈 영역은 무시

### 6. 불확실한 텍스트
- 이미지에서 명확하게 읽을 수 없는 글자/단어는 `[?추정텍스트?]` 형식으로 표기
- 작은 글씨, 겹친 셀, 흐릿한 영역의 텍스트를 **추측하여 틀리게 적는 것보다** 불확실함을 표시하는 것이 낫습니다

### 7. 할루시네이션 방지 (최우선)
- 이미지에 없는 내용을 절대 생성하지 마세요. 이 규칙은 다른 모든 규칙보다 우선합니다.
- 이전 섹션에서 "합성"을 다뤘다고 해서 "대성공 시스템", "도감 보상 체계" 등을 만들어내면 안 됩니다.
- 이미지에 읽을 수 있는 내용이 거의 없거나 이전 섹션과 전부 겹치면 짧게 출력해도 됩니다.
- "## N. 새로운 섹션명"과 같이 이미지에 없는 새로운 대분류를 만들지 마세요.

**중요**: 내용 추출은 반드시 **상세 이미지(Image 2)에서만** 수행하세요.
개요 이미지(Image 1)는 위치 파악 참고용일 뿐, 거기서 텍스트를 읽으면 안 됩니다.
상세 이미지에 보이는 내용 중, 이전 섹션과 중복되지 않는 새로운 내용만 빠짐없이 추출하세요."""

    return prompt


# ── 플로우차트 크롭 & 재분석 ──

FLOWCHART_PROMPT = """당신은 플로우차트/다이어그램 해석 전문가입니다.

이 이미지에는 플로우차트가 포함되어 있습니다. 플로우차트의 모든 요소를 정확하게 Mermaid로 변환하세요.

## 분석 절차 (반드시 이 순서를 따르세요)

### Step 1: 모든 도형(노드) 나열

이미지에 보이는 모든 도형을 테이블로 나열하세요:

| 번호 | 텍스트 | 모양 | 위치 |
|-----|--------|------|------|

- 모양: 원, 사각형, 둥근사각형, 마름모 등
- 위치: 좌측, 좌-중, 중앙, 중앙-우, 우측, 상단, 하단 등

### Step 2: 모든 화살표(연결선) 추적

**각 도형에서 나가는 선을 하나하나 추적합니다.**

도형마다 다음을 수행하세요:
1. 해당 도형의 **외곽선(테두리)에서 나가는 선**이 몇 개인지 확인
2. 각 선이 나가는 **방향**(→↑↓←)을 기록
3. 각 선을 **끝까지** 따라감:
   - 선이 꺾이거나(직각 전환) 방향이 바뀌어도 **끊기지 않으면 계속 따라감**
   - 선이 다른 선과 합류(T자/Y자 교차)하면, 합류 후 **화살촉(▶) 방향**으로 계속
   - **화살촉이 닿는 도형**이 최종 도착지
4. 라벨(Yes/No 등)이 있으면 기록

⚠️ **주의**: 도형에서 나가는 선이 2개 이상일 수 있습니다!
- 예: 마름모(분기)에서 Yes/No 2개 선이 나감
- 예: 사각형에서도 오른쪽 + 위쪽 등 여러 방향으로 선이 나갈 수 있음
- **특히 긴 수평선/수직선이 이미지 끝까지 이어지는 경우를 놓치지 마세요**

결과를 테이블로 기록하세요:

| 출발 | 도착 | 라벨 |
|-----|------|------|

### Step 3: 분석 결과를 주석으로 기록
`<!-- 화살표 분석 -->` 블록에 Step 1, 2 결과를 텍스트로 기록

### Step 4: Mermaid 코드 작성
Step 2의 테이블을 **그대로** Mermaid flowchart 코드로 변환

## 추가 규칙
- 도형 근처의 주석/참조 텍스트는 `> **[노드명] 주석**: 내용` 형식으로 Mermaid 블록 아래에 기록
- 이미지에 없는 화살표를 추측하여 추가하지 마세요
"""


import re
from PIL import Image


LOCATE_FLOWCHART_PROMPT = """이 이미지에서 플로우차트/흐름도가 있는 영역의 위치를 알려주세요.

규칙:
- 플로우차트의 모든 도형(시작/종료 포함), 모든 화살표, 라벨(Yes/No), 주변 주석 텍스트를 **모두** 포함하는 바운딩 박스
- 이미지 전체 크기 대비 백분율(0~100)로 답변
- **반드시 아래 JSON 형식으로만** 답변하세요. 다른 텍스트는 쓰지 마세요:

{"top_pct": N, "bottom_pct": N, "left_pct": N, "right_pct": N}"""


def has_flowchart(md_text):
    """1차 패스 결과에 mermaid 블록이 있는지 감지"""
    return "```mermaid" in md_text


def locate_flowchart_bbox(image_path):
    """Vision AI에게 플로우차트 영역 좌표를 물어봄 (전용 경량 호출)"""
    result = call_vision(LOCATE_FLOWCHART_PROMPT, [image_path], max_tokens=200)
    text = result["text"].strip()
    # JSON 파싱
    try:
        # JSON 블록 추출 (코드 블록 안에 있을 수 있음)
        json_match = re.search(r'\{[^}]+\}', text)
        if json_match:
            bbox = json.loads(json_match.group())
            print(f"      [flowchart] locate: {bbox} ({result['input_tokens']}+{result['output_tokens']} tok, {result['timing']['api_s']:.1f}s)")
            return {
                "top": bbox.get("top_pct", 0),
                "bottom": bbox.get("bottom_pct", 100),
                "left": bbox.get("left_pct", 0),
                "right": bbox.get("right_pct", 100),
            }
    except (json.JSONDecodeError, KeyError) as e:
        print(f"      [flowchart] locate parse error: {e}, raw={text[:200]}")
    return None


def crop_flowchart_region(image_path, bbox_pct, output_path):
    """이미지에서 플로우차트 영역을 크롭 (넉넉한 여유 포함)"""
    img = Image.open(image_path)
    w, h = img.size
    # bbox 높이/너비의 50%를 추가 패딩으로 확보 (최소 10% 이미지)
    box_h = bbox_pct["bottom"] - bbox_pct["top"]
    box_w = bbox_pct["right"] - bbox_pct["left"]
    pad_v = max(box_h * 0.5, 10)  # 세로 패딩: bbox 높이의 50% 또는 이미지 10%
    pad_h = max(box_w * 0.2, 5)   # 가로 패딩: bbox 너비의 20% 또는 이미지 5%
    top = int(h * max(0, bbox_pct["top"] - pad_v) / 100)
    bottom = int(h * min(100, bbox_pct["bottom"] + pad_v) / 100)
    left = int(w * max(0, bbox_pct["left"] - pad_h) / 100)
    right = int(w * min(100, bbox_pct["right"] + pad_h) / 100)
    cropped = img.crop((left, top, right, bottom))
    cropped.save(output_path, "PNG")
    return cropped.size


LOCATE_SUB_IMAGES_PROMPT = """이 이미지에서 다음 시각 요소들의 정확한 위치를 찾아주세요.

요소 목록:
{descriptions}

각 요소의 위치를 이미지 전체 크기 대비 백분율(0~100)로 알려주세요.
반드시 아래 JSON 배열 형식으로만 답변하세요. 다른 텍스트 없이:

[{{"top_pct": N, "bottom_pct": N, "left_pct": N, "right_pct": N}}, ...]

- 순서는 위 요소 목록 순서와 동일
- 각 요소를 **완전히** 포함하는 바운딩 박스를 지정
- 도형/UI 스크린샷의 외곽선까지 정확히 포함"""


def locate_sub_image_regions(tile_image_path, descriptions):
    """Vision AI 전용 호출로 여러 서브 이미지 영역 좌표를 한 번에 파악"""
    desc_list = "\n".join(f"{i+1}. {d}" for i, d in enumerate(descriptions))
    prompt = LOCATE_SUB_IMAGES_PROMPT.format(descriptions=desc_list)

    result = call_vision(prompt, [tile_image_path], max_tokens=500)
    text = result["text"].strip()
    print(f"      [sub-image] locate: {result['input_tokens']}+{result['output_tokens']} tok, "
          f"{result['timing']['api_s']:.1f}s")

    try:
        json_match = re.search(r'\[.*\]', text, re.DOTALL)
        if json_match:
            bboxes = json.loads(json_match.group())
            if isinstance(bboxes, list) and len(bboxes) == len(descriptions):
                return bboxes, result
    except (json.JSONDecodeError, KeyError) as e:
        print(f"      [sub-image] locate parse error: {e}")
    return None, result


def _normalize_sub_image_markers(text):
    """Vision AI가 직접 ![desc](./images/...) 를 출력한 경우 [SUB_IMAGE: desc] 로 정규화"""
    return re.sub(r'!\[(.+?)\]\(\./images/[^)]+\)', r'[SUB_IMAGE: \1]', text)


def extract_sub_images(tile_text, tile_image_path, output_dir, tile_id, sheet_safe_name):
    """Parse [SUB_IMAGE: desc] markers, locate regions via dedicated Vision call,
    crop, save, replace with MD links. Falls back to full tile image if locate fails.
    Returns (updated_text, num_extracted, extra_tokens).
    """
    # Vision AI가 ![desc](./images/...) 를 직접 출력한 경우 정규화
    tile_text = _normalize_sub_image_markers(tile_text)

    # [SUB_IMAGE: desc] 또는 [SUB_IMAGE: desc | anything] 둘 다 매칭
    pattern = re.compile(r'\[SUB_IMAGE:\s*(.+?)(?:\s*\|[^\]]*)?\]')

    matches = list(pattern.finditer(tile_text))
    if not matches:
        return tile_text, 0, 0

    descriptions = [m.group(1).strip() for m in matches]
    images_dir = os.path.join(output_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    # 전용 locate 호출로 정밀 좌표 획득
    bboxes, locate_result = locate_sub_image_regions(tile_image_path, descriptions)
    extra_tokens = (locate_result.get("input_tokens", 0) +
                    locate_result.get("output_tokens", 0)) if locate_result else 0

    img = Image.open(tile_image_path)
    w, h = img.size

    # 타일 이미지 전체를 fallback으로 미리 저장
    import shutil  # noqa: used once for tile fallback copy
    tile_fallback_name = f"{sheet_safe_name}_{tile_id}.png"
    tile_fallback_path = os.path.join(images_dir, tile_fallback_name)
    if not os.path.exists(tile_fallback_path):
        shutil.copy2(tile_image_path, tile_fallback_path)

    fig_counter = 0
    replacements = {}  # match start -> replacement string

    for i, match in enumerate(matches):
        desc = descriptions[i]
        fig_counter += 1

        bbox = None
        if bboxes and i < len(bboxes):
            b = bboxes[i]
            t_pct = b.get("top_pct", 0)
            b_pct = b.get("bottom_pct", 100)
            l_pct = b.get("left_pct", 0)
            r_pct = b.get("right_pct", 100)
            # 유효성 검사
            if 0 <= t_pct < b_pct <= 100 and 0 <= l_pct < r_pct <= 100:
                # 너무 큰 bbox는 무의미 (이미지의 90%+ 차지)
                area_pct = (b_pct - t_pct) * (r_pct - l_pct) / 100
                if area_pct < 70:
                    bbox = {"top": t_pct, "bottom": b_pct,
                            "left": l_pct, "right": r_pct}

        if bbox:
            # 10% 패딩 추가
            box_h = bbox["bottom"] - bbox["top"]
            box_w = bbox["right"] - bbox["left"]
            pad_v = max(box_h * 0.1, 2)
            pad_h = max(box_w * 0.1, 2)
            top = int(h * max(0, bbox["top"] - pad_v) / 100)
            bottom = int(h * min(100, bbox["bottom"] + pad_v) / 100)
            left = int(w * max(0, bbox["left"] - pad_h) / 100)
            right = int(w * min(100, bbox["right"] + pad_h) / 100)

            filename = f"{sheet_safe_name}_{tile_id}_fig{fig_counter}.png"
            filepath = os.path.join(images_dir, filename)
            cropped = img.crop((left, top, right, bottom))
            cropped.save(filepath, "PNG")
            cw, ch = cropped.size
            print(f"      [sub-image] {filename} ({cw}x{ch}px) [cropped]")
        else:
            # fallback: 타일 전체 이미지
            filename = tile_fallback_name
            print(f"      [sub-image] {filename} ({w}x{h}px) [full tile fallback]")

        replacements[match.start()] = f"![{desc}](./images/{filename})"

    # 역순으로 교체 (offset 유지)
    updated = tile_text
    for start in sorted(replacements.keys(), reverse=True):
        match = [m for m in matches if m.start() == start][0]
        updated = updated[:match.start()] + replacements[start] + updated[match.end():]

    return updated, fig_counter, extra_tokens


def replace_mermaid_block(original_md, new_mermaid_md):
    """원본 MD의 mermaid 블록(+ 화살표 분석 주석)을 2차 결과로 교체"""
    # 화살표 분석 주석 + mermaid 블록 + 직후 노드 주석(> **...**)을 찾아 교체
    pattern = re.compile(
        r'(<!-- 화살표 분석 -->.*?```mermaid\n.*?```\n?'   # 분석 주석 + mermaid
        r'(?:\n>.*\n?)*)',                                  # 노드 주석 lines
        re.DOTALL
    )
    if pattern.search(original_md):
        return pattern.sub(new_mermaid_md.strip() + "\n", original_md, count=1)
    # 화살표 분석 주석 없이 mermaid만 있는 경우
    simple_pattern = re.compile(r'```mermaid\n.*?```', re.DOTALL)
    if simple_pattern.search(original_md):
        return simple_pattern.sub(new_mermaid_md.strip(), original_md, count=1)
    return original_md


def reprocess_flowchart(tile_image_path, bbox_pct, output_dir, tile_id):
    """플로우차트 크롭 후 전용 프롬프트로 재분석"""
    crop_path = os.path.join(output_dir, f"{tile_id}_flowchart_crop.png")
    crop_size = crop_flowchart_region(tile_image_path, bbox_pct, crop_path)
    print(f"      [flowchart] Cropped {crop_size[0]}x{crop_size[1]}px -> {os.path.basename(crop_path)}")

    t0 = time.time()
    result = call_vision(FLOWCHART_PROMPT, [crop_path], max_tokens=4000)
    elapsed = time.time() - t0
    print(f"      [flowchart] 2nd pass: {elapsed:.1f}s, "
          f"tok={result['input_tokens']:,}+{result['output_tokens']:,}")

    # 결과 저장
    fc_md_path = os.path.join(output_dir, f"{tile_id}_flowchart.md")
    with open(fc_md_path, "w", encoding="utf-8") as f:
        f.write(result["text"])

    return {
        "text": result["text"],
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "elapsed": elapsed,
        "crop_path": crop_path,
    }


# ── 시트별 처리 ──

def process_sheet(sheet_dir, sheet_name):
    """한 시트의 모든 타일을 Vision AI로 처리"""
    vision_dir = os.path.join(sheet_dir, "_vision_input")
    manifest_path = os.path.join(vision_dir, "tile_manifest.json")

    if not os.path.exists(manifest_path):
        return {"success": False, "error": "tile_manifest.json not found"}

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    tiles = manifest.get("tiles", [])
    total_tiles = len(tiles)
    overview_path = os.path.join(vision_dir, "overview.png")
    has_overview = os.path.exists(overview_path)

    # sheet_safe_name (서브 이미지 파일명용)
    sheet_safe_name = sheet_name
    for ch in '/\\:*?"<>| ':
        sheet_safe_name = sheet_safe_name.replace(ch, "_")

    # 출력 디렉토리 미리 생성 (플로우차트 크롭 저장용)
    output_dir = os.path.join(sheet_dir, "_vision_output")
    os.makedirs(output_dir, exist_ok=True)

    results = []
    total_input_tokens = 0
    total_output_tokens = 0
    accumulated_md = ""  # 이전 타일들의 누적 결과

    for i, tile in enumerate(tiles):
        tile_id = tile["tile_id"]
        tile_path = os.path.join(vision_dir, f"{tile_id}.png")

        if not os.path.exists(tile_path):
            results.append({"tile_id": tile_id, "success": False, "error": "file not found"})
            continue

        # 2-이미지 전략: overview + detail (단일 타일이면 detail만)
        if total_tiles == 1:
            images = [tile_path]
            is_single = True
        else:
            images = [overview_path, tile_path] if has_overview else [tile_path]
            is_single = False

        # 누적 컨텍스트 크기 제한 (뒤쪽 타일의 프롬프트 비대화 방지)
        # 핵심: 전체 누적을 보내면 Vision AI가 "모든 섹션이 완료됐다"고 오판하여
        #       이미지를 읽지 않고 새 내용을 날조함(할루시네이션).
        #       → 마지막 2개 헤딩 구간만 전달하여 "현재 어디까지 왔는지"만 알려줌.
        context_md = ""
        if i > 0 and accumulated_md:
            # 마지막 2개 ## 레벨 헤딩 구간만 추출
            lines = accumulated_md.split('\n')
            heading_indices = [idx for idx, line in enumerate(lines)
                               if line.startswith('## ') or line.startswith('### ')]
            if len(heading_indices) >= 2:
                start_idx = heading_indices[-2]
                context_md = '\n'.join(lines[start_idx:])
            elif heading_indices:
                start_idx = heading_indices[-1]
                context_md = '\n'.join(lines[start_idx:])
            else:
                context_md = accumulated_md[-2000:]
            # 최대 3000자로 제한
            if len(context_md) > 3000:
                context_md = context_md[-3000:]
                first_heading = context_md.find('\n#')
                if first_heading > 0:
                    context_md = context_md[first_heading + 1:]

        # 프롬프트 빌드 타이밍
        t_prompt_start = time.time()
        prompt = build_tile_prompt(
            sheet_name, tile, total_tiles, is_single,
            tile_index=i,
            previous_md=context_md,
        )
        t_prompt = time.time() - t_prompt_start

        # API 호출 (재시도 1회)
        for attempt in range(2):
            try:
                api_result = call_vision(prompt, images)
                timing = api_result["timing"]
                sizes = api_result["sizes"]

                total_input_tokens += api_result["input_tokens"]
                total_output_tokens += api_result["output_tokens"]

                # 단계별 성능 로그
                img_kb = [round(b/1024, 1) for b in sizes["image_bytes"]]
                print(f"    [{i+1}/{total_tiles}] {tile_id}  "
                      f"tok={api_result['input_tokens']:,}+{api_result['output_tokens']:,}  "
                      f"time={timing['total_s']:.1f}s "
                      f"(encode={timing['encode_s']:.2f}s api={timing['api_s']:.1f}s)  "
                      f"img={img_kb}KB  prompt={sizes['prompt_chars']:,}ch")

                results.append({
                    "tile_id": tile_id,
                    "success": True,
                    "text": api_result["text"],
                    "input_tokens": api_result["input_tokens"],
                    "output_tokens": api_result["output_tokens"],
                    "elapsed": timing["total_s"],
                    "timing": timing,
                    "sizes": sizes,
                })

                # 플로우차트 크롭 & 재분석
                tile_text = api_result["text"]
                if has_flowchart(tile_text):
                    fc_bbox = locate_flowchart_bbox(tile_path)
                else:
                    fc_bbox = None
                if fc_bbox:
                    print(f"      [flowchart] Detected! bbox={fc_bbox}")
                    try:
                        fc_result = reprocess_flowchart(
                            tile_path, fc_bbox, output_dir, tile_id
                        )
                        tile_text = replace_mermaid_block(tile_text, fc_result["text"])
                        total_input_tokens += fc_result["input_tokens"]
                        total_output_tokens += fc_result["output_tokens"]
                        # 결과에 플로우차트 재분석 정보 추가
                        results.append({
                            "tile_id": f"{tile_id}_flowchart",
                            "success": True,
                            "text": fc_result["text"],
                            "input_tokens": fc_result["input_tokens"],
                            "output_tokens": fc_result["output_tokens"],
                            "elapsed": fc_result["elapsed"],
                            "is_flowchart_pass": True,
                        })
                    except Exception as fc_err:
                        print(f"      [flowchart] 2nd pass FAILED: {fc_err}")

                # 서브 이미지 추출 ([SUB_IMAGE: ...] 마커 -> locate + 크롭 + 저장 + MD 링크)
                tile_text, num_sub_images, sub_extra_tokens = extract_sub_images(
                    tile_text, tile_path, output_dir, tile_id, sheet_safe_name
                )
                if num_sub_images > 0:
                    total_input_tokens += sub_extra_tokens
                    print(f"      [sub-image] {num_sub_images} images extracted")

                # 1차 결과 업데이트 (2차로 교체된 텍스트 반영)
                api_result["text"] = tile_text
                # results에 이미 추가된 타일 엔트리의 텍스트도 업데이트
                for r in results:
                    if r.get("tile_id") == tile_id and not r.get("is_flowchart_pass"):
                        r["text"] = tile_text
                        break

                # 누적 MD 업데이트 (다음 타일에 전달)
                if accumulated_md:
                    accumulated_md += "\n\n" + tile_text
                else:
                    accumulated_md = tile_text
                break

            except Exception as e:
                if attempt == 0:
                    print(f"    [{i+1}/{total_tiles}] {tile_id} RETRY: {e}")
                    time.sleep(3)
                else:
                    print(f"    [{i+1}/{total_tiles}] {tile_id} FAILED: {e}")
                    results.append({
                        "tile_id": tile_id,
                        "success": False,
                        "error": str(e),
                    })

    # 최종 결과 = 누적 MD (중복 제거된 연속 텍스트)
    merged_text = accumulated_md

    # 개별 타일 결과
    for r in results:
        if r.get("success") and r.get("text"):
            tile_path = os.path.join(output_dir, f"{r['tile_id']}.md")
            with open(tile_path, "w", encoding="utf-8") as f:
                f.write(r["text"])

    # 병합 결과
    merged_path = os.path.join(output_dir, "merged.md")
    with open(merged_path, "w", encoding="utf-8") as f:
        f.write(f"# {sheet_name}\n\n")
        f.write(merged_text)

    # 성능 요약 계산
    successful_tiles = [r for r in results if r.get("success")]
    total_api_time = sum(r.get("timing", {}).get("api_s", 0) for r in successful_tiles)
    total_encode_time = sum(r.get("timing", {}).get("encode_s", 0) for r in successful_tiles)
    total_elapsed = sum(r.get("elapsed", 0) for r in successful_tiles)
    avg_api_per_tile = total_api_time / len(successful_tiles) if successful_tiles else 0

    # 메타데이터
    meta = {
        "sheet_name": sheet_name,
        "total_tiles": total_tiles,
        "success_count": sum(1 for r in results if r.get("success")),
        "failed_count": sum(1 for r in results if not r.get("success")),
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "performance": {
            "total_elapsed_s": round(total_elapsed, 1),
            "total_api_s": round(total_api_time, 1),
            "total_encode_s": round(total_encode_time, 3),
            "avg_api_per_tile_s": round(avg_api_per_tile, 1),
            "tokens_per_second": round(total_output_tokens / total_api_time, 1) if total_api_time > 0 else 0,
        },
        "tiles": [{k: v for k, v in r.items() if k != "text"} for r in results],
    }
    meta_path = os.path.join(output_dir, "vision_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return {
        "success": True,
        "sheet_name": sheet_name,
        "total_tiles": total_tiles,
        "success_count": meta["success_count"],
        "failed_count": meta["failed_count"],
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "performance": meta["performance"],
        "merged_path": merged_path,
    }


def _discover_sheets_from_dirs(capture_dir):
    """디렉토리 스캔으로 캡처된 시트 목록 생성 (매니페스트 불완전 시 보완)"""
    discovered = []
    for entry in sorted(os.listdir(capture_dir)):
        entry_path = os.path.join(capture_dir, entry)
        if not os.path.isdir(entry_path) or entry.startswith("_"):
            continue
        tm = os.path.join(entry_path, "_vision_input", "tile_manifest.json")
        if os.path.exists(tm):
            with open(tm, "r", encoding="utf-8") as f:
                tile_manifest = json.load(f)
            discovered.append({
                "name": tile_manifest.get("sheet_name", entry),
                "capture_success": True,
                "sections": tile_manifest.get("total_rows", "?"),
            })
    return discovered


def process_all(capture_dir, target_sheet=None, parallel=1):
    """모든 시트를 Vision AI로 처리.

    Args:
        capture_dir: 캡처 출력 디렉토리
        target_sheet: 특정 시트만 처리 (None=전체)
        parallel: 동시 처리할 시트 수 (1=순차, 2~8=병렬)
    """
    manifest_path = os.path.join(capture_dir, "_capture_manifest.json")
    source_name = "?"

    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        sheets = manifest.get("sheets", [])
        source_name = manifest.get("source", "?")
    else:
        sheets = []

    # 매니페스트에 없는 시트를 디렉토리에서 보완
    manifest_names = {s["name"] for s in sheets}
    discovered = _discover_sheets_from_dirs(capture_dir)
    for d in discovered:
        if d["name"] not in manifest_names:
            sheets.append(d)

    if target_sheet:
        # 쉼표로 여러 시트 지정 가능: "스킬,변신,UI_변신_기본"
        target_names = [t.strip() for t in target_sheet.split(",")]
        sheets = [s for s in sheets if s["name"] in target_names]
        if not sheets:
            print(f"ERROR: sheet(s) '{target_sheet}' not found")
            return []

    # 성공한 시트만 대상
    sheets = [s for s in sheets if s.get("capture_success") or s.get("img_success") or s.get("success")]
    sheets = [s for s in sheets if not s.get("blank")]

    total = len(sheets)
    parallel = min(parallel, total)  # 시트 수보다 많은 병렬은 의미 없음

    print(f"[Vision] Processing {total} sheets from {source_name}")
    print(f"[Vision] Model: {VISION_MODEL}")
    if parallel > 1:
        print(f"[Vision] Parallel: {parallel} sheets concurrently")
    print()

    t_start = time.time()

    if parallel <= 1:
        # 순차 처리 (기존 방식)
        all_results = _process_sheets_sequential(sheets, capture_dir, total)
    else:
        # 병렬 처리
        all_results = _process_sheets_parallel(sheets, capture_dir, total, parallel)

    elapsed = time.time() - t_start

    # 결과 요약
    grand_input = sum(r.get("total_input_tokens", 0) for r in all_results if r.get("success"))
    grand_output = sum(r.get("total_output_tokens", 0) for r in all_results if r.get("success"))

    print(f"\n{'='*60}")
    print(f"[Vision] Complete: {total} sheets, {elapsed:.0f}s total wall time")
    if parallel > 1:
        print(f"[Vision] Parallel speedup: {parallel} workers")
    print(f"[Vision] Tokens: {grand_input:,} input + {grand_output:,} output = {grand_input + grand_output:,} total")
    if grand_output > 0 and elapsed > 0:
        print(f"[Vision] Throughput: {grand_output / elapsed:.1f} output tok/s (wall), "
              f"{(grand_input + grand_output) / elapsed:.1f} total tok/s (wall)")
    print(f"{'='*60}")

    # 시트별 성능 요약 테이블
    success_results = [r for r in all_results if r.get("success")]
    if len(success_results) > 1:
        print(f"\n[Performance Summary]")
        print(f"{'Sheet':<25} {'Tiles':>5} {'InTok':>8} {'OutTok':>8} {'API(s)':>7} {'tok/s':>6}")
        print(f"{'-'*25} {'-'*5} {'-'*8} {'-'*8} {'-'*7} {'-'*6}")
        for r in success_results:
            perf = r.get("performance", {})
            print(f"{r['sheet_name']:<25} {r['total_tiles']:>5} "
                  f"{r['total_input_tokens']:>8,} {r['total_output_tokens']:>8,} "
                  f"{perf.get('total_api_s', 0):>7.1f} "
                  f"{perf.get('tokens_per_second', 0):>6.1f}")

    return all_results


def _process_sheets_sequential(sheets, capture_dir, total):
    """시트를 순차적으로 처리한다."""
    all_results = []
    for count, sheet_info in enumerate(sheets, 1):
        name = sheet_info["name"]
        safe_name = name
        for ch in '/\\:*?"<>|':
            safe_name = safe_name.replace(ch, "_")

        sheet_dir = os.path.join(capture_dir, safe_name)
        if not os.path.isdir(sheet_dir):
            print(f"  [{count}/{total}] {name} -> SKIP (no directory)")
            continue

        sections = sheet_info.get("sections") or "?"
        print(f"  [{count}/{total}] {name} ({sections} sections)...")

        result = process_sheet(sheet_dir, name)
        all_results.append(result)

        if result["success"]:
            perf = result.get("performance", {})
            print(f"    => {result['success_count']}/{result['total_tiles']} tiles OK  "
                  f"tok={result['total_input_tokens']:,}+{result['total_output_tokens']:,}  "
                  f"time={perf.get('total_elapsed_s', '?')}s  "
                  f"api={perf.get('total_api_s', '?')}s  "
                  f"speed={perf.get('tokens_per_second', '?')} tok/s")
        else:
            print(f"    => FAILED: {result.get('error', '?')}")

    return all_results


def _process_sheets_parallel(sheets, capture_dir, total, parallel):
    """시트를 병렬로 처리한다.

    각 시트 내에서 타일은 여전히 순차 처리 (누적 컨텍스트 의존),
    시트 간에는 완전 독립이므로 병렬 가능.
    """
    import threading

    print_lock = threading.Lock()
    all_results = [None] * len(sheets)

    def _worker(idx, sheet_info):
        name = sheet_info["name"]
        safe_name = name
        for ch in '/\\:*?"<>|':
            safe_name = safe_name.replace(ch, "_")

        sheet_dir = os.path.join(capture_dir, safe_name)
        if not os.path.isdir(sheet_dir):
            with print_lock:
                print(f"  [{idx+1}/{total}] {name} -> SKIP (no directory)")
            return None

        sections = sheet_info.get("sections") or "?"
        with print_lock:
            print(f"  [{idx+1}/{total}] {name} ({sections} sections) -> START")

        result = process_sheet(sheet_dir, name)
        all_results[idx] = result

        with print_lock:
            if result["success"]:
                perf = result.get("performance", {})
                print(f"  [{idx+1}/{total}] {name} -> DONE  "
                      f"{result['success_count']}/{result['total_tiles']} tiles  "
                      f"tok={result['total_input_tokens']:,}+{result['total_output_tokens']:,}  "
                      f"time={perf.get('total_elapsed_s', '?')}s")
            else:
                print(f"  [{idx+1}/{total}] {name} -> FAILED: {result.get('error', '?')}")

        return result

    with ThreadPoolExecutor(max_workers=parallel) as executor:
        futures = {}
        for idx, sheet_info in enumerate(sheets):
            future = executor.submit(_worker, idx, sheet_info)
            futures[future] = idx

        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                idx = futures[future]
                name = sheets[idx]["name"]
                with print_lock:
                    print(f"  [{idx+1}/{total}] {name} -> ERROR: {e}")

    return [r for r in all_results if r is not None]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python vision.py <capture_output_dir> [--sheet <name>] [--parallel <N>]")
        print("  --parallel N : 동시 처리할 시트 수 (default: 1, 추천: 4)")
        sys.exit(1)

    capture_dir = sys.argv[1]
    target_sheet = None
    parallel = 1

    if "--sheet" in sys.argv:
        idx = sys.argv.index("--sheet")
        if idx + 1 < len(sys.argv):
            target_sheet = sys.argv[idx + 1]

    if "--parallel" in sys.argv:
        idx = sys.argv.index("--parallel")
        if idx + 1 < len(sys.argv):
            parallel = int(sys.argv[idx + 1])

    if not os.path.isdir(capture_dir):
        print(f"ERROR: directory not found: {capture_dir}")
        sys.exit(1)

    results = process_all(capture_dir, target_sheet, parallel=parallel)
    failed = [r for r in results if not r.get("success")]
    sys.exit(1 if failed else 0)
