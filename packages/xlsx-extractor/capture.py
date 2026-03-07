#!/usr/bin/env python3
"""
capture.py - Stage 1: Excel 시트를 이미지 세트로 변환 (2단계 병렬 파이프라인)

Phase 1: XLSX -> [LibreOffice headless, 병렬] -> 시트별 PDF
Phase 2: PDF -> [PyMuPDF + Pillow, 병렬] -> 개요 이미지 + 분할 상세 이미지

사용법:
    python capture.py <input.xlsx> <output_dir>
    python capture.py <input.xlsx> <output_dir> --sheet "시트이름"
"""

import sys
import os
import json
import subprocess
import time
import tempfile
import math
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

# ── 설정 ──
SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"
LO_PYTHON = r"C:\Program Files\LibreOffice\program\python.exe"

DETAIL_MAX = 1568       # Vision AI 최적 크기
OVERVIEW_MAX_W = 1568   # 개요 이미지 최대 너비
OVERLAP_RATIO = 0.10    # 오버랩 비율 (10%)
PNG_DPI = 100           # PDF -> PNG 변환 해상도
MAX_PNG_DIMENSION = 20000

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

def get_sheet_names(xlsx_path):
    import openpyxl
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    names = wb.sheetnames
    wb.close()
    return names


# ══════════════════════════════════════════════════════════════
# Phase 1: Excel -> PDF (시트별 독립 LibreOffice 프로세스)
# ══════════════════════════════════════════════════════════════

