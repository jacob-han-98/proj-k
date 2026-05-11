"""
OnlyOffice viewer host: serve a single XLSX + embed HTML page.

Used both for PoC verification and by Klaud main process (spawned via WSL).

Usage:
    python3 serve.py <xlsx-path> [--port 9000] [--onlyoffice-url http://...:8080] [--title "..."]

Env fallbacks (when CLI flag absent):
    PROJK_ONLYOFFICE_FILE_PORT     default 9000
    PROJK_ONLYOFFICE_URL           default http://<wsl-ip>:8080
    PROJK_ONLYOFFICE_TITLE         default <basename>
    PROJK_ONLYOFFICE_SHEET         default ""  (passed to DocsAPI as activeCell)
"""
import argparse
import http.server
import socketserver
import sys
import os
import shutil
import time
import html
import json
import subprocess
from pathlib import Path

DEFAULT_PORT = 9000
DEFAULT_OO_PORT = 8080


def get_wsl_ip() -> str:
    out = subprocess.check_output(["hostname", "-I"], text=True).strip()
    return out.split()[0]


def main(src_arg: str, port: int, onlyoffice_url: str, title: str, sheet: str) -> None:
    src = Path(src_arg).resolve()
    if not src.exists():
        print(f"ERROR: file not found: {src}", file=sys.stderr)
        sys.exit(2)
    if src.suffix.lower() not in (".xlsx", ".xlsm", ".xls"):
        print(f"WARN: unexpected extension: {src.suffix}", file=sys.stderr)

    serve_dir = Path("/tmp/projk-onlyoffice-poc")
    serve_dir.mkdir(exist_ok=True)
    safe_name = f"sample{src.suffix.lower()}"
    target = serve_dir / safe_name
    if target.exists():
        target.chmod(0o644)
        target.unlink()
    shutil.copyfile(src, target)
    target.chmod(0o644)

    wsl_ip = get_wsl_ip()
    file_url_for_container = f"http://host.docker.internal:{port}/{safe_name}"
    key = f"{safe_name}-{int(target.stat().st_mtime)}-{int(time.time())}"

    config = {
        "width": "100%",
        "height": "100%",
        "type": "desktop",
        "documentType": "cell",
        "document": {
            "fileType": src.suffix.lstrip(".").lower() or "xlsx",
            "key": key,
            "title": title or src.name,
            "url": file_url_for_container,
            "permissions": {"download": True, "edit": False, "print": True},
        },
        "editorConfig": {
            "mode": "view",
            "lang": "ko",
            "user": {
                "id": "poc-viewer",
                "name": "PoC Viewer",
            },
            "customization": {
                "autosave": False,
                "forcesave": False,
                "compactHeader": True,
                "toolbarNoTabs": False,
                "uiTheme": "default-light",
            },
        },
    }

    embed_html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>OnlyOffice PoC — {html.escape(src.name)}</title>
<style>html,body{{margin:0;padding:0;height:100%;width:100%;overflow:hidden}}#editor{{height:100vh;width:100vw}}</style>
<script src="{onlyoffice_url}/web-apps/apps/api/documents/api.js"></script>
</head>
<body>
<div id="editor"></div>
<script>
const config = {json.dumps(config, ensure_ascii=False)};
new DocsAPI.DocEditor("editor", config);
</script>
</body>
</html>
"""
    (serve_dir / "index.html").write_text(embed_html, encoding="utf-8")

    os.chdir(serve_dir)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):
            sys.stdout.write(f"[serve] {self.address_string()} - {fmt % args}\n")
            sys.stdout.flush()

        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            super().end_headers()

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", port), Handler) as httpd:
        print(f"=== OnlyOffice viewer server ready ===")
        print(f"  Browser URL : http://{wsl_ip}:{port}/")
        print(f"  Source file : {src} ({target.stat().st_size:,} bytes)")
        print(f"  Title       : {title or src.name}")
        print(f"  OnlyOffice  : {onlyoffice_url}")
        print(f"  Container fetches: {file_url_for_container}")
        print(f"  Doc key     : {key}")
        if sheet:
            print(f"  Sheet       : {sheet}")
        print(f"  Ctrl+C to stop")
        sys.stdout.flush()
        httpd.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OnlyOffice viewer host (single XLSX)")
    parser.add_argument("path", help="Path to the .xlsx file (WSL path)")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PROJK_ONLYOFFICE_FILE_PORT", DEFAULT_PORT)),
        help="HTTP port (default 9000 / env PROJK_ONLYOFFICE_FILE_PORT)",
    )
    parser.add_argument(
        "--onlyoffice-url",
        default=os.environ.get("PROJK_ONLYOFFICE_URL", ""),
        help="OnlyOffice DS endpoint (default env PROJK_ONLYOFFICE_URL or http://<wsl-ip>:8080)",
    )
    parser.add_argument(
        "--title",
        default=os.environ.get("PROJK_ONLYOFFICE_TITLE", ""),
        help="Display title shown in OnlyOffice header",
    )
    parser.add_argument(
        "--sheet",
        default=os.environ.get("PROJK_ONLYOFFICE_SHEET", ""),
        help="Sheet name to focus on open (best-effort via DocsAPI)",
    )
    args = parser.parse_args()

    oo_url = args.onlyoffice_url.strip() or f"http://{get_wsl_ip()}:{DEFAULT_OO_PORT}"
    main(args.path, port=args.port, onlyoffice_url=oo_url, title=args.title, sheet=args.sheet)
