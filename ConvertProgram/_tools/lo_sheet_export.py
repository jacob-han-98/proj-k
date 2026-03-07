#!/usr/bin/env python3
"""
lo_sheet_export.py - LibreOffice UNO를 사용한 시트별 PDF 내보내기

각 시트를 fit-to-page(1페이지 너비)로 개별 PDF 파일로 내보낸다.

사용법 (시스템 Python에서 호출):
    python lo_sheet_export.py <input.xlsx> <output_dir>

내부적으로 각 시트마다 LibreOffice 프로세스를 개별 실행하여 안정성 확보.
출력: output_dir/{nn}_{시트명}.pdf + output_dir/_export_manifest.json
"""

import sys
import os
import json
import subprocess
import time
import tempfile

# LibreOffice 경로
SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"
LO_PYTHON = r"C:\Program Files\LibreOffice\program\python.exe"


def get_sheet_names_openpyxl(xlsx_path):
    """openpyxl로 시트 이름 목록 가져오기 (빠름, LO 불필요)"""
    import openpyxl
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    names = wb.sheetnames
    wb.close()
    return names


def safe_filename(name):
    """파일명에 안전한 문자열로 변환"""
    for ch in '/\\:*?"<>|':
        name = name.replace(ch, "_")
    return name


def export_single_sheet(xlsx_path, output_dir, sheet_index, sheet_name, pipe_name):
    """단일 시트를 PDF로 내보내기 (별도 LibreOffice 프로세스)"""
    safe_name = safe_filename(sheet_name)
    pdf_path = os.path.join(output_dir, f"{sheet_index:02d}_{safe_name}.pdf")

    # UNO 스크립트를 임시 파일로 생성
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

    for attempt in range(20):
        try:
            ctx = resolver.resolve(
                "uno:pipe,name={pipe_name};urp;StarOffice.ComponentContext")
            break
        except:
            time.sleep(1.0)
    else:
        print("ERROR: LibreOffice 연결 실패")
        sys.exit(1)

    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    file_url = uno.systemPathToFileUrl(r"{xlsx_path}")
    doc = desktop.loadComponentFromURL(file_url, "_blank", 0,
        (make_prop("ReadOnly", True),))

    if doc is None:
        print("ERROR: 파일 열기 실패")
        sys.exit(1)

    controller = doc.getCurrentController()
    sheets = doc.getSheets()
    sheet = sheets.getByIndex({sheet_index})
    controller.setActiveSheet(sheet)

    # fit-to-page 설정
    try:
        style_name = sheet.PageStyle
        page_styles = doc.getStyleFamilies().getByName("PageStyles")
        page_style = page_styles.getByName(style_name)
        page_style.ScaleToPagesX = 1
        page_style.ScaleToPagesY = 0
        page_style.PageScale = 0
    except Exception as e:
        print(f"WARN: 페이지 스타일 설정 실패: {{e}}")

    # 현재 시트 사용 범위를 Selection으로 지정
    cursor = sheet.createCursor()
    cursor.gotoStartOfUsedArea(False)
    cursor.gotoEndOfUsedArea(True)

    pdf_filter_data = (
        make_prop("IsSkipEmptyPages", False),
        make_prop("UseLosslessCompression", True),
        make_prop("Quality", 90),
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

    # 임시 스크립트 파일 생성
    script_fd, script_path = tempfile.mkstemp(suffix=".py", prefix="lo_export_")
    try:
        with os.fdopen(script_fd, "w", encoding="utf-8") as f:
            f.write(uno_script)

        # LibreOffice 리스너 시작
        soffice_proc = subprocess.Popen(
            [SOFFICE, "--headless", "--norestore",
             f"--accept=pipe,name={pipe_name};urp;"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

        time.sleep(4)  # LibreOffice 초기화 대기 (충분히)

        # UNO 스크립트 실행
        result = subprocess.run(
            [LO_PYTHON, script_path],
            capture_output=True, text=True, timeout=120,
        )

        output = result.stdout.strip()
        if output.startswith("OK:"):
            file_size = int(output.split(":")[1])
            return {"success": True, "size_bytes": file_size, "pdf_path": pdf_path}
        else:
            error_msg = result.stderr.strip() or output or "Unknown error"
            return {"success": False, "error": error_msg, "pdf_path": pdf_path}

    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout (60s)", "pdf_path": pdf_path}
    except Exception as e:
        return {"success": False, "error": str(e), "pdf_path": pdf_path}
    finally:
        # LibreOffice 프로세스 정리
        try:
            soffice_proc.terminate()
            soffice_proc.wait(timeout=5)
        except Exception:
            try:
                soffice_proc.kill()
            except Exception:
                pass
        # 임시 스크립트 삭제
        try:
            os.unlink(script_path)
        except Exception:
            pass
        # soffice.bin 잔여 프로세스 정리 (강제 종료 + 충분한 대기)
        subprocess.run(
            ["taskkill", "/F", "/IM", "soffice.bin"],
            capture_output=True, timeout=5,
        )
        subprocess.run(
            ["taskkill", "/F", "/IM", "soffice.exe"],
            capture_output=True, timeout=5,
        )
        time.sleep(3)  # 프로세스 완전 종료 대기


def export_all_sheets(input_path, output_dir):
    """XLSX 파일의 모든 시트를 개별 PDF로 내보내기"""
    input_path = os.path.abspath(input_path)
    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    sheet_names = get_sheet_names_openpyxl(input_path)
    sheet_count = len(sheet_names)
    results = []

    print(f"[lo_sheet_export] 파일: {os.path.basename(input_path)}")
    print(f"[lo_sheet_export] 시트 수: {sheet_count}")
    print(f"[lo_sheet_export] 시트 목록: {', '.join(sheet_names)}")

    for i, name in enumerate(sheet_names):
        safe_name = safe_filename(name)

        # 최대 2회 시도 (1회 실패 시 재시도)
        result = None
        for attempt in range(2):
            pipe_name = f"sheet_export_{os.getpid()}_{i}_a{attempt}"
            result = export_single_sheet(input_path, output_dir, i, name, pipe_name)
            if result["success"]:
                break
            if attempt == 0:
                print(f"  [RETRY] {name}: 재시도 중...")
                time.sleep(5)  # 추가 대기 후 재시도

        result.update({
            "index": i,
            "name": name,
            "safe_name": safe_name,
        })
        results.append(result)

        if result["success"]:
            print(f"  [{i+1}/{sheet_count}] {name} -> {os.path.basename(result['pdf_path'])} ({result['size_bytes']:,} bytes)")
        else:
            print(f"  [{i+1}/{sheet_count}] {name} -> FAILED: {result.get('error', 'Unknown')}")

    # 매니페스트 저장
    manifest_path = os.path.join(output_dir, "_export_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "source": os.path.basename(input_path),
            "source_path": input_path,
            "sheet_count": sheet_count,
            "sheets": results,
        }, f, ensure_ascii=False, indent=2)

    success_count = sum(1 for r in results if r["success"])
    print(f"[lo_sheet_export] 완료: {success_count}/{sheet_count} 성공")
    return results


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python lo_sheet_export.py <input.xlsx> <output_dir>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_dir = sys.argv[2]

    if not os.path.exists(input_file):
        print(f"ERROR: 파일 없음: {input_file}")
        sys.exit(1)

    # 기존 soffice 프로세스 정리
    subprocess.run(["taskkill", "/F", "/IM", "soffice.bin"],
                   capture_output=True)
    time.sleep(1)

    results = export_all_sheets(input_file, output_dir)
    failed = [r for r in results if not r["success"]]
    sys.exit(1 if failed else 0)
