#!/usr/bin/env python3
"""Local log server for Chrome Extension debugging.
Receives logs via HTTP POST and writes to extension.log file.

Usage: python3 log-server.py
Logs are written to: packages/chrome-extension/logs/extension.log
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
from pathlib import Path
from datetime import datetime

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "extension.log"
PORT = 19876
HOST = "0.0.0.0"  # Listen on all interfaces (WSL → Windows accessible)


class LogHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")

        try:
            msg = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, {"error": "Invalid JSON"})
            return

        action = msg.get("action", "log")

        if action == "log":
            self._write_log(msg)
            self._respond(200, {"status": "ok"})

        elif action == "log_batch":
            entries = msg.get("entries", [])
            for entry in entries:
                self._write_log(entry)
            self._respond(200, {"status": "ok", "count": len(entries)})

        else:
            self._respond(400, {"error": f"Unknown action: {action}"})

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _respond(self, code, data):
        self.send_response(code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _write_log(self, entry):
        ts = entry.get("ts", datetime.now().isoformat())
        level = entry.get("level", "info").upper()
        source = entry.get("source", "?")
        message = entry.get("message", "")
        data = entry.get("data", "")

        line = f"{ts} [{level}] [{source}] {message}"
        if data:
            line += f" | {data}"

        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")

        # Also print to console
        print(line)

    def log_message(self, format, *args):
        pass  # Suppress default HTTP logging


def main():
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n{'='*60}\n")
        f.write(f"Log server started at {datetime.now().isoformat()}\n")
        f.write(f"Listening on http://127.0.0.1:{PORT}\n")
        f.write(f"{'='*60}\n")

    print(f"PK Log Server running on http://127.0.0.1:{PORT}")
    print(f"Logs → {LOG_FILE}")

    server = HTTPServer((HOST, PORT), LogHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