def _export_one_sheet(args):
    """워커 함수: 단일 시트를 PDF로 내보내기 (독립 LO 프로세스)"""
    xlsx_path, pdf_dir, sheet_index, sheet_name = args
    safe_name = safe_filename(sheet_name)
    pdf_path = os.path.join(pdf_dir, f"{sheet_index:02d}_{safe_name}.pdf")
    # 워커별 고유 pipe (PID + index + timestamp)
    pipe_name = f"cap_{os.getpid()}_{sheet_index}_{int(time.time() * 1000) % 100000}"

    uno_script = f'''
import uno, sys, os, time
from com.sun.star.beans import PropertyValue

def make_prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p

def main():
    localContext = uno.getComponentContext()
    resolver = localContext.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", localContext)

    for attempt in range(15):
        try:
            ctx = resolver.resolve(
                "uno:pipe,name={pipe_name};urp;StarOffice.ComponentContext")
            break
        except:
            time.sleep(0.5)
    else:
        print("ERROR: LibreOffice connect failed")
        sys.exit(1)

    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    file_url = uno.systemPathToFileUrl(r"{xlsx_path}")
    doc = desktop.loadComponentFromURL(file_url, "_blank", 0,
        (make_prop("ReadOnly", True),))

    if doc is None:
        print("ERROR: file open failed")
        sys.exit(1)

    controller = doc.getCurrentController()
    sheets = doc.getSheets()
    sheet = sheets.getByIndex({sheet_index})
    controller.setActiveSheet(sheet)

    try:
        style_name = sheet.PageStyle
        page_styles = doc.getStyleFamilies().getByName("PageStyles")
        page_style = page_styles.getByName(style_name)

        page_style.ScaleToPagesX = 1
        page_style.ScaleToPagesY = 1
        page_style.PageScale = 0

        page_style.Width = 400000    # 400cm
        page_style.Height = 400000   # 400cm

        page_style.LeftMargin = 100
        page_style.RightMargin = 100
        page_style.TopMargin = 100
        page_style.BottomMargin = 100
    except Exception as e:
        print(f"WARN: page style failed: {{e}}")

    cursor = sheet.createCursor()
    cursor.gotoStartOfUsedArea(False)
    cursor.gotoEndOfUsedArea(True)

    pdf_filter_data = (
        make_prop("IsSkipEmptyPages", False),
        make_prop("UseLosslessCompression", True),
        make_prop("Quality", 95),
        make_prop("Selection", cursor),
    )

    export_props = (
        make_prop("FilterName", "calc_pdf_Export"),
        make_prop("FilterData", uno.Any(
            "[]com.sun.star.beans.PropertyValue", pdf_filter_data)),
        make_prop("Overwrite", True),
    )

    pdf_url = uno.systemPathToFileUrl(r"{pdf_path}")
    doc.storeToURL(pdf_url, export_props)

    size = os.path.getsize(r"{pdf_path}") if os.path.exists(r"{pdf_path}") else 0
    print(f"OK:{{size}}")

    try:
        doc.close(True)
    except:
        pass

main()
'''

    script_fd, script_path = tempfile.mkstemp(suffix=".py", prefix="lo_cap_")
    soffice_proc = None
    t_start = time.time()
    try:
        with os.fdopen(script_fd, "w", encoding="utf-8") as f:
            f.write(uno_script)

        # 각 워커별 독립 LO 사용자 프로파일 (동시 실행 충돌 방지)
        user_install = tempfile.mkdtemp(prefix="lo_profile_")
        user_install_url = "file:///" + user_install.replace("\\", "/")

        soffice_proc = subprocess.Popen(
            [SOFFICE, "--headless", "--norestore",
             f"-env:UserInstallation={user_install_url}",
             f"--accept=pipe,name={pipe_name};urp;"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        lo_pid = soffice_proc.pid

        time.sleep(3)  # LO 초기화 대기 (프로파일 생성 포함)

        result = subprocess.run(
            [LO_PYTHON, script_path],
            capture_output=True, text=True, timeout=180,
        )

        elapsed = time.time() - t_start
        output = result.stdout.strip()

        if output.startswith("OK:"):
            file_size = int(output.split(":")[1])
            return {
                "success": True, "sheet_index": sheet_index,
                "sheet_name": sheet_name, "pdf_path": pdf_path,
                "size_bytes": file_size, "elapsed": round(elapsed, 1),
            }
        else:
            error_msg = result.stderr.strip() or output or "Unknown error"
            # 에러 메시지에서 핵심만 추출
            if "Traceback" in error_msg:
                lines = error_msg.strip().split("\n")
                error_msg = lines[-1] if lines else error_msg
            return {
                "success": False, "sheet_index": sheet_index,
                "sheet_name": sheet_name, "pdf_path": pdf_path,
                "error": error_msg, "elapsed": round(elapsed, 1),
            }

    except subprocess.TimeoutExpired:
        elapsed = time.time() - t_start
        return {
            "success": False, "sheet_index": sheet_index,
            "sheet_name": sheet_name, "pdf_path": pdf_path,
            "error": "Timeout (180s)", "elapsed": round(elapsed, 1),
        }
    except Exception as e:
        elapsed = time.time() - t_start
        return {
            "success": False, "sheet_index": sheet_index,
            "sheet_name": sheet_name, "pdf_path": pdf_path,
            "error": str(e), "elapsed": round(elapsed, 1),
        }
    finally:
        # LO 강제 종료 (대기 없이)
        if soffice_proc:
            try:
                soffice_proc.kill()
            except Exception:
                pass
        try:
            os.unlink(script_path)
        except Exception:
            pass
        # 임시 프로파일은 phase1 끝에서 일괄 정리


def phase1_export_pdfs(xlsx_path, output_dir, sheet_indices, sheet_names):
    """Phase 1: 모든 시트를 PDF로 병렬 내보내기"""
    xlsx_path = os.path.abspath(xlsx_path)
    pdf_dir = os.path.join(output_dir, "_pdfs")
    os.makedirs(pdf_dir, exist_ok=True)

    # LO는 무거움 - 워커 수 제한 (최대 4)
    workers = min(get_max_workers(), 4)
    total = len(sheet_indices)

    print(f"[Phase 1] Excel -> PDF ({total} sheets, {workers} workers)")
    print(f"  PDF output: {pdf_dir}")
    t_start = time.time()

    # 워커 인자 준비
    tasks = [
        (xlsx_path, pdf_dir, idx, sheet_names[idx])
        for idx in sheet_indices
    ]

    results = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_export_one_sheet, t): t for t in tasks}
        for future in as_completed(futures):
            r = future.result()
            results.append(r)
            tag = "OK" if r["success"] else "FAIL"
            size_str = f'{r.get("size_bytes", 0):,} bytes' if r["success"] else r.get("error", "?")
            print(f"  [{tag}] [{r['elapsed']}s] {r['sheet_name']} -> {size_str}")

    # 인덱스 순으로 정렬
    results.sort(key=lambda r: r["sheet_index"])

    elapsed_total = time.time() - t_start
    ok = sum(1 for r in results if r["success"])
    fail = sum(1 for r in results if not r["success"])
    print(f"[Phase 1] Done: {ok} OK, {fail} failed ({elapsed_total:.1f}s total)")

    # 실패 상세 리포트
    if fail > 0:
        print(f"\n[Phase 1] FAILED sheets:")
        for r in results:
            if not r["success"]:
                print(f"  - [{r['sheet_index']}] {r['sheet_name']}: {r['error']}")

    # 잔여 LO 프로세스 정리 (모든 워커 완료 후)
    subprocess.run(["taskkill", "/F", "/IM", "soffice.bin"],
                   capture_output=True, timeout=5)
    subprocess.run(["taskkill", "/F", "/IM", "soffice.exe"],
                   capture_output=True, timeout=5)

    # 임시 LO 프로파일 일괄 정리
    import shutil, glob
    for d in glob.glob(os.path.join(tempfile.gettempdir(), "lo_profile_*")):
        shutil.rmtree(d, ignore_errors=True)

    # 실패 시트 순차 재시도 (1개씩, 안정적으로)
    failed = [r for r in results if not r["success"]]
    if failed:
        print(f"\n[Phase 1] Retrying {len(failed)} failed sheet(s) sequentially...")
        time.sleep(2)
        for r in failed:
            idx = r["sheet_index"]
            name = r["sheet_name"]
            retry_args = (xlsx_path, pdf_dir, idx, name)
            retry_result = _export_one_sheet(retry_args)
            # cleanup
            subprocess.run(["taskkill", "/F", "/IM", "soffice.bin"],
                           capture_output=True, timeout=5)
            subprocess.run(["taskkill", "/F", "/IM", "soffice.exe"],
                           capture_output=True, timeout=5)
            for d in glob.glob(os.path.join(tempfile.gettempdir(), "lo_profile_*")):
                shutil.rmtree(d, ignore_errors=True)
            time.sleep(1)

            tag = "OK" if retry_result["success"] else "FAIL"
            size_str = f'{retry_result.get("size_bytes", 0):,} bytes' if retry_result["success"] else retry_result.get("error", "?")
            print(f"  [RETRY {tag}] {name} -> {size_str}")

            # 기존 결과 교체
            results = [retry_result if x["sheet_index"] == idx else x for x in results]

        results.sort(key=lambda r: r["sheet_index"])
        ok2 = sum(1 for r in results if r["success"])
        fail2 = sum(1 for r in results if not r["success"])
        print(f"[Phase 1] After retry: {ok2} OK, {fail2} failed")

    return results, pdf_dir


