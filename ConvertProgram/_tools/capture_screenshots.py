"""
XLSX 시트 스크린샷 자동 캡처
==============================
Excel COM 자동화로 각 시트를 PDF로 내보내고, PyMuPDF로 PNG 변환.
의미 단위(섹션)별 자동 분할: 빈 행(여백) 감지로 콘텐츠가 끊기지 않게 분할.

사용법:
  python capture_screenshots.py "경로/파일.xlsx"                  # 단일 파일
  python capture_screenshots.py "경로/파일.xlsx" --sheets "변신,스킬"  # 특정 시트만
  python capture_screenshots.py "경로/파일.xlsx" --out "출력/폴더"     # 출력 폴더 지정
  python capture_screenshots.py "경로/파일.xlsx" --dpi 200            # 해상도 지정
  python capture_screenshots.py "경로/파일.xlsx" --no-split           # 분할 없이 전체 이미지만

의존성: pywin32, pymupdf, pillow
  pip install pywin32 pymupdf pillow
"""

import win32com.client
import fitz  # PyMuPDF
from PIL import Image
import numpy as np
import io
import os
import sys
import argparse
import tempfile
import time
from pathlib import Path


# ============================================================
# 의미 단위 이미지 분할
# ============================================================

def find_empty_rows(img, threshold=250, empty_ratio=0.98):
    """이미지에서 '빈 행'을 찾는다.

    빈 행 = 행 내 픽셀의 empty_ratio 이상이 threshold 이상(거의 흰색)인 행.

    Returns:
        numpy bool array: 각 행이 빈 행이면 True
    """
    arr = np.array(img.convert("L"))  # grayscale
    row_bright = (arr >= threshold).mean(axis=1)  # 각 행에서 밝은 픽셀 비율
    return row_bright >= empty_ratio


