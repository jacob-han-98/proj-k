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
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

import klaud_crawl_state as state  # noqa: E402

DATA_DIR = ROOT / "data"
CONF_OUT = ROOT.parent / "confluence-downloader" / "output"
XLSX_OUT = Path(os.environ.get("PROJK_GDD_OUTPUT", str(ROOT.parent / "xlsx-extractor" / "output")))


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


def _confluence_setup(source: str):
    """confluence-downloader ConfluenceClient + ancestor(root page id) 준비.

    env(CONFLUENCE_URL/USERNAME/API_TOKEN, *_ROOT_PAGE_ID) 미설정이면 confluence-downloader/.env
    로 fallback. 성공 시 (client, ancestor), 실패 시 (None, None). cron-tick·report 공용.
    """
    try:
        cd_root = Path(__file__).resolve().parent.parent.parent / "confluence-downloader"
        if str(cd_root) not in sys.path:
            sys.path.insert(0, str(cd_root))
        from src.client import ConfluenceClient  # type: ignore[import-not-found]
    except ImportError as e:
        print(f"   ⚠ confluence-downloader import 실패: {e}")
        return None, None

    def _env3():
        return (os.environ.get("CONFLUENCE_URL"), os.environ.get("CONFLUENCE_USERNAME"),
                os.environ.get("CONFLUENCE_API_TOKEN"))

    url, user, token = _env3()
    if not (url and user and token):
        env_path = Path(__file__).resolve().parent.parent.parent / "confluence-downloader" / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())
            url, user, token = _env3()
    if not (url and user and token):
        print(f"   ⚠ CONFLUENCE_URL/USERNAME/API_TOKEN env 미설정 — {source} skip")
        return None, None

    if source == "confluence-projk":
        ancestor = os.environ.get("CONFLUENCE_ROOT_PAGE_ID")
    else:
        ancestor = os.environ.get("CONFLUENCE_ART_ROOT_PAGE_ID")
    if not ancestor:
        print(f"   ⚠ {source} 의 root_page_id env 미설정 — skip")
        return None, None

    return ConfluenceClient(url, user, token, request_delay=0.3), ancestor


def _p4_depot_paths() -> list[str]:
    paths = os.environ.get(
        "P4_DEPOT_PATHS",
        "//main/ProjectK/Resource/design/...,//main/ProjectK/Design/..."
    ).split(",")
    return [p.strip() for p in paths if p.strip()]


def _p4_depot_to_resource_path(depot_file: str) -> str:
    """depot path → resource_path (cron-tick 과 동일 규약)."""
    return depot_file.split("ProjectK/", 1)[-1] if "ProjectK/" in depot_file else depot_file.lstrip("/")


def _detect_confluence_changes(source: str, last_tick: str | None, args) -> list[dict]:
    """Confluence v1 CQL lastmodified 로 변경 페이지 조회."""
    client, ancestor = _confluence_setup(source)
    if client is None:
        return []

    # 첫 tick 이면 1일 전부터, 그 이후엔 last_tick 이후
    if last_tick:
        since_ts = last_tick
    else:
        since_ts = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()

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

    depot_paths = _p4_depot_paths()

    # last_changelist 는 crawl_kv 영속화 우선, 없으면 env fallback
    last_cl = None
    kv_cl = state.get_kv("p4_last_changelist")
    if kv_cl:
        last_cl = int(kv_cl)
    elif os.environ.get("P4_LAST_CHANGELIST"):
        last_cl = int(os.environ["P4_LAST_CHANGELIST"]) or None
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
            rp = _p4_depot_to_resource_path(f)
            changed.append({
                "resource_path": rp,
                "resource_id": f,
                "last_modified": cl["date"],
                "existing": rp in existing,
            })
    if changes and not getattr(args, "dry_run", False):
        latest = max(c["changelist"] for c in changes)
        state.set_kv("p4_last_changelist", str(latest))
        print(f"   p4 latest changelist seen: {latest} (crawl_kv 영속화 완료)")
    return changed


# ── report ───────────────────────────────────────────────────────────


def _import_p4():
    try:
        import p4_changes  # type: ignore[import-not-found]
        return p4_changes
    except ImportError:
        try:
            sys.path.insert(0, str(ROOT / "src"))
            import p4_changes  # type: ignore[import-not-found]
            return p4_changes
        except ImportError as e:
            print(f"   ⚠ p4_changes import 실패: {e}")
            return None


