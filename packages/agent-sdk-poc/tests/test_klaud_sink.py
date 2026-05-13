"""
test_klaud_sink.py — Klaud 통합 로그 sink + 제보 endpoint 단위 검증
====================================================================
새 SQLite store + 6개 /klaud/* endpoint + admin token 게이트 + retention 묶기.

실행:
    .venv/bin/python tests/test_klaud_sink.py

검증 항목:
- klaud_sink.init() 멱등 (재호출 안전)
- POST /klaud/log/batch — 정상 batch + 잘못된 entry skip + queue → SQLite flush
- POST /klaud/report — report_id uuid 반환 + screenshot 별도 column
- GET /klaud/logs — token 없으면 503, 잘못된 token 401, 정상 200 + 필터
- GET /klaud/reports + /klaud/reports/{id} — 묶인 로그 window 동작
- KlaudSinkHandler 가 logging.getLogger().error(...) 적재
- log_event() mirror — source='agent' 로 들어가는지
- retention — 30일 이전 row 삭제
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

# admin token 을 테스트 전에 미리 set — server 가 import 시점에 읽을 수 있게
os.environ["KLAUD_ADMIN_TOKEN"] = "test-admin-token-xyz"

import klaud_sink  # noqa: E402

# 별도 임시 DB 경로 — production data 침범 방지
_TMP_DB = Path(tempfile.mkdtemp(prefix="klaud_sink_test_")) / "klaud_test.db"

# server import 전에 init 이 production path 로 가지 않도록 미리 patch
_orig_init = klaud_sink.init


def _test_init(db_path=None):
    # 인자 무시하고 항상 임시 DB 사용 (server.py startup hook 이 인자 없이 호출)
    _orig_init(db_path=_TMP_DB)


klaud_sink.init = _test_init  # type: ignore

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, cond, detail))
    icon = PASS if cond else FAIL
    print(f"  {icon} {name}" + (f" — {detail}" if detail and not cond else ""))


def _flush_wait(timeout: float = 3.0) -> None:
    """writer thread 가 큐를 drain 할 시간 — polling."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if klaud_sink._LOG_QUEUE.qsize() == 0:
            time.sleep(0.2)  # writer 가 마지막 batch 처리할 시간
            return
        time.sleep(0.1)


def _new_client() -> TestClient:
    """TestClient — FastAPI startup hook 자동 실행."""
    return TestClient(server.app)


# ─────────────────────────────────────────────────────────────────────────────
# 1. klaud_sink.init() 멱등
# ─────────────────────────────────────────────────────────────────────────────

def test_init_idempotent():
    print("\n[1] klaud_sink.init() 멱등")
    with _new_client() as client:
        check("startup → init 성공 (DB 파일 생성)", _TMP_DB.exists())
        # 재호출 안전
        klaud_sink.init(db_path=_TMP_DB)
        check("init() 재호출 no-op", True)

        s = klaud_sink.stats()
        check("stats() initialized=True", s.get("initialized") is True, str(s))
        check("stats() db_path 매칭", Path(s["db_path"]) == _TMP_DB)


# ─────────────────────────────────────────────────────────────────────────────
# 2. POST /klaud/log/batch
# ─────────────────────────────────────────────────────────────────────────────

