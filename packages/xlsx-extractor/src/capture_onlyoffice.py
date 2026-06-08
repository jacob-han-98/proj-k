#!/usr/bin/env python3
"""
capture_onlyoffice.py - Stage 1 대체 백엔드 (Linux headless)

Excel COM(Windows) 대신 OnlyOffice Document Server 변환 API 로 시트별 전체 PNG 생성.
  Phase 1 (이 모듈): xlsx → (OnlyOffice DS) → PDF → (poppler/pdftoppm) 시트별 콘텐츠 crop PNG
  Phase 2 (capture.py 재사용): full PNG → overview + detail tiles

핵심 보장: "시트 1개 = 공백 없는 단일 이미지"
  - 전체 워크북을 한 번에 변환하되 spreadsheetLayout(fitToWidth=1 + 큰 pageSize)으로
    시트당 정확히 1 PDF 페이지 (도형/이미지 보존, openpyxl 재작성 안 함).
  - OnlyOffice 는 숨김 시트를 PDF 에서 제외 → page i ↔ visible sheet i 결정적 매핑.
  - **래스터화는 poppler(pdftoppm) 사용.** OnlyOffice 가 출력한 PDF 는 비표준 soft mask
    (ExtGState missing group)를 써서 PyMuPDF(fitz)가 해당 영역을 불투명 파랑으로 오렌더함.
    poppler 는 이를 올바르게 처리. (2026-06-07 UI_변신_합성 시트에서 발견·확정)
  - 콘텐츠 bbox 는 저해상도 probe 렌더의 비백색 픽셀로 산출 후, 그 영역만 target DPI 로
    crop 렌더 → 거대 캔버스 회피, 자연 배율 유지.

의존: pdftoppm/pdfinfo (poppler-utils), requests, openpyxl, Pillow, numpy.

env:
  PROJK_ONLYOFFICE_URL        DS endpoint (default http://localhost:8080)
  PROJK_ONLYOFFICE_DPI        최종 렌더 DPI (default 150)
  PROJK_ONLYOFFICE_PROBE_DPI  bbox probe DPI (default 36)
"""

import os
import re
import json
import time
import socket
import shutil
import uuid
import glob
import zipfile
import subprocess
import threading
import http.server
import socketserver
from pathlib import Path
from urllib.parse import urlparse

# capture.py 의 Phase2 및 유틸 재사용 (계약 동일)
from capture import safe_filename, phase2_split_images, get_sheet_names, NumpySafeEncoder

OO_URL_DEFAULT = os.environ.get("PROJK_ONLYOFFICE_URL", "http://localhost:8080")
OO_DPI = int(os.environ.get("PROJK_ONLYOFFICE_DPI", "150"))
PROBE_DPI = int(os.environ.get("PROJK_ONLYOFFICE_PROBE_DPI", "36"))
# 시트당 1페이지 강제용 — 가로는 1페이지 fit(자연 배율), 세로는 분할 방지로 크게.
# 더 키우면 x2t 가 콘텐츠를 page box 밖(음수 좌표)에 배치하는 버그 발생 → 1200×5000mm 안전값.
PAGE_WIDTH_MM = os.environ.get("PROJK_ONLYOFFICE_PAGE_W", "1200mm")
PAGE_HEIGHT_MM = os.environ.get("PROJK_ONLYOFFICE_PAGE_H", "5000mm")
CONVERT_TIMEOUT = int(os.environ.get("PROJK_ONLYOFFICE_TIMEOUT", "300"))
PAD_PT = 4  # 콘텐츠 bbox 여백(pt)
# drawing 앵커를 absoluteAnchor 로 변환할지 (기본 on). 끄려면 PROJK_ONLYOFFICE_ABS_ANCHOR=0
ABS_ANCHOR = os.environ.get("PROJK_ONLYOFFICE_ABS_ANCHOR", "1") != "0"