def _upstream_confluence(source: str) -> dict | None:
    """confluence root 아래 전체 페이지를 **tree-walk** 로 열거 (삭제+이동 감지 공용).

    반환 {resource_id: {resource_path(title), path(정규 로컬 상대경로), last_modified}}.
    path 는 native 다운로더 규약(Design/<조상>/.../<title>, sanitize_filename 적용)과 동일.
    """
    client, ancestor = _confluence_setup(source)
    if client is None:
        return None
    try:
        cd_run = _import_confluence_run()
        san = cd_run.sanitize_filename
    except Exception:
        san = lambda s: s  # noqa
    out: dict = {}
    try:
        rootpage = client.get_page(str(ancestor), expand="version")
        rootseg = san(rootpage.get("title", "Design"))
        out[str(ancestor)] = {"resource_path": rootpage.get("title", ""),
                              "path": rootseg, "last_modified": None}
        stack = [(str(ancestor), rootseg)]
        seen = set()
        while stack:
            pid, prefix = stack.pop()
            for c in client.get_children(pid):
                cid = c.get("id")
                if not cid or cid in seen:
                    continue
                seen.add(cid)
                ctype = c.get("type", "page")
                seg = san(c.get("title", ""))
                full = f"{prefix}/{seg}" if prefix else seg
                stack.append((cid, full))   # page/folder 모두 경로 체인에 포함
                # page + folder 모두 out 에 등록 — native 다운로더가 folder 도 content.md 로
                # 저장하므로, page 만 등록하면 folder content.md 가 '삭제후보' 오탐이 됨.
                out[cid] = {"resource_path": c.get("title", ""), "path": full, "type": ctype,
                            "last_modified": c.get("version", {}).get("when")}
    except Exception as e:
        print(f"   ⚠ Confluence tree 열거 실패: {e}")
        return None
    return out


def _upstream_p4_xlsx() -> dict | None:
    """depot 의 현재 .xlsx 전체 → {depot_file: {resource_path, last_modified}}. 실패 시 None."""
    p4 = _import_p4()
    if p4 is None:
        return None
    if not p4.is_available():
        print("   ⚠ p4 cli 또는 P4PORT 미설정 — p4-xlsx upstream 열거 불가")
        return None
    files = p4.list_depot_files(_p4_depot_paths())
    if not files:
        # ★ 안전: depot 열거가 비면 티켓 만료/p4 오류 추정(실제로 빌 리 없음).
        #   {}(빈) 반환 시 report 가 모든 로컬을 '삭제됨'으로 오판 → 대량 purge 사고.
        print("   ⚠ p4 depot 열거 결과 0건 — 티켓 만료/오류 추정. upstream 미가용 처리(삭제판정 보류).")
        return None
    out = {}
    for f in files:
        df = f["depot_file"]
        if not df.endswith(".xlsx"):
            continue
        out[df] = {"resource_path": _p4_depot_to_resource_path(df), "last_modified": None}
    return out or None


def _report_one_source(source: str, purge_missing: bool) -> dict:
    """한 source 의 upstream vs 로컬 set-diff 결과 dict 생성 (read-only, purge_missing 시 예외)."""
    local_list = state.list_resources(source=source, limit=100000)
    # 로컬 인덱스: resource_id 기준 (없으면 path)
    local_by_id = {}
    for r in local_list:
        key = r.get("resource_id") or r["resource_path"]
        local_by_id[key] = r

    if source.startswith("confluence-"):
        upstream = _upstream_confluence(source)
    elif source == "p4-xlsx":
        upstream = _upstream_p4_xlsx()
    else:
        upstream = None

    result = {
        "source": source,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "upstream_available": upstream is not None,
        "upstream_count": len(upstream) if upstream else None,
        "local_count": len(local_list),
        "fresh": [],
        "to_fetch_new": [],
        "to_fetch_stale": [],
        "deleted": [],
    }

    # 로컬 stale/failed → 받아야 할 것(갱신)
    for r in local_list:
        if r["status"] in {"stale", "failed"}:
            result["to_fetch_stale"].append({
                "resource_id": r.get("resource_id"), "resource_path": r["resource_path"],
                "status": r["status"],
            })

    if upstream is None:
        # upstream 미가용 → 신규/삭제 판정 불가, 로컬 stale 만 보고
        result["note"] = "upstream 열거 불가 (자격/설정 미비) — 신규·삭제 판정 생략, 로컬 stale 만 표시"
        return result

    local_ids = set(local_by_id.keys())
    upstream_ids = set(upstream.keys())

    # 신규: upstream 에만 있음
    for uid in upstream_ids - local_ids:
        result["to_fetch_new"].append({
            "resource_id": uid, "resource_path": upstream[uid]["resource_path"],
            "last_modified": upstream[uid]["last_modified"],
        })
    # fresh: 양쪽 + 로컬 status fresh
    for uid in upstream_ids & local_ids:
        if local_by_id[uid]["status"] == "fresh":
            result["fresh"].append({
                "resource_id": uid, "resource_path": local_by_id[uid]["resource_path"],
            })
    # 삭제됨: 로컬에 있으나 upstream 에 없음 (purged 제외)
    deleted = []
    for lid in local_ids - upstream_ids:
        r = local_by_id[lid]
        if r["status"] == "purged":
            continue
        item = {"resource_id": r.get("resource_id"), "resource_path": r["resource_path"],
                "status": r["status"]}
        result["deleted"].append(item)
        deleted.append(item)

    if purge_missing:
        changed = False
        # ★ 서킷 브레이커: 삭제 후보가 로컬의 큰 비율이면 upstream 열거 실패 의심 → purge 전면 중단.
        #   (2026-06-09 p4 티켓 만료로 빈 열거 → 141개 대량 오삭제 사고 재발 방지.)
        safety_cap = max(10, int(0.30 * len(local_list)))
        if deleted and len(deleted) > safety_cap:
            result["purge_aborted"] = len(deleted)
            print(f"   🛑 {source}: purge 중단 — 삭제 후보 {len(deleted)}/{len(local_list)} 과다"
                  f"(>{safety_cap}). 저장소 열거 실패 의심 → 전량 보존. 수동 확인 필요.")
            deleted = []
        if deleted:
            removed, kept = _purge_missing(source, deleted)
            result["purged_now"] = len(removed)
            result["purge_kept_falsepos"] = len(kept)
            print(f"   🗑 {source}: 실제 삭제 {len(removed)}개 정리, 오탐 보존 {len(kept)}개")
            changed = changed or bool(removed)
        # 이동/이름변경 정리 (confluence — 경로=조상 계층이라 이동 시 옛 위치 orphan 발생)
        if source.startswith("confluence-"):
            moved = _reconcile_confluence_moves(source, upstream)
            result["moved_now"] = len(moved)
            if moved:
                print(f"   ↪ {source}: 이동 정리 {len(moved)}개 (옛 위치 제거 + 새 위치 재취득)")
            changed = changed or bool(moved)
        if changed:
            _rebuild_markdown_indexes()

    return result