# ══════════════════════════════════════════════════════════════
# Phase 2: PDF -> PNG + 분할 (병렬)
# ══════════════════════════════════════════════════════════════

def _pdf_to_png(pdf_path, output_path, target_dpi=PNG_DPI):
    """PDF를 PNG로 변환. 콘텐츠 영역만 clip하여 렌더링."""
    import fitz

    doc = fitz.open(pdf_path)
    if doc.page_count != 1:
        pages = doc.page_count
        doc.close()
        return {"success": False, "error": f"PDF has {pages} pages (expected 1)"}

    page = doc[0]
    pdf_w_pt, pdf_h_pt = page.rect.width, page.rect.height

    # 콘텐츠 바운딩 박스 계산
    margin_pt = 5
    content_rect = None

    blocks = page.get_text("dict", flags=0)["blocks"]
    for b in blocks:
        bbox = fitz.Rect(b["bbox"])
        content_rect = bbox if content_rect is None else content_rect | bbox

    for drawing in page.get_drawings():
        bbox = fitz.Rect(drawing["rect"])
        content_rect = bbox if content_rect is None else content_rect | bbox

    for img_info in page.get_images(full=True):
        for r in page.get_image_rects(img_info[0]):
            content_rect = r if content_rect is None else content_rect | r

    if content_rect is None or content_rect.is_empty:
        doc.close()
        return {"success": True, "width": 0, "height": 0, "blank": True}

    clip = content_rect + fitz.Rect(-margin_pt, -margin_pt, margin_pt, margin_pt)
    clip = clip & page.rect

    # DPI 동적 조절
    dpi = target_dpi
    max_dim = max(clip.width, clip.height) * dpi / 72.0
    if max_dim > MAX_PNG_DIMENSION:
        dpi = int(target_dpi * MAX_PNG_DIMENSION / max_dim)
        dpi = max(dpi, 72)

    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
    pix.save(output_path)
    w, h = pix.width, pix.height
    doc.close()

    return {"success": True, "width": w, "height": h, "actual_dpi": dpi}


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