# ── drawing 앵커 절대좌표화 (흐름도 연결선 정렬) ──

def _anchors_to_absolute(xml: str):
    """drawing XML 의 twoCellAnchor/oneCellAnchor 를 absoluteAnchor 로 변환.

    이유: OnlyOffice 는 도형을 셀 앵커(컬럼폭=폰트 메트릭 의존)로 배치하면서 일부
    연결선/요소는 저장된 절대 EMU 좌표(원작성 Excel 기준)로 배치 → 두 기준이 어긋나
    흐름도 연결선이 노드에서 떨어진다(특히 우측 누적). 모든 앵커를 Excel 이 저장한
    동일 절대좌표(a:off/a:ext)로 통일하면 폰트와 무관하게 도형·연결선이 일관 정렬된다.
    (2026-06-07 변신 시트 NO 분기선 ~95px 단절 → 0px 로 해결 확인)
    """
    count = [0]

    def repl(m):
        kind = m.group(1)
        anchor = m.group(0)
        off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"\s*/>', anchor)
        ext = re.search(r'<a:ext cx="(-?\d+)" cy="(-?\d+)"\s*/>', anchor)
        if not (off and ext):
            return anchor  # 절대좌표 없으면 원형 유지
        x, y, cx, cy = off.group(1), off.group(2), ext.group(1), ext.group(2)
        inner = anchor
        inner = re.sub(rf'^<xdr:{kind}\b[^>]*>', '', inner, count=1)
        inner = re.sub(rf'</xdr:{kind}>$', '', inner, count=1)
        inner = re.sub(r'^<xdr:from>.*?</xdr:from>', '', inner, count=1, flags=re.S)
        if kind == 'twoCellAnchor':
            inner = re.sub(r'^<xdr:to>.*?</xdr:to>', '', inner, count=1, flags=re.S)
        else:  # oneCellAnchor: from 뒤에 <xdr:ext/>
            inner = re.sub(r'^<xdr:ext\b[^>]*/>', '', inner, count=1, flags=re.S)
        count[0] += 1
        return (f'<xdr:absoluteAnchor><xdr:pos x="{x}" y="{y}"/>'
                f'<xdr:ext cx="{cx}" cy="{cy}"/>{inner}</xdr:absoluteAnchor>')

    new = re.sub(r'<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>.*?</xdr:\1>',
                 repl, xml, flags=re.S)
    return new, count[0]


def _rewrite_xlsx_absolute_anchors(xlsx_path: str) -> int:
    """xlsx(복사본) 내 모든 xl/drawings/drawing*.xml 을 in-place 로 absoluteAnchor 변환.

    반환: 변환된 앵커 총 개수. (원본 아닌 서빙용 복사본에만 적용할 것.)
    """
    src = Path(xlsx_path)
    tmp = src.with_suffix(src.suffix + ".tmp")
    total = 0
    with zipfile.ZipFile(src, "r") as zin, \
            zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if re.match(r"xl/drawings/drawing\d+\.xml$", item.filename):
                txt = data.decode("utf-8")
                new, n = _anchors_to_absolute(txt)
                if n:
                    data = new.encode("utf-8")
                    total += n
            zout.writestr(item, data)
    tmp.replace(src)
    return total


# ── HTTP 호스팅 (컨테이너가 변환 대상 파일을 fetch) ──

def _host_gateway() -> str:
    """compose extra_hosts 의 host-gateway 매핑. 컨테이너→호스트 도달 주소."""
    return "host.docker.internal"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _start_file_server(directory: Path):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", _free_port()), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _spreadsheet_layout() -> dict:
    return {
        "ignorePrintArea": True,
        "gridLines": True,        # 셀 구분선 보존
        "headings": False,
        "fitToWidth": 1,          # 가로 1페이지 (자연 배율, 우측 잘림 방지)
        "fitToHeight": 0,
        "orientation": "portrait",
        "margins": {"top": "0mm", "bottom": "0mm", "left": "0mm", "right": "0mm"},
        "pageSize": {"width": PAGE_WIDTH_MM, "height": PAGE_HEIGHT_MM},
    }


