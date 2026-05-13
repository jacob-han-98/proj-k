#!/usr/bin/env python3
"""
klaud-crawl — 운영자용 P4/Confluence 크롤 상태 관리 CLI (릴리스-C).

사용:
    klaud-crawl status [--source <s>] [--filter <regex>] [--limit N] [--status <s>]
    klaud-crawl diff --since <ISO-ts|duration>
    klaud-crawl purge <path-glob> --source <s> [--yes]
    klaud-crawl reindex <path-glob | --all> --source <s>
    klaud-crawl cron-tick [--source <s>] [--dry-run]

이 CLI 는 backend 의 klaud_crawl_state SQLite store 를 직접 조작.
HTTP endpoint 없이도 cron 에서 호출 가능 (운영 안전성).

cron 등록 예:
    */10 * * * * cd /opt/agent-sdk-poc && .venv/bin/python scripts/klaud-crawl.py cron-tick >> logs/crawl.log 2>&1

⚠️ Phase A — cron-tick 의 실 fetch 로직 (Confluence v2 since / P4 changelist) 은 stub.
다음 phase 에서 confluence-downloader / xlsx-extractor 호출로 채움.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

import klaud_crawl_state as state  # noqa: E402


def _fmt_ts(ts: str | None) -> str:
    if not ts:
        return "—"
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return d.astimezone().strftime("%m-%d %H:%M")
    except (ValueError, AttributeError):
        return ts[:16]


def _parse_duration(s: str) -> str:
    """'1h' / '30m' / '1d' / ISO-ts → ISO-ts."""
    s = s.strip()
    if not s:
        return datetime.now(timezone.utc).isoformat()
    m = re.match(r"^(\d+)([smhd])$", s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        delta = {"s": timedelta(seconds=n), "m": timedelta(minutes=n),
                 "h": timedelta(hours=n), "d": timedelta(days=n)}[unit]
        return (datetime.now(timezone.utc) - delta).isoformat()
    # ISO assumed
    return s


# ── status ───────────────────────────────────────────────────────────


def cmd_status(args: argparse.Namespace) -> int:
    res = state.list_resources(
        source=args.source,
        status=args.status,
        q=args.filter,
        limit=args.limit,
    )
    s = state.stats()
    print(
        f"📊 Total {s['total']} resources — "
        f"fresh: {s['fresh']}, stale: {s['stale']}, failed: {s['failed']}, purged: {s['purged']}"
    )
    if s["last_cron_tick_at"]:
        print(f"   last cron-tick: {_fmt_ts(s['last_cron_tick_at'])}")
    print()
    if not res:
        print("(no resources matched)")
        return 0
    fmt = "  {idx:>4}  {source:<18}  {path:<60}  {status:<7}  {indexed:<12}  {chunks:>5}"
    print(fmt.format(idx="#", source="source", path="path", status="status",
                     indexed="indexed", chunks="chunks"))
    print("  " + "─" * 110)
    for i, r in enumerate(res, 1):
        print(fmt.format(
            idx=i,
            source=r["source"],
            path=(r["resource_path"][:58] + "…") if len(r["resource_path"]) > 60 else r["resource_path"],
            status=r["status"],
            indexed=_fmt_ts(r["last_indexed_at"]),
            chunks=r["chunk_count"],
        ))
    return 0


# ── diff ─────────────────────────────────────────────────────────────


def cmd_diff(args: argparse.Namespace) -> int:
    since_iso = _parse_duration(args.since)
    events = state.recent_changes(since_iso=since_iso, source=args.source, limit=args.limit)
    if not events:
        print(f"(no changes since {_fmt_ts(since_iso)})")
        return 0
    print(f"📜 Changes since {_fmt_ts(since_iso)} — {len(events)} events")
    print()
    for e in events:
        print(f"  {_fmt_ts(e['ts'])}  {e['source']:<18}  {e['action']:<10}  {e['resource_path']}")
        if e.get("detail"):
            print(f"             ↳ {e['detail'][:120]}")
    return 0


# ── purge / reindex ──────────────────────────────────────────────────


def _resolve_paths(args: argparse.Namespace) -> list[str]:
    """path-glob → 매칭되는 resource_path 리스트."""
    res = state.list_resources(source=args.source, limit=5000)
    if not args.pattern:
        return []
    return [r["resource_path"] for r in res if fnmatch.fnmatch(r["resource_path"], args.pattern)]


def cmd_purge(args: argparse.Namespace) -> int:
    if not args.source:
        print("❌ --source 필수")
        return 1
    paths = _resolve_paths(args)
    if not paths:
        print("(no matching resources)")
        return 0
    print(f"⚠ purge 대상 {len(paths)}개 (source={args.source}):")
    for p in paths[:20]:
        print(f"  - {p}")
    if len(paths) > 20:
        print(f"  ... and {len(paths) - 20} more")
    if not args.yes:
        try:
            ans = input("\n계속? [y/N] ").strip().lower()
        except EOFError:
            ans = ""
        if ans not in {"y", "yes"}:
            print("취소")
            return 0
    n = state.mark_purged(args.source, paths)
    print(f"✅ {n} 개 purged. (ChromaDB chunk 실 삭제는 별도 — TODO Phase B)")
    return 0


def cmd_reindex(args: argparse.Namespace) -> int:
    if not args.source:
        print("❌ --source 필수")
        return 1
    if args.all:
        n = state.mark_stale(args.source, all_in_source=True)
        print(f"✅ {n} 개 stale 처리 (source={args.source}, 전체). 다음 cron-tick 에 재처리.")
        return 0
    paths = _resolve_paths(args)
    if not paths:
        print("(no matching resources)")
        return 0
    n = state.mark_stale(args.source, resource_paths=paths)
    print(f"✅ {n} 개 stale 처리. 다음 cron-tick 에 재처리.")
    return 0


# ── cron-tick (stub) ─────────────────────────────────────────────────


def cmd_cron_tick(args: argparse.Namespace) -> int:
    """변경 감지 + stale 표시.

    Phase B: 두 source 의 upstream 변경 감지 → status='stale' 표시.
    실 fetch + ChromaDB update 는 별도 `reindex-run` 명령 (Phase C) 또는 사용자가
    직접 confluence-downloader / xlsx-extractor 실행 후 `upsert_resource` 호출.

    이렇게 분리한 이유:
    - 변경 감지 (가벼움, ~수 초) 와 실 fetch + re-chunk (무거움, 시간 단위) 의 latency 차이.
    - cron-tick 은 10분 주기로 가벼워야 하고, 실 fetch 는 operator 가 확인 후 실행하는 게 안전.
    """
    new_tick = datetime.now(timezone.utc).isoformat()
    sources = [args.source] if args.source else sorted(state.VALID_SOURCES)
    s = state.stats()
    last_tick = s.get("last_cron_tick_at")

    print(f"⏱ cron-tick @ {_fmt_ts(new_tick)}")
    if last_tick:
        print(f"   previous tick: {_fmt_ts(last_tick)}")
    else:
        print(f"   previous tick: (none — first run, since 1 day ago)")
    print(f"   sources: {sources}")

    if args.dry_run:
        # last_tick 갱신 안 함 — dry-run 은 read-only
        print("(dry-run)")
        return 0

    # 변경 감지
    total_changed = 0
    for src in sources:
        if src.startswith("confluence-"):
            changed = _detect_confluence_changes(src, last_tick, args)
        elif src == "p4-xlsx":
            changed = _detect_p4_xlsx_changes(last_tick, args)
        else:
            continue
        # 변경된 리소스를 stale 처리 (다음 reindex 명령에서 실 fetch)
        if changed:
            paths = [c["resource_path"] for c in changed]
            state.mark_stale(src, resource_paths=paths)
            for c in changed:
                # 새 리소스이면 신규 upsert
                if not c.get("existing"):
                    state.upsert_resource(
                        source=src,
                        resource_path=c["resource_path"],
                        resource_id=c.get("resource_id"),
                        last_modified_upstream=c.get("last_modified"),
                        status="stale",
                    )
        total_changed += len(changed)
        print(f"   {src}: {len(changed)} changes detected")

    state.set_last_cron_tick(new_tick)
    print(f"✅ cron-tick complete — {total_changed} resources marked stale")
    if total_changed:
        print(f"   다음: 'klaud-crawl reindex --all --source <s>' 로 실 fetch + ChromaDB 업데이트")
    return 0


def _detect_confluence_changes(source: str, last_tick: str | None, args) -> list[dict]:
    """Confluence v1 CQL lastmodified 로 변경 페이지 조회.

    `confluence-downloader` 의 ConfluenceClient 를 import 해서 사용.
    """
    try:
        import sys
        cd_src = Path(__file__).resolve().parent.parent.parent / "confluence-downloader" / "src"
        cd_root = cd_src.parent
        if str(cd_root) not in sys.path:
            sys.path.insert(0, str(cd_root))
        from src.client import ConfluenceClient  # type: ignore[import-not-found]
    except ImportError as e:
        print(f"   ⚠ confluence-downloader import 실패: {e}")
        return []

    import os
    url = os.environ.get("CONFLUENCE_URL")
    user = os.environ.get("CONFLUENCE_USERNAME")
    token = os.environ.get("CONFLUENCE_API_TOKEN")
    if not (url and user and token):
        # confluence-downloader/.env 시도
        from pathlib import Path as _P
        env_path = _P(__file__).resolve().parent.parent.parent / "confluence-downloader" / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())
            url = os.environ.get("CONFLUENCE_URL")
            user = os.environ.get("CONFLUENCE_USERNAME")
            token = os.environ.get("CONFLUENCE_API_TOKEN")
    if not (url and user and token):
        print(f"   ⚠ CONFLUENCE_URL/USERNAME/API_TOKEN env 미설정 — {source} skip")
        return []

    if source == "confluence-projk":
        ancestor = os.environ.get("CONFLUENCE_ROOT_PAGE_ID")
    else:
        ancestor = os.environ.get("CONFLUENCE_ART_ROOT_PAGE_ID")
    if not ancestor:
        print(f"   ⚠ {source} 의 root_page_id env 미설정 — skip")
        return []

    # 첫 tick 이면 1일 전부터, 그 이후엔 last_tick 이후
    from datetime import datetime, timedelta, timezone
    if last_tick:
        since_ts = last_tick
    else:
        since_ts = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()

    client = ConfluenceClient(url, user, token, request_delay=0.3)
    try:
        pages = client.search_modified_since(since_ts, ancestor_id=ancestor, limit=500)
    except Exception as e:
        print(f"   ⚠ Confluence search 실패: {e}")
        return []

    # crawl_state 와 매칭 — 기존 리소스 여부 확인
    existing = {r["resource_path"] for r in state.list_resources(source=source, limit=10000)}
    changed: list[dict] = []
    for p in pages:
        # resource_path = page title 단순 사용 (실 디렉토리 구조는 다운로드 시점에 결정)
        rp = p.get("title", "")
        if not rp:
            continue
        changed.append({
            "resource_path": rp,
            "resource_id": p.get("id"),
            "last_modified": p.get("lastModified"),
            "existing": rp in existing,
        })
    return changed


def _detect_p4_xlsx_changes(last_tick: str | None, args) -> list[dict]:
    """P4 changes -e <last_changelist> 로 변경 xlsx list.

    p4_changes 모듈 (graceful skip if not available).
    """
    try:
        from src import p4_changes  # type: ignore[import-not-found]
    except ImportError:
        try:
            import sys
            sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
            import p4_changes  # type: ignore[import-not-found]
        except ImportError as e:
            print(f"   ⚠ p4_changes import 실패: {e}")
            return []

    if not p4_changes.is_available():
        print("   ⚠ p4 cli 또는 P4PORT 미설정 — p4-xlsx skip")
        return []

    import os
    depot_paths = os.environ.get(
        "P4_DEPOT_PATHS",
        "//main/ProjectK/Resource/design/...,//main/ProjectK/Design/..."
    ).split(",")
    depot_paths = [p.strip() for p in depot_paths if p.strip()]

    # last_changelist 는 별도 state — 간단히 env 또는 0
    last_cl = int(os.environ.get("P4_LAST_CHANGELIST", "0")) or None
    changes = p4_changes.list_changes_since(last_cl, depot_paths, max_changelists=200)

    existing = {r["resource_path"] for r in state.list_resources(source="p4-xlsx", limit=10000)}
    files_seen: set[str] = set()
    changed: list[dict] = []
    for cl in changes:
        files = p4_changes.list_files_in_changelist(cl["changelist"])
        for f in files:
            if not f.endswith(".xlsx"):
                continue
            if f in files_seen:
                continue
            files_seen.add(f)
            # depot path → resource_path 정규화 (예: //main/ProjectK/Resource/design/Skill.xlsx → 'Resource/design/Skill.xlsx')
            rp = f.split("ProjectK/", 1)[-1] if "ProjectK/" in f else f.lstrip("/")
            changed.append({
                "resource_path": rp,
                "resource_id": f,
                "last_modified": cl["date"],
                "existing": rp in existing,
            })
    if changes:
        latest = max(c["changelist"] for c in changes)
        print(f"   p4 latest changelist seen: {latest} (set P4_LAST_CHANGELIST={latest} for next tick)")
    return changed


# ── main ─────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(prog="klaud-crawl", description="Klaud 크롤 상태 관리 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_status = sub.add_parser("status", help="리소스 현황")
    p_status.add_argument("--source", choices=sorted(state.VALID_SOURCES))
    p_status.add_argument("--status", choices=sorted(state.VALID_STATUSES))
    p_status.add_argument("--filter", help="resource_path LIKE 검색")
    p_status.add_argument("--limit", type=int, default=500)
    p_status.set_defaults(func=cmd_status)

    p_diff = sub.add_parser("diff", help="변화 내역")
    p_diff.add_argument("--since", required=True, help="ISO-ts 또는 '1h'/'30m'/'1d'")
    p_diff.add_argument("--source", choices=sorted(state.VALID_SOURCES))
    p_diff.add_argument("--limit", type=int, default=500)
    p_diff.set_defaults(func=cmd_diff)

    p_purge = sub.add_parser("purge", help="특정 리소스 purge (ChromaDB chunk 제거 + status=purged)")
    p_purge.add_argument("pattern", help="path-glob (fnmatch)")
    p_purge.add_argument("--source", required=True, choices=sorted(state.VALID_SOURCES))
    p_purge.add_argument("--yes", action="store_true", help="확인 prompt skip")
    p_purge.set_defaults(func=cmd_purge)

    p_reindex = sub.add_parser("reindex", help="강제 재인덱싱 (status=stale 표시)")
    p_reindex.add_argument("pattern", nargs="?", default="", help="path-glob")
    p_reindex.add_argument("--source", required=True, choices=sorted(state.VALID_SOURCES))
    p_reindex.add_argument("--all", action="store_true", help="해당 source 의 모든 리소스")
    p_reindex.set_defaults(func=cmd_reindex)

    p_cron = sub.add_parser("cron-tick", help="cron 주기 호출 — 변경 감지 + 증분 인덱싱 (Phase A: stub)")
    p_cron.add_argument("--source", choices=sorted(state.VALID_SOURCES))
    p_cron.add_argument("--dry-run", action="store_true")
    p_cron.set_defaults(func=cmd_cron_tick)

    args = parser.parse_args()
    state.init()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