def _verify_gone(source, rid, rp, conf_client):
    """저장소에서 정말 사라졌는지 검증 (오탐 방지). True=삭제됨."""
    try:
        if source.startswith("confluence-"):
            if not rid or conf_client is None:
                return False
            try:
                conf_client.get_page(rid, expand="version")
                return False   # 아직 존재 → 삭제 아님(스코프 밖일 뿐)
            except Exception as e:
                return "404" in str(e) or "No content found" in str(e)
        if source == "p4-xlsx":
            p4 = _import_p4()
            if not p4 or not p4.is_available():
                return False   # 검증 불가 → 보수적으로 보존
            # 하위폴더 워크북 오탐 방지: 카테고리 전체(재귀)에서 basename 존재 확인
            cat = _gdd_category(rp)
            base = Path(rp).name
            scope = f"//main/ProjectK/Design/{cat}/..." if cat else "//main/ProjectK/Design/..."
            files = p4.list_depot_files([scope])
            if not files:
                return False   # ★ 열거 실패/빈 결과 → 삭제 판정 보류(보존). 빈 카테고리는 비정상.
            names = {Path(f["depot_file"]).name for f in files}
            return base not in names
    except Exception:
        return False
    return False


def _purge_missing(source, deleted):
    """검증 후 실제 삭제된 리소스만 로컬(content.md+요약)+crawl_state 정리. (removed, kept)."""
    import shutil
    conf_client = None
    id_to_dir = {}
    if source.startswith("confluence-"):
        conf_client, _ = _confluence_setup(source)
        # confluence_id → content.md dir 맵 1회 빌드
        for cm in CONF_OUT.rglob("content.md"):
            m = re.search(r"^confluence_id:\s*(\S+)", cm.read_text(encoding="utf-8", errors="ignore"), re.M)
            if m:
                id_to_dir[m.group(1).strip()] = cm.parent
    removed, kept = [], []
    for it in deleted:
        rid, rp = it.get("resource_id"), it["resource_path"]
        if not _verify_gone(source, rid, rp, conf_client):
            kept.append(rp)
            continue
        # 로컬 파일 + 요약 제거
        try:
            if source.startswith("confluence-"):
                d = id_to_dir.get(rid)
                if d and d.exists():
                    rel = d.relative_to(CONF_OUT)
                    shutil.rmtree(d, ignore_errors=True)
                    sm = (ROOT / "index" / "summaries" / "confluence" / rel).with_suffix(".md")
                    if sm.exists():
                        sm.unlink()
            elif source == "p4-xlsx":
                cat = _gdd_category(rp)
                wb = Path(rp).stem
                if cat:
                    shutil.rmtree(XLSX_OUT / cat / wb, ignore_errors=True)
                    shutil.rmtree(ROOT / "index" / "summaries" / "xlsx" / cat / wb, ignore_errors=True)
        except Exception as e:
            print(f"   ⚠ purge 로컬 제거 실패 {rp}: {e}")
        if _vector_enabled():
            try:
                state.purge_chromadb_chunks(source, [rp])   # 벡터 DB 청크도 제거
            except Exception:
                pass
        state.mark_purged(source, [rp])
        removed.append(rp)
    return removed, kept


