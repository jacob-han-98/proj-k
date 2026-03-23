#!/usr/bin/env python3
"""
enricher.py - Confluence MD 이미지 보강 핵심 로직

순차적 컨텍스트 누적 방식:
1. content.md에서 이미지 참조를 순서대로 추출
2. 첫 번째 이미지: 전체 MD + 이미지 → Vision API → 설명 삽입
3. 두 번째 이미지: 이미 보강된 MD + 이미지 → Vision API → 설명 삽입
4. ...반복하여 최종 content_enriched.md 생성
"""

import re
import json
import time
from pathlib import Path

try:
    from .vision_client import call_vision
except ImportError:
    from vision_client import call_vision

# 이미지 참조 패턴: ![alt](images/filename.ext)
IMAGE_REF_PATTERN = re.compile(r'!\[([^\]]*)\]\((images/[^)]+)\)')

# 토큰 윈도우 전략: 이미지 11개 이상일 때 전체 MD 대신 윈도우 사용
FULL_CONTEXT_THRESHOLD = 10
CONTEXT_WINDOW_CHARS = 3000  # 이미지 앞뒤 각 3000자


def find_image_refs(md_text: str) -> list[dict]:
    """MD 텍스트에서 이미지 참조를 순서대로 추출.
    Returns: [{"alt": str, "rel_path": str, "start": int, "end": int}]
    """
    refs = []
    for m in IMAGE_REF_PATTERN.finditer(md_text):
        refs.append({
            "alt": m.group(1),
            "rel_path": m.group(2),  # "images/filename.png"
            "start": m.start(),
            "end": m.end(),
            "full_match": m.group(0),
        })
    return refs


def _build_prompt(md_text: str, image_ref: dict, image_index: int,
                  total_images: int, use_window: bool) -> str:
    """Vision API용 프롬프트 생성."""
    filename = Path(image_ref["rel_path"]).name

    if use_window:
        # 윈도우 모드: 이미지 주변 컨텍스트만 전송
        start = max(0, image_ref["start"] - CONTEXT_WINDOW_CHARS)
        end = min(len(md_text), image_ref["end"] + CONTEXT_WINDOW_CHARS)
        context = md_text[start:end]
        context_note = f"(문서의 일부분을 보여드립니다. 이미지 참조 주변 {CONTEXT_WINDOW_CHARS}자)"
    else:
        context = md_text
        context_note = "(전체 문서)"

    prompt = f"""당신은 게임 기획 위키 문서의 이미지를 분석하는 전문가입니다.

아래는 모바일 MMORPG "Project K"의 기획 위키에서 가져온 Markdown 문서입니다 {context_note}.
이 문서에는 이미지 참조가 포함되어 있습니다.

현재 분석할 이미지: `{filename}` ({image_index + 1}/{total_images}번째)

## 문서 내용:
```markdown
{context}
```

## 요청:
첨부된 이미지가 `{filename}`입니다.
이 이미지가 문서의 맥락에서 무엇을 보여주는지 **한국어로** 간결하게 설명해주세요.

규칙:
- 제목이나 머리말 없이 바로 설명을 시작하세요. "이 이미지는..."으로 시작.
- 2~5문장으로 간결하게. 줄바꿈 없이 하나의 단락으로 작성하세요.
- 이미지에 보이는 것만 설명하세요. 추측하거나 없는 내용을 만들지 마세요.
- 게임 기획서 맥락에 맞게 전문 용어를 사용하세요.
- 이미지에 텍스트가 있으면 주요 내용을 포함하세요.
- 이미지가 표/차트/다이어그램이면 구조를 간략히 설명하세요.
- 이미지가 UI 스크린샷이면 어떤 화면인지 설명하세요.
- **중요**: 이미지에 동그라미 안에 번호(①②③ 또는 1,2,3 등)가 표시되어 있으면, 각 번호 아이콘이 가리키는 UI 요소나 영역을 빠짐없이 설명하세요. 예: "①은 좌측 상단의 보스 목록 영역을, ②는 중앙의 보스 상세 정보 패널을 가리킨다." 형식으로 번호별로 구체적 위치와 의미를 서술하세요.
"""
    return prompt


def _insert_description(md_text: str, image_ref: dict, description: str) -> str:
    """이미지 참조 바로 아래에 설명을 삽입."""
    desc_block = f"\n> **[이미지 설명]**: {description}\n"

    # 이미지 참조 다음 줄에 삽입
    insert_pos = image_ref["end"]

    # 이미지 참조 뒤에 줄바꿈이 없으면 추가
    if insert_pos < len(md_text) and md_text[insert_pos] != '\n':
        desc_block = '\n' + desc_block

    return md_text[:insert_pos] + desc_block + md_text[insert_pos:]