def _create_detail_tiles(full_img_path, output_dir):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None

    img = Image.open(full_img_path)
    W, H = img.size

    if H <= DETAIL_MAX:
        tile_path = os.path.join(output_dir, "detail_r0.png")
        img.save(tile_path, "PNG")
        return {
            "tiles": [{
                "tile_id": "detail_r0", "row_index": 0, "total_rows": 1,
                "pixel_region": {"x": 0, "y": 0, "w": W, "h": H},
                "position_description": "entire sheet",
            }],
            "total_rows": 1, "split_needed": False,
        }

    overlap_px = int(DETAIL_MAX * OVERLAP_RATIO)
    splits = _find_vertical_split_points(img, DETAIL_MAX, overlap_px)
    total_rows = len(splits)

    tiles = []
    for r, y_start in enumerate(splits):
        y_end = min(splits[r + 1] + overlap_px, H) if r < total_rows - 1 else H
        tile = img.crop((0, y_start, W, y_end))

        tile_id = f"detail_r{r}"
        tile_path = os.path.join(output_dir, f"{tile_id}.png")
        tile.save(tile_path, "PNG")

        if total_rows <= 3:
            pos_desc = ["top", "middle", "bottom"][min(r, 2)]
        else:
            pos_desc = f"section {r+1}/{total_rows}"

        tiles.append({
            "tile_id": tile_id, "row_index": r, "total_rows": total_rows,
            "pixel_region": {"x": 0, "y": int(y_start), "w": W, "h": int(y_end - y_start)},
            "position_description": pos_desc,
            "overlap_bottom": overlap_px if r < total_rows - 1 else 0,
        })

    return {
        "tiles": tiles, "total_rows": total_rows, "split_needed": True,
        "original_size": {"width": W, "height": H},
    }


def _convert_one_sheet(args):
    """워커 함수: 단일 PDF -> PNG + 개요 + 분할"""
    pdf_result, output_base = args
    sheet_index = pdf_result["sheet_index"]
    sheet_name = pdf_result["sheet_name"]
    safe_name = safe_filename(sheet_name)

    sheet_dir = os.path.join(output_base, safe_name, "_vision_input")
    os.makedirs(sheet_dir, exist_ok=True)

    result = {
        "sheet_index": sheet_index,
        "sheet_name": sheet_name,
        "safe_name": safe_name,
    }

    # PDF -> PNG
    full_png_path = os.path.join(sheet_dir, "full_original.png")
    png_result = _pdf_to_png(pdf_result["pdf_path"], full_png_path)

    if not png_result.get("success"):
        result["success"] = False
        result["error"] = png_result.get("error", "PNG conversion failed")
        return result

    if png_result.get("blank"):
        result["success"] = True
        result["blank"] = True
        return result

    w, h = png_result["width"], png_result["height"]
    result["full_image"] = {"width": w, "height": h}

    # 개요 이미지
    overview_path = os.path.join(sheet_dir, "overview.png")
    overview_info = _create_overview(full_png_path, overview_path)
    result["overview"] = overview_info

    # 분할
    tile_info = _create_detail_tiles(full_png_path, sheet_dir)
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
    result["blank"] = False
    return result