def _reconcile_confluence_moves(source, upstream):
    """로컬 content.md 실제 경로 ≠ 저장소 현재 정규 경로(이동/이름변경) → 옛 위치 제거 + 새 위치 재취득.

    upstream: _upstream_confluence 결과 {id: {path, resource_path(title), ...}}.
    반환 moved 리스트 [{id, old, new}]. (deleted 는 여기서 다루지 않음 — purge 가 처리.)
    """
    import shutil
    _load_bedrock_env()
    client, _ = _confluence_setup(source)
    cd_run = _import_confluence_run()
    summ_root = ROOT / "index" / "summaries" / "confluence"
    # 로컬 id → (실제 상대경로, content.md dir) 수집 (순회 중 삭제 방지 위해 먼저 리스트화)
    locals_ = []
    for cm in CONF_OUT.rglob("content.md"):
        try:
            m = re.search(r"^confluence_id:\s*(\S+)", cm.read_text(encoding="utf-8", errors="ignore"), re.M)
        except Exception:
            m = None
        if m:
            locals_.append((m.group(1).strip(), str(cm.parent.relative_to(CONF_OUT)).replace("\\", "/"), cm.parent))
    moved = []
    for cid, actual, olddir in locals_:
        u = upstream.get(cid)
        if not u:
            continue  # 저장소에 없음 = 삭제(별도 purge), 이동 아님
        canon = u["path"]
        if actual == canon:
            continue  # 제자리
        # 이동/이름변경 — 옛 위치 제거
        try:
            shutil.rmtree(olddir, ignore_errors=True)
            old_sm = (summ_root / actual).with_suffix(".md")
            if old_sm.exists():
                old_sm.unlink()
            # 새 위치 재취득 + 요약
            new_dir = CONF_OUT / canon
            new_dir.mkdir(parents=True, exist_ok=True)
            cd_run.download_page(client, cid, new_dir, skip_existing=False,
                                 content_type="page",
                                 no_images=(os.environ.get("PROJK_CONFLUENCE_IMAGES", "0") != "1"))
            new_cm = new_dir / "content.md"
            if new_cm.exists():
                _build_summary_for(new_cm)
                # 벡터 DB: 옛 위치 청크 purge + 새 위치 재인덱싱
                if _vector_enabled():
                    title = u.get("resource_path", "")
                    try:
                        state.purge_chromadb_chunks(source, [actual.rsplit("/", 1)[-1], title])
                    except Exception:
                        pass
                    _update_vector_db(source, [(title or canon, str(new_cm))])
            moved.append({"id": cid, "old": actual, "new": canon})
            print(f"   ↪ 이동 정리: {actual}  →  {canon}")
        except Exception as e:
            print(f"   ⚠ 이동 정리 실패 {actual}: {e}")
    return moved


def cmd_report(args: argparse.Namespace) -> int:
    sources = [args.source] if args.source else sorted(state.VALID_SOURCES)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    all_results = []
    for src in sources:
        print(f"\n🔎 report: {src}")
        res = _report_one_source(src, purge_missing=args.purge_missing)
        all_results.append(res)
        # 매 source 즉시 JSON 저장 (실시간 가시성 원칙)
        out_path = DATA_DIR / f"report_{src}_latest.json"
        out_path.write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")

        up = res["upstream_count"]
        print(f"   upstream: {up if up is not None else '미가용'}  local: {res['local_count']}")
        print(f"   ✅ fresh: {len(res['fresh'])}")
        print(f"   ⬇ 받아야 할 것 — 신규: {len(res['to_fetch_new'])}, 갱신(stale): {len(res['to_fetch_stale'])}")
        print(f"   🗑 삭제됨(upstream 없음): {len(res['deleted'])}")
        if res.get("note"):
            print(f"   ℹ {res['note']}")
        # 상위 몇 개 미리보기
        for label, key in [("신규", "to_fetch_new"), ("삭제", "deleted")]:
            items = res[key][:5]
            for it in items:
                print(f"      [{label}] {it['resource_path']}  (id={it.get('resource_id')})")
            if len(res[key]) > 5:
                print(f"      [{label}] ... and {len(res[key]) - 5} more")
        print(f"   📄 저장: {out_path}")

    if not args.json:
        return 0
    print("\n" + json.dumps(all_results, ensure_ascii=False, indent=2))
    return 0


# ── reindex-run (실 fetch + 변환 + 인덱싱) ───────────────────────────
#
# 현재 활성 인덱스는 agent-sdk-poc 의 **마크다운 1:1 파일 기반**:
#   content.md → build_summaries.py (LLM 요약, summaries/<rel>.md 덮어쓰기)
#              → build_master_index.py + build_term_index.py (전체 재집계, LLM 없음)
# ChromaDB(qna-poc) 경로는 이 박스에 미설치 → 사용 안 함. 요약 파일이 1:1 로
# 덮어써지므로 append 중복 문제 없음(=purge 불필요). MASTER/TERM 은 run 당 1회 재빌드.


def _load_crawl_env() -> None:
    """scripts/crawl.env (비밀 아님 설정) 을 환경에 로드. 모든 명령 시작 시 1회."""
    env_path = HERE / "crawl.env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


def _load_bedrock_env() -> bool:
    """build_summaries 의 LLM 호출용 AWS_BEARER_TOKEN_BEDROCK 를 환경에 로드.

    agent-sdk-poc/.env 에 없으면 xlsx-extractor/.env → ConvertProgram/.env 순서로 탐색.
    """
    if os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        return True
    candidates = [
        ROOT.parent / "xlsx-extractor" / ".env",
        ROOT.parent.parent / "ConvertProgram" / ".env",
    ]
    for env_path in candidates:
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())
        if os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
            return True
    return bool(os.environ.get("AWS_BEARER_TOKEN_BEDROCK"))


