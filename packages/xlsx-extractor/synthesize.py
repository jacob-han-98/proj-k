#!/usr/bin/env python3
"""
synthesize.py - Stage 4: Vision + Parse 결과 합성 -> 최종 content.md + images/

Vision AI 출력(merged.md)을 정제하고, Parse(OOXML) 보정을 적용하여
최종 지식 베이스 문서를 생성한다.

주요 기능:
1. 타일 경계 중복 콘텐츠 감지/제거
2. 타일 섹션 헤더 제거 (# SheetName - Section N/M)
3. Parse 보정 적용 (Mermaid 플로우차트 OOXML 검증)
4. 메타데이터 헤더 추가
5. 서브 이미지 정리 및 복사
6. _final/ 디렉토리에 최종 출력

사용법:
    python synthesize.py <output_dir> [--xlsx <path>] [--sheet <name>]
    python synthesize.py output/PK_변신\ 및\ 스킬\ 시스템
    python synthesize.py output/PK_변신\ 및\ 스킬\ 시스템 --xlsx ../../7_System/PK_변신\ 및\ 스킬\ 시스템.xlsx
"""

import sys
import os
import re
import json
import shutil
import time
from pathlib import Path
from datetime import datetime

# parse.py에서 OOXML 보정 함수 import
from parse import (
    get_sheet_drawing_map,
    extract_shapes_and_connectors,
    group_flowcharts,
    extract_mermaid_blocks,
    match_mermaid_to_ooxml,
    verify_and_correct_mermaid,
    apply_corrections,
)


# ── 타일 경계 중복 제거 ──

def deduplicate_tile_boundaries(text, sheet_name):
    """타일 경계에서 발생하는 중복 콘텐츠를 감지하고 제거한다.

    처리 순서:
    1. 타일 섹션 헤더 제거 (# SheetName - Section N/M 등)
    2. "(계속)" 접미사 제거 (모든 헤딩에서)
    3. 연속 중복 헤딩 정리 (부모 컨텍스트 반복 제거)
    4. 타일 경계의 불완전 잘림 섹션 제거
    5. 최상위 # SheetName 헤더 정리 (첫 번째만 유지)
    6. 연속 빈 줄 정리
    """
    # Step 1: 타일 섹션 헤더 제거
    section_pattern = re.compile(
        rf'^# {re.escape(sheet_name)}\s*-\s*Section\s+\d+/\d+\s*\n*',
        re.MULTILINE
    )
    text = section_pattern.sub('', text)

    # 중간 생성물 헤더도 제거 (# SheetName ... (섹션 N/M) 등)
    analysis_pattern = re.compile(
        rf'^# {re.escape(sheet_name)}\s+.*?\(섹션\s*\d+/\d+\)\s*\n*',
        re.MULTILINE
    )
    text = analysis_pattern.sub('', text)

    # Step 2: "(계속)" 접미사 제거 — 모든 헤딩에서 단순히 제거
    text = re.sub(r'^(#{2,4}\s+.+?)\s*\(계속\)\s*$', r'\1', text, flags=re.MULTILINE)

    # Step 3: 연속 중복 헤딩 정리
    # (계속) 제거 후 동일 헤딩이 연속으로 나타나면, 이후 것은 부모 컨텍스트 반복
    # → 사이에 실질 콘텐츠가 없으면 첫 번째 제거 (내용은 두 번째 아래에 있으므로)
    text = _remove_context_repeat_headings(text)

    # Step 4: 타일 경계의 불완전 잘림 섹션 제거
    text = _remove_incomplete_boundary_sections(text)

    # Step 5: 중복 # SheetName 헤더 정리 (첫 번째만 유지)
    header_pattern = re.compile(
        rf'^# {re.escape(sheet_name)}\s*$',
        re.MULTILINE
    )
    matches = list(header_pattern.finditer(text))
    if len(matches) > 1:
        for m in reversed(matches[1:]):
            text = text[:m.start()] + text[m.end():]

    # Step 6: 연속 빈 줄 정리 (3개 이상 → 2개로)
    text = re.sub(r'\n{4,}', '\n\n\n', text)

    return text.strip()


