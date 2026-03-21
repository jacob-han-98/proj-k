"""
db.py - 데이터 파이프라인 SQLite DB

테이블:
- crawl_sources: 크롤링 소스 (Perforce 경로, Confluence 루트페이지)
- documents: 원본 문서 목록
- conversions: 변환 이력 (버전별, 롤백 지원)
- jobs: 작업큐 (crawler/capturer/converter/indexer)
- issues: 품질 이슈 (기획자 피드백)
- index_snapshots: 인덱스 버전 스냅샷 (롤백 포인트)
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

DEFAULT_DB_PATH = Path.home() / ".data-pipeline" / "pipeline.db"


def get_db_path() -> Path:
    import os
    return Path(os.getenv("PIPELINE_DB_PATH", str(DEFAULT_DB_PATH)))


@contextmanager
def get_conn(db_path: Optional[Path] = None):
    """DB 연결 컨텍스트 매니저."""
    path = db_path or get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Optional[Path] = None):
    """DB 스키마 초기화."""
    with get_conn(db_path) as conn:
        conn.executescript(SCHEMA_SQL)


# ── 스키마 ────────────────────────────────────────────────

SCHEMA_SQL = """
-- 크롤링 소스: Perforce 경로, Confluence 루트 페이지 등
CREATE TABLE IF NOT EXISTS crawl_sources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,          -- 사람이 읽는 이름 (예: "7_System 기획서")
    source_type     TEXT NOT NULL,                 -- perforce | confluence
    path            TEXT NOT NULL,                 -- depot 경로 or root_page_id
    convert_strategy TEXT NOT NULL DEFAULT 'vision-first',
                                                   -- vision-first | table-parser | html-to-md
    properties      TEXT DEFAULT '{}',             -- JSON: 추가 속성
    schedule        TEXT DEFAULT 'manual',          -- manual | hourly | daily | cron식
    enabled         INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- 원본 문서
CREATE TABLE IF NOT EXISTS documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id       INTEGER NOT NULL REFERENCES crawl_sources(id),
    file_path       TEXT NOT NULL,                 -- 원본 파일 경로 (상대)
    file_type       TEXT NOT NULL,                 -- xlsx | md | pptx | html
    file_hash       TEXT,                          -- SHA256 (변경 감지용)
    file_size       INTEGER,
    title           TEXT,                          -- 문서 제목
    metadata        TEXT DEFAULT '{}',             -- JSON: 시트 수, 페이지 버전 등
    status          TEXT DEFAULT 'new',            -- new | crawled | captured | converted | indexed | error
    last_crawled_at TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(source_id, file_path)
);

-- 변환 이력 (버전별 보관 → 롤백 가능)
CREATE TABLE IF NOT EXISTS conversions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id     INTEGER NOT NULL REFERENCES documents(id),
    version         INTEGER NOT NULL DEFAULT 1,
    strategy        TEXT NOT NULL,                 -- 사용된 변환 전략
    stage           TEXT NOT NULL,                 -- capture | vision | parse | synthesize | enrich
    status          TEXT DEFAULT 'pending',        -- pending | running | completed | failed
    input_path      TEXT,                          -- 입력 파일/디렉토리 경로
    output_path     TEXT,                          -- 출력 파일/디렉토리 경로
    quality_score   REAL,                          -- 0.0~1.0 품질 점수
    error_message   TEXT,
    stats           TEXT DEFAULT '{}',             -- JSON: 토큰, 시간, 크기 등
    is_active       INTEGER DEFAULT 1,             -- 현재 서빙 중인 버전 (롤백 시 변경)
    worker_id       TEXT,                          -- 처리한 워커 ID
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(document_id, version, stage)
);

-- 작업큐
CREATE TABLE IF NOT EXISTS jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type        TEXT NOT NULL,                 -- crawl | capture | convert | index
    source_id       INTEGER REFERENCES crawl_sources(id),
    document_id     INTEGER REFERENCES documents(id),
    status          TEXT DEFAULT 'pending',        -- pending | assigned | running | completed | failed | cancelled
    priority        INTEGER DEFAULT 5,             -- 1(최고) ~ 10(최저)
    worker_type     TEXT,                          -- 필요한 워커 타입 (windows | any)
    worker_id       TEXT,                          -- 할당된 워커 ID
    params          TEXT DEFAULT '{}',             -- JSON: 작업 파라미터
    result          TEXT DEFAULT '{}',             -- JSON: 작업 결과
    error_message   TEXT,
    retry_count     INTEGER DEFAULT 0,
    max_retries     INTEGER DEFAULT 3,
    created_at      TEXT DEFAULT (datetime('now')),
    assigned_at     TEXT,
    started_at      TEXT,
    completed_at    TEXT
);

