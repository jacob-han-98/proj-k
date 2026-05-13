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
    """변경 감지 + 증분 인덱싱.

    Phase A: stub — last_cron_tick_at 만 기록. 실 fetch+update 는 Phase B.
    Phase B 예정:
      1. Confluence v2 API since=<last_modified> 로 변경 페이지 조회
      2. P4 changes -e <last-changelist> 로 변경 XLSX 조회
      3. confluence-downloader / xlsx-extractor 호출 (또는 직접 fetch)
      4. ChromaDB 의 chunk 업데이트
      5. crawl_state.upsert_resource(...) 로 status='fresh'
    """
    ts = datetime.now(timezone.utc).isoformat()
    state.set_last_cron_tick(ts)
    sources = [args.source] if args.source else sorted(state.VALID_SOURCES)
    print(f"⏱ cron-tick @ {_fmt_ts(ts)} — sources: {sources}")
    if args.dry_run:
        print("(dry-run — 실 fetch 없음)")
        return 0
    stale = []
    for src in sources:
        rows = state.list_resources(source=src, status="stale", limit=5000)
        stale.extend(rows)
    print(f"   stale: {len(stale)} resources need re-index")
    print("   ⚠ Phase A — 실 fetch/update 미구현 (Phase B 에서 confluence-downloader / xlsx-extractor 연결)")
    return 0


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