def _remove_context_repeat_headings(text):
    """(계속) 제거 후 동일 헤딩이 연속 등장하는 경우,
    부모 컨텍스트 반복 헤딩을 제거한다.

    패턴 (계속 제거 후):
      ## ▶ 변신
      ### ② 세부 규칙
      #### (4) 합성            ← 원래 타일 경계 이전 콘텐츠 끝
      ## ▶ 변신                ← 부모 컨텍스트 반복 (삭제 대상)
      ### ② 세부 규칙          ← 부모 컨텍스트 반복 (삭제 대상)
      #### (4) 합성            ← 이후 콘텐츠 시작
      ... continuation content ...

    규칙: 동일 레벨+제목의 연속 헤딩 쌍에서, 사이에 하위 헤딩만 있고
    실질 콘텐츠가 없으면 → 두 번째(이후) 헤딩을 삭제한다.
    (콘텐츠는 그 아래에 있으므로 유지됨)
    """
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$', re.MULTILINE)
    all_headings = list(heading_pattern.finditer(text))

    if len(all_headings) < 2:
        return text

    # 삭제할 행들 수집 (행의 시작~끝+줄바꿈)
    removals = []

    for i in range(len(all_headings) - 1):
        h_curr = all_headings[i]
        h_next = all_headings[i + 1]

        curr_level = len(h_curr.group(1))
        next_level = len(h_next.group(1))
        curr_title = h_curr.group(2).strip()
        next_title = h_next.group(2).strip()

        # 동일 레벨+제목이 연속으로 나오고,
        # 사이에 비어있지 않은 콘텐츠 줄이 없으면 → 두 번째는 컨텍스트 반복
        if curr_level == next_level and curr_title == next_title:
            between = text[h_curr.end():h_next.start()]
            non_heading_content = [
                l for l in between.split('\n')
                if l.strip() and not l.strip().startswith('#') and not l.strip() == '---'
            ]
            if len(non_heading_content) == 0:
                # 사이에 콘텐츠 없음 → 두 번째(h_next) 헤딩 라인 삭제
                end = h_next.end()
                while end < len(text) and text[end] == '\n':
                    end += 1
                removals.append((h_next.start(), end))

    # 뒤에서부터 제거
    for start, end in sorted(removals, reverse=True):
        text = text[:start] + text[end:]

    return text


def _remove_incomplete_boundary_sections(text):
    """타일 경계에서 잘린 불완전한 섹션을 제거한다.

    동일한 제목의 헤딩이 연속으로 등장할 때 (사이에 다른 동급/상위 헤딩 없음),
    첫 번째가 짧은 경우(< 8 비어있지 않은 줄) 불완전한 잘림으로 판단하여 제거한다.
    """
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$', re.MULTILINE)
    all_headings = list(heading_pattern.finditer(text))

    if len(all_headings) < 2:
        return text

    removals = []

    for i in range(len(all_headings) - 1):
        h1 = all_headings[i]
        h1_level = len(h1.group(1))
        h1_title = h1.group(2).strip()

        for j in range(i + 1, len(all_headings)):
            h2 = all_headings[j]
            h2_level = len(h2.group(1))
            h2_title = h2.group(2).strip()

            # 동일 레벨, 동일 제목
            if h2_level == h1_level and h2_title == h1_title:
                # h1 ~ h2 사이에 같은 레벨이나 상위 레벨의 다른 헤딩이 있으면 무시
                has_sibling = False
                for k in range(i + 1, j):
                    hk_level = len(all_headings[k].group(1))
                    if hk_level <= h1_level:
                        has_sibling = True
                        break

                if has_sibling:
                    break

                # h1의 콘텐츠가 짧은지 확인 (불완전 잘림 판정)
                h1_content = text[h1.end():h2.start()]
                h1_nonempty = [l for l in h1_content.split('\n')
                               if l.strip() and not l.strip().startswith('#')]

                if len(h1_nonempty) < 8:
                    removals.append((h1.start(), h2.start()))
                break

    for start, end in sorted(removals, reverse=True):
        text = text[:start] + text[end:]

    return text


