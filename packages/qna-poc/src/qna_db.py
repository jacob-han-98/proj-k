"""
qna_db.py — QnA 이력 및 피드백 저장 (SQLite)

모든 질문/답변/평가를 기록하여 시스템 품질 개선에 활용.
"""

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "qna_history.db"

_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """스레드별 SQLite 커넥션 (Streamlit 호환)."""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _init_tables(_local.conn)
    return _local.conn


def _init_tables(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS qna_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            role TEXT,
            confidence TEXT,
            total_tokens INTEGER DEFAULT 0,
            api_seconds REAL DEFAULT 0,
            sources_json TEXT,
            trace_json TEXT,
            planning_model TEXT,
            answer_model TEXT,
            reflection_model TEXT,
            max_chunks INTEGER
        );

        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            qna_id INTEGER NOT NULL,
            rating TEXT NOT NULL,
            comment TEXT DEFAULT '',
            FOREIGN KEY (qna_id) REFERENCES qna_history(id)
        );
    """)
    conn.commit()


def save_qna(question: str, answer: str, role: str = None,
             confidence: str = None, total_tokens: int = 0,
             api_seconds: float = 0, sources: list = None,
             trace: list = None, planning_model: str = None,
             answer_model: str = None, reflection_model: str = None,
             max_chunks: int = None) -> int:
    """QnA 이력 저장. 반환: qna_id."""
    conn = _get_conn()
    cur = conn.execute(
        """INSERT INTO qna_history
           (created_at, question, answer, role, confidence,
            total_tokens, api_seconds, sources_json, trace_json,
            planning_model, answer_model, reflection_model, max_chunks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.now().isoformat(),
            question, answer, role, confidence,
            total_tokens, api_seconds,
            json.dumps(sources or [], ensure_ascii=False),
            json.dumps(trace or [], ensure_ascii=False),
            planning_model, answer_model, reflection_model, max_chunks,
        ),
    )
    conn.commit()
    return cur.lastrowid


def save_feedback(qna_id: int, rating: str, comment: str = ""):
    """피드백 저장. rating: 'up' | 'down'."""
    conn = _get_conn()
    # 기존 피드백이 있으면 업데이트
    existing = conn.execute(
        "SELECT id FROM feedback WHERE qna_id = ?", (qna_id,)
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE feedback SET rating = ?, comment = ?, created_at = ? WHERE qna_id = ?",
            (rating, comment, datetime.now().isoformat(), qna_id),
        )
    else:
        conn.execute(
            "INSERT INTO feedback (created_at, qna_id, rating, comment) VALUES (?, ?, ?, ?)",
            (datetime.now().isoformat(), qna_id, rating, comment),
        )
    conn.commit()


def get_stats() -> dict:
    """전체 통계 반환."""
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) FROM qna_history").fetchone()[0]
    up = conn.execute(
        "SELECT COUNT(*) FROM feedback WHERE rating = 'up'"
    ).fetchone()[0]
    down = conn.execute(
        "SELECT COUNT(*) FROM feedback WHERE rating = 'down'"
    ).fetchone()[0]
    return {"total_qna": total, "thumbs_up": up, "thumbs_down": down}
