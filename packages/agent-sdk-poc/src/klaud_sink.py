"""
klaud_sink — Klaud 통합 로그 sink + 제보 store.

frontend/main/sidecar/agent 의 로그를 단일 SQLite 에 적재하고, 관리자가 /klaud/logs
GET 으로 조회. 제보 (POST /klaud/report) 는 ts 기준 직전 N분(default 10) 의 로그와
함께 묶임.

설계 메모:
- SQLite 단일 파일 (agent-sdk-poc/data/klaud_log.db). 트래픽 늘면 Postgres migrate.
- emit 은 thread-local queue 로 enqueue (1ms 이내). daemon thread 가 1초 또는 100개
  batch 로 insert. handler 안에서 직접 SQLite write 하면 logging 재귀 위험.
- retention 30일 startup cleanup. 정기 cron 없음 — server restart 또는 매일 자정
  task 가 잘라냄.
- agent 자기 로그는 logging.Handler subclass (`KlaudSinkHandler`) 로 root logger 에
  attach. server.py 의 `log_event()` 도 별도 경로로 enqueue.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ── 상수 ─────────────────────────────────────────────────────────────

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DEFAULT_DB_PATH = _DATA_DIR / "klaud_log.db"

_RETENTION_DAYS = 30
_REPORT_WINDOW_MINUTES = 10  # /klaud/reports/{id} 가 묶는 직전 N분
_QUEUE_MAXSIZE = 10000
_BATCH_MAX = 100
_BATCH_INTERVAL_SEC = 1.0

_BATCH_BODY_LIMIT_MB = 1.0    # POST /klaud/log/batch
_REPORT_BODY_LIMIT_MB = 5.0   # POST /klaud/report (screenshot_b64 포함)

VALID_LEVELS = {"log", "info", "warn", "error"}
VALID_SOURCES = {"renderer", "main", "sidecar", "agent"}


# ── 모듈 상태 ────────────────────────────────────────────────────────

_LOG = logging.getLogger("klaud_sink")
_LOG_QUEUE: queue.Queue = queue.Queue(maxsize=_QUEUE_MAXSIZE)
_WRITER_STARTED = False
_WRITER_LOCK = threading.Lock()
_DB_PATH: Path = _DEFAULT_DB_PATH
_WRITE_CONN: sqlite3.Connection | None = None  # writer thread 전용
_DROPPED_COUNT = 0  # queue.Full 로 떨어진 entry 수 (모니터링)


# ── 스키마 ──────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS klaud_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  ingest_ts TEXT NOT NULL,
  source TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  machine_id TEXT,
  user_email TEXT,
  klaud_version TEXT,
  session_id TEXT,
  extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON klaud_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_user_ts ON klaud_logs(user_email, ts);
CREATE INDEX IF NOT EXISTS idx_logs_mach_sess_ts ON klaud_logs(machine_id, session_id, ts);
CREATE INDEX IF NOT EXISTS idx_logs_level ON klaud_logs(level);

CREATE TABLE IF NOT EXISTS klaud_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_uuid TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  ingest_ts TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  user_email TEXT,
  klaud_version TEXT,
  session_id TEXT,
  note TEXT,
  context_json TEXT,
  screenshot_b64 TEXT,
  log_window_minutes INTEGER NOT NULL DEFAULT 10
);
CREATE INDEX IF NOT EXISTS idx_reports_ts ON klaud_reports(ts);
CREATE INDEX IF NOT EXISTS idx_reports_user_ts ON klaud_reports(user_email, ts);
"""


# ── 초기화 ──────────────────────────────────────────────────────────


def init(db_path: Path | None = None) -> None:
    """SQLite 파일 생성 + 스키마 + writer thread 시작 + retention cleanup.

    server.py startup 에서 1회 호출. 멱등 (이미 시작됐으면 no-op).
    """
    global _WRITER_STARTED, _DB_PATH, _WRITE_CONN

    with _WRITER_LOCK:
        if _WRITER_STARTED:
            return

        _DB_PATH = Path(db_path) if db_path else _DEFAULT_DB_PATH
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)

        # writer thread 전용 connection — daemon thread 에서만 write.
        # check_same_thread=False 로 startup 시 schema/cleanup 도 같이 처리 가능.
        _WRITE_CONN = sqlite3.connect(str(_DB_PATH), check_same_thread=False, isolation_level=None)
        _WRITE_CONN.executescript(_SCHEMA)
        _WRITE_CONN.execute("PRAGMA journal_mode=WAL")
        _WRITE_CONN.execute("PRAGMA synchronous=NORMAL")

        _retention_cleanup()

        t = threading.Thread(target=_writer_loop, name="klaud-log-writer", daemon=True)
        t.start()

        # root logger 에 핸들러 attach — agent 자기 로그를 같은 store 에 적재
        root = logging.getLogger()
        root.addHandler(KlaudSinkHandler())

        _WRITER_STARTED = True
        _LOG.info(f"klaud_sink initialized — db={_DB_PATH}, retention={_RETENTION_DAYS}d")


