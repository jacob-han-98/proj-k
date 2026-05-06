"""Watch HEAD probe progression for a single file.

Polls debug-probe server at fixed interval and logs each result with timestamp.
Used to capture transition: local write -> OneDrive Sync upload -> SP cloud ready.
"""

import json
import sys
import time
import urllib.request
from datetime import datetime

PROBE_URL = "http://127.0.0.1:8770/head-probe"


def probe(rel_path: str) -> dict:
    payload = {"relPaths": [rel_path]}
    req = urllib.request.Request(
        PROBE_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=10).read())[0]


def main() -> None:
    rel_path = sys.argv[1] if len(sys.argv) > 1 else "7_System/PK_몬스터 사망 랙돌 시스템"
    duration_s = int(sys.argv[2]) if len(sys.argv) > 2 else 90
    interval_s = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5

    print(f"watch: {rel_path}  for {duration_s}s every {interval_s}s")
    print(f"{'t(s)':>6} {'head':>4} {'CL':>12} {'rng':>4} {'zip':>3} {'ms':>5}  bytes  loc")
    print("-" * 100)

    t0 = time.time()
    last_state = None
    while time.time() - t0 < duration_s:
        try:
            r = probe(rel_path)
            elapsed = time.time() - t0
            state = (r.get("headStatus"), r.get("headContentLength"), r.get("isZipMagic"))
            head = str(r.get("headStatus") or "-")
            cl = str(r.get("headContentLength") if r.get("headContentLength") is not None else "-")
            rng = str(r.get("rangeStatus") or "-")
            zip_ok = ("Y" if r.get("isZipMagic") else "N") if r.get("isZipMagic") is not None else "-"
            ms = str(r.get("elapsedMs") or "-")
            zb = (r.get("zipBytes") or "")[:14]
            loc = (r.get("headRedirectLocation") or "")[:30]
            err = r.get("error", "")
            mark = " *" if state != last_state else ""
            print(
                f"{elapsed:>6.1f} {head:>4} {cl:>12} {rng:>4} {zip_ok:>3} {ms:>5}  {zb:<14}  {loc} {err}{mark}",
                flush=True,
            )
            last_state = state
        except Exception as e:
            elapsed = time.time() - t0
            print(f"{elapsed:>6.1f} ERR: {e}", flush=True)
        time.sleep(interval_s)


if __name__ == "__main__":
    main()
