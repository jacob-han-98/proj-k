"""
tier2_verify.py - 비전 기반 MD 변환 품질 검증 및 자동 반복 보강

스크린샷과 MD를 비교하여 10개 검증 질문을 생성하고 점수를 매긴다.
만점에 가까울 때까지 보강 → 재검증을 반복한다.

사용법:
    # 단일 시트 검증
    python tier2_verify.py --screenshot "screenshots/변신.png" --md "sheets/변신.md"

    # 도형 MD 포함 검증
    python tier2_verify.py --screenshot "screenshots/변신.png" --md "sheets/변신.md" --shapes-md "sheets/변신_도형.md"

    # 자동 반복 보강 (기본 max 3회)
    python tier2_verify.py --screenshot "screenshots/변신.png" --md "sheets/변신.md" --auto-fix --max-rounds 5

환경변수:
    AWS_BEARER_TOKEN_BEDROCK: Bedrock API Key (Bearer Token)
    AWS_REGION: AWS 리전 (기본: us-east-1)
"""

import argparse
import base64
import json
import os
import re
import sys
import copy
from pathlib import Path
from datetime import datetime


# ─── Bedrock 공통 ───

def _get_bedrock_config() -> tuple[str, str]:
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not token:
        print("[ERROR] AWS_BEARER_TOKEN_BEDROCK 환경변수가 설정되지 않았습니다.")
        sys.exit(1)
    region = os.environ.get("AWS_REGION", "us-east-1")
    return token, region


def _bedrock_model_id(model: str) -> str:
    mapping = {
        "claude-sonnet-4-20250514": "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "claude-sonnet-4-6": "anthropic.claude-sonnet-4-6",
        "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
        "claude-opus-4-20250514": "anthropic.claude-opus-4-20250514-v1:0",
    }
    return mapping.get(model, f"us.anthropic.{model}-v1:0")


def load_image_base64(image_path: str) -> tuple[str, str]:
    ext = Path(image_path).suffix.lower()
    media_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
    media_type = media_types.get(ext, "image/png")
    with open(image_path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")
    return data, media_type


def split_tall_image(image_path: str, max_h: int = 4000, overlap: int = 200) -> list[str]:
    try:
        from PIL import Image
    except ImportError:
        return [image_path]
    img = Image.open(image_path)
    w, h = img.size
    if h <= max_h:
        return [image_path]
    parts = []
    y, idx = 0, 0
    stem, parent = Path(image_path).stem, Path(image_path).parent
    while y < h:
        y_end = min(y + max_h, h)
        crop = img.crop((0, y, w, y_end))
        p = str(parent / f"{stem}_vpart{idx}.png")
        crop.save(p, "PNG")
        parts.append(p)
        idx += 1
        y = y_end - overlap if y_end < h else h
    return parts


def call_bedrock(prompt: str, image_paths: list[str],
                  model: str = "claude-sonnet-4-20250514") -> str:
    """Bedrock API 호출하여 텍스트 응답 반환."""
    import requests
    token, region = _get_bedrock_config()
    model_id = _bedrock_model_id(model)
    url = f"https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke"

    content = []
    for img_path in image_paths:
        img_data, media_type = load_image_base64(img_path)
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": img_data}
        })
    content.append({"type": "text", "text": prompt})

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8192,
        "messages": [{"role": "user", "content": content}],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    resp = requests.post(url, json=body, headers=headers, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"Bedrock API 오류 {resp.status_code}: {resp.text[:500]}")
    return resp.json()["content"][0]["text"]