-- 품질 이슈 (기획자 피드백 연동)
CREATE TABLE IF NOT EXISTS issues (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id     INTEGER REFERENCES documents(id),
    issue_type      TEXT NOT NULL,                 -- ocr_error | missing_data | wrong_content | outdated | other
    severity        TEXT DEFAULT 'medium',          -- low | medium | high | critical
    title           TEXT NOT NULL,
    description     TEXT,
    reported_by     TEXT,                          -- 리포터 (기획자 이름/ID)
    status          TEXT DEFAULT 'open',           -- open | in_progress | resolved | wont_fix
    resolution      TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    resolved_at     TEXT
);

-- 인덱스 스냅샷 (롤백 포인트)
CREATE TABLE IF NOT EXISTS index_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_name   TEXT NOT NULL,
    chunk_count     INTEGER,
    document_count  INTEGER,
    chroma_path     TEXT,                          -- ChromaDB 백업 경로
    is_active       INTEGER DEFAULT 0,             -- 현재 서빙 중
    metadata        TEXT DEFAULT '{}',             -- JSON: 포함된 문서 버전 등
    created_at      TEXT DEFAULT (datetime('now'))
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_conversions_document ON conversions(document_id);
CREATE INDEX IF NOT EXISTS idx_conversions_active ON conversions(is_active) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_worker_type ON jobs(worker_type, status);
CREATE INDEX IF NOT EXISTS idx_issues_document ON issues(document_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
""";


# ── 편의 함수 ─────────────────────────────────────────────

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# -- crawl_sources --

def add_source(conn, name: str, source_type: str, path: str,
               convert_strategy: str = "vision-first",
               properties: dict = None, schedule: str = "manual") -> int:
    cur = conn.execute(
        """INSERT INTO crawl_sources (name, source_type, path, convert_strategy, properties, schedule)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (name, source_type, path, convert_strategy,
         json.dumps(properties or {}, ensure_ascii=False), schedule)
    )
    return cur.lastrowid


def list_sources(conn, enabled_only: bool = True) -> list[dict]:
    sql = "SELECT * FROM crawl_sources"
    if enabled_only:
        sql += " WHERE enabled = 1"
    return [dict(r) for r in conn.execute(sql).fetchall()]