# ── Parse 보정 ──

def apply_parse_corrections(md_text, xlsx_path, sheet_name):
    """Parse(OOXML) 보정을 MD 텍스트에 적용한다.
    Returns: (corrected_text, correction_log)
    """
    try:
        sheet_drawing_map = get_sheet_drawing_map(xlsx_path)
        drawing_path = sheet_drawing_map.get(sheet_name)
        if not drawing_path:
            return md_text, None

        shapes, connectors = extract_shapes_and_connectors(xlsx_path, drawing_path)
        if not connectors:
            return md_text, None

        groups = group_flowcharts(shapes, connectors)
        if not groups:
            return md_text, None

        mermaid_blocks = extract_mermaid_blocks(md_text)
        if not mermaid_blocks:
            return md_text, {'message': 'No mermaid blocks'}

        matches = match_mermaid_to_ooxml(mermaid_blocks, groups, shapes)

        corrections_log = []
        corrected = md_text

        # 뒤에서부터 교체 (offset 유지)
        for match in sorted(matches, key=lambda m: m['block']['start'], reverse=True):
            block = match['block']
            group = groups[match['group_index']]
            result = verify_and_correct_mermaid(block['code'], group)

            if result['missing_edges']:
                corrected_code, added = apply_corrections(block['code'], result)
                new_block = f"```mermaid\n{corrected_code}\n```"
                corrected = (
                    corrected[:block['start']] +
                    new_block +
                    corrected[block['end']:]
                )
                corrections_log.append({
                    'added_edges': added,
                    'match_count': result['match_count'],
                    'ooxml_edge_count': result['ooxml_edge_count'],
                })
            else:
                corrections_log.append({
                    'added_edges': [],
                    'match_count': result['match_count'],
                    'ooxml_edge_count': result['ooxml_edge_count'],
                    'message': 'All edges verified',
                })

        return corrected, {'corrections': corrections_log}
    except Exception as e:
        return md_text, {'error': str(e)}


# ── 메타데이터 헤더 ──

def add_metadata_header(md_text, sheet_name, source_file):
    """최종 content.md에 메타데이터 헤더를 추가한다."""
    today = datetime.now().strftime("%Y-%m-%d")

    header = f"# {sheet_name}\n\n"
    header += f"> 원본: {source_file} / 시트: {sheet_name}\n"
    header += f"> 변환일: {today}\n"
    header += f"> 파이프라인: xlsx-extractor v1 (Capture -> Vision -> Parse -> Synthesize)\n"
    header += "\n---\n\n"

    # 기존 첫 줄의 # SheetName 제거
    cleaned = re.sub(
        rf'^# {re.escape(sheet_name)}\s*\n+',
        '',
        md_text,
        count=1
    )

    return header + cleaned


# ── 서브 이미지 관리 ──

def collect_referenced_images(md_text):
    """MD 텍스트에서 참조되는 이미지 파일명을 수집한다."""
    pattern = re.compile(r'!\[.*?\]\(\./images/([^)]+)\)')
    return set(pattern.findall(md_text))


def copy_sub_images(vision_images_dir, final_images_dir, referenced_files=None):
    """Vision 출력의 서브 이미지를 _final/images/로 복사한다.
    referenced_files가 주어지면 해당 파일만 복사 (dangling 방지).
    Returns: (copied_count, skipped_count, filenames)
    """
    if not os.path.isdir(vision_images_dir):
        return 0, 0, []

    os.makedirs(final_images_dir, exist_ok=True)

    copied = 0
    skipped = 0
    filenames = []
    for fname in sorted(os.listdir(vision_images_dir)):
        if not fname.lower().endswith('.png'):
            continue
        # referenced_files가 지정된 경우, 참조되는 파일만 복사
        if referenced_files is not None and fname not in referenced_files:
            skipped += 1
            continue
        src = os.path.join(vision_images_dir, fname)
        dst = os.path.join(final_images_dir, fname)
        shutil.copy2(src, dst)
        copied += 1
        filenames.append(fname)

    return copied, skipped, filenames