def _convert_to_pdf(ds_url: str, file_url: str) -> bytes:
    """OnlyOffice DS 변환 API: xlsx(url) → pdf(bytes)."""
    import requests
    body = {
        "async": False,
        "filetype": "xlsx",
        "outputtype": "pdf",
        "key": "projk-" + uuid.uuid4().hex[:16],
        "title": "capture.xlsx",
        "url": file_url,
        "spreadsheetLayout": _spreadsheet_layout(),
    }
    r = requests.post(f"{ds_url}/converter", json=body,
                      headers={"Accept": "application/json"}, timeout=CONVERT_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    if data.get("error"):
        raise RuntimeError(f"OnlyOffice converter error code={data['error']} (body={data})")
    if not data.get("endConvert"):
        raise RuntimeError(f"OnlyOffice convert not finished: {data}")
    pdf_url = data["fileUrl"]
    u = urlparse(pdf_url)
    local_url = f"{ds_url}{u.path}" + (f"?{u.query}" if u.query else "")
    for cand in (pdf_url, local_url):
        try:
            pr = requests.get(cand, timeout=CONVERT_TIMEOUT)
            if pr.ok and pr.content[:4] == b"%PDF":
                return pr.content
        except Exception:
            continue
    raise RuntimeError(f"PDF 다운로드 실패: {pdf_url} / {local_url}")


# ── poppler(pdftoppm/pdfinfo) 래스터화 ──

def _pdf_page_count(pdf_path: str) -> int:
    out = subprocess.run(["pdfinfo", pdf_path], capture_output=True, text=True, timeout=60).stdout
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    raise RuntimeError("pdfinfo: page count 파싱 실패")


def _pdftoppm(pdf_path: str, page_no: int, dpi: int, out_prefix: str, crop=None) -> str | None:
    """page_no(1-based)를 PNG 로 렌더. crop=(x,y,w,h) px@dpi 이면 그 영역만. 산출 PNG 경로."""
    cmd = ["pdftoppm", "-png", "-r", str(dpi), "-f", str(page_no), "-l", str(page_no)]
    if crop:
        x, y, w, h = (max(0, int(v)) for v in crop)
        cmd += ["-x", str(x), "-y", str(y), "-W", str(w), "-H", str(h)]
    cmd += [pdf_path, out_prefix]
    subprocess.run(cmd, check=True, capture_output=True, timeout=CONVERT_TIMEOUT)
    files = sorted(glob.glob(out_prefix + "*.png"))
    return files[-1] if files else None


def _nonwhite_bbox(png_path: str):
    """PNG 의 비백색 콘텐츠 bbox (x0,y0,x1,y1) 픽셀. 전부 백색이면 None."""
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    a = np.asarray(Image.open(png_path).convert("RGB"))
    nonwhite = ~np.all(a > 245, axis=2)
    ys, xs = np.where(nonwhite)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# ── Phase 1 (OnlyOffice) — capture.phase1_capture_images 와 동일 반환 계약 ──

def phase1_capture_images_oo(xlsx_path, output_base, sheet_indices, sheet_names, oo_url=None):
    """전체 워크북을 한 번 변환 후, 요청된 시트(visible index)만 full_original.png 생성.

    반환: capture.phase1_capture_images 와 동일한 dict 리스트.
    """
    oo_url = (oo_url or OO_URL_DEFAULT).rstrip("/")
    xlsx_path = os.path.abspath(xlsx_path)
    total = len(sheet_indices)

    print(f"[Phase 1] OnlyOffice 변환 ({total}/{len(sheet_names)} sheets, dpi={OO_DPI}, poppler)")
    t_start = time.time()

    work = Path("/tmp/projk-oo") / uuid.uuid4().hex[:8]
    work.mkdir(parents=True, exist_ok=True)
    served = work / "capture.xlsx"
    shutil.copyfile(xlsx_path, served)  # 원본 불침습: 복사본에만 전처리 적용
    if ABS_ANCHOR:
        try:
            n = _rewrite_xlsx_absolute_anchors(str(served))
            if n:
                print(f"  [pre] drawing 앵커 {n}개 → absoluteAnchor (연결선 정렬)")
        except Exception as e:
            print(f"  [pre][WARN] absoluteAnchor 변환 실패, 원형 사용: {e}")
    httpd = _start_file_server(work)
    file_url = f"http://{_host_gateway()}:{httpd.server_address[1]}/capture.xlsx"

    def _fail_all(err):
        return [{"success": False, "sheet_index": idx, "sheet_name": sheet_names[idx],
                 "safe_name": safe_filename(sheet_names[idx]), "blank": False,
                 "error": err, "elapsed": 0} for idx in sheet_indices]

    try:
        pdf_bytes = _convert_to_pdf(oo_url, file_url)
    except Exception as e:
        httpd.shutdown(); shutil.rmtree(work, ignore_errors=True)
        print(f"[Phase 1] 변환 실패: {e}")
        return _fail_all(f"convert failed: {e}")
    finally:
        httpd.shutdown()

    pdf_path = str(work / "out.pdf")
    Path(pdf_path).write_bytes(pdf_bytes)

    results = []
    try:
        npages = _pdf_page_count(pdf_path)
        if npages != len(sheet_names):
            print(f"  [WARN] PDF 페이지({npages}) != visible 시트({len(sheet_names)}) — 매핑 불일치")
            return _fail_all(f"page/sheet mismatch ({npages} vs {len(sheet_names)})")

        scale = OO_DPI / PROBE_DPI
        pad_px = PAD_PT * OO_DPI / 72.0
        for n, idx in enumerate(sheet_indices):
            name = sheet_names[idx]
            safe_name = safe_filename(name)
            sheet_dir = os.path.join(output_base, safe_name, "_vision_input")
            os.makedirs(sheet_dir, exist_ok=True)
            full_png = os.path.join(sheet_dir, "full_original.png")
            page_no = idx + 1  # 1-based
            t_sheet = time.time()
            try:
                # 1) probe 렌더 (저해상도 full) → 콘텐츠 bbox
                probe_prefix = str(work / f"probe{idx}")
                probe_png = _pdftoppm(pdf_path, page_no, PROBE_DPI, probe_prefix)
                bbox = _nonwhite_bbox(probe_png) if probe_png else None
                if bbox is None:
                    results.append({"success": True, "sheet_index": idx, "sheet_name": name,
                                    "safe_name": safe_name, "blank": True,
                                    "elapsed": round(time.time() - t_sheet, 1)})
                    print(f"  [{n+1}/{total}] {name} -> BLANK")
                    continue
                # 2) bbox → target dpi 픽셀 crop, pad 적용
                x0, y0, x1, y1 = bbox
                cx = x0 * scale - pad_px
                cy = y0 * scale - pad_px
                cw = (x1 - x0) * scale + 2 * pad_px
                ch = (y1 - y0) * scale + 2 * pad_px
                out_prefix = str(work / f"page{idx}")
                rendered = _pdftoppm(pdf_path, page_no, OO_DPI, out_prefix, crop=(cx, cy, cw, ch))
                if not rendered:
                    raise RuntimeError("pdftoppm 렌더 산출 없음")
                shutil.move(rendered, full_png)
                from PIL import Image
                Image.MAX_IMAGE_PIXELS = None
                with Image.open(full_png) as im:
                    w, h = im.size
                results.append({"success": True, "sheet_index": idx, "sheet_name": name,
                                "safe_name": safe_name, "png_path": full_png, "blank": False,
                                "width": w, "height": h,
                                "elapsed": round(time.time() - t_sheet, 1)})
                print(f"  [{n+1}/{total}] {name} -> {w}x{h}px ({time.time()-t_sheet:.1f}s)")
            except Exception as e:
                results.append({"success": False, "sheet_index": idx, "sheet_name": name,
                                "safe_name": safe_name, "blank": False,
                                "error": str(e), "elapsed": round(time.time() - t_sheet, 1)})
                print(f"  [{n+1}/{total}] {name} -> FAIL: {e}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    results.sort(key=lambda r: r["sheet_index"])
    ok = sum(1 for r in results if r["success"] and not r.get("blank"))
    blank = sum(1 for r in results if r.get("blank"))
    fail = sum(1 for r in results if not r["success"])
    print(f"[Phase 1] Done: {ok} OK, {blank} blank, {fail} failed ({time.time()-t_start:.1f}s)")
    return results


# ── 메인 (capture.capture_all 미러) ──

def capture_all_oo(xlsx_path, output_dir, target_sheet=None, oo_url=None):
    """OnlyOffice 백엔드 전체 캡처 파이프라인 (capture.capture_all 와 동일 출력 계약)."""
    xlsx_path = os.path.abspath(xlsx_path)
    output_dir = os.path.abspath(output_dir)

    sheet_names = get_sheet_names(xlsx_path)  # visible only, 순서 보존
    excel_name = Path(xlsx_path).stem
    output_base = os.path.join(output_dir, safe_filename(excel_name))
    os.makedirs(output_base, exist_ok=True)

    if target_sheet:
        target_list = [t.strip() for t in target_sheet.split(",")]
        indices = []
        for tn in target_list:
            if tn in sheet_names:
                indices.append(sheet_names.index(tn))
            else:
                print(f"WARNING: sheet '{tn}' not found. Available: {sheet_names}")
        if not indices:
            print("ERROR: no matching sheets found")
            return []
    else:
        indices = list(range(len(sheet_names)))

    total = len(indices)
    print(f"[capture] File: {os.path.basename(xlsx_path)}")
    print(f"[capture] Sheets: {total} / {len(sheet_names)} total  (backend=onlyoffice)")
    print()

    capture_results = phase1_capture_images_oo(xlsx_path, output_base, indices, sheet_names, oo_url=oo_url)
    split_results = phase2_split_images(capture_results)

    all_results = []
    for cr in capture_results:
        sr = next((r for r in split_results if r["sheet_index"] == cr["sheet_index"]), None)
        entry = {
            "index": cr["sheet_index"], "name": cr["sheet_name"],
            "capture_success": cr["success"], "capture_error": cr.get("error"),
            "capture_elapsed": cr.get("elapsed"), "blank": cr.get("blank", False),
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
            "capture_method": "onlyoffice_pdf_poppler",
            "sheet_count": len(sheet_names),
            "captured": total,
            "sheets": all_results,
        }, f, ensure_ascii=False, indent=2, cls=NumpySafeEncoder)

    ok = sum(1 for r in all_results if r.get("split_success"))
    blank = sum(1 for r in all_results if r.get("blank"))
    fail = total - ok - blank
    print(f"\n[capture] Final: {ok} OK, {blank} blank, {fail} failed / {total} total")
    return all_results


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python capture_onlyoffice.py <input.xlsx> <output_dir> [--sheet <name>]")
        sys.exit(1)
    input_file, out_dir = sys.argv[1], sys.argv[2]
    tsheet = None
    if "--sheet" in sys.argv:
        i = sys.argv.index("--sheet")
        if i + 1 < len(sys.argv):
            tsheet = sys.argv[i + 1]
    res = capture_all_oo(input_file, out_dir, tsheet)
    failed = [r for r in res if not r.get("split_success") and not r.get("blank")]
    sys.exit(1 if failed else 0)
