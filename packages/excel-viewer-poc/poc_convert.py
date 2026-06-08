#!/usr/bin/env python3
"""
캡처 게이트 PoC — OnlyOffice DS Conversion API 로 xlsx -> pdf -> png.

핵심 검증: "시트 1개 = 공백 없는 단일 이미지" 가 가능한가.
전략: 전체 워크북을 한 번에 변환하되 spreadsheetLayout 으로 시트당 1페이지 강제
      (fitToWidth/fitToHeight=1, margins=0, gridLines=true, ignorePrintArea=true).
      → 도형/이미지 보존(openpyxl 재작성 안 함) + 시트↔PDF페이지 결정적 1:1 매핑.

usage:
  poc_convert.py <xlsx> [--mode a1|a2] [--dpi 220] [--out DIR] [--ds http://localhost:8080]
"""
import argparse, json, os, sys, time, threading, socket, http.server, socketserver, shutil, uuid
from pathlib import Path
import requests
import fitz  # PyMuPDF
import openpyxl


def host_gateway_ip() -> str:
    """컨테이너가 host 에 닿는 주소. compose 의 extra_hosts host-gateway 매핑 사용."""
    return "host.docker.internal"


def serve_dir(directory: Path, port: int):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", port), handler)
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def free_port() -> int:
    s = socket.socket()
    s.bind(("", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def visible_sheets(xlsx: Path):
    wb = openpyxl.load_workbook(xlsx, read_only=True, keep_links=False)
    names = [ws.title for ws in wb.worksheets if ws.sheet_state == "visible"]
    wb.close()
    return names


def layout(mode: str) -> dict:
    base = {
        "ignorePrintArea": True,
        "gridLines": True,
        "headings": False,
        "margins": {"top": "0mm", "bottom": "0mm", "left": "0mm", "right": "0mm"},
        "orientation": "portrait",
    }
    if mode == "a2":
        # 강제 1페이지 (시트당 1장 보장, 큰 시트는 축소)
        base["fitToWidth"] = 1
        base["fitToHeight"] = 1
    else:
        # a1: 자연 배율, 매우 큰 page 로 한 페이지 유도
        base["fitToWidth"] = 1
        base["fitToHeight"] = 0
        base["pageSize"] = {"width": "1200mm", "height": "5000mm"}
    return base


def convert(ds: str, file_url: str, mode: str, timeout=180) -> bytes:
    key = "poc-" + uuid.uuid4().hex[:16]
    body = {
        "async": False,
        "filetype": "xlsx",
        "outputtype": "pdf",
        "key": key,
        "title": "poc.xlsx",
        "url": file_url,
        "spreadsheetLayout": layout(mode),
    }
    r = requests.post(f"{ds}/converter", json=body,
                      headers={"Accept": "application/json"}, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    if data.get("error"):
        raise RuntimeError(f"converter error code={data['error']} (body={data})")
    if not data.get("endConvert"):
        raise RuntimeError(f"async not finished: {data}")
    pdf_url = data["fileUrl"]
    # fileUrl 호스트가 컨테이너 내부 주소일 수 있어 localhost:8080 로 치환
    from urllib.parse import urlparse
    u = urlparse(pdf_url)
    local_url = f"{ds}{u.path}" + (f"?{u.query}" if u.query else "")
    for cand in (pdf_url, local_url):
        try:
            pr = requests.get(cand, timeout=timeout)
            if pr.ok and pr.content[:4] == b"%PDF":
                return pr.content
        except Exception:
            continue
    raise RuntimeError(f"PDF 다운로드 실패 url={pdf_url} / {local_url}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--mode", choices=["a1", "a2"], default="a2")
    ap.add_argument("--dpi", type=int, default=220)
    ap.add_argument("--out", default=None)
    ap.add_argument("--ds", default="http://localhost:8080")
    args = ap.parse_args()

    xlsx = Path(args.xlsx).resolve()
    assert xlsx.exists(), xlsx
    out = Path(args.out) if args.out else Path("/tmp/poc_out") / xlsx.stem
    out.mkdir(parents=True, exist_ok=True)

    sheets = visible_sheets(xlsx)
    print(f"[poc] file={xlsx.name}  visible sheets={len(sheets)}  mode={args.mode} dpi={args.dpi}")
    print(f"[poc] sheets: {sheets}")

    # HTTP 호스팅 (컨테이너가 fetch)
    serve_root = Path("/tmp/poc_serve"); serve_root.mkdir(exist_ok=True)
    served = serve_root / "poc.xlsx"
    shutil.copyfile(xlsx, served)
    port = free_port()
    httpd = serve_dir(serve_root, port)
    gw = host_gateway_ip()
    file_url = f"http://{gw}:{port}/poc.xlsx"
    print(f"[poc] hosting {file_url}  (gateway={gw} port={port})")

    try:
        t0 = time.time()
        pdf = convert(args.ds, file_url, args.mode)
        dt = time.time() - t0
        (out / "out.pdf").write_bytes(pdf)
        doc = fitz.open(stream=pdf, filetype="pdf")
        npages = doc.page_count
        print(f"[poc] converted in {dt:.1f}s  PDF pages={npages}  (visible sheets={len(sheets)})")
        match = "✅ 1:1" if npages == len(sheets) else f"⚠️ MISMATCH ({npages} pages vs {len(sheets)} sheets)"
        print(f"[poc] page<->sheet: {match}")

        summary = {"file": xlsx.name, "mode": args.mode, "dpi": args.dpi,
                   "visible_sheets": len(sheets), "pdf_pages": npages,
                   "convert_sec": round(dt, 1), "pages": []}
        for i, page in enumerate(doc):
            # 콘텐츠 bbox (텍스트+드로잉+이미지 합집합) 만 클립 렌더 → 거대 캔버스 회피, 자연 배율 유지
            cb = fitz.Rect()
            for b in page.get_text("dict")["blocks"]:
                cb |= fitz.Rect(b["bbox"])
            for dr in page.get_drawings():
                cb |= dr["rect"]
            try:
                for img in page.get_image_info():
                    cb |= fitz.Rect(img["bbox"])
            except Exception:
                pass
            blank = cb.is_empty
            if blank:
                cb = fitz.Rect(0, 0, 200, 200)
            else:
                pad = 4
                cb = fitz.Rect(cb.x0 - pad, cb.y0 - pad, cb.x1 + pad, cb.y1 + pad) & page.rect
            pix = page.get_pixmap(dpi=args.dpi, clip=cb)
            name = f"page{i:02d}.png"
            pix.save(str(out / name))
            sheet = sheets[i] if i < len(sheets) else f"(page{i})"
            info = {"page": i, "sheet": sheet, "content_w_pt": round(cb.width, 1),
                    "content_h_pt": round(cb.height, 1), "px_w": pix.width, "px_h": pix.height,
                    "blank": blank, "png": name}
            summary["pages"].append(info)
            print(f"   page{i:02d} sheet='{sheet}'  content {cb.width:.0f}x{cb.height:.0f}pt  "
                  f"{pix.width}x{pix.height}px{' [BLANK]' if blank else ''} -> {name}")
        (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        print(f"[poc] done. out={out}")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
