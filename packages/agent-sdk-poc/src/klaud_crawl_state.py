"""
klaud_crawl_state — P4/Confluence 크롤링 메타 store (릴리스-C).

각 인덱스 가능 리소스 (XLSX 시트 / Confluence 페이지) 의 인덱싱 상태를 SQLite 에
적재. ChromaDB 의 chunk 자체는 별개 — 여기엔 메타만 (last_indexed_at, hash, status,
chunk_count).

운영 흐름:
1. cron-tick → 각 source 의 upstream poll → 변경된 resource 만 fetch + re-index
2. upsert_resource(...) 로 status='fresh' + last_indexed_at = now
3. CLI / web admin: list_resources(...) 로 현황 조회, mark_purged / mark_stale 로 액션
4. purge → ChromaDB 의 chunk 삭제 (별도 호출) + status='purged'
5. reindex → status='stale' (다음 tick 에 재처리)

CLI / endpoint / web UI 모두 같은 store 를 공유 — single source of truth.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── 상수 ─────────────────────────────────────────────────────────────

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DEFAULT_DB_PATH = _DATA_DIR / "crawl_state.db"

VALID_SOURCES = {
    "p4-xlsx",            # P4 의 XLSX 기획서 (xlsx-extractor 가 인덱싱)
    "confluence-projk",   # Project K 기획 Confluence 스페이스
    "confluence-art",     # Art - Project K Confluence 스페이스 (릴리스-C 신설, imageless)
}

VALID_STATUSES = {"fresh", "stale", "failed", "purged"}

_LOG = logging.getLogger("klaud_crawl_state")
_LOCK = threading.Lock()
_CONN: sqlite3.Connection | None = None
_DB_PATH: Path = _DEFAULT_DB_PATH
_LAST_CRON_TICK_AT: str | None = None  # in-memory 마지막 cron-tick 시각

_SCHEMA = """
CREATE TABLE IF NOT EXISTS crawl_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  resource_id TEXT,
  last_modified_upstream TEXT,
  last_indexed_at TEXT,
  content_hash TEXT,
  chunk_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'fresh',
  error_msg TEXT,
  UNIQUE(source, resource_path)
);
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_resources(status, last_indexed_at);
CREATE INDEX IF NOT EXISTS idx_crawl_source ON crawl_resources(source);
CREATE INDEX IF NOT EXISTS idx_crawl_indexed ON crawl_resources(last_indexed_at);