def get_source(conn, source_id: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM crawl_sources WHERE id = ?", (source_id,)).fetchone()
    return dict(row) if row else None


# -- documents --

def upsert_document(conn, source_id: int, file_path: str, file_type: str,
                    file_hash: str = None, file_size: int = None,
                    title: str = None, metadata: dict = None) -> int:
    existing = conn.execute(
        "SELECT id FROM documents WHERE source_id = ? AND file_path = ?",
        (source_id, file_path)
    ).fetchone()

    if existing:
        conn.execute(
            """UPDATE documents SET file_hash = ?, file_size = ?, title = ?,
               metadata = ?, last_crawled_at = ?, updated_at = ?
               WHERE id = ?""",
            (file_hash, file_size, title,
             json.dumps(metadata or {}, ensure_ascii=False),
             now_iso(), now_iso(), existing["id"])
        )
        return existing["id"]
    else:
        cur = conn.execute(
            """INSERT INTO documents (source_id, file_path, file_type, file_hash,
               file_size, title, metadata, last_crawled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (source_id, file_path, file_type, file_hash, file_size, title,
             json.dumps(metadata or {}, ensure_ascii=False), now_iso())
        )
        return cur.lastrowid


def get_document(conn, doc_id: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    return dict(row) if row else None


def list_documents(conn, source_id: int = None, status: str = None) -> list[dict]:
    sql = "SELECT * FROM documents WHERE 1=1"
    params = []
    if source_id:
        sql += " AND source_id = ?"
        params.append(source_id)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY updated_at DESC"
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def update_document_status(conn, doc_id: int, status: str):
    conn.execute(
        "UPDATE documents SET status = ?, updated_at = ? WHERE id = ?",
        (status, now_iso(), doc_id)
    )


# -- conversions --

def create_conversion(conn, document_id: int, stage: str, strategy: str,
                      input_path: str = None, version: int = None) -> int:
    if version is None:
        row = conn.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM conversions WHERE document_id = ?",
            (document_id,)
        ).fetchone()
        version = row["v"]

    cur = conn.execute(
        """INSERT INTO conversions (document_id, version, strategy, stage, input_path)
           VALUES (?, ?, ?, ?, ?)""",
        (document_id, version, strategy, stage, input_path)
    )
    return cur.lastrowid


def complete_conversion(conn, conversion_id: int, output_path: str,
                        quality_score: float = None, stats: dict = None):
    conn.execute(
        """UPDATE conversions SET status = 'completed', output_path = ?,
           quality_score = ?, stats = ?, completed_at = ?
           WHERE id = ?""",
        (output_path, quality_score,
         json.dumps(stats or {}, ensure_ascii=False), now_iso(), conversion_id)
    )


def fail_conversion(conn, conversion_id: int, error_message: str):
    conn.execute(
        """UPDATE conversions SET status = 'failed', error_message = ?, completed_at = ?
           WHERE id = ?""",
        (error_message, now_iso(), conversion_id)
    )


def get_active_conversion(conn, document_id: int, stage: str) -> Optional[dict]:
    row = conn.execute(
        """SELECT * FROM conversions
           WHERE document_id = ? AND stage = ? AND is_active = 1
           ORDER BY version DESC LIMIT 1""",
        (document_id, stage)
    ).fetchone()
    return dict(row) if row else None


def rollback_conversion(conn, document_id: int, stage: str, to_version: int):
    """특정 버전으로 롤백."""
    conn.execute(
        "UPDATE conversions SET is_active = 0 WHERE document_id = ? AND stage = ?",
        (document_id, stage)
    )
    conn.execute(
        """UPDATE conversions SET is_active = 1
           WHERE document_id = ? AND stage = ? AND version = ?""",
        (document_id, stage, to_version)
    )


def list_conversion_history(conn, document_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT * FROM conversions WHERE document_id = ? ORDER BY version DESC, stage",
        (document_id,)
    ).fetchall()]


# -- jobs --

def create_job(conn, job_type: str, source_id: int = None, document_id: int = None,
               priority: int = 5, worker_type: str = "any",
               params: dict = None) -> int:
    cur = conn.execute(
        """INSERT INTO jobs (job_type, source_id, document_id, priority, worker_type, params)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (job_type, source_id, document_id, priority, worker_type,
         json.dumps(params or {}, ensure_ascii=False))
    )
    return cur.lastrowid


def claim_job(conn, worker_id: str, worker_types: list[str] = None) -> Optional[dict]:
    """워커가 작업을 가져감. worker_types로 처리 가능한 타입 필터."""
    if worker_types:
        placeholders = ",".join("?" for _ in worker_types)
        sql = f"""SELECT * FROM jobs
                  WHERE status = 'pending'
                  AND (worker_type IN ({placeholders}) OR worker_type = 'any')
                  ORDER BY priority ASC, created_at ASC
                  LIMIT 1"""
        row = conn.execute(sql, worker_types).fetchone()
    else:
        row = conn.execute(
            """SELECT * FROM jobs WHERE status = 'pending'
               ORDER BY priority ASC, created_at ASC LIMIT 1"""
        ).fetchone()

    if not row:
        return None

    conn.execute(
        """UPDATE jobs SET status = 'assigned', worker_id = ?, assigned_at = ?
           WHERE id = ? AND status = 'pending'""",
        (worker_id, now_iso(), row["id"])
    )
    return dict(row)


def start_job(conn, job_id: int):
    conn.execute(
        "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?",
        (now_iso(), job_id)
    )


def complete_job(conn, job_id: int, result: dict = None):
    conn.execute(
        """UPDATE jobs SET status = 'completed', result = ?, completed_at = ?
           WHERE id = ?""",
        (json.dumps(result or {}, ensure_ascii=False), now_iso(), job_id)
    )


def fail_job(conn, job_id: int, error_message: str):
    row = conn.execute("SELECT retry_count, max_retries FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row and row["retry_count"] < row["max_retries"]:
        conn.execute(
            """UPDATE jobs SET status = 'pending', error_message = ?,
               retry_count = retry_count + 1, worker_id = NULL, assigned_at = NULL
               WHERE id = ?""",
            (error_message, job_id)
        )
    else:
        conn.execute(
            """UPDATE jobs SET status = 'failed', error_message = ?, completed_at = ?
               WHERE id = ?""",
            (error_message, now_iso(), job_id)
        )


def list_jobs(conn, status: str = None, job_type: str = None, limit: int = 50) -> list[dict]:
    sql = "SELECT * FROM jobs WHERE 1=1"
    params = []
    if status:
        sql += " AND status = ?"
        params.append(status)
    if job_type:
        sql += " AND job_type = ?"
        params.append(job_type)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def get_job_stats(conn) -> dict:
    rows = conn.execute(
        "SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status"
    ).fetchall()
    return {r["status"]: r["cnt"] for r in rows}


# -- issues --

def create_issue(conn, document_id: int, issue_type: str, title: str,
                 description: str = None, reported_by: str = None,
                 severity: str = "medium") -> int:
    cur = conn.execute(
        """INSERT INTO issues (document_id, issue_type, severity, title, description, reported_by)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (document_id, issue_type, severity, title, description, reported_by)
    )
    return cur.lastrowid


def list_issues(conn, status: str = None, document_id: int = None) -> list[dict]:
    sql = "SELECT i.*, d.file_path, d.title as doc_title FROM issues i LEFT JOIN documents d ON i.document_id = d.id WHERE 1=1"
    params = []
    if status:
        sql += " AND i.status = ?"
        params.append(status)
    if document_id:
        sql += " AND i.document_id = ?"
        params.append(document_id)
    sql += " ORDER BY i.created_at DESC"
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def resolve_issue(conn, issue_id: int, resolution: str):
    conn.execute(
        "UPDATE issues SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?",
        (resolution, now_iso(), issue_id)
    )


# -- index_snapshots --

def create_snapshot(conn, snapshot_name: str, chunk_count: int,
                    document_count: int, chroma_path: str = None,
                    metadata: dict = None) -> int:
    cur = conn.execute(
        """INSERT INTO index_snapshots (snapshot_name, chunk_count, document_count,
           chroma_path, metadata) VALUES (?, ?, ?, ?, ?)""",
        (snapshot_name, chunk_count, document_count, chroma_path,
         json.dumps(metadata or {}, ensure_ascii=False))
    )
    return cur.lastrowid


def activate_snapshot(conn, snapshot_id: int):
    """특정 스냅샷을 활성화 (롤백)."""
    conn.execute("UPDATE index_snapshots SET is_active = 0")
    conn.execute(
        "UPDATE index_snapshots SET is_active = 1 WHERE id = ?",
        (snapshot_id,)
    )


def get_active_snapshot(conn) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM index_snapshots WHERE is_active = 1"
    ).fetchone()
    return dict(row) if row else None


# -- 통계 --

def get_pipeline_stats(conn) -> dict:
    """Admin 대시보드용 전체 통계."""
    doc_stats = conn.execute(
        "SELECT status, COUNT(*) as cnt FROM documents GROUP BY status"
    ).fetchall()

    job_stats = conn.execute(
        "SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status"
    ).fetchall()

    issue_stats = conn.execute(
        "SELECT status, COUNT(*) as cnt FROM issues GROUP BY status"
    ).fetchall()

    source_count = conn.execute("SELECT COUNT(*) as cnt FROM crawl_sources WHERE enabled = 1").fetchone()
    doc_count = conn.execute("SELECT COUNT(*) as cnt FROM documents").fetchone()
    active_snapshot = get_active_snapshot(conn)

    return {
        "sources": source_count["cnt"],
        "documents": {
            "total": doc_count["cnt"],
            "by_status": {r["status"]: r["cnt"] for r in doc_stats},
        },
        "jobs": {r["status"]: r["cnt"] for r in job_stats},
        "issues": {r["status"]: r["cnt"] for r in issue_stats},
        "active_snapshot": active_snapshot,
    }


if __name__ == "__main__":
    import sys
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    init_db(db_path)
    path = db_path or get_db_path()
    print(f"DB initialized: {path}")

    with get_conn(db_path) as conn:
        stats = get_pipeline_stats(conn)
        print(f"Sources: {stats['sources']}, Documents: {stats['documents']['total']}")
