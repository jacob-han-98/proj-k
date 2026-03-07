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
    """AWS Bedrock Claude Vision API 호출 (2-이미지 전략)"""
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

    # 이미지 → base64
    content = []
    for img_path in image_paths:
        with open(img_path, "rb") as f:
            img_data = base64.standard_b64encode(f.read()).decode("utf-8")
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": img_data},
        })

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

    resp = requests.post(url, json=body, headers=headers, timeout=600)

    if resp.status_code != 200:
        raise RuntimeError(f"Bedrock API error {resp.status_code}: {resp.text[:500]}")

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

    usage = result.get("usage", {})
    return {
        "text": text.strip(),
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
    }


# ── 프롬프트 ──

SYSTEM_CONTEXT = """당신은 게임 기획서 분석 전문가입니다. Excel 기획서 시트의 이미지를 분석하여
AI 지식 베이스에 저장할 수 있는 구조화된 텍스트로 변환합니다."""

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
## 이전 섹션까지의 해석 결과

아래는 이 시트의 이전 섹션(들)을 해석한 결과입니다.
- 이미지가 분할되면서 **이전 섹션의 마지막 내용이 현재 이미지의 앞부분에 중복**될 수 있습니다. 중복된 내용은 반복하지 마세요.
- 현재 이미지의 상단에 테이블/콘텐츠가 잘린 채 시작된다면, 이전 섹션의 해석 결과와 Image 1(개요)을 함께 참고하여 해당 내용이 이어지는 것임을 이해하세요.
- 이전 결과의 마지막 항목 이후부터 새로운 내용만 출력하세요.

<previous_sections>
{previous_md}
</previous_sections>
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
- **Mermaid** 코드 블록으로 변환
- 노드 텍스트, 연결 방향, 조건 분기를 정확히 기록
- 예: ```mermaid\\nflowchart TD\\n  A[시작] --> B{{조건}}\\n```

### 3. 복잡한 도식/관계도
텍스트로 직접 표현이 어려운 도식은 다음 순서로 시도:
- **수학적 표현**: 공식, 수식, 비율 관계
- **의사코드**: if/else, 루프 등의 로직 표현
- **구조화된 목록**: 계층적 관계를 들여쓰기로 표현
- **ASCII art**: 간단한 도식을 텍스트로 그림

### 4. 텍스트 변환 불가능한 시각 요소
UI 스크린샷, 게임 화면, 복잡한 일러스트 등:
- `[IMAGE: 설명]` 마커를 남김
- 해당 요소가 무엇인지 최대한 상세히 설명
- 요소 내 텍스트가 있다면 모두 기록
- 위치, 크기, 색상 등 시각적 속성도 기술

### 5. 연속성 규칙
- 이전 섹션 결과가 제공된 경우, **중복 내용을 절대 반복하지 마세요**
- 이전 결과의 마지막 행/항목 이후부터 이어서 작성하세요
- 테이블이 이어지는 경우, 헤더를 다시 쓰지 말고 행만 계속하세요
- 빈 영역은 무시

**중요**: 내용 추출은 반드시 **상세 이미지(Image 2)에서만** 수행하세요.
개요 이미지(Image 1)는 위치 파악 참고용일 뿐, 거기서 텍스트를 읽으면 안 됩니다.
상세 이미지에 보이는 내용 중, 이전 섹션과 중복되지 않는 새로운 내용만 빠짐없이 추출하세요."""

    return prompt


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

        prompt = build_tile_prompt(
            sheet_name, tile, total_tiles, is_single,
            tile_index=i,
            previous_md=accumulated_md if i > 0 else "",
        )

        # API 호출 (재시도 1회)
        for attempt in range(2):
            try:
                t_start = time.time()
                api_result = call_vision(prompt, images)
                elapsed = time.time() - t_start

                total_input_tokens += api_result["input_tokens"]
                total_output_tokens += api_result["output_tokens"]

                print(f"    [{i+1}/{total_tiles}] {tile_id} "
                      f"({api_result['input_tokens']:,}+{api_result['output_tokens']:,} tok, "
                      f"{elapsed:.1f}s)")

                results.append({
                    "tile_id": tile_id,
                    "success": True,
                    "text": api_result["text"],
                    "input_tokens": api_result["input_tokens"],
                    "output_tokens": api_result["output_tokens"],
                    "elapsed": round(elapsed, 1),
                })

                # 누적 MD 업데이트 (다음 타일에 전달)
                if accumulated_md:
                    accumulated_md += "\n\n" + api_result["text"]
                else:
                    accumulated_md = api_result["text"]
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

    # 결과 저장
    output_dir = os.path.join(sheet_dir, "_vision_output")
    os.makedirs(output_dir, exist_ok=True)

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

    # 메타데이터
    meta = {
        "sheet_name": sheet_name,
        "total_tiles": total_tiles,
        "success_count": sum(1 for r in results if r.get("success")),
        "failed_count": sum(1 for r in results if not r.get("success")),
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
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
        "merged_path": merged_path,
    }


def process_all(capture_dir, target_sheet=None):
    """모든 시트를 Vision AI로 처리"""
    manifest_path = os.path.join(capture_dir, "_capture_manifest.json")
    if not os.path.exists(manifest_path):
        print(f"ERROR: _capture_manifest.json not found in {capture_dir}")
        return []

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    sheets = manifest.get("sheets", [])

    if target_sheet:
        sheets = [s for s in sheets if s["name"] == target_sheet]
        if not sheets:
            print(f"ERROR: sheet '{target_sheet}' not found")
            return []

    # 성공한 시트만 대상
    sheets = [s for s in sheets if s.get("img_success") or s.get("success")]
    sheets = [s for s in sheets if not s.get("blank")]

    total = len(sheets)
    print(f"[Vision] Processing {total} sheets from {manifest.get('source', '?')}")
    print(f"[Vision] Model: {VISION_MODEL}")
    print()

    all_results = []
    grand_input = 0
    grand_output = 0
    t_start = time.time()

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
            grand_input += result["total_input_tokens"]
            grand_output += result["total_output_tokens"]
            print(f"    => {result['success_count']}/{result['total_tiles']} tiles OK "
                  f"({result['total_input_tokens']:,}+{result['total_output_tokens']:,} tok)")
        else:
            print(f"    => FAILED: {result.get('error', '?')}")

    elapsed = time.time() - t_start

    print(f"\n[Vision] Done: {total} sheets, {elapsed:.0f}s")
    print(f"[Vision] Tokens: {grand_input:,} input + {grand_output:,} output "
          f"= {grand_input + grand_output:,} total")

    return all_results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python vision.py <capture_output_dir> [--sheet <name>]")
        sys.exit(1)

    capture_dir = sys.argv[1]
    target_sheet = None

    if "--sheet" in sys.argv:
        idx = sys.argv.index("--sheet")
        if idx + 1 < len(sys.argv):
            target_sheet = sys.argv[idx + 1]

    if not os.path.isdir(capture_dir):
        print(f"ERROR: directory not found: {capture_dir}")
        sys.exit(1)

    results = process_all(capture_dir, target_sheet)
    failed = [r for r in results if not r.get("success")]
    sys.exit(1 if failed else 0)