CREATE TABLE IF NOT EXISTS crawl_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON crawl_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_source ON crawl_events(source);
"""


def init(db_path: Path | None = None) -> None:
    """SQLite open + schema. 멱등."""
    global _CONN, _DB_PATH
    with _LOCK:
        if _CONN is not None:
            return
        _DB_PATH = Path(db_path) if db_path else _DEFAULT_DB_PATH
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CONN = sqlite3.connect(str(_DB_PATH), check_same_thread=False, isolation_level=None)
        _CONN.executescript(_SCHEMA)
        _CONN.execute("PRAGMA journal_mode=WAL")
        _CONN.execute("PRAGMA synchronous=NORMAL")
        _LOG.info(f"klaud_crawl_state initialized — db={_DB_PATH}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conn() -> sqlite3.Connection:
    if _CONN is None:
        raise RuntimeError("klaud_crawl_state not initialized — call init() first")
    return _CONN


# ── upsert / mark ────────────────────────────────────────────────────


def upsert_resource(
    source: str,
    resource_path: str,
    resource_id: str | None = None,
    last_modified_upstream: str | None = None,
    content_hash: str | None = None,
    chunk_count: int = 0,
    status: str = "fresh",
    error_msg: str | None = None,
) -> None:
    """리소스 upsert. cron-tick 의 정상 인덱싱 끝나면 호출."""
    if source not in VALID_SOURCES:
        raise ValueError(f"invalid source: {source}")
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status: {status}")
    now = _now()
    with _LOCK:
        _conn().execute(
            """
            INSERT INTO crawl_resources
                (source, resource_path, resource_id, last_modified_upstream,
                 last_indexed_at, content_hash, chunk_count, status, error_msg)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, resource_path) DO UPDATE SET
                resource_id = excluded.resource_id,
                last_modified_upstream = excluded.last_modified_upstream,
                last_indexed_at = excluded.last_indexed_at,
                content_hash = excluded.content_hash,
                chunk_count = excluded.chunk_count,
                status = excluded.status,
                error_msg = excluded.error_msg
            """,
            (source, resource_path, resource_id, last_modified_upstream, now,
             content_hash, chunk_count, status, error_msg),
        )
    _log_event(source, resource_path, "added" if status == "fresh" else status, error_msg)


def mark_purged(source: str, resource_paths: list[str]) -> int:
    """purge — status='purged' (chunk_count 도 0). ChromaDB 의 chunk 삭제는 별도 호출."""
    if not resource_paths:
        return 0
    now = _now()
    n = 0
    with _LOCK:
        for path in resource_paths:
            cur = _conn().execute(
                "UPDATE crawl_resources SET status='purged', chunk_count=0, last_indexed_at=? "
                "WHERE source=? AND resource_path=?",
                (now, source, path),
            )
            if cur.rowcount > 0:
                n += 1
                _log_event(source, path, "purged")
    return n


def mark_stale(source: str, resource_paths: list[str] | None = None, all_in_source: bool = False) -> int:
    """reindex — status='stale'. 다음 cron-tick 에 재처리.

    all_in_source=True 면 해당 source 의 모든 리소스 stale 처리.
    """
    now = _now()
    n = 0
    with _LOCK:
        if all_in_source:
            cur = _conn().execute(
                "UPDATE crawl_resources SET status='stale', last_indexed_at=? "
                "WHERE source=? AND status != 'purged'",
                (now, source),
            )
            n = cur.rowcount
            _log_event(source, "*", "stale_all", f"queued {n}")
        elif resource_paths:
            for path in resource_paths:
                cur = _conn().execute(
                    "UPDATE crawl_resources SET status='stale', last_indexed_at=? "
                    "WHERE source=? AND resource_path=?",
                    (now, source, path),
                )
                if cur.rowcount > 0:
                    n += 1
                    _log_event(source, path, "stale")
    return n


def mark_failed(source: str, resource_path: str, error_msg: str) -> None:
    now = _now()
    with _LOCK:
        _conn().execute(
            "UPDATE crawl_resources SET status='failed', last_indexed_at=?, error_msg=? "
            "WHERE source=? AND resource_path=?",
            (now, error_msg[:500], source, resource_path),
        )
    _log_event(source, resource_path, "failed", error_msg)


# ── query ────────────────────────────────────────────────────────────


def list_resources(
    source: str | None = None,
    status: str | None = None,
    q: str | None = None,
    cursor: int | None = None,
    limit: int = 500,
) -> list[dict]:
    """필터된 리소스 목록. id-cursor pagination."""
    limit = max(1, min(int(limit or 500), 5000))
    where: list[str] = []
    params: list[Any] = []
    if source:
        where.append("source = ?")
        params.append(source)
    if status:
        where.append("status = ?")
        params.append(status)
    if q:
        where.append("resource_path LIKE ?")
        params.append(f"%{q}%")
    if cursor is not None:
        where.append("id > ?")
        params.append(int(cursor))

    sql = (
        "SELECT id, source, resource_path, resource_id, last_modified_upstream, "
        "last_indexed_at, content_hash, chunk_count, status, error_msg "
        "FROM crawl_resources"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id ASC LIMIT ?"
    params.append(limit)

    with _LOCK:
        rows = _conn().execute(sql, params).fetchall()
    return [_row_to_resource(r) for r in rows]


def recent_changes(since_iso: str | None = None, source: str | None = None, limit: int = 500) -> list[dict]:
    """crawl_events 의 시간 역순 — 최근 변화 (added / stale / purged / failed)."""
    limit = max(1, min(int(limit or 500), 5000))
    where: list[str] = []
    params: list[Any] = []
    if since_iso:
        where.append("ts >= ?")
        params.append(since_iso)
    if source:
        where.append("source = ?")
        params.append(source)
    sql = "SELECT ts, source, resource_path, action, detail FROM crawl_events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    with _LOCK:
        rows = _conn().execute(sql, params).fetchall()
    return [
        {"ts": r[0], "source": r[1], "resource_path": r[2], "action": r[3], "detail": r[4]}
        for r in rows
    ]


def stats() -> dict:
    """전체 stats — total / per status / per source / last cron tick."""
    with _LOCK:
        rows = _conn().execute(
            "SELECT status, COUNT(*) FROM crawl_resources GROUP BY status"
        ).fetchall()
        per_status = {r[0]: r[1] for r in rows}
        per_source_rows = _conn().execute(
            "SELECT source, COUNT(*) FROM crawl_resources GROUP BY source"
        ).fetchall()
        per_source = {r[0]: r[1] for r in per_source_rows}
        total = sum(per_status.values())
    return {
        "total": total,
        "per_status": per_status,
        "per_source": per_source,
        "stale": per_status.get("stale", 0),
        "failed": per_status.get("failed", 0),
        "fresh": per_status.get("fresh", 0),
        "purged": per_status.get("purged", 0),
        "last_cron_tick_at": _LAST_CRON_TICK_AT,
        "db_path": str(_DB_PATH),
    }


def set_last_cron_tick(ts_iso: str | None = None) -> None:
    """cron-tick 시작/종료 시 갱신. /admin/klaud 의 헤더 표시용."""
    global _LAST_CRON_TICK_AT
    _LAST_CRON_TICK_AT = ts_iso or _now()


# ── event log ────────────────────────────────────────────────────────


def _log_event(source: str, resource_path: str, action: str, detail: str | None = None) -> None:
    try:
        _conn().execute(
            "INSERT INTO crawl_events (ts, source, resource_path, action, detail) VALUES (?, ?, ?, ?, ?)",
            (_now(), source, resource_path, action, (detail or "")[:500]),
        )
    except sqlite3.Error as e:
        _LOG.warning(f"crawl_event log failed: {e}")


def _row_to_resource(r: tuple) -> dict:
    return {
        "id": r[0],
        "source": r[1],
        "resource_path": r[2],
        "resource_id": r[3],
        "last_modified_upstream": r[4],
        "last_indexed_at": r[5],
        "content_hash": r[6],
        "chunk_count": r[7] or 0,
        "status": r[8],
        "error_msg": r[9],
    }


# ── 테스트 헬퍼 (production 에서도 안전) ───────────────────────────────


def reset_for_test(db_path: Path | None = None) -> None:
    """테스트 전용 — close + 새 DB 로 reinit."""
    global _CONN, _LAST_CRON_TICK_AT
    with _LOCK:
        if _CONN:
            _CONN.close()
            _CONN = None
        _LAST_CRON_TICK_AT = None
    init(db_path)