def _retention_cleanup() -> None:
    """30일 이전 row 삭제. startup + 후속 (옵션) cron 에서 호출."""
    if _WRITE_CONN is None:
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_RETENTION_DAYS)).isoformat()
    try:
        cur = _WRITE_CONN.execute("DELETE FROM klaud_logs WHERE ts < ?", (cutoff,))
        n_logs = cur.rowcount
        cur = _WRITE_CONN.execute(
            "DELETE FROM klaud_reports WHERE ts < ? AND report_uuid NOT IN "
            "(SELECT report_uuid FROM klaud_reports ORDER BY ts DESC LIMIT 1000)",
            (cutoff,),
        )
        # 제보는 무기한 보존이 default 지만, 30일 + 최근 1000건은 유지 — 일단 conservative.
        n_reports = cur.rowcount
        if n_logs or n_reports:
            _LOG.info(f"klaud_sink retention: removed {n_logs} logs / {n_reports} reports")
    except sqlite3.Error as e:
        _LOG.warning(f"klaud_sink retention cleanup failed: {e}")


# ── enqueue (hot path) ─────────────────────────────────────────────


def enqueue_log(entry: dict[str, Any]) -> None:
    """단일 로그 entry 를 queue 에 enqueue. 1ms 이내 반환.

    필수: ts, source, level, message. 나머지 옵셔널.
    queue 가 가득 차면 drop (silent) — 사용자 영향 0 가드.
    """
    global _DROPPED_COUNT
    try:
        _LOG_QUEUE.put_nowait(entry)
    except queue.Full:
        _DROPPED_COUNT += 1
        # 1000건마다 한 번씩만 경고 (스팸 방지)
        if _DROPPED_COUNT % 1000 == 1:
            _LOG.warning(f"klaud_sink queue full — dropped {_DROPPED_COUNT} entries so far")


def ingest_batch(
    entries: list[dict[str, Any]],
    machine_id: str | None,
    user_email: str | None,
    klaud_version: str | None,
    session_id: str | None,
) -> int:
    """frontend POST /klaud/log/batch 의 entry 묶음을 enqueue.

    Returns: 실제 enqueue 된 개수.
    """
    ingest_ts = _now_iso()
    n = 0
    for e in entries:
        if not isinstance(e, dict):
            continue
        ts = e.get("ts") or ingest_ts
        source = e.get("source")
        level = e.get("level", "info")
        message = e.get("message")
        if source not in VALID_SOURCES or message is None:
            continue  # 잘못된 entry 는 silent drop (frontend 책임)
        if level not in VALID_LEVELS:
            level = "info"
        extra = e.get("extra")
        extra_json = json.dumps(extra, ensure_ascii=False) if extra else None
        enqueue_log({
            "ts": str(ts)[:64],
            "ingest_ts": ingest_ts,
            "source": source,
            "level": level,
            "message": str(message)[:8000],
            "machine_id": machine_id,
            "user_email": user_email,
            "klaud_version": klaud_version,
            "session_id": session_id,
            "extra_json": extra_json,
        })
        n += 1
    return n


def insert_report(
    machine_id: str,
    user_email: str | None,
    klaud_version: str | None,
    session_id: str | None,
    note: str | None,
    context: dict | None,
    screenshot_b64: str | None,
    ts: str | None = None,
    window_minutes: int = _REPORT_WINDOW_MINUTES,
) -> str:
    """제보 insert (동기). Returns report_uuid."""
    if _WRITE_CONN is None:
        raise RuntimeError("klaud_sink not initialized")
    if not machine_id:
        raise ValueError("machine_id required")

    report_uuid = str(uuid.uuid4())
    ingest_ts = _now_iso()
    ts = (ts or ingest_ts)[:64]
    context_json = json.dumps(context, ensure_ascii=False) if context else None

    with _WRITER_LOCK:  # write conn 직렬화
        _WRITE_CONN.execute(
            "INSERT INTO klaud_reports "
            "(report_uuid, ts, ingest_ts, machine_id, user_email, klaud_version, "
            " session_id, note, context_json, screenshot_b64, log_window_minutes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                report_uuid, ts, ingest_ts, machine_id, user_email, klaud_version,
                session_id, note, context_json, screenshot_b64, window_minutes,
            ),
        )
    return report_uuid


# ── writer thread ──────────────────────────────────────────────────


