#!/usr/bin/env python3
"""
capture.py - Stage 1: Excel 시트를 이미지 세트로 변환

Phase 1: Excel COM CopyPicture → 시트별 전체 PNG (페이지 나눔 없음, 도형 렌더링 정확)
Phase 2: 전체 PNG → 개요 이미지 + 분할 상세 이미지

사용법:
    python capture.py <input.xlsx> <output_dir>
    python capture.py <input.xlsx> <output_dir> --sheet "시트이름"
"""

import sys
import os
import json
import time
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

# ── 설정 ──
DETAIL_MAX = 1568       # Vision AI 최적 크기
OVERVIEW_MAX_W = 1568   # 개요 이미지 최대 너비
OVERLAP_RATIO = 0.10    # 오버랩 비율 (10%)

def get_max_workers():
    return max(1, (os.cpu_count() or 4) - 2)


# ── 유틸 ──

class NumpySafeEncoder(json.JSONEncoder):
    def default(self, obj):
        import numpy as np
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

def safe_filename(name):
    for ch in '/\\:*?"<>|':
        name = name.replace(ch, "_")
    return name


def _trim_right_whitespace(img, bg_threshold=240, padding=20):
    """이미지 우측 빈 공간 자동 크롭. AutoFit 후 불필요한 여백 제거."""
    import numpy as np
    arr = np.array(img.convert("RGB"))
    h, w, _ = arr.shape
    non_bg = ~np.all(arr > bg_threshold, axis=2)
    col_has_content = non_bg.any(axis=0)
    if not col_has_content.any():
        return img
    rightmost = int(np.where(col_has_content)[0][-1])
    crop_x = min(rightmost + padding, w)
    if crop_x < w * 0.95:
        return img.crop((0, 0, crop_x, h))
    return img

def get_sheet_names(xlsx_path):
    import openpyxl
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    names = wb.sheetnames
    wb.close()
    return names


# ══════════════════════════════════════════════════════════════
# Phase 1: Excel COM CopyPicture → 시트별 전체 PNG
# ══════════════════════════════════════════════════════════════