def parse_json(text: str) -> dict | None:
    match = re.search(r'```json\s*\n(.*?)\n```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


# ─── 검증 단계 ───

VERIFY_PROMPT_TEMPLATE = """당신은 게임 기획 문서 변환 품질 검증관입니다.

첨부된 스크린샷은 Excel 기획서 "{sheet_name}" 시트의 원본 화면입니다.
아래는 이 시트를 자동 변환한 Markdown 문서입니다.

## 검증 지시

스크린샷을 꼼꼼히 살펴보고, **도형/플로우차트/이미지가 있는 영역**을 중심으로
MD 파일에 정보가 제대로 반영되었는지 검증하세요.

**10개의 구체적인 검증 질문**을 만들고, 각 질문에 대해 MD 파일을 채점하세요.

검증 질문은 다음 영역에서 골고루 출제하세요:
- 플로우차트 흐름 (분기 조건 Yes/No 포함 여부, 시작→종료 경로 완전성)
- 도형 주석/부연설명 반영 여부
- 테이블 헤더 및 구조 완전성
- 색상/강조 정보 반영 여부
- 이미지 내 텍스트 또는 이미지 맥락 설명
- 스펙아웃/제외 표시 반영 여부

## 출력 형식

JSON으로 출력하세요:

```json
{{
  "questions": [
    {{
      "id": 1,
      "category": "flowchart | table | color | image | annotation | spec_out",
      "question": "구체적인 검증 질문",
      "expected": "스크린샷에서 확인한 정답",
      "found_in_md": true 또는 false,
      "score": 0 또는 1,
      "detail": "MD에서 해당 정보를 찾은 위치 또는 누락 설명"
    }}
  ],
  "total_score": "N/10",
  "pass": true 또는 false,
  "summary": "전체 평가 요약",
  "fix_suggestions": [
    {{
      "target_file": "변신.md 또는 변신_도형.md",
      "location": "수정할 위치 설명",
      "action": "추가할 내용 (MD 형식)"
    }}
  ]
}}
```

`pass`는 total_score가 9 이상일 때 true입니다.

---

## Markdown (셀 데이터)

```markdown
{md_text}
```

{shapes_section}
"""


def build_verify_prompt(md_text: str, shapes_md_text: str = None,
                         sheet_name: str = "") -> str:
    shapes_section = ""
    if shapes_md_text:
        shapes_section = f"""## Markdown (도형/플로우차트)

```markdown
{shapes_md_text}
```"""

    return VERIFY_PROMPT_TEMPLATE.format(
        sheet_name=sheet_name,
        md_text=md_text,
        shapes_section=shapes_section,
    )


def verify(screenshot_path: str, md_path: str, shapes_md_path: str = None,
           model: str = "claude-sonnet-4-20250514") -> dict:
    """검증 수행: 스크린샷 vs MD 비교, 10개 질문 채점."""
    sheet_name = Path(md_path).stem

    with open(md_path, "r", encoding="utf-8") as f:
        md_text = f.read()
    shapes_md_text = None
    if shapes_md_path and os.path.exists(shapes_md_path):
        with open(shapes_md_path, "r", encoding="utf-8") as f:
            shapes_md_text = f.read()

    image_parts = split_tall_image(screenshot_path)
    prompt = build_verify_prompt(md_text, shapes_md_text, sheet_name)

    print(f"  검증 중 (이미지 {len(image_parts)}개)...", end=" ", flush=True)
    raw = call_bedrock(prompt, image_parts, model)

    # 분할 이미지 정리
    for p in image_parts:
        if p != screenshot_path and os.path.exists(p):
            os.remove(p)

    result = parse_json(raw)
    if result is None:
        print("JSON 파싱 실패")
        return {"total_score": "0/10", "pass": False, "raw": raw}

    score_str = result.get("total_score", "0/10")
    score = int(score_str.split("/")[0]) if "/" in str(score_str) else 0
    passed = result.get("pass", score >= 9)

    print(f"점수: {score_str} {'PASS' if passed else 'FAIL'}")
    return result


# ─── 보강 단계 ───

FIX_PROMPT_TEMPLATE = """당신은 게임 기획 문서 변환 전문가입니다.

검증 결과 아래 항목들이 누락되었습니다. MD 파일을 직접 수정하세요.

## 수정 지시

각 fix_suggestion에 대해 **정확한 수정 내용**을 생성하세요.
기존 MD의 어떤 부분을 어떻게 바꿀지 `old_text` → `new_text` 형식으로 출력하세요.

## 출력 형식

```json
{{
  "edits": [
    {{
      "target_file": "변신.md 또는 변신_도형.md",
      "old_text": "기존 MD에서 찾을 텍스트 (정확히 일치해야 함)",
      "new_text": "대체할 새 텍스트"
    }}
  ]
}}
```

old_text가 비어있으면 new_text를 파일 끝에 추가합니다.
수정이 불필요하면 edits를 빈 배열로 반환하세요.

## 검증에서 실패한 항목

{fail_items}

## 보강 제안

{fix_suggestions}

## 현재 MD (셀 데이터)

```markdown
{md_text}
```

{shapes_section}
"""


def apply_fixes(verify_result: dict, md_path: str, shapes_md_path: str = None,
                screenshot_path: str = None, model: str = "claude-sonnet-4-20250514") -> bool:
    """검증 실패 항목을 자동 보강한다. 변경 여부 반환."""
    questions = verify_result.get("questions", [])
    fail_items = [q for q in questions if q.get("score", 0) == 0]
    fix_suggestions = verify_result.get("fix_suggestions", [])

    if not fail_items and not fix_suggestions:
        print("  보강할 항목 없음")
        return False

    with open(md_path, "r", encoding="utf-8") as f:
        md_text = f.read()
    shapes_md_text = None
    if shapes_md_path and os.path.exists(shapes_md_path):
        with open(shapes_md_path, "r", encoding="utf-8") as f:
            shapes_md_text = f.read()

    shapes_section = ""
    if shapes_md_text:
        shapes_section = f"## 현재 MD (도형/플로우차트)\n\n```markdown\n{shapes_md_text}\n```"

    fail_text = json.dumps(fail_items, ensure_ascii=False, indent=2)
    fix_text = json.dumps(fix_suggestions, ensure_ascii=False, indent=2)

    prompt = FIX_PROMPT_TEMPLATE.format(
        fail_items=fail_text,
        fix_suggestions=fix_text,
        md_text=md_text,
        shapes_section=shapes_section,
    )

    # 이미지도 함께 보내서 맥락 제공
    image_parts = []
    if screenshot_path:
        image_parts = split_tall_image(screenshot_path)

    print(f"  보강 생성 중 (실패 {len(fail_items)}건)...", end=" ", flush=True)
    raw = call_bedrock(prompt, image_parts, model)

    # 분할 이미지 정리
    for p in image_parts:
        if p != screenshot_path and os.path.exists(p):
            os.remove(p)

    result = parse_json(raw)
    if not result or not result.get("edits"):
        print("수정 사항 없음")
        return False

    edits = result["edits"]
    changed = False

    for edit in edits:
        target = edit.get("target_file", "")
        old_text = edit.get("old_text", "")
        new_text = edit.get("new_text", "")

        if not new_text:
            continue

        # 대상 파일 결정
        if "도형" in target and shapes_md_path:
            file_path = shapes_md_path
        else:
            file_path = md_path

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        if old_text and old_text in content:
            content = content.replace(old_text, new_text, 1)
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)
            changed = True
            print(f"\n    수정: {Path(file_path).name} [{old_text[:30]}...] → [{new_text[:30]}...]")
        elif not old_text:
            # 파일 끝에 추가
            with open(file_path, "a", encoding="utf-8") as f:
                f.write("\n" + new_text)
            changed = True
            print(f"\n    추가: {Path(file_path).name} [{new_text[:50]}...]")

    if changed:
        print("  보강 적용 완료")
    else:
        print("  매칭되는 수정 대상 없음")

    return changed


