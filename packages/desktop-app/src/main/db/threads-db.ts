// 스레드 워크스페이스 DB 래퍼. main process 에서만 사용.
//
// 사용자별 db 는 app.getPath('userData')/threads.db. 첫 부팅 시 자동 생성 + 스키마 적용.
// 모든 read/write 는 동기 (better-sqlite3) — main process 안에서 IPC 핸들러가 짧게 호출.
//
// 책임:
//   - DB 연결 lifetime 관리 (process 단위 singleton)
//   - 부팅 시 마이그레이션 실행
//   - Thread / Message / Citation / ThreadDoc CRUD
//   - 단순 트랜잭션 (메시지 + 인용 한 번에 insert 등)
//
// 테스트 가능성: openDatabase(path) 가 ':memory:' 도 받음 → vitest 가 in-memory 로 단위 테스트.

import { openDatabase as openSqlJs, type Database as DB } from './sqljs-wrapper';
import { MIGRATIONS, LATEST_VERSION } from './schema';

export type { DB };

export interface Thread {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: number;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
  meta_json: string | null;
}

export interface Citation {
  id?: number;
  message_id: string;
  doc_type: 'xlsx' | 'confluence';
  doc_id: string;
  doc_title: string | null;
  snippet: string | null;
  score: number | null;
  rank: number;
  url: string | null;
}

export interface ThreadDoc {
  thread_id: string;
  doc_id: string;
  doc_type: 'xlsx' | 'confluence';
  doc_title: string | null;
  added_at: number;
  pinned: number;
}

// ---------- 연결 + 마이그레이션 ----------

export async function openDatabase(path: string): Promise<DB> {
  const db = await openSqlJs(path);
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.save();
  return db;
}

function migrate(db: DB): void {
  const cur = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (cur >= LATEST_VERSION) return;
  for (const m of MIGRATIONS) {
    if (m.version <= cur) continue;
    db.exec(m.sql);
    db.pragma(`user_version = ${m.version}`);
  }
}

// ---------- Thread ----------

export function createThread(db: DB, t: { id: string; title: string }): Thread {
  const now = Date.now();
  const row: Thread = {
    id: t.id,
    title: t.title,
    created_at: now,
    updated_at: now,
    archived: 0,
  };
  db.prepare(
    `INSERT INTO threads (id, title, created_at, updated_at, archived)
     VALUES (@id, @title, @created_at, @updated_at, @archived)`,
  ).run(row);
  return row;
}

export function getThread(db: DB, id: string): Thread | null {
  return (db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as Thread | undefined) ?? null;
}

export function listThreads(db: DB, opts: { includeArchived?: boolean; limit?: number } = {}): Thread[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const where = opts.includeArchived ? '' : 'WHERE archived = 0';
  return db
    .prepare(`SELECT * FROM threads ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as unknown as Thread[];
}

export function renameThread(db: DB, id: string, title: string): void {
  db.prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id);
}

export function archiveThread(db: DB, id: string): void {
  db.prepare(`UPDATE threads SET archived = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function deleteThread(db: DB, id: string): void {
  db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
}

// ---------- Message ----------

export function appendMessage(
  db: DB,
  m: Omit<Message, 'created_at'> & { created_at?: number; citations?: Omit<Citation, 'message_id'>[] },
): Message {
  const now = m.created_at ?? Date.now();
  const row: Message = {
    id: m.id,
    thread_id: m.thread_id,
    role: m.role,
    content: m.content,
    created_at: now,
    meta_json: m.meta_json ?? null,
  };

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, thread_id, role, content, created_at, meta_json)
     VALUES (@id, @thread_id, @role, @content, @created_at, @meta_json)`,
  );
  const insertCite = db.prepare(
    `INSERT INTO citations (message_id, doc_type, doc_id, doc_title, snippet, score, rank, url)
     VALUES (@message_id, @doc_type, @doc_id, @doc_title, @snippet, @score, @rank, @url)`,
  );
  const touchThread = db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`);

  const tx = db.transaction(() => {
    insertMessage.run(row);
    if (m.citations) {
      for (const c of m.citations) insertCite.run({ ...c, message_id: row.id });
    }
    touchThread.run(now, row.thread_id);
  });
  tx();
  return row;
}

export function listMessages(db: DB, threadId: string): Message[] {
  return db
    .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`)
    .all(threadId) as unknown as Message[];
}

export function listCitations(db: DB, messageId: string): Citation[] {
  return db
    .prepare(`SELECT * FROM citations WHERE message_id = ? ORDER BY rank ASC`)
    .all(messageId) as unknown as Citation[];
}

// ---------- ThreadDoc ----------

export function upsertThreadDoc(
  db: DB,
  d: Omit<ThreadDoc, 'added_at'> & { added_at?: number },
): ThreadDoc {
  const now = d.added_at ?? Date.now();
  const row: ThreadDoc = {
    thread_id: d.thread_id,
    doc_id: d.doc_id,
    doc_type: d.doc_type,
    doc_title: d.doc_title ?? null,
    added_at: now,
    pinned: d.pinned ?? 0,
  };
  // 존재하면 added_at / doc_title 만 갱신, pinned 는 유지.
  db.prepare(
    `INSERT INTO thread_docs (thread_id, doc_id, doc_type, doc_title, added_at, pinned)
     VALUES (@thread_id, @doc_id, @doc_type, @doc_title, @added_at, @pinned)
     ON CONFLICT (thread_id, doc_id, doc_type)
     DO UPDATE SET doc_title = excluded.doc_title, added_at = excluded.added_at`,
  ).run(row);
  return row;
}

export function listThreadDocs(db: DB, threadId: string): ThreadDoc[] {
  return db
    .prepare(`SELECT * FROM thread_docs WHERE thread_id = ? ORDER BY pinned DESC, added_at DESC`)
    .all(threadId) as unknown as ThreadDoc[];
}

export function setThreadDocPinned(
  db: DB,
  threadId: string,
  docId: string,
  docType: ThreadDoc['doc_type'],
  pinned: boolean,
): void {
  db.prepare(
    `UPDATE thread_docs SET pinned = ?
     WHERE thread_id = ? AND doc_id = ? AND doc_type = ?`,
  ).run(pinned ? 1 : 0, threadId, docId, docType);
}