def remove_dangling_image_refs(md_text, available_images):
    """사용 가능한 이미지 목록에 없는 이미지 참조를 텍스트 설명으로 교체한다."""
    def _replace_missing(m):
        alt = m.group(1)
        fname = m.group(2)
        if fname in available_images:
            return m.group(0)  # 유지
        # 이미지가 없으면 텍스트 설명만 남김
        return f"*[이미지: {alt}]*"

    return re.sub(
        r'!\[([^\]]*)\]\(\./images/([^)]+)\)',
        _replace_missing,
        md_text
    )


# ── 시트별 합성 ──

def synthesize_sheet(sheet_dir, sheet_name, xlsx_path=None, source_name=""):
    """한 시트의 Vision + Parse 결과를 합성하여 _final/ 출력을 생성한다."""
    vision_output_dir = os.path.join(sheet_dir, "_vision_output")
    merged_path = os.path.join(vision_output_dir, "merged.md")

    if not os.path.exists(merged_path):
        return {"success": False, "error": "merged.md not found", "sheet_name": sheet_name}

    t_start = time.time()

    # 1. Vision 출력 읽기
    with open(merged_path, "r", encoding="utf-8") as f:
        md_text = f.read()

    original_lines = len(md_text.split('\n'))

    # 2. 타일 경계 중복 제거
    md_text = deduplicate_tile_boundaries(md_text, sheet_name)
    deduped_lines = len(md_text.split('\n'))
    lines_removed = original_lines - deduped_lines

    # 3. Parse 보정 적용 (OOXML Mermaid 검증)
    parse_result = None
    if xlsx_path and os.path.exists(xlsx_path):
        md_text, parse_result = apply_parse_corrections(md_text, xlsx_path, sheet_name)

    # 4. 메타데이터 헤더 추가
    md_text = add_metadata_header(md_text, sheet_name, source_name)

    # 5. 참조되는 이미지 파일 수집
    referenced_images = collect_referenced_images(md_text)

    # 6. _final/ 디렉토리 생성 및 서브 이미지 복사
    final_dir = os.path.join(sheet_dir, "_final")
    final_images_dir = os.path.join(final_dir, "images")
    os.makedirs(final_dir, exist_ok=True)

    vision_images_dir = os.path.join(vision_output_dir, "images")
    img_copied, img_skipped, img_files = copy_sub_images(
        vision_images_dir, final_images_dir, referenced_images
    )

    # 7. Dangling 이미지 참조 처리 (dedup으로 제거된 섹션의 이미지 등)
    md_text = remove_dangling_image_refs(md_text, set(img_files))

    # 8. content.md 출력
    content_path = os.path.join(final_dir, "content.md")
    with open(content_path, "w", encoding="utf-8") as f:
        f.write(md_text)

    elapsed = time.time() - t_start

    return {
        "success": True,
        "sheet_name": sheet_name,
        "content_path": content_path,
        "content_lines": len(md_text.split('\n')),
        "content_bytes": len(md_text.encode('utf-8')),
        "lines_deduped": lines_removed,
        "images_copied": img_copied,
        "images_skipped": img_skipped,
        "parse_corrections": parse_result,
        "elapsed_s": round(elapsed, 2),
    }


# ── 전체 처리 ──