def _import_confluence_run():
    """confluence-downloader/run.py 모듈 import (download_page/sanitize_filename/OUTPUT_DIR 재사용)."""
    cd_root = ROOT.parent / "confluence-downloader"
    if str(cd_root) not in sys.path:
        sys.path.insert(0, str(cd_root))
    import run as cd_run  # type: ignore[import-not-found]
    return cd_run


def _confluence_output_dir(cd_run, client, page_id: str, root_id: str, title: str) -> Path:
    """단일 페이지의 output 디렉터리를 ancestors 로 재구성.

    downloader 트리는 root 페이지에서 시작 → 최상위 폴더 = sanitize(root title).
    경로 = OUTPUT_DIR / sanitize(root) / sanitize(중간조상...) / sanitize(title).
    """
    base = Path(cd_run.OUTPUT_DIR)
    san = cd_run.sanitize_filename
    try:
        page = client.get_page(page_id, expand="ancestors")
        ancestors = page.get("ancestors", []) or []
    except Exception:
        ancestors = []
    chain_titles: list[str] = []
    # ★ 정규 규약 = native 다운로더(resolve_output_path)와 동일: root("Design") 포함.
    #   예: Design/컨텐츠 디자인/세계관/콘텐츠 설정/로딩 문구. (bootstrap 794p 와 일치, 중복 방지)
    root_idx = next((i for i, a in enumerate(ancestors) if str(a.get("id")) == str(root_id)), None)
    if root_idx is not None:
        chain_titles = [a.get("title", "") for a in ancestors[root_idx:]]
    elif ancestors:
        chain_titles = [a.get("title", "") for a in ancestors]
    chain_titles.append(title)
    path = base
    for t in chain_titles:
        path = path / san(t)
    return path


def _vector_enabled() -> bool:
    return os.environ.get("PROJK_VECTOR_INDEX", "1") != "0"


def _update_vector_db(source: str, items: list[tuple]) -> int:
    """변경된 content.md 들을 벡터 DB(ChromaDB project_k)에 반영.

    items: [(resource_path, content_md_path), ...].
    절차: purge_chromadb_chunks(중복 방지 선행) → chunk_file → index_chunks(Titan 임베딩+upsert).
    Klaud 빠른검색(의미검색)이 이 컬렉션을 조회하므로 마크다운 인덱스와 함께 최신화한다.
    chromadb/qna-poc indexer 미가용이면 graceful skip (마크다운 인덱싱엔 영향 없음).
    """
    if not _vector_enabled() or not items:
        return 0
    try:
        import chromadb  # noqa: F401
        qna_src = ROOT.parent / "qna-poc"
        if str(qna_src) not in sys.path:
            sys.path.insert(0, str(qna_src))
        from src.indexer import chunk_file, index_chunks  # type: ignore[import-not-found]
    except Exception as e:
        print(f"   ⚠ 벡터 인덱싱 모듈 미가용 — skip (마크다운만): {e}")
        return 0
    if not _load_bedrock_env():
        print("   ⚠ Titan 임베딩 자격 미설정 — 벡터 인덱싱 skip")
        return 0
    # 1) 중복 방지: 기존 청크 purge (append-only 라 재인덱싱 시 dup)
    state.purge_chromadb_chunks(source, [rp for rp, _ in items])
    # 2) chunk + embed + index
    source_type = "confluence" if source.startswith("confluence") else "excel"
    chunks = []
    from pathlib import Path as _P
    for rp, cm in items:
        try:
            chunks += chunk_file(_P(cm), source_type=source_type)
        except Exception as e:
            print(f"   ⚠ 벡터 chunk 실패 {rp}: {e}")
    if chunks:
        try:
            index_chunks(chunks, reset=False)
            print(f"   🧬 벡터 DB: {len(items)}개 리소스 → {len(chunks)} 청크 임베딩·반영")
        except Exception as e:
            print(f"   ⚠ 벡터 index_chunks 실패: {e}")
            return 0
    return len(chunks)


def _rebuild_markdown_indexes() -> None:
    """MASTER_INDEX + TERM_INDEX 재집계 (LLM 없음, run 당 1회)."""
    py = sys.executable
    for script in ("build_master_index.py", "build_term_index.py"):
        print(f"   ▶ {script} 재집계…")
        import subprocess
        r = subprocess.run([py, str(HERE / script)], cwd=str(ROOT))
        if r.returncode != 0:
            print(f"   ⚠ {script} exit={r.returncode}")


def _build_summary_for(content_md: Path) -> bool:
    """단일 content.md 의 요약 생성 (build_summaries --file). 성공 여부."""
    import subprocess
    py = sys.executable
    r = subprocess.run(
        [py, str(HERE / "build_summaries.py"), "--file", str(content_md), "--workers", "1"],
        cwd=str(ROOT), env=os.environ.copy(),
    )
    return r.returncode == 0


def _stale_resources(source: str, only: str | None, limit: int | None) -> list[dict]:
    res = [r for r in state.list_resources(source=source, limit=100000)
           if r["status"] in {"stale", "failed"}]
    if only:
        res = [r for r in res if re.search(only, r["resource_path"])]
    if limit:
        res = res[:limit]
    return res