def _writer_loop() -> None:
    """daemon thread — queue 를 drain 해서 SQLite 에 batch insert.

    1초 timeout 또는 100건 차면 flush.
    """
    while True:
        batch: list[dict[str, Any]] = []
        try:
            entry = _LOG_QUEUE.get(timeout=_BATCH_INTERVAL_SEC)
            batch.append(entry)
            while len(batch) < _BATCH_MAX:
                try:
                    batch.append(_LOG_QUEUE.get_nowait())
                except queue.Empty:
                    break
        except queue.Empty:
            continue

        if not batch or _WRITE_CONN is None:
            continue

        try:
            _WRITE_CONN.executemany(
                "INSERT INTO klaud_logs "
                "(ts, ingest_ts, source, level, message, machine_id, user_email, "
                " klaud_version, session_id, extra_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        e.get("ts"),
                        e.get("ingest_ts") or _now_iso(),
                        e.get("source", "agent"),
                        e.get("level", "info"),
                        e.get("message", ""),
                        e.get("machine_id"),
                        e.get("user_email"),
                        e.get("klaud_version"),
                        e.get("session_id"),
                        e.get("extra_json"),
                    )
                    for e in batch
                ],
            )
        except sqlite3.Error as e:
            print(f"[klaud_sink] batch insert failed (n={len(batch)}): {e}", file=sys.stderr)


# ── logging.Handler — agent 자기 로그 ───────────────────────────────


class KlaudSinkHandler(logging.Handler):
    """agent-sdk-poc 의 logging 출력을 klaud_logs (source='agent') 에 함께 적재.

    re-entrance 방지: handler 내부에서 enqueue 만 함. SQLite write 는 별도 thread.
    """

    _LEVEL_MAP = {
        logging.DEBUG: "log",
        logging.INFO: "info",
        logging.WARNING: "warn",
        logging.ERROR: "error",
        logging.CRITICAL: "error",
    }

    def emit(self, record: logging.LogRecord) -> None:
        # 자기 자신을 무한 enqueue 하지 않도록 — klaud_sink 모듈 자체 로그는 적재 X
        if record.name.startswith("klaud_sink"):
            return
        try:
            ts = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()
            msg = self.format(record) if self.formatter else record.getMessage()
            enqueue_log({
                "ts": ts,
                "ingest_ts": ts,
                "source": "agent",
                "level": self._LEVEL_MAP.get(record.levelno, "info"),
                "message": str(msg)[:8000],
                "extra_json": json.dumps(
                    {"logger": record.name, "pathname": record.pathname, "lineno": record.lineno},
                    ensure_ascii=False,
                ),
            })
        except Exception:
            self.handleError(record)


def enqueue_agent_event(event_type: str, detail: str, session_id: str | None = None) -> None:
    """server.py 의 log_event() hook 용 — agent timeline 에 일관되게 기록."""
    enqueue_log({
        "ts": _now_iso(),
        "ingest_ts": _now_iso(),
        "source": "agent",
        "level": "info",
        "message": f"{event_type}: {detail}"[:8000],
        "session_id": session_id,
        "extra_json": json.dumps({"event_type": event_type}, ensure_ascii=False),
    })


# ── admin 조회 ──────────────────────────────────────────────────────


def query_logs(
    user_email: str | None = None,
    machine_id: str | None = None,
    session_id: str | None = None,
    source: str | None = None,
    level: str | None = None,
    ts_from: str | None = None,
    ts_to: str | None = None,
    cursor: int | None = None,
    limit: int = 500,
) -> list[dict]:
    """admin GET /klaud/logs.

    cursor: id-based pagination (이전 페이지의 마지막 id 보다 큰 row 반환).
    limit: max 5000.
    """
    if _WRITE_CONN is None:
        raise RuntimeError("klaud_sink not initialized")
    limit = max(1, min(int(limit or 500), 5000))

    where: list[str] = []
    params: list[Any] = []
    if user_email:
        where.append("user_email = ?")
        params.append(user_email)
    if machine_id:
        where.append("machine_id = ?")
        params.append(machine_id)
    if session_id:
        where.append("session_id = ?")
        params.append(session_id)
    if source:
        where.append("source = ?")
        params.append(source)
    if level:
        where.append("level = ?")
        params.append(level)
    if ts_from:
        where.append("ts >= ?")
        params.append(ts_from)
    if ts_to:
        where.append("ts <= ?")
        params.append(ts_to)
    if cursor is not None:
        where.append("id > ?")
        params.append(int(cursor))

    sql = "SELECT id, ts, ingest_ts, source, level, message, machine_id, user_email, " \
          "klaud_version, session_id, extra_json FROM klaud_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id ASC LIMIT ?"
    params.append(limit)

    rows = _WRITE_CONN.execute(sql, params).fetchall()
    return [_row_to_log(r) for r in rows]


