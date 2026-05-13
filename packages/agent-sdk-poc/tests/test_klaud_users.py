"""
test_klaud_users.py — 사용자 관리 endpoint 단위 검증 (2026-05-13)
====================================================================
admin 가 web UI 에서 사용자 등록/삭제/role 토글. id_token verify 성공 시 자동 upsert.
KLAUD_DEV_BYPASS_AUTH 로 개발 모드 인증 우회.

실행:
    .venv/bin/python tests/test_klaud_users.py

검증:
- klaud_sink: create / upsert / set_role / delete / list_with_stats
- /klaud/admin/users CRUD endpoints (auth 게이트 + 정상/오류)
- id_token verify → upsert_user 자동 호출 (display_name / picture 동기화)
- DB role='admin' 이면 _require_admin 통과
- KLAUD_DEV_BYPASS_AUTH=1 → 모든 auth 우회
- env whitelist + DB admin OR 합집합
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

os.environ["KLAUD_ADMIN_TOKEN"] = "test-admin-static"
os.environ["KLAUD_GOOGLE_CLIENT_ID"] = "fake.apps.googleusercontent.com"
os.environ["KLAUD_GOOGLE_WORKSPACE_DOMAIN"] = "hybecorp.com"
os.environ["KLAUD_ADMIN_EMAILS"] = "envadmin@hybecorp.com"
os.environ.pop("KLAUD_DEV_BYPASS_AUTH", None)

import klaud_sink  # noqa: E402
import google_id_token  # noqa: E402

_TMP_DB = Path(tempfile.mkdtemp(prefix="klaud_users_test_")) / "klaud.db"

_orig_sink_init = klaud_sink.init


def _test_sink_init(db_path=None):
    _orig_sink_init(db_path=_TMP_DB)


klaud_sink.init = _test_sink_init  # type: ignore

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, cond, detail))
    icon = PASS if cond else FAIL
    print(f"  {icon} {name}" + (f" — {detail}" if detail and not cond else ""))


def _client():
    return TestClient(server.app)


# verify 의 fake
_verify_responses: dict[str, dict | None] = {}
_orig_verify = google_id_token.verify


def _fake_verify(token_str: str):
    res = _verify_responses.get(token_str)
    if res is None:
        with google_id_token._counter_lock:
            google_id_token._verify_fail_count += 1
        return None
    with google_id_token._counter_lock:
        google_id_token._verify_success_count += 1
    return res


def _install_fake():
    google_id_token.verify = _fake_verify  # type: ignore
    google_id_token.reset_counters()
    _verify_responses.clear()


def _restore():
    google_id_token.verify = _orig_verify  # type: ignore


# ── 1. klaud_sink users CRUD ─────────────────────────────────────────────────


def test_users_crud():
    print("\n[1] klaud_sink users — upsert / create / set_role / delete / list")
    # TestClient context 한 번 진입해서 FastAPI startup hook (klaud_sink.init) 트리거
    with _client():
        pass
    # Fresh state — drop & recreate
    with klaud_sink._WRITER_LOCK:
        klaud_sink._WRITE_CONN.execute("DELETE FROM klaud_users")

    # upsert (auto from id_token verify)
    klaud_sink.upsert_user("alice@hybecorp.com", machine_id="m-1",
                            display_name="Alice", klaud_version="0.6.0")
    u = klaud_sink.get_user("alice@hybecorp.com")
    check("upsert 신규 — role=regular default", u is not None and u["role"] == "regular")
    check("upsert 신규 — display_name", u["display_name"] == "Alice")
    check("upsert 신규 — machine_ids 1개", u["machine_ids"] == ["m-1"])

    # upsert 동일 user 다른 machine — machine_ids 누적
    klaud_sink.upsert_user("alice@hybecorp.com", machine_id="m-2", display_name=None)
    u = klaud_sink.get_user("alice@hybecorp.com")
    check("upsert 누적 — machine_ids 2개", set(u["machine_ids"]) == {"m-1", "m-2"})
    check("upsert display_name 보존 (None 으로 덮지 X)", u["display_name"] == "Alice")

    # create (admin 미리 등록) — 미로그인 사용자
    ok = klaud_sink.create_user("bob@hybecorp.com", role="admin", note="DBA")
    check("create 신규 admin", ok is True)
    u = klaud_sink.get_user("bob@hybecorp.com")
    check("create 신규 — role=admin", u["role"] == "admin")
    check("create 신규 — note='DBA'", u["note"] == "DBA")
    check("create 신규 — last_seen=None (미로그인)", u["last_seen"] is None)

    # create duplicate → False
    ok = klaud_sink.create_user("bob@hybecorp.com", role="regular")
    check("create 중복 → False", ok is False)
    check("기존 role=admin 보존 (덮어쓰기 X)", klaud_sink.get_user("bob@hybecorp.com")["role"] == "admin")

    # set_role
    ok = klaud_sink.set_user_role("alice@hybecorp.com", "admin", note="승격")
    check("set_role admin → True", ok is True)
    u = klaud_sink.get_user("alice@hybecorp.com")
    check("set_role 적용", u["role"] == "admin" and u["note"] == "승격")

    ok = klaud_sink.set_user_role("nonexistent@hybecorp.com", "admin")
    check("set_role 미존재 → False", ok is False)

    # invalid role
    try:
        klaud_sink.set_user_role("alice@hybecorp.com", "invalid-role")
        check("set_role invalid → ValueError", False)
    except ValueError:
        check("set_role invalid → ValueError", True)

    # is_db_admin
    check("is_db_admin alice (admin)", klaud_sink.is_db_admin("alice@hybecorp.com") is True)
    check("is_db_admin bob (admin)", klaud_sink.is_db_admin("bob@hybecorp.com") is True)
    check("is_db_admin charlie (없음)", klaud_sink.is_db_admin("charlie@hybecorp.com") is False)
    check("is_db_admin None", klaud_sink.is_db_admin(None) is False)

    # disabled → NOT db_admin
    klaud_sink.set_user_role("bob@hybecorp.com", "disabled")
    check("disabled → is_db_admin False", klaud_sink.is_db_admin("bob@hybecorp.com") is False)
    klaud_sink.set_user_role("bob@hybecorp.com", "admin")  # restore

    # delete
    ok = klaud_sink.delete_user("alice@hybecorp.com")
    check("delete True", ok is True)
    check("delete 후 get_user None", klaud_sink.get_user("alice@hybecorp.com") is None)


# ── 2. id_token verify → upsert 자동 ─────────────────────────────────────────


def test_auto_upsert():
    print("\n[2] _resolve_user_email — id_token verify 성공 시 자동 upsert")
    _install_fake()
    _verify_responses["good-jenny"] = {
        "email": "jenny@hybecorp.com", "email_verified": True,
        "name": "Jenny Park", "picture": "https://example.com/j.png",
    }

    out = server._resolve_user_email(
        "good-jenny", claimed_email=None,
        machine_id="m-jenny-1", klaud_version="0.6.1",
    )
    check("verify 성공 → email 반환", out == "jenny@hybecorp.com")

    u = klaud_sink.get_user("jenny@hybecorp.com")
    check("자동 upsert — 사용자 row 존재", u is not None)
    check("display_name=Jenny Park", u["display_name"] == "Jenny Park")
    check("picture_url 동기화", u["picture_url"] == "https://example.com/j.png")
    check("machine_ids 에 m-jenny-1", "m-jenny-1" in u["machine_ids"])
    check("klaud_version=0.6.1", u["klaud_version"] == "0.6.1")
    check("role=regular default", u["role"] == "regular")

    # verify 실패 → upsert 안 됨
    out = server._resolve_user_email("bad-token", claimed_email=None)
    check("verify 실패 → None", out is None)

    # SSO 비활성 시 upsert 안 됨
    saved = os.environ.pop("KLAUD_GOOGLE_CLIENT_ID")
    try:
        out = server._resolve_user_email("good-jenny", claimed_email="other@x.com")
        check("SSO 비활성 → claimed 사용 + upsert 없음", out == "other@x.com")
    finally:
        os.environ["KLAUD_GOOGLE_CLIENT_ID"] = saved

    _restore()


# ── 3. /klaud/admin/users CRUD endpoints ─────────────────────────────────────


def test_endpoints_auth_create():
    print("\n[3] /klaud/admin/users — create + auth")
    with _client() as c:
        # no auth
        r = c.post("/klaud/admin/users", json={"email": "x@hybecorp.com"})
        check("no auth → 401", r.status_code == 401)

        # static token OK
        r = c.post(
            "/klaud/admin/users",
            headers={"Authorization": "Bearer test-admin-static"},
            json={"email": "new1@hybecorp.com", "role": "regular", "note": "테스트"},
        )
        check("static auth + valid → 201/200", r.status_code == 200 and r.json()["created"], f"{r.status_code} {r.text[:200]}")

        # duplicate → 409
        r = c.post(
            "/klaud/admin/users",
            headers={"Authorization": "Bearer test-admin-static"},
            json={"email": "new1@hybecorp.com"},
        )
        check("중복 → 409", r.status_code == 409)

        # bad role → 400
        r = c.post(
            "/klaud/admin/users",
            headers={"Authorization": "Bearer test-admin-static"},
            json={"email": "x@hybecorp.com", "role": "owner"},
        )
        check("invalid role → 400", r.status_code == 400)

        # bad email → 400
        r = c.post(
            "/klaud/admin/users",
            headers={"Authorization": "Bearer test-admin-static"},
            json={"email": "no-at-symbol"},
        )
        check("invalid email → 400", r.status_code == 400)


def test_endpoints_list_role_delete():
    print("\n[4] /klaud/admin/users — list + role + delete")
    headers = {"Authorization": "Bearer test-admin-static"}
    with _client() as c:
        # list — bob (admin) + new1 (regular) 최소
        r = c.get("/klaud/admin/users", headers=headers)
        check("list 200", r.status_code == 200)
        emails = {u["email"] for u in r.json()["users"]}
        check("list 에 bob + new1", {"bob@hybecorp.com", "new1@hybecorp.com"}.issubset(emails))
        check("env_admin_emails 노출", "envadmin@hybecorp.com" in r.json().get("env_admin_emails", []))

        # filter role=admin
        r = c.get("/klaud/admin/users?role=admin", headers=headers)
        check("role=admin 필터", all(u["role"] == "admin" for u in r.json()["users"]))

        # search q=bob
        r = c.get("/klaud/admin/users?q=bob", headers=headers)
        emails = {u["email"] for u in r.json()["users"]}
        check("q=bob 매칭", "bob@hybecorp.com" in emails)

        # set role
        r = c.post(
            "/klaud/admin/users/new1@hybecorp.com/role",
            headers=headers, json={"role": "admin", "note": "DBA 권한 부여"},
        )
        check("set_role 200", r.status_code == 200)
        check("set_role role=admin 반환", r.json()["role"] == "admin")

        # set role on missing user → 404
        r = c.post(
            "/klaud/admin/users/missing@hybecorp.com/role",
            headers=headers, json={"role": "admin"},
        )
        check("set_role 미존재 → 404", r.status_code == 404)

        # delete
        r = c.delete("/klaud/admin/users/new1@hybecorp.com", headers=headers)
        check("delete 200", r.status_code == 200)
        r = c.delete("/klaud/admin/users/new1@hybecorp.com", headers=headers)
        check("delete 두 번째 → 404", r.status_code == 404)


# ── 4. dev bypass ───────────────────────────────────────────────────────────


def test_dev_bypass():
    print("\n[5] KLAUD_DEV_BYPASS_AUTH — 개발 모드 인증 우회")
    os.environ["KLAUD_DEV_BYPASS_AUTH"] = "1"
    try:
        with _client() as c:
            r = c.get("/klaud/admin/users")
            check("dev bypass: no auth → 200", r.status_code == 200, f"{r.status_code}")
            r = c.get("/klaud/logs")
            check("dev bypass: /klaud/logs → 200", r.status_code == 200)
            r = c.post(
                "/klaud/admin/users",
                json={"email": "bypass-test@hybecorp.com"},
            )
            check("dev bypass: create no auth → 200", r.status_code == 200)
    finally:
        os.environ.pop("KLAUD_DEV_BYPASS_AUTH")

    # bypass 끄면 다시 401
    with _client() as c:
        r = c.get("/klaud/admin/users")
        check("bypass off: no auth → 401", r.status_code == 401)


# ── 5. DB admin 으로 인증 (env whitelist 외) ────────────────────────────────


def test_db_admin_auth():
    print("\n[6] DB role='admin' 사용자가 id_token 으로 인증")
    _install_fake()
    # bob 은 DB admin (이전 test 에서 set), env whitelist 가 아닌 다른 도메인 가정
    _verify_responses["bob-id-token"] = {
        "email": "bob@hybecorp.com", "email_verified": True,
    }
    # bob 이 DB admin 인지 재확인 (이전 test 가 disabled 후 admin 복원)
    klaud_sink.set_user_role("bob@hybecorp.com", "admin")
    check("bob role=admin in DB", klaud_sink.is_db_admin("bob@hybecorp.com") is True)

    with _client() as c:
        r = c.get(
            "/klaud/admin/users",
            headers={"Authorization": "Bearer bob-id-token"},
        )
        check("DB admin id_token → 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # 비-admin 사용자의 id_token → 401
    _verify_responses["new1-id-token"] = {
        "email": "newuser@hybecorp.com", "email_verified": True,
    }
    klaud_sink.upsert_user("newuser@hybecorp.com")  # role=regular
    with _client() as c:
        r = c.get(
            "/klaud/admin/users",
            headers={"Authorization": "Bearer new1-id-token"},
        )
        check("regular user id_token → 401", r.status_code == 401)
    _restore()


# ── main ─────────────────────────────────────────────────────────────────────


def main():
    test_users_crud()
    test_auto_upsert()
    test_endpoints_auth_create()
    test_endpoints_list_role_delete()
    test_dev_bypass()
    test_db_admin_auth()

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = total - passed
    print(f"\n{'═' * 60}")
    print(f"  Total: {total} | Pass: {passed} | Fail: {failed}")
    print(f"  DB: {_TMP_DB}")
    if failed:
        print("\n  실패:")
        for name, ok, detail in results:
            if not ok:
                print(f"    {FAIL} {name}" + (f"\n        {detail}" if detail else ""))
        sys.exit(1)
    print(f"  {PASS} 모두 통과")


if __name__ == "__main__":
    main()
