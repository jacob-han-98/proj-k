"""
test_klaud_crawl.py — 릴리스-C 크롤 store + endpoint + CLI 검증
=================================================================
klaud_crawl_state SQLite store, 5개 /klaud/crawl/* endpoint, 그리고
admin auth 게이트 검증.

실행:
    .venv/bin/python tests/test_klaud_crawl.py

검증 항목:
- upsert_resource — 신규/conflict update
- list_resources — filter (source/status/q) + cursor pagination
- mark_purged / mark_stale — 단건/all_in_source
- recent_changes — crawl_events 시간 역순
- stats — per_status / per_source / last_cron_tick_at
- /klaud/crawl/{resources,recent-changes,stats} GET admin auth
- /klaud/crawl/{purge,reindex} POST admin auth + 400/200 케이스
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

os.environ["KLAUD_ADMIN_TOKEN"] = "test-admin-token-crawl"
os.environ.pop("KLAUD_GOOGLE_CLIENT_ID", None)  # SSO 비활성 (dual auth 한쪽만)

import klaud_sink  # noqa: E402
import klaud_crawl_state  # noqa: E402

_TMP_LOG_DB = Path(tempfile.mkdtemp(prefix="klaud_crawl_test_log_")) / "klaud_log.db"
_TMP_CRAWL_DB = Path(tempfile.mkdtemp(prefix="klaud_crawl_test_crawl_")) / "crawl_state.db"

# klaud_sink: monkey-patch 로 default path 우회 (sink.init 은 self-call 안 함)
_orig_sink_init = klaud_sink.init


def _test_sink_init(db_path=None):
    _orig_sink_init(db_path=_TMP_LOG_DB)


klaud_sink.init = _test_sink_init  # type: ignore

# klaud_crawl_state: monkey-patch 대신 server import 전에 직접 init.
# reset_for_test() 가 내부에서 init() 을 self-call 하기 때문에 monkey-patch 하면
# 무한 재귀. server startup hook 의 init() 호출은 이미 _CONN 가 있으면 no-op.
klaud_crawl_state.init(_TMP_CRAWL_DB)

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


def _seed():
    """샘플 리소스 5개 + 1개 stale + 1개 purged."""
    klaud_crawl_state.upsert_resource("p4-xlsx", "7_System/PK_HUD 시스템.xlsx", chunk_count=42)
    klaud_crawl_state.upsert_resource("p4-xlsx", "7_System/PK_변신 및 스킬 시스템.xlsx", chunk_count=78)
    klaud_crawl_state.upsert_resource("confluence-projk", "시스템 디자인/전투", chunk_count=15)
    klaud_crawl_state.upsert_resource("confluence-projk", "시스템 디자인/HUD", chunk_count=22)
    klaud_crawl_state.upsert_resource("confluence-art", "Project K/네이밍 규칙", chunk_count=8)
    klaud_crawl_state.mark_stale("p4-xlsx", ["7_System/PK_HUD 시스템.xlsx"])
    klaud_crawl_state.mark_purged("confluence-projk", ["시스템 디자인/HUD"])


# ── 1. store CRUD ────────────────────────────────────────────────────────────


def test_store_basic():
    print("\n[1] klaud_crawl_state — upsert / list / mark")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()

    rows = klaud_crawl_state.list_resources()
    check("seed 5건 list", len(rows) == 5, f"got={len(rows)}")

    rows = klaud_crawl_state.list_resources(source="p4-xlsx")
    check("source=p4-xlsx 2건", len(rows) == 2)

    rows = klaud_crawl_state.list_resources(status="stale")
    check("status=stale 1건", len(rows) == 1)
    check("stale 의 path", rows[0]["resource_path"] == "7_System/PK_HUD 시스템.xlsx")

    rows = klaud_crawl_state.list_resources(status="purged")
    check("status=purged 1건", len(rows) == 1)

    rows = klaud_crawl_state.list_resources(q="HUD")
    check("q=HUD LIKE 2건 (xlsx + confluence)", len(rows) == 2, f"got={len(rows)}")

    # cursor pagination
    rows1 = klaud_crawl_state.list_resources(limit=2)
    check("limit=2 first batch", len(rows1) == 2)
    rows2 = klaud_crawl_state.list_resources(limit=2, cursor=rows1[-1]["id"])
    check("cursor pagination next batch", len(rows2) == 2)
    check("cursor 가 first batch id 들과 안 겹침", set(r["id"] for r in rows1).isdisjoint(set(r["id"] for r in rows2)))


def test_store_actions():
    print("\n[2] mark_purged / mark_stale / mark_failed")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()

    n = klaud_crawl_state.mark_purged("p4-xlsx", ["7_System/PK_변신 및 스킬 시스템.xlsx"])
    check("mark_purged 1건", n == 1)
    rows = klaud_crawl_state.list_resources(status="purged")
    paths = {r["resource_path"] for r in rows}
    check("purged 에 추가됨", "7_System/PK_변신 및 스킬 시스템.xlsx" in paths)

    n = klaud_crawl_state.mark_stale("confluence-projk", all_in_source=True)
    check("mark_stale all_in_source", n >= 1)  # purged 1건 제외하면 1건 stale
    rows = klaud_crawl_state.list_resources(source="confluence-projk", status="stale")
    check("confluence-projk stale 1건 (purged 제외)", len(rows) == 1)

    klaud_crawl_state.mark_failed("confluence-art", "Project K/네이밍 규칙", "Confluence 502 timeout")
    rows = klaud_crawl_state.list_resources(status="failed")
    check("mark_failed 적용", len(rows) == 1 and rows[0]["error_msg"] == "Confluence 502 timeout")


def test_store_events_stats():
    print("\n[3] recent_changes + stats")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()
    klaud_crawl_state.mark_stale("p4-xlsx", ["7_System/PK_변신 및 스킬 시스템.xlsx"])

    events = klaud_crawl_state.recent_changes()
    # seed 5 'added' + 1 'stale' (mark_stale at seed) + 1 'purged' (seed) + 1 'stale' (위)
    check("events ≥ 6", len(events) >= 6, f"got={len(events)}")
    actions = {e["action"] for e in events}
    check("events 에 'added' 포함", "added" in actions)
    check("events 에 'stale' 포함", "stale" in actions)
    check("events 에 'purged' 포함", "purged" in actions)

    stats = klaud_crawl_state.stats()
    check("stats.total == 5", stats["total"] == 5)
    check("stats.per_status 에 stale 키", "stale" in stats["per_status"])
    check("stats.per_source 에 3종 모두", len(stats["per_source"]) == 3)
    check("last_cron_tick_at 미설정 None", stats["last_cron_tick_at"] is None)

    klaud_crawl_state.set_last_cron_tick()
    stats2 = klaud_crawl_state.stats()
    check("set_last_cron_tick 후 값 있음", stats2["last_cron_tick_at"] is not None)


# ── 2. /klaud/crawl/* endpoint ───────────────────────────────────────────────


def test_endpoints_admin_auth():
    print("\n[4] /klaud/crawl/* GET admin auth")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()
    with _new_client() as client:
        # no auth
        for path in ["/klaud/crawl/resources", "/klaud/crawl/recent-changes", "/klaud/crawl/stats"]:
            r = client.get(path)
            check(f"{path} no-auth → 401", r.status_code == 401)
        # good auth
        for path in ["/klaud/crawl/resources", "/klaud/crawl/recent-changes", "/klaud/crawl/stats"]:
            r = client.get(path, headers={"Authorization": "Bearer test-admin-token-crawl"})
            check(f"{path} good-auth → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")


def test_resources_filter():
    print("\n[5] GET /klaud/crawl/resources filter")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()
    headers = {"Authorization": "Bearer test-admin-token-crawl"}
    with _new_client() as client:
        r = client.get("/klaud/crawl/resources?source=confluence-art", headers=headers).json()
        check("source=confluence-art 1건", r["count"] == 1)

        r = client.get("/klaud/crawl/resources?status=stale", headers=headers).json()
        check("status=stale 1건", r["count"] == 1)

        r = client.get("/klaud/crawl/resources?q=HUD", headers=headers).json()
        check("q=HUD 2건", r["count"] == 2)


def test_purge_endpoint():
    print("\n[6] POST /klaud/crawl/purge")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()
    headers = {"Authorization": "Bearer test-admin-token-crawl"}
    with _new_client() as client:
        # no auth
        r = client.post("/klaud/crawl/purge", json={"source": "p4-xlsx", "resource_paths": ["x"]})
        check("no-auth → 401", r.status_code == 401)

        # bad source
        r = client.post(
            "/klaud/crawl/purge", headers=headers,
            json={"source": "totally-bogus", "resource_paths": ["x"]},
        )
        check("bad source → 400", r.status_code == 400)

        # empty paths
        r = client.post(
            "/klaud/crawl/purge", headers=headers,
            json={"source": "p4-xlsx", "resource_paths": []},
        )
        check("empty paths → 400", r.status_code == 400)

        # valid
        r = client.post(
            "/klaud/crawl/purge", headers=headers,
            json={"source": "p4-xlsx", "resource_paths": ["7_System/PK_HUD 시스템.xlsx"]},
        )
        check("valid purge → 200", r.status_code == 200)
        check("purged 1", r.json().get("purged") == 1)

        # DB 확인
        with sqlite3.connect(str(_TMP_CRAWL_DB)) as c:
            row = c.execute(
                "SELECT status FROM crawl_resources WHERE source=? AND resource_path=?",
                ("p4-xlsx", "7_System/PK_HUD 시스템.xlsx"),
            ).fetchone()
        check("DB status='purged'", row[0] == "purged")


def test_reindex_endpoint():
    print("\n[7] POST /klaud/crawl/reindex")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    _seed()
    headers = {"Authorization": "Bearer test-admin-token-crawl"}
    with _new_client() as client:
        # neither paths nor all_in_source
        r = client.post(
            "/klaud/crawl/reindex", headers=headers,
            json={"source": "p4-xlsx"},
        )
        check("필수 누락 → 400", r.status_code == 400)

        # specific paths
        r = client.post(
            "/klaud/crawl/reindex", headers=headers,
            json={"source": "p4-xlsx", "resource_paths": ["7_System/PK_변신 및 스킬 시스템.xlsx"]},
        )
        check("specific reindex 200", r.status_code == 200 and r.json().get("queued") == 1)

        # all_in_source
        r = client.post(
            "/klaud/crawl/reindex", headers=headers,
            json={"source": "confluence-projk", "all_in_source": True},
        )
        check("all_in_source 200", r.status_code == 200)
        # purged 1건 제외, 1건 stale 처리
        check("all_in_source queued ≥1", r.json().get("queued") >= 1)


# ── 3. recent-changes since 필터 ─────────────────────────────────────────────


def test_recent_changes_since():
    print("\n[8] GET /klaud/crawl/recent-changes ?since")
    klaud_crawl_state.reset_for_test(_TMP_CRAWL_DB)
    klaud_crawl_state.upsert_resource("p4-xlsx", "old-resource", chunk_count=1)
    import time as _t
    _t.sleep(0.1)
    middle_ts = klaud_crawl_state._now()
    _t.sleep(0.1)
    klaud_crawl_state.upsert_resource("p4-xlsx", "new-resource", chunk_count=2)

    headers = {"Authorization": "Bearer test-admin-token-crawl"}
    with _new_client() as client:
        r = client.get(
            f"/klaud/crawl/recent-changes?since={middle_ts}",
            headers=headers,
        ).json()
        paths = {e["resource_path"] for e in r["changes"]}
        check("since 이후만 — new-resource 포함", "new-resource" in paths)
        check("since 이전 old-resource 제외", "old-resource" not in paths)


# ── main ─────────────────────────────────────────────────────────────────────


def main():
    test_store_basic()
    test_store_actions()
    test_store_events_stats()
    test_endpoints_admin_auth()
    test_resources_filter()
    test_purge_endpoint()
    test_reindex_endpoint()
    test_recent_changes_since()

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = total - passed
    print(f"\n{'═' * 60}")
    print(f"  Total: {total} | Pass: {passed} | Fail: {failed}")
    if failed:
        print("\n  실패 항목:")
        for name, ok, detail in results:
            if not ok:
                print(f"    {FAIL} {name}" + (f"\n        {detail}" if detail else ""))
        sys.exit(1)
    print(f"  {PASS} 모두 통과")


if __name__ == "__main__":
    main()