def query_reports(
    user_email: str | None = None,
    machine_id: str | None = None,
    ts_from: str | None = None,
    ts_to: str | None = None,
    cursor: int | None = None,
    limit: int = 100,
) -> list[dict]:
    if _WRITE_CONN is None:
        raise RuntimeError("klaud_sink not initialized")
    limit = max(1, min(int(limit or 100), 1000))

    where: list[str] = []
    params: list[Any] = []
    if user_email:
        where.append("user_email = ?")
        params.append(user_email)
    if machine_id:
        where.append("machine_id = ?")
        params.append(machine_id)
    if ts_from:
        where.append("ts >= ?")
        params.append(ts_from)
    if ts_to:
        where.append("ts <= ?")
        params.append(ts_to)
    if cursor is not None:
        where.append("id > ?")
        params.append(int(cursor))

    sql = "SELECT id, report_uuid, ts, ingest_ts, machine_id, user_email, klaud_version, " \
          "session_id, note, context_json, log_window_minutes FROM klaud_reports"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id ASC LIMIT ?"
    params.append(limit)

    rows = _WRITE_CONN.execute(sql, params).fetchall()
    return [_row_to_report(r) for r in rows]


def get_report_with_logs(report_uuid: str) -> dict | None:
    """제보 + 직전 N분 로그 묶음."""
    if _WRITE_CONN is None:
        raise RuntimeError("klaud_sink not initialized")

    row = _WRITE_CONN.execute(
        "SELECT id, report_uuid, ts, ingest_ts, machine_id, user_email, klaud_version, "
        "session_id, note, context_json, screenshot_b64, log_window_minutes "
        "FROM klaud_reports WHERE report_uuid = ?",
        (report_uuid,),
    ).fetchone()
    if not row:
        return None

    report = _row_to_report(row, include_screenshot=True)
    window = int(row[11] or _REPORT_WINDOW_MINUTES)

    # 직전 window 분의 같은 (machine_id, session_id) 로그
    try:
        ts_end = row[2]
        ts_dt = datetime.fromisoformat(ts_end.replace("Z", "+00:00"))
        ts_from = (ts_dt - timedelta(minutes=window)).isoformat()
    except (ValueError, AttributeError):
        ts_from = None

    machine_id = row[4]
    session_id = row[7]
    log_rows = _WRITE_CONN.execute(
        "SELECT id, ts, ingest_ts, source, level, message, machine_id, user_email, "
        "klaud_version, session_id, extra_json FROM klaud_logs "
        "WHERE machine_id = ? AND (session_id = ? OR ? IS NULL) "
        + (" AND ts >= ?" if ts_from else "")
        + " AND ts <= ? ORDER BY ts ASC, id ASC LIMIT 5000",
        (
            machine_id,
            session_id,
            session_id,
            *([ts_from] if ts_from else []),
            ts_end,
        ),
    ).fetchall()

    return {
        "report": report,
        "logs": [_row_to_log(r) for r in log_rows],
        "log_window_minutes": window,
    }


def stats() -> dict:
    """관리자/디버그용 — store 상태 요약."""
    if _WRITE_CONN is None:
        return {"initialized": False}
    log_count = _WRITE_CONN.execute("SELECT COUNT(*) FROM klaud_logs").fetchone()[0]
    report_count = _WRITE_CONN.execute("SELECT COUNT(*) FROM klaud_reports").fetchone()[0]
    return {
        "initialized": True,
        "db_path": str(_DB_PATH),
        "log_count": log_count,
        "report_count": report_count,
        "queue_size": _LOG_QUEUE.qsize(),
        "dropped_count": _DROPPED_COUNT,
    }


# ── row → dict ──────────────────────────────────────────────────────


def _row_to_log(r: tuple) -> dict:
    return {
        "id": r[0],
        "ts": r[1],
        "ingest_ts": r[2],
        "source": r[3],
        "level": r[4],
        "message": r[5],
        "machine_id": r[6],
        "user_email": r[7],
        "klaud_version": r[8],
        "session_id": r[9],
        "extra": json.loads(r[10]) if r[10] else None,
    }


def _row_to_report(r: tuple, include_screenshot: bool = False) -> dict:
    out = {
        "id": r[0],
        "report_uuid": r[1],
        "ts": r[2],
        "ingest_ts": r[3],
        "machine_id": r[4],
        "user_email": r[5],
        "klaud_version": r[6],
        "session_id": r[7],
        "note": r[8],
        "context": json.loads(r[9]) if r[9] else None,
    }
    if len(r) > 11 and r[11]:
        out["log_window_minutes"] = r[11]
    if include_screenshot and len(r) > 10:
        out["screenshot_b64"] = r[10]
    return out


# ── 유틸 ────────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def admin_token() -> str | None:
    """env KLAUD_ADMIN_TOKEN — 미설정이면 None (인증 비활성).

    None 이면 GET 들이 403 반환 (운영 안전). 진짜 활성화는 env 설정 필요.
    """
    return os.environ.get("KLAUD_ADMIN_TOKEN") or None