def phase1_capture_images(xlsx_path, output_base, sheet_indices, sheet_names, excel_app=None):
    """Phase 1: Excel COM으로 시트별 전체 PNG 캡처 (페이지 나눔 없음)

    Args:
        excel_app: 기존 Excel.Application COM 객체. None이면 새로 생성.
    """
    import win32com.client
    from PIL import ImageGrab

    xlsx_path = os.path.abspath(xlsx_path)
    total = len(sheet_indices)

    own_excel = excel_app is None

    print(f"[Phase 1] Excel COM CopyPicture ({total} sheets)")
    t_start = time.time()

    if own_excel:
        excel = win32com.client.Dispatch("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        excel.Interactive = False
        excel.AskToUpdateLinks = False
    else:
        excel = excel_app
    # NOTE: ScreenUpdating는 반드시 True여야 CopyPicture(xlScreen)이 작동함
    # Visible=False + Interactive=False로 팝업 억제

    results = []
    try:
        wb = excel.Workbooks.Open(xlsx_path)

        for i, idx in enumerate(sheet_indices):
            name = sheet_names[idx]
            safe_name = safe_filename(name)
            sheet_dir = os.path.join(output_base, safe_name, "_vision_input")
            os.makedirs(sheet_dir, exist_ok=True)
            full_png = os.path.join(sheet_dir, "full_original.png")

            t_sheet = time.time()
            try:
                ws = wb.Sheets(idx + 1)  # COM은 1-based index

                ur = ws.UsedRange
                row_count = ur.Rows.Count
                col_count = ur.Columns.Count

                # 빈 시트 감지 (1셀만 있고 비어있는 경우)
                if row_count <= 1 and col_count <= 1:
                    val = ur.Cells(1, 1).Value
                    if val is None or (isinstance(val, str) and val.strip() == ""):
                        elapsed = time.time() - t_sheet
                        results.append({
                            "success": True, "sheet_index": idx, "sheet_name": name,
                            "safe_name": safe_name, "blank": True,
                            "elapsed": round(elapsed, 1),
                        })
                        print(f"  [{i+1}/{total}] {name} -> BLANK ({elapsed:.1f}s)")
                        continue

                # ── 캡처 범위 확장: 오버플로우 텍스트를 잡기 위해 우측 여백 추가 ──
                # UsedRange만 캡처하면 마지막 컬럼에서 오버플로우 텍스트가 잘림
                # 우측으로 컬럼을 확장하여 오버플로우 영역까지 캡처
                extra_cols = 50  # 고정 50컬럼 여백 (~3200px) — 오버플로우 텍스트 확보
                last_row = ur.Row + row_count - 1
                last_col = ur.Column + col_count - 1 + extra_cols
                capture_range = ws.Range(
                    ws.Cells(ur.Row, ur.Column),
                    ws.Cells(last_row, last_col)
                )

                # CopyPicture: xlScreen=1, xlBitmap=2
                capture_range.CopyPicture(Appearance=1, Format=2)
                img = ImageGrab.grabclipboard()

                if img is None:
                    raise RuntimeError("CopyPicture failed: no image in clipboard")

                # ── 우측 여백 자동 크롭 ──
                img = _trim_right_whitespace(img)

                img.save(full_png, "PNG")
                w, h = img.size
                elapsed = time.time() - t_sheet

                results.append({
                    "success": True, "sheet_index": idx, "sheet_name": name,
                    "safe_name": safe_name, "png_path": full_png, "blank": False,
                    "width": w, "height": h, "elapsed": round(elapsed, 1),
                })
                print(f"  [{i+1}/{total}] {name} -> {w}x{h}px ({elapsed:.1f}s)")

            except Exception as e:
                elapsed = time.time() - t_sheet
                results.append({
                    "success": False, "sheet_index": idx, "sheet_name": name,
                    "safe_name": safe_name, "blank": False,
                    "error": str(e), "elapsed": round(elapsed, 1),
                })
                print(f"  [{i+1}/{total}] {name} -> FAIL: {e} ({elapsed:.1f}s)")

        wb.Close(False)
    except Exception as e:
        print(f"[Phase 1] Excel open error: {e}")
    finally:
        if own_excel:
            try:
                excel.Quit()
            except Exception:
                pass

    results.sort(key=lambda r: r["sheet_index"])

    elapsed_total = time.time() - t_start
    ok = sum(1 for r in results if r["success"] and not r.get("blank"))
    blank = sum(1 for r in results if r.get("blank"))
    fail = sum(1 for r in results if not r["success"])
    print(f"[Phase 1] Done: {ok} OK, {blank} blank, {fail} failed ({elapsed_total:.1f}s)")

    return results


# ══════════════════════════════════════════════════════════════
# Phase 2: 전체 PNG → 개요 이미지 + 분할 상세 이미지 (병렬)
# ══════════════════════════════════════════════════════════════

def _create_overview(full_img_path, overview_path, max_width=OVERVIEW_MAX_W):
    from PIL import Image
    img = Image.open(full_img_path)
    w, h = img.size
    if w <= max_width:
        img.save(overview_path, "PNG")
        return {"width": w, "height": h, "scaled": False}
    ratio = max_width / w
    new_h = int(h * ratio)
    resized = img.resize((max_width, new_h), Image.LANCZOS)
    resized.save(overview_path, "PNG")
    return {"width": max_width, "height": new_h, "scaled": True}


def _find_vertical_split_points(img, max_tile_h, overlap_px, min_gap=5):
    import numpy as np
    W, H = img.size
    arr = np.array(img.convert("RGB"))
    non_white = ~np.all(arr > 240, axis=2)
    row_density = non_white.sum(axis=1) / W

    stride = max_tile_h - overlap_px
    splits = [0]

    while splits[-1] + max_tile_h < H:
        ideal_cut = splits[-1] + stride
        search_start = max(splits[-1] + stride // 2, 0)
        search_end = min(ideal_cut + overlap_px, H - 1)
        search_range = row_density[search_start:search_end + 1]

        if len(search_range) > 0:
            empty_rows = search_range < 0.02
            best_cut = None

            if empty_rows.any():
                in_gap = False
                gap_start = 0
                best_gap_center = None
                best_gap_size = 0
                for idx, is_empty in enumerate(empty_rows):
                    if is_empty and not in_gap:
                        gap_start = idx
                        in_gap = True
                    elif not is_empty and in_gap:
                        gap_size = idx - gap_start
                        if gap_size >= min_gap and gap_size > best_gap_size:
                            best_gap_size = gap_size
                            best_gap_center = gap_start + gap_size // 2
                        in_gap = False
                if in_gap:
                    gap_size = len(search_range) - gap_start
                    if gap_size >= min_gap and gap_size > best_gap_size:
                        best_gap_center = gap_start + gap_size // 2
                if best_gap_center is not None:
                    best_cut = search_start + best_gap_center

            if best_cut is None:
                min_density_idx = np.argmin(search_range)
                best_cut = search_start + int(min_density_idx)

            splits.append(best_cut)
        else:
            splits.append(ideal_cut)

    return splits


def _smart_horizontal_crop(tile_img, header_skip=80, bg_threshold=245,
                           min_content_ratio=0.01, padding=30):
    """타일 이미지의 우측 빈 공간을 크롭. 헤더 행은 건너뛰고 데이터 영역 기준."""
    import numpy as np
    W, H = tile_img.size
    if W <= OVERVIEW_MAX_W:
        return tile_img, W  # 이미 작으면 크롭 불필요

    arr = np.array(tile_img.convert("RGB"))
    skip = min(header_skip, H // 3)  # 이미지가 작으면 스킵 축소
    data_region = arr[skip:, :, :]
    if data_region.shape[0] == 0:
        return tile_img, W

    non_bg = ~np.all(data_region > bg_threshold, axis=2)
    col_density = non_bg.sum(axis=0) / data_region.shape[0]
    content_cols = np.where(col_density > min_content_ratio)[0]

    if len(content_cols) == 0:
        return tile_img, W

    rightmost = int(content_cols[-1])
    crop_x = min(rightmost + padding, W)

    if crop_x < W * 0.90:  # 10% 이상 줄어들 때만 크롭
        return tile_img.crop((0, 0, crop_x, H)), crop_x
    return tile_img, W


def _create_detail_tiles(full_img_path, output_dir):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None

    img = Image.open(full_img_path)
    W, H = img.size

    if H <= DETAIL_MAX:
        # 단일 타일 — 가로 크롭 적용
        cropped, crop_w = _smart_horizontal_crop(img)
        tile_path = os.path.join(output_dir, "detail_r0.png")
        cropped.save(tile_path, "PNG")
        if crop_w < W:
            print(f"    [crop] detail_r0: {W}→{crop_w}px ({(1-crop_w/W)*100:.0f}% 절약)")
        return {
            "tiles": [{
                "tile_id": "detail_r0", "row_index": 0, "total_rows": 1,
                "pixel_region": {"x": 0, "y": 0, "w": crop_w, "h": H},
                "position_description": "entire sheet",
            }],
            "total_rows": 1, "split_needed": False,
        }

    overlap_px = int(DETAIL_MAX * OVERLAP_RATIO)
    splits = _find_vertical_split_points(img, DETAIL_MAX, overlap_px)
    total_rows = len(splits)

    # 모든 타일의 데이터 영역 기준 최대 너비 계산 (일관된 크롭)
    max_content_x = 0
    tile_imgs = []
    for r, y_start in enumerate(splits):
        y_end = min(splits[r + 1] + overlap_px, H) if r < total_rows - 1 else H
        tile = img.crop((0, y_start, W, y_end))
        _, crop_w = _smart_horizontal_crop(tile)
        max_content_x = max(max_content_x, crop_w)
        tile_imgs.append((tile, y_start, y_end))

    # 일관된 너비로 크롭 (가장 넓은 타일 기준)
    crop_w = min(max_content_x, W)
    if crop_w < W * 0.90:
        print(f"    [crop] 전체 타일: {W}→{crop_w}px ({(1-crop_w/W)*100:.0f}% 절약)")

    tiles = []
    for r, (tile, y_start, y_end) in enumerate(tile_imgs):
        if crop_w < W * 0.90:
            tile = tile.crop((0, 0, crop_w, tile.size[1]))

        tile_id = f"detail_r{r}"
        tile_path = os.path.join(output_dir, f"{tile_id}.png")
        tile.save(tile_path, "PNG")

        if total_rows <= 3:
            pos_desc = ["top", "middle", "bottom"][min(r, 2)]
        else:
            pos_desc = f"section {r+1}/{total_rows}"

        tiles.append({
            "tile_id": tile_id, "row_index": r, "total_rows": total_rows,
            "pixel_region": {"x": 0, "y": int(y_start), "w": tile.size[0], "h": int(y_end - y_start)},
            "position_description": pos_desc,
            "overlap_bottom": overlap_px if r < total_rows - 1 else 0,
        })

    return {
        "tiles": tiles, "total_rows": total_rows, "split_needed": True,
        "original_size": {"width": W, "height": H},
        "cropped_width": crop_w if crop_w < W * 0.90 else W,
    }


def _split_one_sheet(args):
    """워커 함수: 전체 PNG → 개요 + 분할 타일"""
    capture_result, = args
    sheet_index = capture_result["sheet_index"]
    sheet_name = capture_result["sheet_name"]
    safe_name = capture_result["safe_name"]
    full_png = capture_result["png_path"]

    sheet_dir = os.path.dirname(full_png)  # _vision_input/

    result = {
        "sheet_index": sheet_index,
        "sheet_name": sheet_name,
        "safe_name": safe_name,
    }

    try:
        w, h = capture_result["width"], capture_result["height"]
        result["full_image"] = {"width": w, "height": h}

        # 개요 이미지
        overview_path = os.path.join(sheet_dir, "overview.png")
        overview_info = _create_overview(full_png, overview_path)
        result["overview"] = overview_info

        # 분할
        tile_info = _create_detail_tiles(full_png, sheet_dir)
        result["tiles"] = tile_info

        # tile_manifest.json
        manifest = {
            "sheet_name": sheet_name,
            "full_image": result["full_image"],
            "overview": result["overview"],
            "total_rows": tile_info["total_rows"],
            "split_needed": tile_info["split_needed"],
            "tiles": tile_info["tiles"],
        }
        manifest_path = os.path.join(sheet_dir, "tile_manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2, cls=NumpySafeEncoder)

        result["success"] = True
        return result

    except Exception as e:
        result["success"] = False
        result["error"] = str(e)
        return result


def phase2_split_images(capture_results):
    """Phase 2: 전체 PNG → 개요 + 분할 타일 (병렬)"""
    valid = [r for r in capture_results if r["success"] and not r.get("blank")]
    if not valid:
        print("[Phase 2] No images to split.")
        return []

    workers = get_max_workers()
    total = len(valid)

    print(f"\n[Phase 2] PNG -> overview + detail tiles ({total} sheets, {workers} workers)")
    t_start = time.time()

    tasks = [(r,) for r in valid]

    results = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_split_one_sheet, t): t for t in tasks}
        for future in as_completed(futures):
            r = future.result()
            results.append(r)
            if r["success"]:
                fi = r["full_image"]
                n = len(r["tiles"]["tiles"])
                print(f"  [OK] {r['sheet_name']} -> {fi['width']}x{fi['height']}px, {n} section(s)")
            else:
                print(f"  [FAIL] {r['sheet_name']} -> {r.get('error', '?')}")

    results.sort(key=lambda r: r["sheet_index"])
    elapsed = time.time() - t_start

    ok = sum(1 for r in results if r["success"])
    fail = sum(1 for r in results if not r["success"])
    print(f"[Phase 2] Done: {ok} OK, {fail} failed ({elapsed:.1f}s)")

    return results


# ══════════════════════════════════════════════════════════════
# 메인
# ══════════════════════════════════════════════════════════════

def capture_all(xlsx_path, output_dir, target_sheet=None, excel_app=None):
    """전체 캡처 파이프라인. excel_app을 전달하면 기존 Excel 인스턴스를 재사용한다."""
    xlsx_path = os.path.abspath(xlsx_path)
    output_dir = os.path.abspath(output_dir)

    sheet_names = get_sheet_names(xlsx_path)
    excel_name = Path(xlsx_path).stem
    output_base = os.path.join(output_dir, safe_filename(excel_name))
    os.makedirs(output_base, exist_ok=True)

    if target_sheet:
        # 콤마 구분 멀티 시트 지원
        target_names = [t.strip() for t in target_sheet.split(",")]
        indices = []
        for tn in target_names:
            if tn in sheet_names:
                indices.append(sheet_names.index(tn))
            else:
                print(f"WARNING: sheet '{tn}' not found. Available: {sheet_names}")
        if not indices:
            print(f"ERROR: no matching sheets found")
            return []
    else:
        indices = list(range(len(sheet_names)))

    total = len(indices)
    print(f"[capture] File: {os.path.basename(xlsx_path)}")
    print(f"[capture] Sheets: {total} / {len(sheet_names)} total")
    print()

    # Phase 1: Excel COM CopyPicture → 시트별 전체 PNG
    capture_results = phase1_capture_images(xlsx_path, output_base, indices, sheet_names, excel_app=excel_app)

    # Phase 2: 전체 PNG → 개요 + 분할 타일 (병렬)
    split_results = phase2_split_images(capture_results)

    # 전체 매니페스트
    all_results = []
    for cr in capture_results:
        sr = next((r for r in split_results if r["sheet_index"] == cr["sheet_index"]), None)
        entry = {
            "index": cr["sheet_index"],
            "name": cr["sheet_name"],
            "capture_success": cr["success"],
            "capture_error": cr.get("error"),
            "capture_elapsed": cr.get("elapsed"),
            "blank": cr.get("blank", False),
        }
        if sr:
            entry["split_success"] = sr["success"]
            entry["split_error"] = sr.get("error")
            fi = sr.get("full_image", {})
            entry["full_size"] = f"{fi.get('width', 0)}x{fi.get('height', 0)}"
            entry["sections"] = sr.get("tiles", {}).get("total_rows") if sr.get("tiles") else None
        elif cr["success"] and not cr.get("blank"):
            entry["split_success"] = False
        all_results.append(entry)

    manifest_path = os.path.join(output_base, "_capture_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "source": os.path.basename(xlsx_path),
            "capture_method": "excel_com_copypicture",
            "sheet_count": len(sheet_names),
            "captured": total,
            "sheets": all_results,
        }, f, ensure_ascii=False, indent=2, cls=NumpySafeEncoder)

    # 요약
    ok = sum(1 for r in all_results if r.get("split_success"))
    blank = sum(1 for r in all_results if r.get("blank"))
    fail = total - ok - blank
    print(f"\n[capture] Final: {ok} OK, {blank} blank, {fail} failed / {total} total")

    return all_results


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python capture.py <input.xlsx> <output_dir> [--sheet <name>]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_dir = sys.argv[2]
    target_sheet = None

    if "--sheet" in sys.argv:
        idx = sys.argv.index("--sheet")
        if idx + 1 < len(sys.argv):
            target_sheet = sys.argv[idx + 1]

    if not os.path.exists(input_file):
        print(f"ERROR: file not found: {input_file}")
        sys.exit(1)

    results = capture_all(input_file, output_dir, target_sheet)
    failed = [r for r in results if not r.get("split_success") and not r.get("blank")]
    sys.exit(1 if failed else 0)