def process_all(output_dir, xlsx_path=None, target_sheet=None):
    """모든 시트를 합성 처리한다."""
    source_name = os.path.basename(output_dir)

    # 시트 디렉토리 탐색
    sheets = []
    for entry in sorted(os.listdir(output_dir)):
        entry_path = os.path.join(output_dir, entry)
        if not os.path.isdir(entry_path) or entry.startswith("_"):
            continue
        merged = os.path.join(entry_path, "_vision_output", "merged.md")
        if os.path.exists(merged):
            # tile_manifest에서 실제 시트이름 가져오기
            tm_path = os.path.join(entry_path, "_vision_input", "tile_manifest.json")
            real_name = entry
            if os.path.exists(tm_path):
                with open(tm_path, "r", encoding="utf-8") as f:
                    tm = json.load(f)
                real_name = tm.get("sheet_name", entry)
            sheets.append({"name": real_name, "dir_name": entry, "dir": entry_path})

    if target_sheet:
        sheets = [s for s in sheets if s["name"] == target_sheet or s["dir_name"] == target_sheet]

    total = len(sheets)
    print(f"[Synthesize] Processing {total} sheets from {source_name}")
    if xlsx_path:
        print(f"[Synthesize] XLSX: {os.path.basename(xlsx_path)}")
    print()

    all_results = []
    t_start = time.time()

    for count, sheet_info in enumerate(sheets, 1):
        name = sheet_info["name"]
        sheet_dir = sheet_info["dir"]

        print(f"  [{count}/{total}] {name}...")
        result = synthesize_sheet(sheet_dir, name, xlsx_path, source_name)
        all_results.append(result)

        if result["success"]:
            parse_info = ""
            if result["parse_corrections"]:
                corrs = result["parse_corrections"].get("corrections", [])
                total_added = sum(len(c.get("added_edges", [])) for c in corrs)
                if total_added > 0:
                    parse_info = f"  parse=+{total_added} edges"
                elif corrs:
                    parse_info = "  parse=verified"

            print(f"    => {result['content_lines']} lines, "
                  f"{result['content_bytes']:,} bytes, "
                  f"dedup=-{result['lines_deduped']} lines, "
                  f"{result['images_copied']} images "
                  f"({result['images_skipped']} skipped)"
                  f"{parse_info}  "
                  f"({result['elapsed_s']:.2f}s)")
        else:
            print(f"    => FAILED: {result.get('error', '?')}")

    elapsed = time.time() - t_start

    # 요약
    success = [r for r in all_results if r["success"]]
    total_lines = sum(r["content_lines"] for r in success)
    total_bytes = sum(r["content_bytes"] for r in success)
    total_deduped = sum(r["lines_deduped"] for r in success)
    total_images = sum(r["images_copied"] for r in success)
    total_skipped = sum(r["images_skipped"] for r in success)

    print(f"\n{'='*60}")
    print(f"[Synthesize] Complete: {len(success)}/{total} sheets, {elapsed:.1f}s")
    print(f"[Synthesize] Total output: {total_lines:,} lines, {total_bytes:,} bytes")
    print(f"[Synthesize] Dedup: {total_deduped} lines removed across all sheets")
    print(f"[Synthesize] Images: {total_images} copied, {total_skipped} skipped (unreferenced)")
    print(f"{'='*60}")

    # 시트별 요약 테이블
    if len(success) > 1:
        print(f"\n{'Sheet':<25} {'Lines':>6} {'Bytes':>8} {'Dedup':>6} {'Images':>6}")
        print(f"{'-'*25} {'-'*6} {'-'*8} {'-'*6} {'-'*6}")
        for r in success:
            print(f"{r['sheet_name']:<25} {r['content_lines']:>6} "
                  f"{r['content_bytes']:>8,} {r['lines_deduped']:>6} "
                  f"{r['images_copied']:>6}")

    return all_results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python synthesize.py <output_dir> [--xlsx <path>] [--sheet <name>]")
        print("Example: python synthesize.py output/PK_변신\\ 및\\ 스킬\\ 시스템 "
              "--xlsx ../../7_System/PK_변신\\ 및\\ 스킬\\ 시스템.xlsx")
        sys.exit(1)

    output_dir = sys.argv[1]
    xlsx_path = None
    target_sheet = None

    if "--xlsx" in sys.argv:
        idx = sys.argv.index("--xlsx")
        if idx + 1 < len(sys.argv):
            xlsx_path = sys.argv[idx + 1]

    if "--sheet" in sys.argv:
        idx = sys.argv.index("--sheet")
        if idx + 1 < len(sys.argv):
            target_sheet = sys.argv[idx + 1]

    if not os.path.isdir(output_dir):
        print(f"ERROR: directory not found: {output_dir}")
        sys.exit(1)

    results = process_all(output_dir, xlsx_path, target_sheet)
    failed = [r for r in results if not r["success"]]
    sys.exit(1 if failed else 0)
