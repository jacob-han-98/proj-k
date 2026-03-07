"""
tier2_vision.py - 비전 모델을 이용한 Tier 2 MD 보강 파이프라인

기존 Tier 1 + 1.5 변환 결과(MD)와 Excel 시트 스크린샷을 비전 모델에 보내
누락된 정보를 식별하고 보강 제안을 생성한다.

사용법:
    # 단일 시트 보강
    python tier2_vision.py --screenshot "screenshots/변신.png" --md "sheets/변신.md"

    # 도형 MD도 함께 비교
    python tier2_vision.py --screenshot "screenshots/변신.png" --md "sheets/변신.md" --shapes-md "sheets/변신_도형.md"

    # 전체 xlsx 폴더 일괄 처리
    python tier2_vision.py --folder "PK_변신_및_스킬_시스템" --kb-root "../_knowledge_base"

환경변수:
    AWS_BEARER_TOKEN_BEDROCK: Bedrock API Key (Bearer Token)
    AWS_REGION: AWS 리전 (기본: us-east-1)
"""

import argparse
import base64
import json
import os
import sys
import re
from pathlib import Path

# .env 파일에서 환경변수 로드
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).parent.parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)
except ImportError:
    pass


# 스크린샷이 너무 크면 분할하기 위한 최대 크기 (픽셀)
MAX_IMAGE_HEIGHT = 4000
# 분할 시 겹침 (컨텍스트 유지)
OVERLAP_PX = 200