def _reindex_confluence(source: str, resources: list[dict], args) -> tuple[int, int, bool]:
    """confluence stale/failed → download_page + build_summaries. (ok, fail, indexed_any)."""
    client, root_id = _confluence_setup(source)
    if client is None:
        print(f"   ⚠ {source}: confluence 설정 미비 — skip")
        return 0, 0, False
    cd_run = _import_confluence_run()
    # 이미지 첨부는 현재 자격으로 /wiki/download/ 가 401 → 항상 skip(text-only).
    # (속도·로그 노이즈 개선. 이미지 인증 해결 시 PROJK_CONFLUENCE_IMAGES=1 로 켤 수 있게.)
    no_images = os.environ.get("PROJK_CONFLUENCE_IMAGES", "0") != "1"
    ok = fail = 0
    indexed_any = False
    vec_items: list[tuple] = []   # (resource_path, content_md) — 벡터 DB 갱신용
    for i, r in enumerate(resources, 1):
        pid = r.get("resource_id")
        title = r["resource_path"]
        if not pid:
            print(f"   [{i}/{len(resources)}] {title}: resource_id(page id) 없음 — skip")
            fail += 1
            continue
        if args.dry_run:
            print(f"   [{i}/{len(resources)}] (dry-run) download+index: {title} (id={pid})")
            continue
        try:
            out_dir = _confluence_output_dir(cd_run, client, pid, root_id, title)
            out_dir.mkdir(parents=True, exist_ok=True)
            dl = cd_run.download_page(client, pid, out_dir, skip_existing=False,
                                      content_type="page", no_images=no_images)
            if dl.get("status") == "error":
                raise RuntimeError(dl.get("error", "download error"))
            content_md = out_dir / "content.md"
            if not content_md.exists():
                raise RuntimeError("content.md 미생성")
            import hashlib
            chash = hashlib.sha256(content_md.read_bytes()).hexdigest()[:16]

            if args.no_index:
                state.upsert_resource(source=source, resource_path=title, resource_id=pid,
                                      content_hash=chash, status="stale")
                print(f"   [{i}/{len(resources)}] ⬇ {title} 다운로드만 (--no-index, stale 유지)")
                ok += 1
                continue

            if not _build_summary_for(content_md):
                raise RuntimeError("build_summaries 실패")
            indexed_any = True
            vec_items.append((title, str(content_md)))
            state.upsert_resource(source=source, resource_path=title, resource_id=pid,
                                  content_hash=chash, chunk_count=1, status="fresh")
            print(f"   [{i}/{len(resources)}] ✅ {title} fetch+index 완료")
            ok += 1
        except Exception as e:
            state.mark_failed(source, title, str(e)[:300])
            print(f"   [{i}/{len(resources)}] ❌ {title}: {e}")
            fail += 1
    if vec_items and not args.no_index:
        _update_vector_db(source, vec_items)
    return ok, fail, indexed_any


def _load_p4_env() -> bool:
    """P4 자격(P4PORT/P4USER/P4PASSWD/P4CLIENT) 을 scripts/.env 에서 환경에 로드."""
    if os.environ.get("P4PORT") and os.environ.get("P4CLIENT"):
        return True
    env_path = ROOT.parent.parent / "scripts" / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())
    return bool(os.environ.get("P4PORT"))


def _gdd_category(resource_path: str) -> str | None:
    """resource_path('Design/7_System/PK_X.xlsx') → '7_System'/'8_Contents'. 그 외 None."""
    for cat in ("7_System", "8_Contents"):
        if f"/{cat}/" in f"/{resource_path}":
            return cat
    return None