# ─── 메인 루프 ───

def verify_and_fix_loop(screenshot_path: str, md_path: str,
                         shapes_md_path: str = None,
                         auto_fix: bool = False,
                         max_rounds: int = 3,
                         model: str = "claude-sonnet-4-20250514",
                         output_dir: str = None) -> dict:
    """검증 → 보강 → 재검증 반복 루프."""
    sheet_name = Path(md_path).stem

    if output_dir is None:
        output_dir = str(Path(md_path).parent)

    all_rounds = []

    for round_num in range(1, max_rounds + 1):
        print(f"\n{'='*50}")
        print(f"  라운드 {round_num}/{max_rounds}: {sheet_name}")
        print(f"{'='*50}")

        # 1. 검증
        result = verify(screenshot_path, md_path, shapes_md_path, model)
        score_str = result.get("total_score", "0/10")
        score = int(str(score_str).split("/")[0]) if "/" in str(score_str) else 0
        passed = result.get("pass", score >= 9)

        round_data = {
            "round": round_num,
            "score": score_str,
            "passed": passed,
            "questions": result.get("questions", []),
            "summary": result.get("summary", ""),
        }
        all_rounds.append(round_data)

        # 질문별 결과 출력
        for q in result.get("questions", []):
            mark = "O" if q.get("score", 0) == 1 else "X"
            print(f"    [{mark}] Q{q.get('id', '?')}: {q.get('question', '')[:60]}")

        if passed:
            print(f"\n  PASS! ({score_str}) 검증 완료.")
            break

        if not auto_fix:
            print(f"\n  FAIL ({score_str}). --auto-fix 옵션으로 자동 보강 가능.")
            break

        # 2. 보강
        changed = apply_fixes(result, md_path, shapes_md_path,
                               screenshot_path, model)
        if not changed:
            print("  더 이상 보강할 수 없음. 종료.")
            break

    # 결과 저장
    output_path = os.path.join(output_dir, f"{sheet_name}_검증결과.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({
            "sheet": sheet_name,
            "timestamp": datetime.now().isoformat(),
            "rounds": all_rounds,
            "final_score": all_rounds[-1]["score"] if all_rounds else "0/10",
            "final_passed": all_rounds[-1]["passed"] if all_rounds else False,
        }, f, ensure_ascii=False, indent=2)

    print(f"\n  검증 결과 저장: {output_path}")
    return all_rounds[-1] if all_rounds else {}


def main():
    parser = argparse.ArgumentParser(
        description="Tier 2 비전 기반 MD 검증 및 자동 보강")
    parser.add_argument("--screenshot", required=True, help="스크린샷 경로")
    parser.add_argument("--md", required=True, help="셀 데이터 MD 경로")
    parser.add_argument("--shapes-md", help="도형 MD 경로")
    parser.add_argument("--auto-fix", action="store_true",
                        help="검증 실패 시 자동 보강 후 재검증")
    parser.add_argument("--max-rounds", type=int, default=3,
                        help="최대 반복 횟수 (기본: 3)")
    parser.add_argument("--model", default="claude-opus-4-6",
                        help="사용할 모델 (기본: claude-opus-4-6)")
    parser.add_argument("--output-dir", "-o", help="결과 저장 폴더")

    args = parser.parse_args()

    if not os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        print("[ERROR] AWS_BEARER_TOKEN_BEDROCK 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    verify_and_fix_loop(
        args.screenshot, args.md, args.shapes_md,
        args.auto_fix, args.max_rounds, args.model, args.output_dir,
    )


if __name__ == "__main__":
    main()