def load_image_base64(image_path: str) -> tuple[str, str]:
    """이미지를 base64로 인코딩하여 반환. (data, media_type)"""
    ext = Path(image_path).suffix.lower()
    media_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    media_type = media_types.get(ext, "image/png")

    with open(image_path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")
    return data, media_type


def split_tall_image(image_path: str) -> list[str]:
    """세로로 긴 이미지를 MAX_IMAGE_HEIGHT 단위로 분할한다.
    분할이 필요 없으면 원본 경로만 반환."""
    try:
        from PIL import Image
    except ImportError:
        return [image_path]

    img = Image.open(image_path)
    w, h = img.size

    if h <= MAX_IMAGE_HEIGHT:
        return [image_path]

    parts = []
    y = 0
    idx = 0
    stem = Path(image_path).stem
    parent = Path(image_path).parent

    while y < h:
        y_end = min(y + MAX_IMAGE_HEIGHT, h)
        crop = img.crop((0, y, w, y_end))
        part_path = str(parent / f"{stem}_part{idx}.png")
        crop.save(part_path, "PNG")
        parts.append(part_path)
        idx += 1
        y = y_end - OVERLAP_PX if y_end < h else h

    print(f"  이미지 분할: {h}px → {len(parts)}개 파트")
    return parts


def build_augment_prompt(md_text: str, shapes_md_text: str = None,
                          sheet_name: str = "") -> str:
    """비전 모델에 보낼 시스템 프롬프트를 생성한다."""

    prompt = f"""당신은 게임 기획 문서 변환 품질 검증 전문가입니다.

아래는 Excel 기획서 "{sheet_name}" 시트를 자동 변환한 Markdown 문서입니다.
첨부된 스크린샷은 같은 시트의 원본 Excel 화면입니다.

## 작업 지시

스크린샷과 Markdown을 비교하여 **누락되거나 부정확한 정보**를 찾아주세요.
특히 다음 항목에 집중하세요:

1. **플로우차트/도형 누락 정보**
   - 화살표 위의 "Yes"/"No" 등 분기 조건 레이블
   - 도형 아래의 부연설명/주석
   - 도형 간 시각적 근접성으로 표현된 관계 (XML에는 연결선이 없지만 시각적으로 관련된 것)
   - 도형의 색상이 의미하는 구분 (예: 다른 시스템 소속)

2. **테이블 누락 정보**
   - 행/열 헤더가 누락된 테이블
   - 병합 셀로 인해 구조가 깨진 테이블
   - 색상으로 표현된 등급/분류 정보

3. **이미지 내 텍스트**
   - 게임 UI 스크린샷 안의 텍스트
   - 다이어그램/인포그래픽 내 레이블

4. **시각적 강조/마킹**
   - 특정 영역에 대한 스펙아웃/제외 표시
   - 화살표나 동그라미로 표시된 강조 영역
   - 색상 하이라이트의 의미

## 출력 형식

JSON 형식으로 출력해주세요:

```json
{{
  "findings": [
    {{
      "type": "missing_label | missing_header | missing_annotation | color_info | image_text | spec_out | other",
      "location": "MD에서의 위치 설명 (예: '등급별 스펙 테이블', '합성 흐름도')",
      "description": "무엇이 누락/부정확한지",
      "suggestion": "보강할 내용 (가능하면 MD 형식으로)",
      "confidence": "high | medium | low"
    }}
  ],
  "summary": "전체 품질 평가 요약"
}}
```

---

## 기존 Markdown (Tier 1 셀 데이터)

```markdown
{md_text}
```
"""

    if shapes_md_text:
        prompt += f"""
---

## 기존 Markdown (Tier 1.5 도형/플로우차트)

```markdown
{shapes_md_text}
```
"""

    return prompt


def _get_bedrock_config() -> tuple[str, str]:
    """Bedrock 인증 정보를 환경변수에서 가져온다."""
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not token:
        print("[ERROR] AWS_BEARER_TOKEN_BEDROCK 환경변수가 설정되지 않았습니다.")
        sys.exit(1)
    region = os.environ.get("AWS_REGION", "us-east-1")
    return token, region


def _bedrock_model_id(model: str) -> str:
    """모델 이름을 Bedrock 모델 ID로 변환한다."""
    mapping = {
        "claude-sonnet-4-20250514": "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "claude-sonnet-4-6": "anthropic.claude-sonnet-4-6",
        "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
        "claude-opus-4-20250514": "anthropic.claude-opus-4-20250514-v1:0",
    }
    return mapping.get(model, f"us.anthropic.{model}-v1:0")


def call_vision_model(prompt: str, image_paths: list[str],
                       model: str = "claude-sonnet-4-20250514") -> tuple:
    """AWS Bedrock를 통해 Claude 비전 모델을 호출한다."""
    import requests

    token, region = _get_bedrock_config()
    model_id = _bedrock_model_id(model)

    # Bedrock InvokeModel 엔드포인트
    url = (f"https://bedrock-runtime.{region}.amazonaws.com"
           f"/model/{model_id}/invoke")

    # 이미지 콘텐츠 구성 (Anthropic Messages API 형식)
    content = []
    for img_path in image_paths:
        img_data, media_type = load_image_base64(img_path)
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": img_data,
            }
        })

    content.append({
        "type": "text",
        "text": prompt,
    })

    # Bedrock 요청 본문
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8192,
        "messages": [{
            "role": "user",
            "content": content,
        }],
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    resp = requests.post(url, json=body, headers=headers, timeout=300)

    if resp.status_code != 200:
        raise RuntimeError(
            f"Bedrock API 오류 {resp.status_code}: {resp.text[:500]}")

    result = resp.json()
    text = result["content"][0]["text"]
    return _parse_json_response(text), text