def _reindex_p4_gdd(source: str, resources: list[dict], args) -> tuple[int, int, bool]:
    """p4 GDD(7_System/8_Contents) stale → p4 sync → OnlyOffice 변환 → build_summaries.

    (ok, fail, indexed_any). DataSheet(Resource/design)는 여기서 처리하지 않음(별 ingest).
    """
    import subprocess
    if not _load_p4_env():
        print("   ⚠ p4-xlsx: P4 자격 미설정 — skip")
        return 0, 0, False
    py = os.environ.get("PROJK_CRAWL_PYTHON", sys.executable)
    extractor = ROOT.parent / "xlsx-extractor"
    out_base = os.environ.get("PROJK_GDD_OUTPUT", str(extractor / "output"))
    gdd_local = os.environ.get("PROJK_GDD_LOCAL", "/home/jacob/p4sync/Design")
    oo_url = os.environ.get("PROJK_ONLYOFFICE_URL", "http://localhost:8080")
    ok = fail = 0
    indexed_any = False
    vec_items: list[tuple] = []   # (resource_path, content_md) — 벡터 DB 갱신용
    for i, r in enumerate(resources, 1):
        rp = r["resource_path"]
        depot = r.get("resource_id") or f"//main/ProjectK/{rp}"
        cat = _gdd_category(rp)
        if cat is None:
            # 7,8 외(예: Resource/design)는 GDD 변환 대상 아님 — skip (별 파이프라인)
            print(f"   [{i}/{len(resources)}] {rp}: GDD(7/8) 아님 — skip")
            continue
        stem = Path(rp).stem
        if args.dry_run:
            print(f"   [{i}/{len(resources)}] (dry-run) sync+convert: {rp} → {cat}")
            continue
        try:
            # 1) p4 sync (변경 파일만)
            subprocess.run(["p4", "sync", depot], capture_output=True, text=True, timeout=300)
            local_xlsx = Path(gdd_local) / cat / Path(rp).name
            if not local_xlsx.exists():
                raise RuntimeError(f"sync 후 로컬 파일 없음: {local_xlsx}")
            if args.no_index:
                state.upsert_resource(source=source, resource_path=rp, resource_id=depot,
                                      status="stale")
                print(f"   [{i}/{len(resources)}] ⬇ {stem} sync만 (--no-index)")
                ok += 1
                continue
            # 2) OnlyOffice 변환 (full pipeline)
            proc = subprocess.run(
                [py, "run.py", str(local_xlsx), "--output", f"{out_base}/{cat}",
                 "--capture-backend", "onlyoffice", "--onlyoffice-url", oo_url, "--parallel", "4"],
                cwd=str(extractor), capture_output=True, text=True, timeout=3600)
            if proc.returncode != 0:
                raise RuntimeError(f"변환 실패: {proc.stderr[-200:] or proc.stdout[-200:]}")
            # 3) 요약 (해당 워크북만)
            s = subprocess.run([py, "scripts/build_summaries.py", "--workbook", stem, "--workers", "4"],
                               cwd=str(ROOT), env=os.environ.copy(), capture_output=True, text=True, timeout=900)
            if s.returncode != 0:
                raise RuntimeError(f"요약 실패: {s.stderr[-200:]}")
            indexed_any = True
            sheet_cms = list((Path(out_base) / cat / stem).rglob("content.md"))
            nsheets = len(sheet_cms)
            for cm in sheet_cms:
                vec_items.append((rp, str(cm)))
            import hashlib
            chash = hashlib.sha256(local_xlsx.read_bytes()).hexdigest()[:16]
            state.upsert_resource(source=source, resource_path=rp, resource_id=depot,
                                  content_hash=chash, chunk_count=nsheets, status="fresh")
            print(f"   [{i}/{len(resources)}] ✅ {stem} 변환+요약 ({nsheets} sheets)")
            ok += 1
        except Exception as e:
            state.mark_failed(source, rp, str(e)[:300])
            print(f"   [{i}/{len(resources)}] ❌ {stem}: {e}")
            fail += 1
    if vec_items and not args.no_index:
        _update_vector_db(source, vec_items)
    return ok, fail, indexed_any


def _refresh_datasheet(args) -> bool:
    """DataSheet(Resource/design) p4 변경 있으면 sync + game_data.db 재빌드. 변경 인덱싱 여부 반환."""
    import subprocess
    if not _load_p4_env():
        print("   ⚠ DataSheet: P4 자격 미설정 — skip")
        return False
    depot = os.environ.get("PROJK_DATASHEET_DEPOT", "//main/ProjectK/Resource/design/...")
    local = os.environ.get("PROJK_DATASHEET_LOCAL", "/home/jacob/p4sync/Resource/design")
    # 변경 감지 (baseline kv 이후)
    last = state.get_kv("p4_datasheet_cl")
    p4 = _import_p4()
    changes = p4.list_changes_since(int(last) if last else None, [depot], max_changelists=50) if p4 else []
    if last and not changes:
        print("   DataSheet: 변경 없음 (skip 재빌드)")
        return False
    if args.dry_run:
        print(f"   (dry-run) DataSheet 변경 {len(changes)}건 → sync+ingest 예정")
        return False
    print(f"   DataSheet: 변경 {len(changes)}건 → p4 sync + game_data.db 재빌드")
    subprocess.run(["p4", "sync", depot], capture_output=True, text=True, timeout=600)
    py = os.environ.get("PROJK_CRAWL_PYTHON", sys.executable)
    dp = ROOT.parent / "data-pipeline"
    r = subprocess.run(
        [py, "-c",
         "import importlib.util,sys;"
         f"spec=importlib.util.spec_from_file_location('gd',r'{dp}/src/game_data.py');"
         "gd=importlib.util.module_from_spec(spec);spec.loader.exec_module(gd);"
         f"rep=gd.ingest_all(r'{local}');print('ingest:',rep.get('tables_created'),'tables',rep.get('total_rows'),'rows')"],
        cwd=str(dp), capture_output=True, text=True, timeout=600)
    print("   " + (r.stdout.strip() or r.stderr[-200:]))
    if r.returncode == 0:
        newcl = p4.latest_changelist(depot) if p4 else None
        if newcl:
            state.set_kv("p4_datasheet_cl", str(newcl))
    return r.returncode == 0