def phase2_convert_images(pdf_results, output_base):
    """Phase 2: PDF -> PNG + 분할 (병렬)"""
    # 성공한 PDF만 대상
    valid = [r for r in pdf_results if r["success"]]
    if not valid:
        print("[Phase 2] No PDFs to convert.")
        return []

    workers = get_max_workers()
    total = len(valid)

    print(f"\n[Phase 2] PDF -> PNG + split ({total} sheets, {workers} workers)")
    t_start = time.time()

    tasks = [(r, output_base) for r in valid]

    results = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_convert_one_sheet, t): t for t in tasks}
        for future in as_completed(futures):
            r = future.result()
            results.append(r)
            if r["success"]:
                if r.get("blank"):
                    print(f"  [OK] {r['sheet_name']} -> BLANK")
                else:
                    fi = r["full_image"]
                    n = len(r["tiles"]["tiles"])
                    print(f"  [OK] {r['sheet_name']} -> {fi['width']}x{fi['height']}px, {n} section(s)")
            else:
                print(f"  [FAIL] {r['sheet_name']} -> {r.get('error', '?')}")

    results.sort(key=lambda r: r["sheet_index"])
    elapsed = time.time() - t_start

    ok = sum(1 for r in results if r["success"])
    fail = sum(1 for r in results if not r["success"])
    print(f"[Phase 2] Done: {ok} OK, {fail} failed ({elapsed:.1f}s total)")

    return results


# ══════════════════════════════════════════════════════════════
# 메인
# ══════════════════════════════════════════════════════════════

def capture_all(xlsx_path, output_dir, target_sheet=None):
    xlsx_path = os.path.abspath(xlsx_path)
    output_dir = os.path.abspath(output_dir)

    sheet_names = get_sheet_names(xlsx_path)
    excel_name = Path(xlsx_path).stem
    output_base = os.path.join(output_dir, safe_filename(excel_name))
    os.makedirs(output_base, exist_ok=True)

    if target_sheet:
        if target_sheet in sheet_names:
            indices = [sheet_names.index(target_sheet)]
        else:
            print(f"ERROR: sheet '{target_sheet}' not found. Available: {sheet_names}")
            return []
    else:
        indices = list(range(len(sheet_names)))

    total = len(indices)
    print(f"[capture] File: {os.path.basename(xlsx_path)}")
    print(f"[capture] Sheets: {total} / {len(sheet_names)} total")
    print(f"[capture] Workers: {get_max_workers()}")
    print()

    # Phase 1: Excel -> PDF (병렬)
    pdf_results, pdf_dir = phase1_export_pdfs(xlsx_path, output_base, indices, sheet_names)

    # Phase 2: PDF -> PNG + 분할 (병렬)
    img_results = phase2_convert_images(pdf_results, output_base)

    # PDF 임시 폴더 정리
    try:
        import shutil
        shutil.rmtree(pdf_dir, ignore_errors=True)
    except Exception:
        pass

    # 전체 매니페스트
    all_results = []
    for pr in pdf_results:
        ir = next((r for r in img_results if r["sheet_index"] == pr["sheet_index"]), None)
        entry = {
            "index": pr["sheet_index"],
            "name": pr["sheet_name"],
            "pdf_success": pr["success"],
            "pdf_error": pr.get("error"),
            "pdf_elapsed": pr.get("elapsed"),
        }
        if ir:
            entry["img_success"] = ir["success"]
            entry["img_error"] = ir.get("error")
            entry["blank"] = ir.get("blank", False)
            fi = ir.get("full_image", {})
            entry["full_size"] = f"{fi.get('width', 0)}x{fi.get('height', 0)}"
            entry["sections"] = ir.get("tiles", {}).get("total_rows") if ir.get("tiles") else None
        else:
            entry["img_success"] = False
            entry["blank"] = False
        all_results.append(entry)

    manifest_path = os.path.join(output_base, "_capture_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "source": os.path.basename(xlsx_path),
            "sheet_count": len(sheet_names),
            "captured": total,
            "sheets": all_results,
        }, f, ensure_ascii=False, indent=2, cls=NumpySafeEncoder)

    # 요약
    ok = sum(1 for r in all_results if r.get("img_success") and not r.get("blank"))
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

    # 기존 soffice 프로세스 정리
    subprocess.run(["taskkill", "/F", "/IM", "soffice.bin"], capture_output=True)
    subprocess.run(["taskkill", "/F", "/IM", "soffice.exe"], capture_output=True)
    time.sleep(1)

    results = capture_all(input_file, output_dir, target_sheet)
    failed = [r for r in results if not r.get("img_success")]
    sys.exit(1 if failed else 0)