def _parse_json_response(text: str) -> dict | None:
    """응답 텍스트에서 JSON을 추출한다."""
    # ```json ... ``` 블록 찾기
    match = re.search(r'```json\s*\n(.*?)\n```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # 전체가 JSON인 경우
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def augment_single(screenshot_path: str, md_path: str,
                    shapes_md_path: str = None,
                    output_path: str = None,
                    model: str = "claude-sonnet-4-20250514") -> dict:
    """단일 시트에 대해 Tier 2 비전 보강을 수행한다."""

    sheet_name = Path(md_path).stem

    # MD 읽기
    with open(md_path, "r", encoding="utf-8") as f:
        md_text = f.read()

    shapes_md_text = None
    if shapes_md_path and os.path.exists(shapes_md_path):
        with open(shapes_md_path, "r", encoding="utf-8") as f:
            shapes_md_text = f.read()

    # 이미지 분할 (필요 시)
    image_parts = split_tall_image(screenshot_path)

    # 프롬프트 생성
    prompt = build_augment_prompt(md_text, shapes_md_text, sheet_name)

    print(f"  비전 모델 호출 중 (이미지 {len(image_parts)}개, 모델: {model})...", flush=True)

    # API 호출
    result, raw_text = call_vision_model(prompt, image_parts, model)

    # 결과 저장
    if output_path is None:
        output_dir = Path(md_path).parent
        output_path = str(output_dir / f"{sheet_name}_tier2_보강.json")

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({
            "sheet": sheet_name,
            "screenshot": screenshot_path,
            "md": md_path,
            "shapes_md": shapes_md_path,
            "model": model,
            "findings": result,
            "raw_response": raw_text,
        }, f, ensure_ascii=False, indent=2)

    # 분할 이미지 정리
    for p in image_parts:
        if p != screenshot_path and os.path.exists(p):
            os.remove(p)

    findings_count = len(result.get("findings", [])) if result else 0
    print(f"  → {findings_count}개 보강 사항 발견 → {output_path}")

    return result


def augment_folder(folder_name: str, kb_root: str,
                    model: str = "claude-sonnet-4-20250514"):
    """폴더 내 모든 시트에 대해 일괄 보강한다."""

    sheets_dir = os.path.join(kb_root, "sheets", folder_name)
    screenshots_dir = os.path.join(kb_root, "screenshots", folder_name)

    if not os.path.exists(sheets_dir):
        print(f"[ERROR] 시트 폴더 없음: {sheets_dir}")
        return
    if not os.path.exists(screenshots_dir):
        print(f"[ERROR] 스크린샷 폴더 없음: {screenshots_dir}")
        return

    # 스크린샷 파일 목록
    screenshots = {Path(f).stem: os.path.join(screenshots_dir, f)
                   for f in os.listdir(screenshots_dir)
                   if f.endswith(".png")}

    # 각 스크린샷에 대응하는 MD 찾기
    for sheet_name, ss_path in sorted(screenshots.items()):
        md_path = os.path.join(sheets_dir, f"{sheet_name}.md")
        shapes_md_path = os.path.join(sheets_dir, f"{sheet_name}_도형.md")

        if not os.path.exists(md_path):
            print(f"  SKIP {sheet_name} (MD 없음)")
            continue

        print(f"\n[{sheet_name}]")
        try:
            augment_single(
                ss_path, md_path,
                shapes_md_path if os.path.exists(shapes_md_path) else None,
                model=model,
            )
        except Exception as e:
            print(f"  ERROR: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Tier 2 비전 모델 MD 보강 파이프라인")

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--screenshot", help="단일 스크린샷 경로")
    group.add_argument("--folder", help="일괄 처리할 폴더명 (_knowledge_base 하위)")

    parser.add_argument("--md", help="기존 MD 파일 경로 (--screenshot 시 필수)")
    parser.add_argument("--shapes-md", help="도형 MD 파일 경로 (선택)")
    parser.add_argument("--kb-root", default=None,
                        help="_knowledge_base 루트 경로")
    parser.add_argument("--output", "-o", help="출력 파일 경로")
    parser.add_argument("--model", default="claude-opus-4-6",
                        help="사용할 모델 (기본: claude-opus-4-6)")

    args = parser.parse_args()

    # Bedrock 인증 확인
    if not os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        print("[ERROR] AWS_BEARER_TOKEN_BEDROCK 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    # kb_root 자동 탐색
    if args.kb_root is None:
        script_dir = Path(__file__).parent
        args.kb_root = str(script_dir.parent / "_knowledge_base")

    if args.screenshot:
        if not args.md:
            print("[ERROR] --screenshot 사용 시 --md도 지정해야 합니다.")
            sys.exit(1)
        print(f"[tier2_vision] 단일 보강: {args.screenshot}")
        augment_single(args.screenshot, args.md, args.shapes_md,
                       args.output, args.model)
    else:
        print(f"[tier2_vision] 폴더 일괄 보강: {args.folder}")
        augment_folder(args.folder, args.kb_root, args.model)


if __name__ == "__main__":
    main()