def test_log_batch():
    print("\n[2] POST /klaud/log/batch")
    with _new_client() as client:
        payload = {
            "machine_id": "machine-test-1",
            "user_email": "tester@example.com",
            "klaud_version": "0.5.42",
            "session_id": "sess-1",
            "entries": [
                {"ts": "2026-05-13T02:30:00Z", "source": "renderer", "level": "error",
                 "message": "Cannot read property foo of undefined",
                 "extra": {"tab_id": "t1", "mode": "review"}},
                {"ts": "2026-05-13T02:30:01Z", "source": "main", "level": "warn",
                 "message": "Slow IPC: ipc.invoke took 1500ms"},
                {"ts": "2026-05-13T02:30:02Z", "source": "sidecar", "level": "info",
                 "message": "sidecar started, port=3502"},
                # 잘못된 entry 들 — silent drop
                {"ts": "x", "source": "INVALID", "message": "should drop"},
                {"ts": "x", "source": "renderer"},  # message 없음 → drop
            ],
        }
        r = client.post("/klaud/log/batch", json=payload)
        check("/klaud/log/batch 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
        check("accepted == 3 (잘못된 2건 skip)", r.json().get("accepted") == 3, str(r.json()))

        _flush_wait()

        # SQLite 에 실제 row 들어갔는지 직접 확인
        with sqlite3.connect(str(_TMP_DB)) as c:
            rows = c.execute(
                "SELECT source, level, message, machine_id, user_email, extra_json "
                "FROM klaud_logs WHERE machine_id = ? ORDER BY id ASC",
                ("machine-test-1",),
            ).fetchall()
        check("SQLite 에 3건 적재", len(rows) == 3, f"rows={len(rows)}")
        check("renderer/error 첫 row", rows[0][:3] == ("renderer", "error", "Cannot read property foo of undefined"))
        check("extra_json 직렬화", json.loads(rows[0][5])["tab_id"] == "t1")
        check("user_email 적재", all(r[4] == "tester@example.com" for r in rows))


def test_log_batch_oversize():
    print("\n[2-b] POST /klaud/log/batch — 1000개 초과 거부")
    with _new_client() as client:
        payload = {
            "machine_id": "m",
            "entries": [{"ts": "2026-05-13T02:30:00Z", "source": "renderer", "level": "info", "message": "x"} for _ in range(1001)],
        }
        r = client.post("/klaud/log/batch", json=payload)
        check("1001건 → 413", r.status_code == 413, f"status={r.status_code}")


# ─────────────────────────────────────────────────────────────────────────────
# 3. POST /klaud/report
# ─────────────────────────────────────────────────────────────────────────────

def test_report():
    print("\n[3] POST /klaud/report")
    with _new_client() as client:
        # 제보 전에 일부 로그 미리 깔아둠 (직전 N분 묶기 검증용)
        log_payload = {
            "machine_id": "machine-report-test",
            "user_email": "rt@example.com",
            "session_id": "sess-report-1",
            "entries": [
                {"ts": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
                 "source": "renderer", "level": "error", "message": "preceding-error-A"},
                {"ts": (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat(),
                 "source": "main", "level": "warn", "message": "preceding-warn-B"},
                # 30분 전 — 묶기 window(10분) 밖
                {"ts": (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat(),
                 "source": "renderer", "level": "info", "message": "old-info-out-of-window"},
            ],
        }
        client.post("/klaud/log/batch", json=log_payload)
        _flush_wait()

        # 제보
        report_payload = {
            "machine_id": "machine-report-test",
            "user_email": "rt@example.com",
            "klaud_version": "0.5.42",
            "session_id": "sess-report-1",
            "ts": datetime.now(timezone.utc).isoformat(),
            "note": "리뷰 모드에서 결과 카드가 비어있음",
            "context": {
                "active_tab": {"id": "t1", "kind": "confluence", "title": "PK_HUD 시스템"},
                "split_mode": "review",
                "url": "https://example.atlassian.net/wiki/spaces/X/pages/123",
                "screenshot_b64": "ZmFrZS1zY3JlZW5zaG90LWRhdGE=",  # base64-fake
            },
        }
        r = client.post("/klaud/report", json=report_payload)
        check("/klaud/report 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
        report_id = r.json().get("report_id")
        check("report_id uuid 반환", bool(report_id) and len(report_id) == 36)

        # 직접 SQLite 검사 — screenshot 이 별도 column
        with sqlite3.connect(str(_TMP_DB)) as c:
            row = c.execute(
                "SELECT note, context_json, screenshot_b64, machine_id FROM klaud_reports "
                "WHERE report_uuid = ?",
                (report_id,),
            ).fetchone()
        check("report DB row 존재", row is not None)
        check("note 적재", row[0] == "리뷰 모드에서 결과 카드가 비어있음")
        ctx = json.loads(row[1])
        check("context.split_mode='review'", ctx.get("split_mode") == "review")
        check("context_json 에 screenshot_b64 없음 (별도 분리)", "screenshot_b64" not in ctx)
        check("screenshot_b64 column 적재", row[2] == "ZmFrZS1zY3JlZW5zaG90LWRhdGE=")

        # report 의 묶인 로그 — admin GET 으로 검증
        rh = client.get(
            f"/klaud/reports/{report_id}",
            headers={"Authorization": "Bearer test-admin-token-xyz"},
        )
        check("GET /klaud/reports/{id} 200 (admin)", rh.status_code == 200)
        bundle = rh.json()
        msgs = [l["message"] for l in bundle.get("logs", [])]
        check("묶기 window — 직전 5분 'preceding-error-A' 포함", "preceding-error-A" in msgs)
        check("묶기 window — 직전 3분 'preceding-warn-B' 포함", "preceding-warn-B" in msgs)
        check("묶기 window — 30분 전 로그는 제외", "old-info-out-of-window" not in msgs)
        check("bundle.report.note 함께 반환", bundle["report"]["note"] == report_payload["note"])


# ─────────────────────────────────────────────────────────────────────────────
# 4. GET /klaud/logs admin 인증
# ─────────────────────────────────────────────────────────────────────────────

def test_admin_auth():
    print("\n[4] GET /klaud/logs 관리자 인증")
    with _new_client() as client:
        # 1) header 없음 → 401
        r = client.get("/klaud/logs")
        check("Authorization 없음 → 401", r.status_code == 401, f"status={r.status_code}")

        # 2) 잘못된 token → 401
        r = client.get("/klaud/logs", headers={"Authorization": "Bearer wrong"})
        check("틀린 token → 401", r.status_code == 401)

        # 3) Basic auth → 401
        r = client.get("/klaud/logs", headers={"Authorization": "Basic Zm9vOmJhcg=="})
        check("Bearer 아닌 scheme → 401", r.status_code == 401)

        # 4) 올바른 token → 200
        r = client.get("/klaud/logs", headers={"Authorization": "Bearer test-admin-token-xyz"})
        check("올바른 token → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")

    # 5) env 없으면 503 — 별도 ENV pop 시나리오
    saved = os.environ.pop("KLAUD_ADMIN_TOKEN", None)
    try:
        with _new_client() as client:
            r = client.get("/klaud/logs", headers={"Authorization": "Bearer anything"})
            check("env 미설정 → 503", r.status_code == 503, f"status={r.status_code}")
    finally:
        if saved:
            os.environ["KLAUD_ADMIN_TOKEN"] = saved


# ─────────────────────────────────────────────────────────────────────────────
# 5. GET /klaud/logs 필터링
# ─────────────────────────────────────────────────────────────────────────────

def test_logs_filter():
    print("\n[5] GET /klaud/logs 필터 (user/level/source)")
    headers = {"Authorization": "Bearer test-admin-token-xyz"}
    with _new_client() as client:
        # user_email 필터
        r = client.get("/klaud/logs?user_email=tester@example.com", headers=headers)
        check("user_email 필터 200", r.status_code == 200)
        logs = r.json()["logs"]
        check("user_email 필터 적용", all(l["user_email"] == "tester@example.com" for l in logs))

        # level=error 필터
        r = client.get("/klaud/logs?level=error", headers=headers)
        check("level=error 필터", all(l["level"] == "error" for l in r.json()["logs"]))

        # source=renderer 필터
        r = client.get("/klaud/logs?source=renderer", headers=headers)
        check("source=renderer 필터", all(l["source"] == "renderer" for l in r.json()["logs"]))


# ─────────────────────────────────────────────────────────────────────────────
# 6. KlaudSinkHandler — agent 자체 logging 적재
# ─────────────────────────────────────────────────────────────────────────────

def test_handler_self_logging():
    print("\n[6] KlaudSinkHandler — agent 자체 logging 적재")
    import logging
    with _new_client() as client:
        # log_event() mirror (server.py 의 mirror)
        from server import log_event
        log_event("sess-handler-test", "test_event", "self-test detail XYZ")
        # 직접 logger 호출
        logging.getLogger("test.handler").error("direct-logger-error-ABC")

        _flush_wait()

        with sqlite3.connect(str(_TMP_DB)) as c:
            rows = c.execute(
                "SELECT message FROM klaud_logs WHERE source='agent' AND "
                "(message LIKE '%self-test detail XYZ%' OR message LIKE '%direct-logger-error-ABC%')"
            ).fetchall()
        msgs = [r[0] for r in rows]
        check("log_event() mirror 적재", any("self-test detail XYZ" in m for m in msgs))
        check("logging.error → handler 적재", any("direct-logger-error-ABC" in m for m in msgs))


# ─────────────────────────────────────────────────────────────────────────────
# 7. retention — 30일 이전 row 삭제
# ─────────────────────────────────────────────────────────────────────────────

def test_retention():
    print("\n[7] retention — 30일 이전 row 삭제")
    # 직접 SQLite 에 31일 전 row insert 후 _retention_cleanup() 호출
    very_old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    klaud_sink._WRITE_CONN.execute(
        "INSERT INTO klaud_logs (ts, ingest_ts, source, level, message) VALUES (?, ?, ?, ?, ?)",
        (very_old, very_old, "agent", "info", "very-old-log-marker-DELETEME"),
    )
    # 확인
    n_before = klaud_sink._WRITE_CONN.execute(
        "SELECT COUNT(*) FROM klaud_logs WHERE message = 'very-old-log-marker-DELETEME'"
    ).fetchone()[0]
    check("retention 전 row 존재", n_before == 1)

    klaud_sink._retention_cleanup()

    n_after = klaud_sink._WRITE_CONN.execute(
        "SELECT COUNT(*) FROM klaud_logs WHERE message = 'very-old-log-marker-DELETEME'"
    ).fetchone()[0]
    check("retention 후 row 삭제", n_after == 0)


# ─────────────────────────────────────────────────────────────────────────────

def main():
    test_init_idempotent()
    test_log_batch()
    test_log_batch_oversize()
    test_report()
    test_admin_auth()
    test_logs_filter()
    test_handler_self_logging()
    test_retention()

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = total - passed
    print(f"\n{'═' * 60}")
    print(f"  Total: {total} | Pass: {passed} | Fail: {failed}")
    print(f"  DB: {_TMP_DB}  (테스트 후 임시 디렉토리에 남음)")
    if failed:
        print(f"\n  실패 항목:")
        for name, ok, detail in results:
            if not ok:
                print(f"    {FAIL} {name}" + (f"\n        {detail}" if detail else ""))
        sys.exit(1)
    print(f"  {PASS} 모두 통과")


if __name__ == "__main__":
    main()
