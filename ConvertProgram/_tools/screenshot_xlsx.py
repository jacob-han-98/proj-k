"""
screenshot_xlsx.py - Excel 시트를 이미지로 캡처하는 Tier 2 파이프라인 도구

win32com으로 Excel을 열어 각 시트의 UsedRange를 클립보드로 복사한 뒤
PNG 이미지로 저장한다. 도형/플로우차트가 포함된 시트를 비전 모델로
분석하기 위한 전처리 단계.

사용법:
    python screenshot_xlsx.py "path/to/file.xlsx"
    python screenshot_xlsx.py "path/to/file.xlsx" --sheets "변신" "스킬"
    python screenshot_xlsx.py "path/to/file.xlsx" --output-dir ./screenshots
"""

import argparse
import os
import sys
import time
import tempfile
from pathlib import Path

def screenshot_xlsx(xlsx_path: str, output_dir: str = None,
                    sheet_names: list = None, zoom: int = 100) -> list:
    """
    Excel 파일의 시트들을 PNG 이미지로 캡처한다.

    Args:
        xlsx_path: xlsx 파일 경로
        output_dir: 출력 폴더 (None이면 _knowledge_base/screenshots/ 하위)
        sheet_names: 캡처할 시트 이름 목록 (None이면 전체)
        zoom: 줌 레벨 (기본 100%)

    Returns:
        생성된 이미지 파일 경로 리스트
    """
    # 지연 임포트 - Windows 전용
    try:
        import win32com.client
        from PIL import ImageGrab, Image
    except ImportError as e:
        print(f"[ERROR] 필요한 패키지가 없습니다: {e}")
        print("  pip install pywin32 Pillow")
        sys.exit(1)

    xlsx_path = os.path.abspath(xlsx_path)
    if not os.path.exists(xlsx_path):
        print(f"[ERROR] 파일을 찾을 수 없습니다: {xlsx_path}")
        sys.exit(1)

    # 출력 폴더 결정
    if output_dir is None:
        base_name = Path(xlsx_path).stem.replace(" ", "_")
        project_root = _find_project_root(xlsx_path)
        output_dir = os.path.join(project_root, "_knowledge_base", "screenshots", base_name)

    os.makedirs(output_dir, exist_ok=True)

    # Excel COM 객체 생성
    excel = None
    wb = None
    saved_files = []

    try:
        excel = win32com.client.Dispatch("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        excel.ScreenUpdating = True  # 렌더링을 위해 필요

        wb = excel.Workbooks.Open(xlsx_path, ReadOnly=True)

        for ws in wb.Worksheets:
            name = ws.Name
            if sheet_names and name not in sheet_names:
                continue

            safe_name = name.replace(" ", "_").replace("/", "_")
            out_path = os.path.join(output_dir, f"{safe_name}.png")

            print(f"  캡처 중: {name} ...", end=" ", flush=True)

            try:
                result = _capture_sheet(excel, ws, out_path, zoom)
                if result:
                    saved_files.append(result)
                    fsize = os.path.getsize(result)
                    print(f"OK ({fsize // 1024}KB)")
                else:
                    print("SKIP (빈 시트)")
            except Exception as e:
                print(f"FAIL ({e})")

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
        # COM 참조 해제
        wb = None
        excel = None

    return saved_files


def _capture_sheet(excel, ws, out_path: str, zoom: int = 100) -> str | None:
    """단일 시트를 PNG로 캡처한다."""
    from PIL import ImageGrab
    import win32com.client
    import pythoncom

    used = ws.UsedRange
    if used is None or (used.Rows.Count <= 1 and used.Columns.Count <= 1):
        cell_val = None
        try:
            cell_val = ws.Cells(1, 1).Value
        except:
            pass
        if cell_val is None:
            return None

    # 시트 활성화
    ws.Activate()
    time.sleep(0.3)

    # UsedRange + 도형 영역을 포함하는 전체 범위 계산
    capture_range = _get_capture_range(ws)
    if capture_range is None:
        return None

    # 줌 설정
    excel.ActiveWindow.Zoom = zoom

    # 범위를 클립보드에 이미지로 복사
    capture_range.CopyPicture(Appearance=1, Format=2)  # xlScreen=1, xlBitmap=2
    time.sleep(0.5)

    # 클립보드에서 이미지 가져오기
    img = ImageGrab.grabclipboard()
    if img is None:
        # 재시도
        time.sleep(1.0)
        img = ImageGrab.grabclipboard()

    if img is None:
        # CopyPicture 대신 전체 화면 캡처 폴백
        return _capture_via_export(ws, capture_range, out_path)

    img.save(out_path, "PNG")
    return out_path


def _get_capture_range(ws):
    """시트의 UsedRange + 도형 영역을 포함하는 범위를 반환한다."""
    used = ws.UsedRange
    if used is None:
        return None

    # UsedRange 경계
    top = used.Row
    left = used.Column
    bottom = top + used.Rows.Count - 1
    right = left + used.Columns.Count - 1

    # 도형이 있으면 도형 영역도 포함
    try:
        shapes = ws.Shapes
        if shapes.Count > 0:
            for i in range(1, shapes.Count + 1):
                shp = shapes.Item(i)
                # 도형의 셀 위치 계산
                try:
                    shp_top_left = shp.TopLeftCell
                    shp_bottom_right = shp.BottomRightCell
                    if shp_top_left.Row < top:
                        top = shp_top_left.Row
                    if shp_top_left.Column < left:
                        left = shp_top_left.Column
                    if shp_bottom_right.Row > bottom:
                        bottom = shp_bottom_right.Row
                    if shp_bottom_right.Column > right:
                        right = shp_bottom_right.Column
                except:
                    pass  # 일부 도형은 TopLeftCell이 없을 수 있음
    except:
        pass

    # 범위 반환
    return ws.Range(ws.Cells(top, left), ws.Cells(bottom, right))


def _capture_via_export(ws, capture_range, out_path: str) -> str | None:
    """CopyPicture 실패 시 Chart 객체를 이용한 이미지 내보내기 폴백."""
    try:
        import win32com.client

        # 임시 차트 생성하여 범위를 이미지로 내보내기
        temp_chart = ws.Parent.Charts.Add()
        temp_chart.Location(Where=2, Name=ws.Name)  # xlLocationAsObject

        # ChartObject로 접근
        chart_obj = ws.ChartObjects(ws.ChartObjects().Count)
        chart_obj.Width = capture_range.Width
        chart_obj.Height = capture_range.Height

        capture_range.CopyPicture(Appearance=1, Format=2)
        chart_obj.Chart.Paste()
        chart_obj.Chart.Export(out_path, "PNG")
        chart_obj.Delete()

        return out_path
    except Exception as e:
        print(f"(export fallback failed: {e})", end=" ")
        return None


def _find_project_root(start_path: str) -> str:
    """CLAUDE.md 또는 _knowledge_base 폴더를 찾아 프로젝트 루트를 반환."""
    current = os.path.dirname(start_path)
    for _ in range(10):
        if os.path.exists(os.path.join(current, "CLAUDE.md")):
            return current
        if os.path.exists(os.path.join(current, "_knowledge_base")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    # 못 찾으면 xlsx 파일과 같은 폴더
    return os.path.dirname(start_path)


def main():
    parser = argparse.ArgumentParser(
        description="Excel 시트를 PNG 이미지로 캡처 (Tier 2 파이프라인)")
    parser.add_argument("xlsx", help="XLSX 파일 경로")
    parser.add_argument("--sheets", nargs="*", help="캡처할 시트 이름 (생략 시 전체)")
    parser.add_argument("--output-dir", "-o", help="출력 폴더")
    parser.add_argument("--zoom", type=int, default=100, help="줌 레벨 (기본 100)")

    args = parser.parse_args()

    print(f"[screenshot_xlsx] {args.xlsx}")
    results = screenshot_xlsx(args.xlsx, args.output_dir, args.sheets, args.zoom)

    print(f"\n완료: {len(results)}개 시트 캡처됨")
    for r in results:
        print(f"  -> {r}")


if __name__ == "__main__":
    main()
