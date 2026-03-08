#!/usr/bin/env python3
"""
synthesize.py - Stage 4: Vision + Parse 결과 합성 -> 최종 content.md + images/

Vision AI 출력(merged.md)을 정제하고, Parse(OOXML) 보정을 적용하여
최종 지식 베이스 문서를 생성한다.

주요 기능:
1. 타일 경계 중복 콘텐츠 감지/제거 (Dedup 2.0)
2. 분석 메타데이터 제거 (Step blocks, HTML comments, 시트 요약 등)
3. 분할된 테이블 병합
4. 원거리 중복 섹션 제거
5. Parse 보정 적용 (Mermaid 플로우차트 OOXML 검증)
6. 메타데이터 헤더 추가
7. 서브 이미지 정리 및 복사
8. _final/ 디렉토리에 최종 출력

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
    extract_grade_colors,
    rgb_to_color_name,
)


# ── 타일 경계 중복 제거 (Dedup 2.0) ──

def deduplicate_tile_boundaries(text, sheet_name):
    """타일 경계에서 발생하는 중복 콘텐츠를 감지하고 제거한다.

    처리 순서 (Dedup 2.0):
    1. 타일 섹션 헤더 제거 (다양한 패턴)
    2. 분석 메타데이터 제거 (Step blocks, HTML comments, 시트 요약 등)
    3. "(계속)" 접미사 제거
    4. 연속 중복 헤딩 정리 (부모 컨텍스트 반복 제거)
    5. 분할된 테이블 병합 (동일 헤딩+테이블 헤더 → 행 합치기)
    6. 원거리 중복 섹션 제거 (동일 제목 2회 이상 → 긴 것 유지)
    7. 타일 경계의 불완전 잘림 섹션 제거
    8. 최상위 # SheetName 헤더 정리 (첫 번째만 유지)
    9. 연속 빈 줄 정리
    """
    # Step 1: 타일 섹션 헤더 제거 (broad patterns)
    text = _remove_tile_section_headers(text, sheet_name)

    # Step 2: 분석 메타데이터 제거
    text = _remove_analysis_metadata(text)

    # Step 3: "(계속)" / "(이어서)" 접미사 제거 — 모든 헤딩에서 단순히 제거
    text = re.sub(r'^(#{2,4}\s+.+?)\s*\(계속\)\s*$', r'\1', text, flags=re.MULTILINE)
    text = re.sub(r'^(#{2,4}\s+.+?)\s*\(이어서\)\s*$', r'\1', text, flags=re.MULTILINE)

    # Step 4: 연속 중복 헤딩 정리
    text = _remove_context_repeat_headings(text)

    # Step 5: 반복되는 부모 컨텍스트 헤딩 축소
    text = _collapse_repeated_parent_headings(text)

    # Step 6: 분할된 테이블 병합
    text = _merge_duplicate_tables(text)

    # Step 7: 원거리 중복 leaf 섹션 제거
    text = _remove_far_duplicate_sections(text)

    # Step 7.5: 동일 콘텐츠 연속 섹션 제거 (다른 제목, 같은 내용)
    text = _remove_identical_content_sections(text)

    # Step 7.6: 타일 경계 레벨 불일치 헤딩 제거
    text = _remove_orphan_level_headings(text)

    # Step 7.65: 동일 heading 연속 구간 병합 (continuation merge)
    text = _merge_same_heading_continuations(text)

    # Step 7.7: bold-text 중복 heading 제거
    # **N) Title** 이미 있으면 ## N) Title 헤딩은 타일 경계 artifact
    text = _remove_bold_heading_duplicates(text)

    # Step 8: 타일 경계의 불완전 잘림 섹션 제거
    text = _remove_incomplete_boundary_sections(text)

    # Step 8: 중복 # SheetName 헤더 정리 (첫 번째만 유지)
    header_pattern = re.compile(
        rf'^# {re.escape(sheet_name)}\s*$',
        re.MULTILINE
    )
    matches = list(header_pattern.finditer(text))
    if len(matches) > 1:
        for m in reversed(matches[1:]):
            text = text[:m.start()] + text[m.end():]

    # Step 8.5: 중복 blockquote 주석 제거 (동일 키의 주석이 2번 이상 → 첫 번째만 유지)
    text = _remove_duplicate_annotations(text)

    # Step 8.6: 남은 meta-commentary 제거
    text = re.sub(r'^\[이전 섹션과.*?\]\s*$', '', text, flags=re.MULTILINE)

    # Step 9: 연속 빈 줄 정리 (3개 이상 → 2개로)
    text = re.sub(r'\n{4,}', '\n\n\n', text)

    return text.strip()


def _remove_tile_section_headers(text, sheet_name):
    """타일 섹션 헤더를 제거한다.

    Vision AI가 생성하는 다양한 패턴을 모두 처리:
    - # SheetName - Section N/M
    - # SheetName 시트 분석 (섹션 N/M)
    - # SheetName 시트 분석 (Section N/M)
    - # SheetName 시스템 기획서 분석 (섹션 N/M)
    - # SheetName (Section N/M)
    - # SheetName (섹션 N/M)
    """
    escaped = re.escape(sheet_name)
    patterns = [
        # # SheetName - Section N/M
        rf'^# {escaped}\s*-\s*Section\s+\d+/\d+\s*\n*',
        # # SheetName ... (Section N/M) or (섹션 N/M)
        rf'^# {escaped}\s+.*?\((?:Section|섹션)\s*\d+/\d+\)\s*\n*',
        # # SheetName (Section N/M) — no middle text
        rf'^# {escaped}\s*\((?:Section|섹션)\s*\d+/\d+\)\s*\n*',
        # # AnyText (섹션 N/N 계속/이어서) — generic (Vision generates expanded sheet names)
        rf'^# .+?\(섹션\s*\d+/\d+\s*[-\s]*(?:계속|이어서)\)\s*\n*',
        # # AnyText (섹션 N/N - 이어서) — dash variant
        rf'^# .+?\((?:Section|섹션)\s*\d+/\d+\s*-\s*이어서\)\s*\n*',
        # NOTE: "## 이전 섹션에서 계속..." is NOT removed here.
        # It must stay until Step block processing uses it as a stop point.
        # It gets removed in _remove_analysis_metadata after Step block cleanup.
    ]

    for pat in patterns:
        text = re.sub(pat, '', text, flags=re.MULTILINE)

    return text


def _remove_analysis_metadata(text):
    """Vision AI가 생성한 분석 메타데이터를 제거한다.

    제거 대상:
    1. HTML 주석 블록: <!-- ... -->
    2. 연속 안내 텍스트: *테이블이 다음 섹션에서 계속됩니다.*
    3. 플로우차트 분석 전체 섹션: # 플로우차트 분석 ~ 다음 # 레벨 헤딩 전
    4. Step N 블록: ## Step N: ... ~ 다음 ## 레벨 이상 헤딩 전
       단, ## Step 4: Mermaid 코드 아래의 ```mermaid``` 블록은 보존
    5. ## 주석 정보 섹션
    6. ## 시트 요약 / ## 시트 개요 끝의 요약 블록
    """
    # 1. HTML 주석 블록 제거 (multiline)
    text = re.sub(r'<!--[\s\S]*?-->', '', text)

    # 2. 연속 안내 텍스트 및 분석 완료 메타데이터 제거
    text = re.sub(r'^\*테이블이 다음 섹션에서 계속됩니다\.\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*테이블이 다음 섹션에서 계속됩니다\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*\[시트\s+.+?\s+분석\s+완료\]\*\s*$', '', text, flags=re.MULTILINE)
    # 타일 경계 continuation markers (다양한 형태)
    text = re.sub(r'^\*\[이후 섹션에서 계속\]\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*\(이전 섹션에서 이어짐\)\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*\(이전 섹션에서 이어지는 내용\)\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*\(이전 섹션에서 이어지는 테이블[^)]*\)\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*\[시트 끝\]\*\s*$', '', text, flags=re.MULTILINE)
    # Vision self-commentary about limitations (hallucinated notes)
    text = re.sub(r'^\*\*\[참고\]\*\*:?\s*.*(?:이미지에는|아래 영역에|표시되지 않았습니다).*$\n?', '', text, flags=re.MULTILINE)
    # Vision tile boundary continuation notes (various bracket/italic forms)
    text = re.sub(r'^\*\[이미지가\s+.*(?:계속됨|계속될|이어짐|이어질)\]?\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\*\[.*(?:잘려\s*있어|잘린\s*채).*(?:계속|이어).*\]\*\s*$', '', text, flags=re.MULTILINE)

    # 3-5. 섹션 단위 제거는 라인 기반으로 처리
    lines = text.split('\n')
    result_lines = []
    skip_until_heading_level = 0  # 이 레벨 이하 헤딩을 만날 때까지 skip
    preserving_mermaid = False
    mermaid_buffer = []

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # skip 모드에서 mermaid 코드 블록 보존 체크
        if skip_until_heading_level > 0:
            # mermaid 코드 블록 시작 감지
            if stripped == '```mermaid':
                preserving_mermaid = True
                mermaid_buffer = [line]
                i += 1
                continue
            elif preserving_mermaid:
                mermaid_buffer.append(line)
                if stripped == '```':
                    # mermaid 블록 완료 — 결과에 추가
                    result_lines.extend(mermaid_buffer)
                    result_lines.append('')
                    preserving_mermaid = False
                    mermaid_buffer = []
                    # Step block에서 mermaid를 보존한 후 skip 종료
                    # (mermaid 이후의 실제 콘텐츠가 소실되는 버그 방지)
                    skip_until_heading_level = 0
                i += 1
                continue

            # 종료 조건: 같은 레벨 이하의 헤딩이 나올 때
            heading_match = re.match(r'^(#{1,6})\s+', line)
            if heading_match:
                heading_level = len(heading_match.group(1))
                if heading_level <= skip_until_heading_level:
                    skip_until_heading_level = 0
                    # 이 라인은 다시 일반 처리
                else:
                    i += 1
                    continue
            else:
                i += 1
                continue

        # 섹션 시작 감지
        heading_match = re.match(r'^(#{1,6})\s+(.+?)\s*$', line)
        if heading_match:
            heading_level = len(heading_match.group(1))
            heading_title = heading_match.group(2).strip()

            # # 플로우차트 분석 (및 변형) — 헤딩 라인만 제거 (Step 블록은 개별 처리)
            # skip 모드로 진입하지 않음: 타일 헤더 제거 후 #레벨 헤딩이 없어
            # skip이 EOF까지 계속되는 버그 방지
            if heading_level == 1 and heading_title.startswith('플로우차트 분석'):
                i += 1
                continue

            # ## Step N: ... (Step 1, 2, 3, 4 등)
            if heading_level == 2 and re.match(r'^Step\s+\d+', heading_title):
                skip_until_heading_level = 2
                i += 1
                continue

            # ## 주석 정보
            if heading_level == 2 and heading_title == '주석 정보':
                skip_until_heading_level = 2
                i += 1
                continue

            # ## 시트 요약 (문서 끝의 AI 생성 요약)
            if heading_level == 2 and heading_title.startswith('시트 요약'):
                skip_until_heading_level = 2
                i += 1
                continue

            # ## 분석 결과 (section N/M) — Vision이 타일 전환 시 생성하는 메타 코멘트
            if heading_level == 2 and re.match(r'^분석 결과\s*\(', heading_title):
                skip_until_heading_level = 2
                i += 1
                continue

        # 일반 라인 — 결과에 추가
        result_lines.append(line)
        i += 1

    text = '\n'.join(result_lines)

    # "## 이전 섹션에서 계속..." 제거 — Step block 처리 이후에 해야 함
    # (Step block skip은 ## 레벨 헤딩을 stop point로 사용하므로)
    text = re.sub(r'^##\s+이전\s+섹션에서\s+계속\.{0,3}\s*$\n*', '', text, flags=re.MULTILINE)

    # 남은 --- 만 있는 줄(구분선) 연속 처리
    text = re.sub(r'(\n---\s*\n)\s*(\n---\s*\n)', r'\1', text)

    return text


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
                end = h_next.end()
                while end < len(text) and text[end] == '\n':
                    end += 1
                removals.append((h_next.start(), end))

    for start, end in sorted(removals, reverse=True):
        text = text[:start] + text[end:]

    return text


def _collapse_repeated_parent_headings(text):
    """반복되는 부모 컨텍스트 헤딩을 축소한다.

    타일 경계에서 Vision AI가 부모 헤딩 체인을 반복 출력하는 패턴:
      ## ▶ 변신
      ### ② 세부 규칙
      #### (1)~(3) ...content...
      ## ▶ 변신                ← 2번째 등장, 컨텍스트 반복
      ### ② 세부 규칙          ← 2번째 등장, 컨텍스트 반복
      #### (4) 합성             ← 고유 콘텐츠

    처리: 두 번째 이후 등장하는 부모 헤딩(하위 헤딩만 가진 컨테이너)을
    제거하되, 그 아래의 고유 자식 콘텐츠는 유지한다.

    부모 헤딩 판별: 해당 헤딩 ~ 다음 같은 레벨 헤딩 사이에
    하위 헤딩이 존재하면 "부모" (컨테이너)로 간주.
    """
    lines = text.split('\n')
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$')

    # 각 라인의 헤딩 정보 파싱
    heading_at = {}  # line_idx -> (level, title)
    for i, line in enumerate(lines):
        m = heading_pattern.match(line)
        if m:
            heading_at[i] = (len(m.group(1)), m.group(2).strip())

    heading_indices = sorted(heading_at.keys())
    if len(heading_indices) < 2:
        return text

    # 각 헤딩이 부모(컨테이너)인지 판별
    def is_parent_heading(h_idx):
        """헤딩 바로 뒤에 비어있는 줄/구분선 이후 하위 헤딩이 나오면 부모"""
        level = heading_at[h_idx][0]
        # 이 헤딩 뒤의 첫 번째 비어있지 않은 줄 확인
        for j in range(h_idx + 1, len(lines)):
            stripped = lines[j].strip()
            if not stripped or stripped == '---':
                continue
            # 첫 번째 비어있지 않은 줄이 더 깊은 헤딩이면 부모
            m2 = heading_pattern.match(lines[j])
            if m2 and len(m2.group(1)) > level:
                return True
            return False
        return False

    # seen: 이미 출현한 (level, title) 세트
    seen = set()
    lines_to_remove = set()

    for h_idx in heading_indices:
        level, title = heading_at[h_idx]
        key = (level, title)

        if key not in seen:
            seen.add(key)
            continue

        # 이미 등장한 적 있는 헤딩
        if is_parent_heading(h_idx):
            # 부모 헤딩 → 이 라인만 제거 (자식 콘텐츠는 유지)
            lines_to_remove.add(h_idx)

    if not lines_to_remove:
        return text

    result = [line for i, line in enumerate(lines) if i not in lines_to_remove]
    return '\n'.join(result)


def _merge_duplicate_tables(text):
    """동일 헤딩 아래에 분할된 테이블을 하나로 병합한다.

    히스토리 시트의 경우, 타일 경계에서 같은 테이블이 4번 반복될 수 있다:
      ## 문서 히스토리 테이블
      | 날짜 | 작성자 | ... |
      |------|--------|-----|
      | row1 |
      | row2 |

      ## 문서 히스토리 테이블   ← 같은 헤딩
      | 날짜 | 작성자 | ... |  ← 같은 테이블 헤더
      |------|--------|-----|
      | row2 |                  ← 겹치는 행 (dedup 대상)
      | row3 |

    → 하나로 합치고 중복 행을 제거한다.
    """
    lines = text.split('\n')
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$')

    # 1단계: 테이블이 있는 헤딩들을 수집
    table_groups = []

    i = 0
    while i < len(lines):
        m = heading_pattern.match(lines[i])
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            heading_idx = i

            # 이 헤딩 아래에 테이블이 있는지 확인
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1

            if j < len(lines) and lines[j].strip().startswith('|'):
                table_header = lines[j].strip()
                header_line = j

                k = j + 1
                if k < len(lines) and re.match(r'^\|[\s\-:|]+\|', lines[k].strip()):
                    sep_line = k
                    k += 1
                else:
                    i += 1
                    continue

                rows = []
                while k < len(lines) and lines[k].strip().startswith('|'):
                    rows.append(lines[k].strip())
                    k += 1

                if rows:
                    table_groups.append({
                        'heading_idx': heading_idx,
                        'level': level,
                        'title': title,
                        'table_header': table_header,
                        'separator': lines[sep_line].strip(),
                        'rows': rows,
                        'section_start': heading_idx,
                        'section_end': k,
                    })

        i += 1

    if len(table_groups) < 2:
        return text

    # 2단계: 동일 (level, title, table_header)를 가진 그룹들 찾기
    from collections import defaultdict
    merge_map = defaultdict(list)
    for idx, g in enumerate(table_groups):
        key = (g['level'], g['title'], g['table_header'])
        merge_map[key].append(idx)

    to_merge = {k: v for k, v in merge_map.items() if len(v) > 1}
    if not to_merge:
        return text

    # 3단계: set-based 라인 제거 + 첫 번째 그룹에 merged rows 삽입
    lines_to_remove = set()
    # key -> merged rows (첫 번째 그룹의 행을 교체할 내용)
    first_group_replacement = {}  # heading_idx -> merged_rows

    for key, group_indices in to_merge.items():
        groups = [table_groups[gi] for gi in group_indices]

        # 모든 행 합치기 (중복 제거, 순서 유지)
        merged_rows = []
        seen = set()
        for g in groups:
            for row in g['rows']:
                if row not in seen:
                    merged_rows.append(row)
                    seen.add(row)

        # 첫 번째 그룹의 기존 데이터 행들을 제거 대상에 추가
        first_g = groups[0]
        first_row_start = first_g['section_end'] - len(first_g['rows'])
        for li in range(first_row_start, first_g['section_end']):
            lines_to_remove.add(li)

        # 첫 번째 그룹의 heading_idx에 교체 기록
        first_group_replacement[first_row_start] = merged_rows

        # 나머지 그룹 전체 삭제 (heading 앞의 빈줄/--- 포함)
        for g in groups[1:]:
            start = g['section_start']
            end = g['section_end']
            # heading 앞의 빈 줄/--- 포함
            while start > 0 and start not in lines_to_remove:
                prev = lines[start - 1].strip()
                if not prev or prev == '---':
                    start -= 1
                else:
                    break
            for li in range(start, end):
                lines_to_remove.add(li)

    # 4단계: 새 라인 배열 빌드
    result = []
    for i, line in enumerate(lines):
        if i in first_group_replacement:
            # 이 위치에 merged rows 삽입
            result.extend(first_group_replacement[i])
        elif i not in lines_to_remove:
            result.append(line)

    return '\n'.join(result)


def _remove_far_duplicate_sections(text):
    """원거리에서 반복되는 동일 제목의 leaf 섹션을 제거한다.

    동일 (level, title)의 헤딩이 2회 이상 나타날 때:
    - leaf 섹션만 대상 (하위 헤딩이 없는 최종 단계 섹션)
    - 각 occurrence의 콘텐츠 길이를 비교
    - 가장 긴 (풍부한) 버전을 유지하고 나머지 제거
    - 동일 길이면 나중 것을 유지 (더 완전할 가능성)

    Parent 헤딩(## ▶ 변신, ### ② 세부 규칙 등)은 건너뛴다 —
    이들은 각 타일에서 구조적 컨텍스트로 반복되지만, 하위에 서로 다른
    고유 콘텐츠를 포함하므로 제거하면 안 된다.
    """
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$', re.MULTILINE)
    all_headings = list(heading_pattern.finditer(text))

    if len(all_headings) < 2:
        return text

    # 각 헤딩의 콘텐츠 범위 및 leaf 여부 계산
    heading_info = []
    for i, h in enumerate(all_headings):
        level = len(h.group(1))
        title = h.group(2).strip()
        start = h.start()

        # 이 헤딩의 콘텐츠 끝 = 같은 레벨 이하의 다음 헤딩 시작 직전
        end = len(text)
        has_sub_headings = False
        for j in range(i + 1, len(all_headings)):
            next_level = len(all_headings[j].group(1))
            if next_level <= level:
                end = all_headings[j].start()
                break
            else:
                has_sub_headings = True

        content = text[h.end():end]
        content_lines = [l for l in content.split('\n') if l.strip()]

        heading_info.append({
            'level': level,
            'title': title,
            'start': start,
            'end': end,
            'content_len': len(content_lines),
            'is_leaf': not has_sub_headings,
        })

    # 동일 (level, title) 그룹 찾기 — leaf만
    # 1차: 같은 (level, title) 매칭
    from collections import defaultdict
    groups = defaultdict(list)
    for idx, info in enumerate(heading_info):
        if info['is_leaf']:
            groups[(info['level'], info['title'])].append(idx)

    # 2차: cross-level 매칭 (같은 title, 다른 level)
    # 짧은 제목(숫자/기호만)은 false positive 방지를 위해 제외
    title_only_groups = defaultdict(list)
    for idx, info in enumerate(heading_info):
        if info['is_leaf'] and len(info['title']) > 3:
            title_only_groups[info['title']].append(idx)

    for title, indices in title_only_groups.items():
        if len(indices) < 2:
            continue
        # 같은 level끼리는 이미 처리되므로, 다른 level이 섞인 경우만
        levels = set(heading_info[i]['level'] for i in indices)
        if len(levels) > 1:
            # 이 cross-level 그룹을 별도 그룹으로 등록
            # 기존 same-level 그룹에서 이미 처리된 것은 제외
            key = ('cross', title)
            groups[key] = indices

    # 2.5차: 번호 체계가 다른 동일 제목 매칭 (① vs (1) vs 1. 등)
    # Vision이 같은 섹션을 다른 타일에서 다른 번호로 출력하는 패턴 처리
    def _strip_number_prefix(title):
        """제목에서 번호 접두사를 제거하여 비교용 정규화 텍스트를 반환한다."""
        # ① ② ③ ... ⑳ → 제거
        stripped = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*', '', title)
        # (1) (2) ... (99) → 제거
        stripped = re.sub(r'^\(\d+\)\s*', '', stripped)
        # 1. 2. ... → 제거
        stripped = re.sub(r'^\d+\.\s*', '', stripped)
        return stripped.strip()

    normalized_groups = defaultdict(list)
    for idx, info in enumerate(heading_info):
        if info['is_leaf']:
            norm = _strip_number_prefix(info['title'])
            if norm and len(norm) > 3:
                normalized_groups[norm].append(idx)

    for norm_title, indices in normalized_groups.items():
        if len(indices) < 2:
            continue
        # 실제 title이 다른 경우만 (같으면 1차에서 이미 처리됨)
        titles = set(heading_info[i]['title'] for i in indices)
        if len(titles) > 1:
            key = ('norm', norm_title)
            groups[key] = indices

    # 2.7차: prefix title matching — 한 제목이 다른 제목의 접두사인 경우
    # 예: "③ 기타 사항" vs "③ 기타 사항 (이미지 하단 텍스트)"
    all_titles = [(idx, info['title']) for idx, info in enumerate(heading_info) if info['is_leaf']]
    for ia, (idx_a, title_a) in enumerate(all_titles):
        for ib, (idx_b, title_b) in enumerate(all_titles):
            if ia >= ib:
                continue
            if title_a == title_b:
                continue
            # 짧은 제목이 긴 제목의 접두사인지
            shorter, longer = (title_a, title_b) if len(title_a) <= len(title_b) else (title_b, title_a)
            if len(shorter) > 3 and longer.startswith(shorter):
                key = ('prefix', shorter)
                if key not in groups:
                    groups[key] = []
                existing = set(groups[key])
                if idx_a not in existing:
                    groups[key].append(idx_a)
                if idx_b not in existing:
                    groups[key].append(idx_b)

    # 3차: same-level parent+leaf duplicate handling
    # 같은 (level, title) 헤딩이 parent(sub-heading 있음)와 leaf(없음)로 모두 등장 시,
    # parent의 sub-heading은 이전 섹션에서 밀려온 것 (타일 경계 artifact).
    # parent heading + direct content만 제거하고 sub-heading은 유지.
    all_same_level = defaultdict(list)
    for idx, info in enumerate(heading_info):
        all_same_level[(info['level'], info['title'])].append(idx)

    parent_leaf_removals = []
    for key, indices in all_same_level.items():
        if len(indices) < 2:
            continue
        leaf_indices = [i for i in indices if heading_info[i]['is_leaf']]
        parent_indices = [i for i in indices if not heading_info[i]['is_leaf']]
        if not leaf_indices or not parent_indices:
            continue
        for p_idx in parent_indices:
            first_sub_start = heading_info[p_idx]['end']
            for j in range(p_idx + 1, len(heading_info)):
                if heading_info[j]['level'] > heading_info[p_idx]['level']:
                    first_sub_start = heading_info[j]['start']
                    break
                elif heading_info[j]['level'] <= heading_info[p_idx]['level']:
                    break
            # parent heading + direct content 제거, sub-headings은 유지
            # parent의 sub-headings은 이전 섹션에서 밀려온 타일 경계 artifact이므로
            # leaf가 존재하면 항상 parent의 heading+direct를 제거한다
            parent_leaf_removals.append((heading_info[p_idx]['start'], first_sub_start))

    # 라인 정규화 (blockquote 접두사, 볼드 마커 제거 후 비교)
    def _normalize_line(line):
        """비교용 라인 정규화: blockquote, 볼드 등 포맷 마커 제거."""
        s = line.strip()
        # blockquote prefix 제거
        s = re.sub(r'^>\s*', '', s)
        # 볼드 마커 제거
        s = s.replace('**', '')
        return s.strip()

    def _extract_normalized_lines(start, end):
        """섹션의 정규화된 콘텐츠 라인 set 추출."""
        return set(
            _normalize_line(l) for l in text[start:end].split('\n')
            if l.strip() and not l.strip().startswith('#') and l.strip() != '---'
        )

    # 중복 있는 그룹만 처리
    removals = parent_leaf_removals[:]
    for key, indices in groups.items():
        if len(indices) < 2:
            continue

        # 가장 긴 콘텐츠를 가진 것을 유지 (tie: 나중 것)
        best_idx = max(indices, key=lambda i: (heading_info[i]['content_len'], i))
        best_info = heading_info[best_idx]
        best_lines = _extract_normalized_lines(best_info['start'], best_info['end'])

        for idx in indices:
            if idx != best_idx:
                info = heading_info[idx]
                shorter_lines = _extract_normalized_lines(info['start'], info['end'])
                if not shorter_lines:
                    removals.append((info['start'], info['end']))
                    continue

                # 겹침 비율 계산: 정규화된 라인 기준
                overlap = shorter_lines & best_lines
                overlap_ratio = len(overlap) / len(shorter_lines) if shorter_lines else 1.0

                if overlap_ratio >= 0.4:
                    # 40% 이상 겹침 → 진짜 중복, 제거
                    removals.append((info['start'], info['end']))
                # else: 고유 콘텐츠가 많음 → 제거하지 않고 유지 (다른 내용이 같은 제목으로 분할된 경우)

    if not removals:
        return text

    # 정렬 후 겹침 제거
    removals.sort()
    merged_removals = []
    for start, end in removals:
        if merged_removals and start < merged_removals[-1][1]:
            merged_removals[-1] = (merged_removals[-1][0], max(merged_removals[-1][1], end))
        else:
            merged_removals.append((start, end))

    # 뒤에서부터 제거
    for start, end in reversed(merged_removals):
        text = text[:start] + text[end:]

    return text


def _remove_identical_content_sections(text):
    """같은 레벨의 연속 섹션이 동일한 콘텐츠를 가진 경우 중복을 제거한다.

    타일 경계에서 Vision AI가 같은 내용을 다른 제목(번호)으로 출력하는 경우:
      ## ③ 기타 사항 (이미지 하단 텍스트)
      > (1) 변신에 외형 및 ...
      > (2) 캐릭터의 외형 ...

      ## ④ 기타 사항
      > (1) 변신에 외형 및 ...   ← 동일 콘텐츠
      > (2) 캐릭터의 외형 ...   ← 동일 콘텐츠

    처리: 콘텐츠가 완전히 동일하면 앞쪽 섹션을 제거 (뒤쪽이 올바른 번호일 가능성 높음).
    """
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$', re.MULTILINE)
    all_headings = list(heading_pattern.finditer(text))

    if len(all_headings) < 2:
        return text

    removals = []

    for i in range(len(all_headings) - 1):
        h1 = all_headings[i]
        h2 = all_headings[i + 1]
        h1_level = len(h1.group(1))
        h2_level = len(h2.group(1))

        if h1_level != h2_level:
            continue

        # 각 섹션의 콘텐츠 (헤딩 제외) 추출
        h1_end = h2.start()
        h2_end = len(text)
        for j in range(i + 2, len(all_headings)):
            if len(all_headings[j].group(1)) <= h2_level:
                h2_end = all_headings[j].start()
                break

        raw1 = text[h1.end():h1_end].strip()
        raw2 = text[h2.end():h2_end].strip()

        # 빈 섹션은 건너뜀
        if not raw1 or not raw2:
            continue

        # 비교 시 --- 구분선과 빈 줄 제거, 번호 접두사 통일하여 정규화
        def _normalize(s):
            lines = [l.strip() for l in s.split('\n') if l.strip() and l.strip() != '---']
            return '\n'.join(lines)

        def _normalize_deep(s):
            """번호 체계, 미세한 조사 차이까지 무시한 깊은 정규화"""
            s = _normalize(s)
            # Mermaid 플로우차트 주석 라인 제거 (다른 섹션에 소속된 주석)
            s = re.sub(r'^>\s*\*\*\[.*?\].*주석\*\*.*$', '', s, flags=re.MULTILINE)
            # 번호 접두사 통일: (1), 1., ①  → 모두 제거
            s = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*', '', s, flags=re.MULTILINE)
            s = re.sub(r'^\(\d+\)\s*', '', s, flags=re.MULTILINE)
            s = re.sub(r'^\d+[\.\)]\s*', '', s, flags=re.MULTILINE)
            # 한글 조사 미세차이 무시 (에/이/을/를/은/는)
            s = re.sub(r'(?<=[\uac00-\ud7af])[에이을를은는가의](?=\s)', '', s)
            # 최종 정리: 빈 줄 제거
            s = '\n'.join(l for l in s.split('\n') if l.strip())
            return s

        content1 = _normalize(raw1)
        content2 = _normalize(raw2)

        # 정확히 동일하거나, 깊은 정규화 후 동일하면 앞쪽 제거
        if content1 == content2 or _normalize_deep(raw1) == _normalize_deep(raw2):
            removals.append((h1.start(), h1_end))

    for start, end in sorted(removals, reverse=True):
        text = text[:start] + text[end:]

    return text


def _remove_orphan_level_headings(text):
    """타일 경계에서 잘못된 레벨로 출력된 orphan 헤딩을 제거한다.

    패턴: Vision AI가 타일 경계에서 부모 컨텍스트를 잃고
    잘못된 레벨로 헤딩을 출력하는 경우:
      ## 4. 장판 기능       ← orphan (부모 ## ③ 밖에서 출력)
      ... (짧은 미리보기 콘텐츠) ...
      ### 4. 장판 기능      ← 정상 (부모 ## ③ 아래)
      ... (전체 콘텐츠) ...

    처리: 같은 title을 가진 더 얕은(##) 헤딩이 더 깊은(###) 헤딩
    근처에 있고, 더 짧은 콘텐츠를 가지면 orphan으로 판단하여 제거.
    """
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$', re.MULTILINE)
    all_headings = list(heading_pattern.finditer(text))

    if len(all_headings) < 2:
        return text

    # 제목별로 헤딩 그룹화 (레벨 무시)
    from collections import defaultdict
    title_groups = defaultdict(list)
    for i, h in enumerate(all_headings):
        level = len(h.group(1))
        title = h.group(2).strip()
        if len(title) > 3:  # 짧은 제목 제외 (false positive 방지)
            title_groups[title].append((i, level, h))

    removals = []

    for title, entries in title_groups.items():
        if len(entries) < 2:
            continue

        # 다른 레벨이 섞여있는지 확인
        levels = set(e[1] for e in entries)
        if len(levels) < 2:
            continue

        # 각 occurrence의 콘텐츠 길이 계산
        for idx_a, (ia, level_a, ha) in enumerate(entries):
            for idx_b, (ib, level_b, hb) in enumerate(entries):
                if idx_a >= idx_b:
                    continue
                if level_a == level_b:
                    continue

                # 얕은 것과 깊은 것 구분
                if level_a < level_b:
                    shallow_i, shallow_h = ia, ha
                    deep_i, deep_h = ib, hb
                else:
                    shallow_i, shallow_h = ib, hb
                    deep_i, deep_h = ia, ha

                # 얕은 것의 "고유" 콘텐츠 = 얕은 헤딩 ~ 깊은 헤딩 사이
                # (깊은 헤딩 아래 콘텐츠는 제외)
                if shallow_i < deep_i:
                    # shallow가 먼저, deep이 나중 — shallow가 orphan 후보
                    orphan_content = text[shallow_h.end():deep_h.start()]
                    orphan_lines = [l for l in orphan_content.split('\n')
                                    if l.strip() and not l.strip().startswith('#')
                                    and l.strip() != '---']
                    if len(orphan_lines) < 15:
                        # overlap check: orphan 콘텐츠가 survivor에도 있는지 확인
                        surv_end = all_headings[deep_i + 1].start() if deep_i + 1 < len(all_headings) else len(text)
                        surv_content = text[deep_h.end():surv_end]
                        surv_lines = set(l.strip() for l in surv_content.split('\n')
                                        if l.strip() and not l.strip().startswith('#'))
                        orphan_set = set(l.strip() for l in orphan_lines)
                        if not orphan_set:
                            removals.append((shallow_h.start(), deep_h.start()))
                        else:
                            overlap = orphan_set & surv_lines
                            if len(overlap) / len(orphan_set) >= 0.4:
                                removals.append((shallow_h.start(), deep_h.start()))
                            # else: orphan has unique content, keep it
                else:
                    # deep이 먼저, shallow가 나중 — deep이 orphan 후보
                    # (타일 경계에서 더 깊은 레벨 헤딩이 먼저 나온 후,
                    #  다음 타일에서 올바른 상위 레벨 헤딩이 나오는 패턴)
                    orphan_content = text[deep_h.end():shallow_h.start()]
                    orphan_lines = [l for l in orphan_content.split('\n')
                                    if l.strip() and not l.strip().startswith('#')
                                    and l.strip() != '---']
                    if len(orphan_lines) < 15:
                        # overlap check: orphan 콘텐츠가 survivor에도 있는지 확인
                        surv_end = len(text)
                        for k in range(shallow_i + 1, len(all_headings)):
                            if len(all_headings[k].group(1)) <= level_b:
                                surv_end = all_headings[k].start()
                                break
                        surv_content = text[shallow_h.end():surv_end]
                        surv_lines = set(l.strip() for l in surv_content.split('\n')
                                        if l.strip() and not l.strip().startswith('#'))
                        orphan_set = set(l.strip() for l in orphan_lines)
                        if not orphan_set:
                            removals.append((deep_h.start(), shallow_h.start()))
                        else:
                            overlap = orphan_set & surv_lines
                            if len(overlap) / len(orphan_set) >= 0.4:
                                removals.append((deep_h.start(), shallow_h.start()))
                            # else: orphan has unique content, keep it

    if not removals:
        return text

    # 겹침 정리 및 뒤에서부터 제거
    removals.sort()
    merged = []
    for start, end in removals:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    for start, end in reversed(merged):
        text = text[:start] + text[end:]

    return text


def _merge_same_heading_continuations(text):
    """동일 제목의 헤딩이 다시 나타나면 연속 구간으로 병합한다.

    타일 경계에서 같은 제목의 헤딩이 반복되는 패턴:
      ### (4) 합성
      → 목적: ...
      → 비고: ...
      **[표준도]**

      ## (4) 합성            ← 타일 경계 artifact (heading 제거)
      **[흐름도]**            ← 이 이후 고유 콘텐츠는 유지
      ```mermaid ...```

    처리:
    1. 두 번째 heading을 제거
    2. 두 번째 섹션 시작부에서 첫 번째 섹션 끝과 중복되는 라인 제거
    3. 나머지 고유 콘텐츠는 자연스럽게 이어붙임
    """
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$', re.MULTILINE)
    all_headings = list(heading_pattern.finditer(text))

    if len(all_headings) < 2:
        return text

    # 같은 title (번호 접두사 정규화 포함)을 가진 헤딩 쌍 찾기
    def _norm_title(title):
        t = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩]\s*', '', title)
        t = re.sub(r'^\(\d+\)\s*', '', t)
        t = re.sub(r'^\d+\.\s*', '', t)
        return t.strip()

    removals = []  # (start, end) ranges to delete

    for i in range(len(all_headings)):
        for j in range(i + 1, len(all_headings)):
            h_first = all_headings[i]
            h_second = all_headings[j]
            title_first = h_first.group(2).strip()
            title_second = h_second.group(2).strip()

            # 제목이 같은지 (정확 일치 또는 정규화 일치)
            if title_first != title_second and _norm_title(title_first) != _norm_title(title_second):
                continue

            # 사이에 다른 같은/상위 레벨 헤딩이 있으면 스킵 (인접 아님)
            first_level = min(len(h_first.group(1)), len(h_second.group(1)))
            between_headings = [h for h in all_headings[i+1:j]
                                if len(h.group(1)) <= first_level]
            if between_headings:
                continue

            # 첫 번째 섹션의 전체 콘텐츠 라인 수집
            first_end_pos = h_second.start()
            first_content = text[h_first.end():first_end_pos]
            first_all_lines = [l.strip() for l in first_content.split('\n')
                               if l.strip() and not l.strip().startswith('#')
                               and l.strip() != '---']
            first_tail_set = set(first_all_lines) if first_all_lines else set()

            # 두 번째 섹션의 시작 콘텐츠 수집
            second_end_pos = all_headings[j+1].start() if j+1 < len(all_headings) else len(text)
            second_content = text[h_second.end():second_end_pos]
            second_lines = second_content.split('\n')

            # 두 번째 섹션 시작부에서 첫 번째 섹션 끝과 겹치는 라인 찾기
            overlap_end = 0
            for k, line in enumerate(second_lines):
                stripped = line.strip()
                if not stripped or stripped == '---':
                    overlap_end = k + 1
                    continue
                if stripped.startswith('#'):
                    break
                if stripped in first_tail_set:
                    overlap_end = k + 1
                else:
                    break

            # heading + 중복 콘텐츠 제거 범위 계산
            # h_second.start() ~ h_second.end() + overlap 라인들
            remove_start = h_second.start()
            if overlap_end > 0:
                # heading + overlap 라인들 제거
                remaining_lines = second_lines[overlap_end:]
                remove_end_text = '\n'.join(second_lines[:overlap_end])
                remove_end = h_second.end() + len(remove_end_text)
                # 후행 줄바꿈 포함
                while remove_end < len(text) and text[remove_end] == '\n':
                    remove_end += 1
                    # 최대 2개 줄바꿈
                    if remove_end - h_second.end() - len(remove_end_text) >= 2:
                        break
            else:
                # heading만 제거
                remove_end = h_second.end()
                while remove_end < len(text) and text[remove_end] == '\n':
                    remove_end += 1
                    if remove_end - h_second.end() >= 2:
                        break

            removals.append((remove_start, remove_end))
            break  # 한 쌍만 처리 후 다음 i로

    # 뒤에서부터 제거
    for start, end in sorted(removals, reverse=True):
        text = text[:start] + text[end:]

    return text


def _remove_bold_heading_duplicates(text):
    """**Title** bold text와 동일한 ## Title heading이 있으면 heading 섹션을 제거한다.

    패턴 (타일 경계 artifact):
      **2) 복수 소환 / 합성**   ← 원래 콘텐츠 (bold text)
      * 2개 이상 소환

      ## 2) 복수 소환 / 합성    ← 타일 경계에서 heading으로 재출력 (제거 대상)
      * 2개 이상 소환

    처리: ## heading 이전 200줄 내에 **title** bold text가 있으면
          heading + 직후 3줄 이내의 중복 라인만 제거 (보수적).
    """
    lines = text.split('\n')
    heading_pattern = re.compile(r'^(#{2,4})\s+(.+?)\s*$')

    removals = []  # (start_line, end_line) — exclusive

    for i, line in enumerate(lines):
        m = heading_pattern.match(line)
        if not m:
            continue
        title = m.group(2).strip()

        # 이전 200줄 내에서 **title** bold text 검색 → 해당 위치(bold_line) 기억
        bold_pattern = f'**{title}**'
        bold_line = -1
        for j in range(max(0, i - 200), i):
            if bold_pattern in lines[j]:
                bold_line = j
                break

        if bold_line < 0:
            continue

        # bold text 직후의 콘텐츠 라인들 수집 (bold 이후 5줄)
        bold_following = []
        for j in range(bold_line + 1, min(bold_line + 6, len(lines))):
            s = lines[j].strip()
            if s and s != '---':
                bold_following.append(s)

        # heading + 직후 최대 3줄만 비교하여 중복 라인 제거
        end = i + 1
        matched = 0
        while end < len(lines) and matched < 3:
            content = lines[end].strip()
            if not content:
                end += 1
                continue
            if content in bold_following:
                end += 1
                matched += 1
            else:
                break

        removals.append((i, end))

    # 뒤에서부터 제거
    for start, end in sorted(removals, reverse=True):
        lines[start:end] = []

    return '\n'.join(lines)


def _remove_duplicate_annotations(text):
    """중복 blockquote 주석을 제거한다.

    Vision AI가 타일 경계에서 같은 주석을 반복 출력하는 패턴 처리:
      > **[결과 대기 화면A] 주석**: 모든 카드가...
      > **[결과 대기 화면A] 주석**: 모든카드가...  ← 중복, 제거

    규칙: 동일한 key(예: "결과 대기 화면A")를 가진 주석은 첫 번째만 유지.
    """
    lines = text.split('\n')
    seen_keys = set()
    result = []
    i = 0

    while i < len(lines):
        line = lines[i]
        # > **[Key] 주석**: ... 또는 > **[Key]**: ... 패턴 감지
        m = re.match(r'^>\s*\*\*\[(.+?)\](?:\s*주석)?\*\*\s*:\s*', line)
        if m:
            key = m.group(1).strip()
            # 여러 줄에 걸친 blockquote 수집
            block_end = i + 1
            while block_end < len(lines) and lines[block_end].startswith('>'):
                block_end += 1

            if key in seen_keys:
                # 중복 → 건너뛰기
                i = block_end
                # 이후 빈 줄도 건너뛰기
                while i < len(lines) and not lines[i].strip():
                    i += 1
                continue
            else:
                seen_keys.add(key)
                result.extend(lines[i:block_end])
                i = block_end
        else:
            result.append(line)
            i += 1

    return '\n'.join(result)


def _remove_incomplete_boundary_sections(text):
    """타일 경계에서 잘린 불완전한 섹션을 제거한다.

    동일한 제목의 헤딩이 등장할 때 (사이에 다른 동급/상위 헤딩 없음),
    첫 번째가 짧은 경우(< 5 비어있지 않은 줄) 불완전한 잘림으로 판단하여 제거한다.
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

                # h1의 콘텐츠가 짧은지 확인 (불완전 잘림 판정) — threshold 5줄로 낮춤
                h1_content = text[h1.end():h2.start()]
                h1_nonempty = [l for l in h1_content.split('\n')
                               if l.strip() and not l.strip().startswith('#')]

                if len(h1_nonempty) < 5:
                    removals.append((h1.start(), h2.start()))
                break

    for start, end in sorted(removals, reverse=True):
        text = text[:start] + text[end:]

    return text


# ── Parse 보정 ──

def correct_grade_colors(md_text, xlsx_path, sheet_name):
    """OOXML 셀 배경색 데이터로 Vision AI의 근사 색상 표기를 보정한다.

    Vision AI는 등급 색상을 "(보라색)", "(빨간색)" 등 근사값으로 출력하지만
    실제 OOXML 데이터와 다를 수 있다. 이 함수는 OOXML에서 정확한 RGB를
    추출하여 테이블 내 색상 표기를 교정한다.

    Returns: (corrected_text, correction_count)
    """
    try:
        grade_colors = extract_grade_colors(xlsx_path, sheet_name)
    except Exception:
        return md_text, 0

    if not grade_colors:
        return md_text, 0

    corrections = 0
    lines = md_text.split('\n')
    result = []

    for line in lines:
        if '|' in line and any(g in line for g in grade_colors):
            # 테이블 행에서 등급명 찾기
            for grade, hex_color in grade_colors.items():
                if grade in line:
                    color_name = rgb_to_color_name(hex_color)
                    # (근사색상명) → 정확한 색상명 (hex) 로 교체
                    # 패턴: (보라색), (빨간색), (노란색), etc.
                    new_line = re.sub(
                        r'\((?:보라색|빨간색|빨강색|적색|노란색|노랑색|파란색|파랑색|초록색|녹색|흰색|흰 색|회색)\)',
                        f'{color_name} ({hex_color})',
                        line
                    )
                    if new_line != line:
                        corrections += 1
                        line = new_line
                        break
        result.append(line)

    return '\n'.join(result), corrections


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

    # 3.5. 등급 색상 보정 (OOXML 셀 배경색 → Vision AI 근사값 교정)
    color_corrections = 0
    if xlsx_path and os.path.exists(xlsx_path):
        md_text, color_corrections = correct_grade_colors(md_text, xlsx_path, sheet_name)

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