def enrich_page(page_dir: str, dry_run: bool = False) -> dict:
    """단일 페이지의 이미지를 보강.

    Args:
        page_dir: content.md가 있는 디렉토리 경로
        dry_run: True면 API 호출 없이 대상만 확인

    Returns:
        {
            "page_dir": str,
            "title": str,
            "total_images": int,
            "enriched_images": int,
            "status": "complete" | "partial" | "no_images" | "dry_run",
            "per_image": [...],
            "total_input_tokens": int,
            "total_output_tokens": int,
            "total_time_s": float,
        }
    """
    page_path = Path(page_dir)
    content_md = page_path / "content.md"
    enriched_md = page_path / "content_enriched.md"
    meta_path = page_path / "enrichment_meta.json"

    if not content_md.exists():
        return {"page_dir": str(page_dir), "status": "no_content_md", "total_images": 0}

    md_text = content_md.read_text(encoding="utf-8")

    # 제목 추출 (frontmatter에서)
    title = ""
    title_match = re.search(r'^title:\s*"?(.+?)"?\s*$', md_text, re.MULTILINE)
    if title_match:
        title = title_match.group(1)

    # 이미지 참조 찾기
    image_refs = find_image_refs(md_text)
    total_images = len(image_refs)

    if total_images == 0:
        return {
            "page_dir": str(page_dir),
            "title": title,
            "total_images": 0,
            "status": "no_images",
        }

    # 실제 존재하는 이미지만 필터
    valid_refs = []
    for ref in image_refs:
        img_path = page_path / ref["rel_path"]
        if img_path.exists():
            valid_refs.append(ref)
        else:
            print(f"  [SKIP] 이미지 파일 없음: {ref['rel_path']}")

    if not valid_refs:
        return {
            "page_dir": str(page_dir),
            "title": title,
            "total_images": total_images,
            "status": "no_valid_images",
        }

    if dry_run:
        image_sizes = []
        for ref in valid_refs:
            img_path = page_path / ref["rel_path"]
            image_sizes.append({
                "filename": Path(ref["rel_path"]).name,
                "size_kb": round(img_path.stat().st_size / 1024, 1),
            })
        return {
            "page_dir": str(page_dir),
            "title": title,
            "total_images": total_images,
            "valid_images": len(valid_refs),
            "images": image_sizes,
            "status": "dry_run",
        }

    # ── 순차적 보강 시작 ──
    working_md = md_text
    per_image = []
    total_input_tokens = 0
    total_output_tokens = 0
    t_start = time.time()
    enriched_count = 0

    for i, ref in enumerate(valid_refs):
        img_path = page_path / ref["rel_path"]
        filename = Path(ref["rel_path"]).name
        use_window = (i >= FULL_CONTEXT_THRESHOLD)

        print(f"  [{i + 1}/{len(valid_refs)}] {filename}", end="", flush=True)

        # 현재 working_md에서 이미지 참조 위치 재탐색 (이전 삽입으로 위치 변경됨)
        current_refs = find_image_refs(working_md)
        current_ref = None
        for cr in current_refs:
            if Path(cr["rel_path"]).name == filename:
                # 이미 설명이 달린 이미지는 건너뛰기
                check_pos = cr["end"]
                remaining = working_md[check_pos:check_pos + 100]
                if "> **[이미지 설명]**:" in remaining:
                    continue
                current_ref = cr
                break

        if current_ref is None:
            print(" → SKIP (이미 보강됨 또는 참조 없음)")
            per_image.append({
                "filename": filename,
                "status": "skipped",
            })
            continue

        # 프롬프트 생성
        prompt = _build_prompt(working_md, current_ref, i, len(valid_refs), use_window)

        try:
            result = call_vision(prompt, [str(img_path)], max_tokens=1000)
            description = result["text"]
            input_tokens = result["input_tokens"]
            output_tokens = result["output_tokens"]
            api_time = result["timing"]["api_s"]

            # 설명 삽입
            # 다시 현재 위치 찾기 (프롬프트 빌드 이후 변경 없으므로 동일)
            working_md = _insert_description(working_md, current_ref, description)
            enriched_count += 1

            total_input_tokens += input_tokens
            total_output_tokens += output_tokens

            per_image.append({
                "filename": filename,
                "status": "ok",
                "description": description,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "api_time_s": api_time,
                "image_size_kb": round(img_path.stat().st_size / 1024, 1),
            })

            print(f" → OK ({output_tokens} tokens, {api_time}s)")

        except Exception as e:
            print(f" → ERROR: {e}")
            per_image.append({
                "filename": filename,
                "status": "error",
                "error": str(e),
            })

    total_time = round(time.time() - t_start, 1)

    # ── 결과 저장 ──
    enriched_md.write_text(working_md, encoding="utf-8")
    print(f"  → {enriched_md.name} 저장 완료")

    meta = {
        "page_dir": str(page_dir),
        "title": title,
        "total_images": total_images,
        "valid_images": len(valid_refs),
        "enriched_images": enriched_count,
        "status": "complete" if enriched_count == len(valid_refs) else "partial",
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "total_time_s": total_time,
        "per_image": per_image,
        "enriched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    return meta