def find_gaps(empty_rows, min_gap_height=8):
    """연속된 빈 행 묶음(gap)을 찾는다.

    Args:
        empty_rows: bool array (행별 빈 행 여부)
        min_gap_height: 이 높이 이상의 연속 빈 행만 gap으로 인정

    Returns:
        list of (start, end, center): gap 시작행, 끝행, 중심행
    """
    gaps = []
    in_gap = False
    gap_start = 0

    for i, is_empty in enumerate(empty_rows):
        if is_empty and not in_gap:
            gap_start = i
            in_gap = True
        elif not is_empty and in_gap:
            gap_end = i
            if gap_end - gap_start >= min_gap_height:
                gaps.append((gap_start, gap_end, (gap_start + gap_end) // 2))
            in_gap = False

    # 마지막 gap 처리
    if in_gap:
        gap_end = len(empty_rows)
        if gap_end - gap_start >= min_gap_height:
            gaps.append((gap_start, gap_end, (gap_start + gap_end) // 2))

    return gaps


def split_image_by_content(img, max_height=2000, min_height=200,
                           overlap=40):
    """이미지를 의미 단위로 분할한다.

    알고리즘 (2단계 gap 탐색):
    1. 빈 행 스캔 → 자연 경계(gap) 탐지
    2. 큰 gap(30px+) 을 우선 분할 후보로 사용 (섹션 경계)
    3. 큰 gap만으로 max_height 유지 불가 시 → 작은 gap(12px+)도 후보에 추가
    4. 각 분할 지점에 overlap 만큼 양쪽 여백 추가 (콘텐츠 끊김 방지)
    5. min_height 미만 섹션은 인접 섹션과 병합

    Args:
        img: PIL Image
        max_height: 섹션 최대 높이 (px)
        min_height: 섹션 최소 높이 (px)
        overlap: 분할 지점 양쪽에 추가할 겹침 여백 (px)

    Returns:
        list of PIL Image: 분할된 이미지들
    """
    height = img.height

    # 분할 불필요
    if height <= max_height:
        return [img]

    # 1. 빈 행 감지
    empty_rows = find_empty_rows(img)

    # 2. 2단계 gap 탐색: 큰 gap 우선, 작은 gap 보조
    big_gaps = find_gaps(empty_rows, min_gap_height=80)   # 섹션 경계 (넓은 여백)
    small_gaps = find_gaps(empty_rows, min_gap_height=40)  # 행 간 경계 (보조, 테이블 행은 무시)

    if not small_gaps:
        return _fallback_split(img, max_height, overlap)

    # 3. gap에 가중치 부여: 큰 gap일수록 분할 우선
    #    cut_points: (center_y, gap_size) → 큰 gap 우선 선택
    big_centers = {g[2] for g in big_gaps}
    all_cuts = [(g[2], g[1] - g[0]) for g in small_gaps]  # (center, size)

    # 4. 분할 지점 선택
    selected_cuts = _select_cuts_weighted(all_cuts, big_centers, height,
                                          max_height, min_height)

    # 5. 분할 실행 (overlap 적용)
    sections = []
    prev_end = 0

    for cut in selected_cuts:
        section_end = min(cut + overlap, height)
        section = img.crop((0, prev_end, img.width, section_end))
        if section.height >= min_height:
            sections.append(section)
        prev_end = max(cut - overlap, 0)

    # 마지막 섹션
    if prev_end < height:
        section = img.crop((0, prev_end, img.width, height))
        if section.height >= min_height:
            sections.append(section)
        elif sections:
            prev = sections[-1]
            merged = Image.new("RGB", (img.width, prev.height + section.height), (255, 255, 255))
            merged.paste(prev, (0, 0))
            merged.paste(section, (0, prev.height))
            sections[-1] = merged

    return sections if sections else [img]


def _select_cuts_weighted(all_cuts, big_centers, total_height,
                          max_height, min_height):
    """큰 gap을 우선 선택하되, 필요하면 작은 gap도 사용.

    Args:
        all_cuts: list of (center_y, gap_size)
        big_centers: set of center_y values for big gaps
        total_height: 전체 이미지 높이
        max_height: 섹션 최대 높이
        min_height: 섹션 최소 높이
    """
    selected = []
    current_start = 0

    while current_start + max_height < total_height:
        lo = current_start + min_height
        hi = current_start + max_height

        # 범위 내 후보 추출
        candidates = [(c, sz) for c, sz in all_cuts if lo <= c <= hi]

        if candidates:
            # 큰 gap(big_centers) 중 가장 뒤쪽 우선
            big_cands = [c for c, sz in candidates if c in big_centers]
            if big_cands:
                best = max(big_cands)
            else:
                # 큰 gap 없으면 → gap 크기 * 위치 가중치로 최적 선택
                # 뒤쪽(max_height에 가까운) + 큰 gap 선호
                best = max(candidates,
                           key=lambda x: x[1] * 2 + (x[0] - lo) / (hi - lo + 1) * 100)[0]
        else:
            # 범위 내 gap 없음 → 가장 가까운 미래 gap 사용
            future = [(c, sz) for c, sz in all_cuts if c > lo]
            if future:
                best = min(future, key=lambda x: x[0])[0]
            else:
                best = current_start + max_height

        selected.append(best)
        current_start = best

    return selected


def trim_page_margins(img, threshold=250, min_content_gap=-1):
    """페이지 이미지의 상하 빈 여백을 제거한다.

    PDF 페이지마다 Excel이 추가하는 상하 margin(빈 공간)을 잘라냄.

    Args:
        img: PIL Image (단일 페이지)
        threshold: 밝기 임계값 (이 이상이면 빈 픽셀)
        min_content_gap: 콘텐츠 시작/끝에서 남길 최소 여백 (px)

    Returns:
        PIL Image: 여백 제거된 이미지
    """
    arr = np.array(img.convert("L"))
    row_bright = (arr >= threshold).mean(axis=1)

    # 완전히 빈 페이지 감지: 모든 행이 빈 행이면 건너뛰기
    content_rows = row_bright < 0.98
    if not content_rows.any():
        return None

    # 콘텐츠 시작: 처음으로 빈 행이 아닌 행
    top = max(0, int(np.argmax(content_rows)) - min_content_gap)

    # 콘텐츠 끝: 마지막으로 빈 행이 아닌 행
    bottom = min(len(row_bright), int(len(row_bright) - np.argmax(content_rows[::-1])) + min_content_gap)

    return img.crop((0, top, img.width, bottom))


def _fallback_split(img, max_height, overlap):
    """gap이 없을 때 균등 분할 (최후 수단)"""
    sections = []
    h = img.height
    y = 0
    while y < h:
        end = min(y + max_height, h)
        section = img.crop((0, y, img.width, end))
        sections.append(section)
        y = end - overlap if end < h else h
    return sections


# ============================================================
# 메인 캡처 로직
# ============================================================

def merge_pdf_pages(pdf_path):
    """멀티 페이지 PDF를 단일 페이지 PDF로 병합.

    각 페이지의 상하 여백을 제거하고 세로로 이어 붙여서
    페이지 경계 없는 단일 페이지 PDF를 생성한다.

    Args:
        pdf_path: PDF 파일 경로 (덮어쓰기됨)
    """
    doc = fitz.open(pdf_path)
    if doc.page_count <= 1:
        doc.close()
        return

    # 각 페이지의 콘텐츠 영역(여백 제외) 크기 파악
    page_rects = []
    for page in doc:
        # 페이지의 실제 콘텐츠 바운딩 박스 (텍스트+그래픽)
        text_rect = page.rect  # 기본 전체 영역
        # get_text로 텍스트 블록 추출하여 실제 콘텐츠 영역 추정
        blocks = page.get_text("blocks")
        drawings = page.get_drawings()
        if blocks or drawings:
            min_y = page.rect.height
            max_y = 0
            for b in blocks:
                min_y = min(min_y, b[1])  # y0
                max_y = max(max_y, b[3])  # y1
            for d in drawings:
                min_y = min(min_y, d["rect"].y0)
                max_y = max(max_y, d["rect"].y1)
            # 여유분 추가
            min_y = max(0, min_y - 5)
            max_y = min(page.rect.height, max_y + 5)
            page_rects.append((page.number, min_y, max_y, page.rect.width))
        else:
            page_rects.append((page.number, 0, page.rect.height, page.rect.width))

    # 병합된 단일 페이지 크기 계산
    max_width = max(r[3] for r in page_rects)
    total_height = sum(r[2] - r[1] for r in page_rects)

    # 새 PDF 생성
    new_doc = fitz.open()
    new_page = new_doc.new_page(width=max_width, height=total_height)

    y_offset = 0
    for page_num, content_top, content_bottom, width in page_rects:
        src_page = doc[page_num]
        content_height = content_bottom - content_top

        # 소스 페이지의 콘텐츠 영역만 잘라서 새 페이지에 삽입
        src_rect = fitz.Rect(0, content_top, width, content_bottom)
        dst_rect = fitz.Rect(0, y_offset, width, y_offset + content_height)

        new_page.show_pdf_page(dst_rect, doc, page_num, clip=src_rect)
        y_offset += content_height

    doc.close()

    # 원본 덮어쓰기 (Windows 파일 잠금 우회: 임시 파일 → 교체)
    tmp_path = pdf_path + ".tmp"
    new_doc.save(tmp_path)
    new_doc.close()

    os.replace(tmp_path, pdf_path)


def get_default_out_dir(xlsx_path):
    """기본 출력 경로: _knowledge_base/screenshots/{workbook_name}/"""
    proj_root = Path(xlsx_path)
    for parent in proj_root.parents:
        kb = parent / "_knowledge_base" / "screenshots"
        if parent.name.endswith("기획") or (parent / "_knowledge_base").exists():
            stem = proj_root.stem.replace(" ", "_")
            return str(kb / stem)
    return str(Path(xlsx_path).parent / "_screenshots" / Path(xlsx_path).stem.replace(" ", "_"))


def sanitize_sheet_name(name):
    """시트 이름을 파일명으로 안전하게 변환"""
    return name.replace(" ", "_").replace("/", "_").replace("\\", "_").replace(":", "_")


def capture_sheets(xlsx_path, out_dir=None, sheet_names=None, dpi=150,
                   skip_existing=False, no_split=False,
                   max_section_height=2000, overlap=40):
    """
    Excel 시트를 PNG 스크린샷으로 캡처.

    출력물:
      - {시트}.pdf  : Excel에서 내보낸 PDF 원본
      - {시트}.png  : 전체 시트 이미지 (모든 페이지 세로 합침)
      - {시트}_section_{n}.png : 의미 단위 분할 이미지 (no_split=False일 때)

    Args:
        xlsx_path: XLSX 파일 경로
        out_dir: 출력 폴더 (None이면 자동 결정)
        sheet_names: 캡처할 시트 이름 리스트 (None이면 전체)
        dpi: 출력 해상도 (기본 150)
        skip_existing: True이면 이미 존재하는 스크린샷 건너뛰기
        no_split: True이면 분할 없이 전체 이미지만 출력
        max_section_height: 분할 시 섹션 최대 높이 (px, 기본 2000)
        overlap: 분할 지점 양쪽 겹침 여백 (px, 기본 40)

    Returns:
        dict: {시트이름: {"full": png경로, "sections": [section경로들]}} 매핑
    """
    xlsx_path = os.path.abspath(xlsx_path)
    if not os.path.exists(xlsx_path):
        print(f"[ERROR] 파일을 찾을 수 없습니다: {xlsx_path}")
        return {}

    if out_dir is None:
        out_dir = get_default_out_dir(xlsx_path)
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    print(f"[INFO] 원본: {xlsx_path}")
    print(f"[INFO] 출력: {out_dir}")
    print(f"[INFO] DPI: {dpi}, 분할: {'OFF' if no_split else f'max {max_section_height}px, overlap {overlap}px'}")

    excel = None
    wb = None
    results = {}

    try:
        excel = win32com.client.DispatchEx("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        excel.ScreenUpdating = False

        wb = excel.Workbooks.Open(xlsx_path, ReadOnly=True)

        all_sheets = [ws.Name for ws in wb.Worksheets]
        print(f"[INFO] 시트 목록: {all_sheets}")

        if sheet_names:
            target_sheets = [s for s in sheet_names if s in all_sheets]
            missing = [s for s in sheet_names if s not in all_sheets]
            if missing:
                print(f"[WARN] 존재하지 않는 시트: {missing}")
        else:
            target_sheets = all_sheets

        for sheet_name in target_sheets:
            safe_name = sanitize_sheet_name(sheet_name)
            png_path = os.path.join(out_dir, f"{safe_name}.png")
            pdf_path = os.path.join(out_dir, f"{safe_name}.pdf")

            if skip_existing and os.path.exists(png_path):
                print(f"  [SKIP] {sheet_name} → 이미 존재")
                results[sheet_name] = {"full": png_path, "sections": []}
                continue

            print(f"  [CAPTURE] {sheet_name} ...", end=" ", flush=True)

            try:
                ws = wb.Worksheets(sheet_name)

                used_range = ws.UsedRange
                if used_range is None or used_range.Rows.Count == 0:
                    print("빈 시트 → 건너뜀")
                    continue

                # 페이지 설정: 너비만 1페이지에 맞추고, 높이는 자유
                # (높이는 PDF 후처리에서 단일 페이지로 병합)
                ws.PageSetup.PrintArea = used_range.Address
                ws.PageSetup.Orientation = 2 if used_range.Columns.Count > 15 else 1
                ws.PageSetup.Zoom = False
                ws.PageSetup.FitToPagesWide = 1
                ws.PageSetup.FitToPagesTall = False

                # PDF 내보내기
                ws.ExportAsFixedFormat(
                    Type=0,  # xlTypePDF
                    Filename=pdf_path,
                    Quality=0,  # xlQualityStandard
                    IncludeDocProperties=False,
                    IgnorePrintAreas=False,
                )

                # PDF → PIL Image 변환 (페이지별 개별 렌더링)
                doc = fitz.open(pdf_path)
                zoom = dpi / 72.0
                mat = fitz.Matrix(zoom, zoom)
                page_count = doc.page_count

                page_images = []
                for page in doc:
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                    page_images.append(img)
                doc.close()

                # 각 페이지의 상하 여백(PDF 페이지 margin) 제거 + 빈 페이지 건너뛰기
                trimmed = [t for t in (trim_page_margins(p) for p in page_images) if t is not None]

                if not trimmed:
                    print("모든 페이지가 빈 페이지 → 건너뜀")
                    continue

                # 전체 이미지 합침 (여백 제거된 페이지들을 이어 붙이기)
                if len(trimmed) == 1:
                    combined = trimmed[0]
                else:
                    max_width = max(img.width for img in trimmed)
                    total_height = sum(img.height for img in trimmed)
                    combined = Image.new("RGB", (max_width, total_height), (255, 255, 255))
                    y_offset = 0
                    for img in trimmed:
                        combined.paste(img, (0, y_offset))
                        y_offset += img.height

                # 전체 이미지 저장
                combined.save(png_path)
                full_size = os.path.getsize(png_path) // 1024

                # 의미 단위 분할
                section_paths = []
                if not no_split and combined.height > max_section_height:
                    sections = split_image_by_content(
                        combined,
                        max_height=max_section_height,
                        overlap=overlap,
                    )

                    # 기존 section 파일 정리
                    for old in Path(out_dir).glob(f"{safe_name}_section_*.png"):
                        old.unlink()

                    for idx, section in enumerate(sections):
                        sec_path = os.path.join(out_dir, f"{safe_name}_section_{idx}.png")
                        section.save(sec_path)
                        section_paths.append(sec_path)

                    print(f"OK ({page_count}p, {combined.width}x{combined.height}, "
                          f"{full_size}KB) → {len(sections)} sections")
                else:
                    print(f"OK ({page_count}p, {combined.width}x{combined.height}, {full_size}KB)")

                results[sheet_name] = {"full": png_path, "sections": section_paths}

            except Exception as e:
                print(f"ERROR: {e}")
                continue

    except Exception as e:
        print(f"[ERROR] Excel COM 오류: {e}")

    finally:
        if wb:
            try:
                wb.Close(SaveChanges=False)
            except:
                pass
        if excel:
            try:
                excel.Quit()
            except:
                pass
        wb = None
        excel = None

    total_sections = sum(len(r.get("sections", [])) for r in results.values())
    print(f"\n[DONE] {len(results)}/{len(target_sheets)} 시트 캡처 완료"
          + (f", 총 {total_sections} sections" if total_sections else ""))
    return results


def main():
    parser = argparse.ArgumentParser(description="XLSX 시트 스크린샷 자동 캡처 (의미 단위 분할)")
    parser.add_argument("xlsx", help="XLSX 파일 경로")
    parser.add_argument("--out", help="출력 폴더 경로")
    parser.add_argument("--sheets", help="캡처할 시트 이름 (쉼표 구분)")
    parser.add_argument("--dpi", type=int, default=150, help="출력 해상도 (기본: 150)")
    parser.add_argument("--skip-existing", action="store_true", help="이미 존재하는 스크린샷 건너뛰기")
    parser.add_argument("--no-split", action="store_true", help="분할 없이 전체 이미지만 출력")
    parser.add_argument("--max-height", type=int, default=2000,
                        help="섹션 최대 높이 px (기본: 2000)")
    parser.add_argument("--overlap", type=int, default=40,
                        help="분할 지점 겹침 여백 px (기본: 40)")

    args = parser.parse_args()

    sheet_names = None
    if args.sheets:
        sheet_names = [s.strip() for s in args.sheets.split(",")]

    results = capture_sheets(
        xlsx_path=args.xlsx,
        out_dir=args.out,
        sheet_names=sheet_names,
        dpi=args.dpi,
        skip_existing=args.skip_existing,
        no_split=args.no_split,
        max_section_height=args.max_height,
        overlap=args.overlap,
    )

    if results:
        print("\n생성된 파일:")
        for name, info in results.items():
            print(f"  {name}:")
            print(f"    전체: {info['full']}")
            if info.get("sections"):
                for sp in info["sections"]:
                    sec_size = os.path.getsize(sp) // 1024
                    img = Image.open(sp)
                    print(f"    분할: {os.path.basename(sp)} ({img.width}x{img.height}, {sec_size}KB)")


if __name__ == "__main__":
    main()
