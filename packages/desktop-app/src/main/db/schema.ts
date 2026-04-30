// 스레드 워크스페이스 SQLite 스키마. main process 에서 better-sqlite3 가 사용.
//
// 마이그레이션 정책:
//   - PRAGMA user_version 으로 schema version 추적.
//   - 부팅 시 현재 version 보다 낮으면 다음 마이그레이션을 순차 실행.
//   - up-only — rollback 안 함 (dev 환경 + 사용자 PC 별 별도 db 라 backup 으로 충분).
//
// 0.1.30+ 에 schema 추가될 때마다 MIGRATIONS 끝에 새 step 추가.

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- 스레드 = 하나의 워크스페이스. 사용자가 시작한 한 흐름.
      CREATE TABLE IF NOT EXISTS threads (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        archived      INTEGER NOT NULL DEFAULT 0
      );

      -- 한 스레드의 메시지 (사용자 질문 + assistant 답변).
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        meta_json     TEXT
      );

      -- 메시지에 매핑된 인용 (검색 hit 또는 cited doc).
      CREATE TABLE IF NOT EXISTS citations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        doc_type      TEXT NOT NULL,
        doc_id        TEXT NOT NULL,
        doc_title     TEXT,
        snippet       TEXT,
        score         REAL,
        rank          INTEGER NOT NULL,
        url           TEXT
      );

      -- 한 스레드의 누적 doc list (사이드바 stickerboard).
      CREATE TABLE IF NOT EXISTS thread_docs (
        thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        doc_id        TEXT NOT NULL,
        doc_type      TEXT NOT NULL,
        doc_title     TEXT,
        added_at      INTEGER NOT NULL,
        pinned        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, doc_id, doc_type)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