def cmd_reindex_run(args: argparse.Namespace) -> int:
    sources = [args.source] if args.source else sorted(state.VALID_SOURCES)
    if not args.dry_run and not args.no_index and not _load_bedrock_env():
        print("⚠ AWS_BEARER_TOKEN_BEDROCK 미설정 — 요약 생성 불가. --no-index 로 다운로드만 하거나 자격 설정 필요.")
        return 1

    total_ok = total_fail = 0
    indexed_any = False
    for src in sources:
        resources = _stale_resources(src, args.only, args.limit)
        print(f"\n♻ reindex-run: {src} — 대상 {len(resources)}개 (stale/failed)")
        if not resources:
            continue
        if src.startswith("confluence-"):
            ok, fail, idx = _reindex_confluence(src, resources, args)
        elif src == "p4-xlsx":
            ok, fail, idx = _reindex_p4_gdd(src, resources, args)
        else:
            ok = fail = 0
            idx = False
        total_ok += ok
        total_fail += fail
        indexed_any |= idx

    if indexed_any and not args.dry_run and not args.no_index:
        print("\n📚 MASTER/TERM 인덱스 재집계 (run 당 1회)…")
        _rebuild_markdown_indexes()

    print(f"\n✅ reindex-run 완료 — 성공 {total_ok}, 실패 {total_fail}"
          + (" (dry-run)" if args.dry_run else ""))
    return 0


# ── sync (원샷: cron-tick → reindex-run → report) ────────────────────


def cmd_sync(args: argparse.Namespace) -> int:
    """수동/cron 원샷: 변경 감지 → 실 fetch+인덱싱 → report 갱신. flock 으로 중복 방지."""
    import fcntl
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = DATA_DIR / "crawl.lock"
    lock_f = open(lock_path, "w")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("⚠ 다른 sync 가 이미 실행 중 (crawl.lock) — 종료")
        return 0

    try:
        print("═" * 60)
        print("STEP 1/3 — cron-tick (변경 감지 → stale 표시)")
        print("═" * 60)
        rc = cmd_cron_tick(args)
        if rc != 0:
            print(f"⚠ cron-tick rc={rc}")

        print("\n" + "═" * 60)
        print("STEP 2/4 — reindex-run (Confluence + p4 GDD: stale 실 fetch + 인덱싱)")
        print("═" * 60)
        cmd_reindex_run(args)

        print("\n" + "═" * 60)
        print("STEP 3/4 — DataSheet (Resource/design → game_data.db 재빌드, 변경 시)")
        print("═" * 60)
        try:
            _refresh_datasheet(args)
        except Exception as e:
            print(f"   ⚠ DataSheet 갱신 실패: {e}")

        purge = getattr(args, "purge", False) and not getattr(args, "dry_run", False)
        print("\n" + "═" * 60)
        print(f"STEP 4/4 — report (set-diff JSON 갱신{', 검증 기반 자동 purge' if purge else ''})")
        print("═" * 60)
        report_args = argparse.Namespace(source=args.source, json=False, purge_missing=purge)
        cmd_report(report_args)
        print("\n✅ sync 완료")
        return 0
    finally:
        fcntl.flock(lock_f, fcntl.LOCK_UN)
        lock_f.close()


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

    p_report = sub.add_parser("report", help="upstream 전수 vs 로컬 set-diff (fresh/받아야할것/삭제됨, read-only)")
    p_report.add_argument("--source", choices=sorted(state.VALID_SOURCES))
    p_report.add_argument("--json", action="store_true", help="전체 결과 JSON 도 stdout 출력")
    p_report.add_argument("--purge-missing", action="store_true",
                          help="upstream 에서 사라진 로컬 리소스를 purged 처리 (기본 read-only)")
    p_report.set_defaults(func=cmd_report)

    p_rin = sub.add_parser("reindex-run", help="stale/failed 리소스 실 fetch + 변환 + 인덱싱 (⚠ Bedrock 비용)")
    p_rin.add_argument("--source", choices=sorted(state.VALID_SOURCES))
    p_rin.add_argument("--limit", type=int, help="처리 개수 상한 (PoC: --limit 1 권장)")
    p_rin.add_argument("--only", help="resource_path 정규식 필터")
    p_rin.add_argument("--no-index", action="store_true", help="다운로드만, 요약/인덱싱 skip (stale 유지)")
    p_rin.add_argument("--dry-run", action="store_true", help="대상만 출력, 실제 fetch 안 함")
    p_rin.set_defaults(func=cmd_reindex_run)

    p_sync = sub.add_parser("sync", help="원샷: cron-tick → reindex-run → report (flock 직렬화, systemd timer 용)")
    p_sync.add_argument("--source", choices=sorted(state.VALID_SOURCES))
    p_sync.add_argument("--limit", type=int)
    p_sync.add_argument("--only")
    p_sync.add_argument("--no-index", action="store_true")
    p_sync.add_argument("--dry-run", action="store_true")
    p_sync.add_argument("--purge", action="store_true",
                        help="저장소에서 삭제/이동된 리소스를 검증 후 로컬 자동 purge (오삭제 방지 검증 포함)")
    p_sync.set_defaults(func=cmd_sync)

    args = parser.parse_args()
    _load_crawl_env()
    state.init()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
