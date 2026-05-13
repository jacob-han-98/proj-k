"""
test_google_sso.py — 릴리스-B Google Workspace SSO 단위 검증
=============================================================
google_id_token.verify() 를 monkey-patch 해서 Google JWKS 호출 없이 검증 흐름만 테스트.

실행:
    .venv/bin/python tests/test_google_sso.py

검증 항목:
- google_id_token.verify() — env 미설정 → skip + counter
- ingest 의 _resolve_user_email — id_token 성공/실패/미포함 케이스
- /klaud/log/batch + /klaud/report 의 user_email 덮어쓰기 (verify 성공/실패)
- _require_admin() dual auth — 기존 token / id_token+whitelist / 둘 다 실패
- /klaud/stats 의 SSO 통계 노출
- env 미설정 시 운영 안전 503
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

# 테스트 전 환경 변수 셋업 (server.py import 전)
os.environ["KLAUD_ADMIN_TOKEN"] = "test-admin-token-static"
os.environ["KLAUD_GOOGLE_CLIENT_ID"] = "fake.apps.googleusercontent.com"
os.environ["KLAUD_GOOGLE_WORKSPACE_DOMAIN"] = "bighitcorp.com"
os.environ["KLAUD_ADMIN_EMAILS"] = "admin@bighitcorp.com,jaekap.han@bighitcorp.com"

import klaud_sink  # noqa: E402
import google_id_token  # noqa: E402

_TMP_DB = Path(tempfile.mkdtemp(prefix="klaud_sso_test_")) / "klaud.db"
_orig_init = klaud_sink.init


def _test_init(db_path=None):
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


def _new_client():
    return TestClient(server.app)


# ── monkey-patch helpers ─────────────────────────────────────────────────────

_verify_calls: list[str] = []
_verify_responses: dict[str, dict | None] = {}


def _fake_verify(token_str: str):
    """google_id_token.verify 의 fake — _verify_responses 로 결과 컨트롤.

    카운터도 직접 증가 (실제 verify 의 counter 흐름 simulate).
    """
    _verify_calls.append(token_str)
    res = _verify_responses.get(token_str)
    if res is None:
        with google_id_token._counter_lock:
            google_id_token._verify_fail_count += 1
        return None
    with google_id_token._counter_lock:
        google_id_token._verify_success_count += 1
    return res


def _install_fake_verify():
    google_id_token.verify = _fake_verify  # type: ignore
    google_id_token.reset_counters()
    _verify_calls.clear()
    _verify_responses.clear()


_orig_verify = google_id_token.verify


def _restore_verify():
    google_id_token.verify = _orig_verify  # type: ignore


# ── 1. google_id_token 모듈 자체 ──────────────────────────────────────────────


def test_module_helpers():
    print("\n[1] google_id_token 모듈 helpers")
    _restore_verify()  # 진짜 verify 함수 사용 (env 검사)
    check("sso_enabled() == True (env 있음)", google_id_token.sso_enabled() is True)
    check("client_id()", google_id_token.client_id() == "fake.apps.googleusercontent.com")
    check("workspace_domain()", google_id_token.workspace_domain() == "bighitcorp.com")
    emails = google_id_token.admin_emails()
    check(
        "admin_emails() 콤마 split + 소문자",
        emails == {"admin@bighitcorp.com", "jaekap.han@bighitcorp.com"},
        f"got={emails}",
    )
    check("is_admin_email — 등록된 email", google_id_token.is_admin_email("admin@bighitcorp.com") is True)
    check("is_admin_email — case-insensitive", google_id_token.is_admin_email("ADMIN@bighitcorp.com") is True)
    check("is_admin_email — 미등록", google_id_token.is_admin_email("other@example.com") is False)
    check("is_admin_email(None)", google_id_token.is_admin_email(None) is False)

    # env 미설정 시 sso_enabled=False
    saved_cid = os.environ.pop("KLAUD_GOOGLE_CLIENT_ID")
    try:
        check("env 미설정 → sso_enabled=False", google_id_token.sso_enabled() is False)
        google_id_token.reset_counters()
        out = google_id_token.verify("any-token")
        check("env 미설정 → verify=None + skip_count 증가", out is None)
        check("verify_skip_count 1", google_id_token.stats()["verify_skip_count"] == 1)
    finally:
        os.environ["KLAUD_GOOGLE_CLIENT_ID"] = saved_cid


# ── 2. _resolve_user_email (ingest 분기 핵심) ─────────────────────────────────


def test_resolve_user_email():
    print("\n[2] _resolve_user_email (ingest path)")
    _install_fake_verify()

    # case A: id_token 미포함 → claimed_email 그대로
    out = server._resolve_user_email(None, "frontend@example.com")
    check("id_token 미포함 → claimed_email 그대로", out == "frontend@example.com")
    check("verify 호출 0", len(_verify_calls) == 0)

    # case B: id_token + verify 성공 → claims.email
    _verify_responses["good-token"] = {"email": "verified@bighitcorp.com", "email_verified": True}
    out = server._resolve_user_email("good-token", "wrong@evil.com")
    check("verify 성공 → claims.email 로 덮어쓰기", out == "verified@bighitcorp.com")
    check("verify 호출 1", len(_verify_calls) == 1)

    # case C: id_token + verify 실패 → None (silent fallback)
    _verify_responses["bad-token"] = None  # fake_verify 가 None 반환
    out = server._resolve_user_email("bad-token", "client-claimed@example.com")
    check("verify 실패 → user_email=None (silent)", out is None)

    # case D: SSO 비활성 시 id_token 무시
    saved_cid = os.environ.pop("KLAUD_GOOGLE_CLIENT_ID")
    try:
        out = server._resolve_user_email("good-token", "frontend@example.com")
        check("SSO 비활성 → id_token 무시 + claimed 사용", out == "frontend@example.com")
    finally:
        os.environ["KLAUD_GOOGLE_CLIENT_ID"] = saved_cid


# ── 3. POST /klaud/log/batch — id_token 덮어쓰기 ──────────────────────────────


def test_batch_overwrite():
    print("\n[3] POST /klaud/log/batch — id_token verify 후 user_email 덮어쓰기")
    _install_fake_verify()
    _verify_responses["good-token"] = {"email": "verified@bighitcorp.com", "email_verified": True}
    _verify_responses["bad-token"] = None

    with _new_client() as client:
        # 1) verify 성공 → frontend 가 보낸 user_email 무시, claims.email 로 적재
        r = client.post(
            "/klaud/log/batch",
            json={
                "machine_id": "m-1",
                "user_email": "evil-impersonator@example.com",
                "id_token": "good-token",
                "session_id": "s-1",
                "entries": [
                    {"ts": "2026-05-13T07:00:00Z", "source": "renderer", "level": "info", "message": "batch-good-1"},
                ],
            },
        )
        check("verify 성공 batch 200", r.status_code == 200)

        # 2) verify 실패 → user_email=null
        r = client.post(
            "/klaud/log/batch",
            json={
                "machine_id": "m-1",
                "user_email": "spoof@example.com",
                "id_token": "bad-token",
                "session_id": "s-1",
                "entries": [
                    {"ts": "2026-05-13T07:00:01Z", "source": "renderer", "level": "info", "message": "batch-bad-1"},
                ],
            },
        )
        check("verify 실패 batch 200 (silent)", r.status_code == 200)

        # 3) id_token 미포함 → frontend 가 보낸 user_email 그대로
        r = client.post(
            "/klaud/log/batch",
            json={
                "machine_id": "m-1",
                "user_email": "anonymous@example.com",
                "session_id": "s-1",
                "entries": [
                    {"ts": "2026-05-13T07:00:02Z", "source": "renderer", "level": "info", "message": "batch-noidtok-1"},
                ],
            },
        )
        check("id_token 미포함 batch 200", r.status_code == 200)

        # writer thread flush 대기
        import time as _t
        deadline = _t.time() + 3.0
        while _t.time() < deadline:
            if klaud_sink._LOG_QUEUE.qsize() == 0:
                _t.sleep(0.3)
                break
            _t.sleep(0.1)

        # SQLite 직접 검증
        import sqlite3 as _sql
        with _sql.connect(str(_TMP_DB)) as c:
            rows = c.execute(
                "SELECT message, user_email FROM klaud_logs WHERE message LIKE 'batch-%' ORDER BY id"
            ).fetchall()
        msg_to_email = dict(rows)
        check(
            "batch-good-1 user_email == verified@bighitcorp.com (덮어쓰기)",
            msg_to_email.get("batch-good-1") == "verified@bighitcorp.com",
            f"got={msg_to_email.get('batch-good-1')}",
        )
        check(
            "batch-bad-1 user_email == None (verify 실패 silent fallback)",
            msg_to_email.get("batch-bad-1") is None,
            f"got={msg_to_email.get('batch-bad-1')}",
        )
        check(
            "batch-noidtok-1 user_email == anonymous@example.com (id_token 없을 때 trust)",
            msg_to_email.get("batch-noidtok-1") == "anonymous@example.com",
            f"got={msg_to_email.get('batch-noidtok-1')}",
        )


# ── 4. POST /klaud/report — id_token 덮어쓰기 ────────────────────────────────


def test_report_overwrite():
    print("\n[4] POST /klaud/report — id_token 덮어쓰기")
    _install_fake_verify()
    _verify_responses["good-token"] = {"email": "verified@bighitcorp.com", "email_verified": True}

    with _new_client() as client:
        r = client.post(
            "/klaud/report",
            json={
                "machine_id": "m-r-1",
                "user_email": "evil@example.com",
                "id_token": "good-token",
                "session_id": "s-r-1",
                "ts": "2026-05-13T07:10:00Z",
                "note": "report with sso",
            },
        )
        check("report 200", r.status_code == 200)
        report_id = r.json()["report_id"]

        import sqlite3 as _sql
        with _sql.connect(str(_TMP_DB)) as c:
            row = c.execute(
                "SELECT user_email, note FROM klaud_reports WHERE report_uuid = ?",
                (report_id,),
            ).fetchone()
        check(
            "report user_email 덮어쓰기",
            row[0] == "verified@bighitcorp.com",
            f"got={row[0]}",
        )


# ── 5. GET dual auth ─────────────────────────────────────────────────────────


def test_dual_auth():
    print("\n[5] GET /klaud/logs dual auth (token / id_token+whitelist)")
    _install_fake_verify()
    _verify_responses["admin-id-token"] = {"email": "admin@bighitcorp.com", "email_verified": True}
    _verify_responses["non-admin-token"] = {"email": "stranger@bighitcorp.com", "email_verified": True}

    with _new_client() as client:
        # 1) 기존 admin token 경로
        r = client.get("/klaud/logs", headers={"Authorization": "Bearer test-admin-token-static"})
        check("기존 admin token → 200", r.status_code == 200, f"status={r.status_code}")

        # 2) id_token + email-in-whitelist
        r = client.get("/klaud/logs", headers={"Authorization": "Bearer admin-id-token"})
        check("id_token + whitelist email → 200", r.status_code == 200, f"status={r.status_code}")

        # 3) id_token + email NOT in whitelist
        r = client.get("/klaud/logs", headers={"Authorization": "Bearer non-admin-token"})
        check("id_token + non-whitelist email → 401", r.status_code == 401)

        # 4) 잘못된 token
        r = client.get("/klaud/logs", headers={"Authorization": "Bearer total-garbage"})
        check("garbage token → 401", r.status_code == 401)

        # 5) Bearer 없음
        r = client.get("/klaud/logs")
        check("no auth → 401", r.status_code == 401)


# ── 6. env 양쪽 미설정 시 503 ─────────────────────────────────────────────────


def test_both_env_missing():
    print("\n[6] env 양쪽 미설정 시 503")
    _install_fake_verify()
    saved_token = os.environ.pop("KLAUD_ADMIN_TOKEN", None)
    saved_cid = os.environ.pop("KLAUD_GOOGLE_CLIENT_ID", None)
    try:
        with _new_client() as client:
            r = client.get("/klaud/logs", headers={"Authorization": "Bearer anything"})
            check(
                "둘 다 미설정 → 503",
                r.status_code == 503 and "KLAUD_ADMIN_TOKEN" in r.json().get("detail", ""),
                f"status={r.status_code} body={r.text[:200]}",
            )
    finally:
        if saved_token:
            os.environ["KLAUD_ADMIN_TOKEN"] = saved_token
        if saved_cid:
            os.environ["KLAUD_GOOGLE_CLIENT_ID"] = saved_cid


# ── 7. /klaud/stats SSO 통계 노출 ─────────────────────────────────────────────


def test_stats_includes_sso():
    print("\n[7] /klaud/stats SSO 섹션 노출")
    _install_fake_verify()
    _verify_responses["good"] = {"email": "verified@bighitcorp.com", "email_verified": True}
    # 일부러 호출 — counter 누적
    google_id_token.reset_counters()
    google_id_token.verify("good")
    google_id_token.verify("bad")  # _verify_responses 에 없음 → fail
    google_id_token.verify("good")

    with _new_client() as client:
        r = client.get("/klaud/stats", headers={"Authorization": "Bearer test-admin-token-static"})
        check("/klaud/stats 200", r.status_code == 200)
        data = r.json()
        check("stats 에 sso 섹션", "sso" in data, f"keys={list(data.keys())}")
        sso = data.get("sso", {})
        check("sso.sso_enabled True", sso.get("sso_enabled") is True)
        check("verify_success_count 2", sso.get("verify_success_count") == 2)
        check("verify_fail_count 1", sso.get("verify_fail_count") == 1)
        check("admin_email_count 2", sso.get("admin_email_count") == 2)


# ── main ─────────────────────────────────────────────────────────────────────


def main():
    test_module_helpers()
    test_resolve_user_email()
    test_batch_overwrite()
    test_report_overwrite()
    test_dual_auth()
    test_both_env_missing()
    test_stats_includes_sso()

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = total - passed
    print(f"\n{'═' * 60}")
    print(f"  Total: {total} | Pass: {passed} | Fail: {failed}")
    print(f"  DB: {_TMP_DB}  (테스트 후 임시 디렉토리에 남음)")
    if failed:
        print("\n  실패 항목:")
        for name, ok, detail in results:
            if not ok:
                print(f"    {FAIL} {name}" + (f"\n        {detail}" if detail else ""))
        sys.exit(1)
    print(f"  {PASS} 모두 통과")


if __name__ == "__main__":
    main()
