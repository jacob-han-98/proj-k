import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDatabase,
  createThread,
  getThread,
  listThreads,
  renameThread,
  archiveThread,
  deleteThread,
  appendMessage,
  listMessages,
  listCitations,
  upsertThreadDoc,
  listThreadDocs,
  setThreadDocPinned,
  type DB,
} from '../../src/main/db/threads-db';
import { LATEST_VERSION } from '../../src/main/db/schema';

let db: DB;

beforeEach(async () => {
  db = await openDatabase(':memory:');
});

describe('migrations', () => {
  it('applies latest schema version on a fresh in-memory db', () => {
    const v = db.pragma('user_version', { simple: true });
    expect(v).toBe(LATEST_VERSION);
  });

  it('creates expected tables', () => {
    const tables = db
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all();
    const names = tables.map((t) => t.name);
    expect(names).toContain('threads');
    expect(names).toContain('messages');
    expect(names).toContain('citations');
    expect(names).toContain('thread_docs');
  });
});

describe('threads CRUD', () => {
  it('creates and reads a thread', () => {
    const t = createThread(db, { id: 't1', title: '첫 스레드' });
    expect(t.id).toBe('t1');
    expect(t.archived).toBe(0);
    expect(getThread(db, 't1')).toEqual(t);
  });

  it('lists threads in updated_at desc, excludes archived by default', () => {
    createThread(db, { id: 'a', title: 'A' });
    // updated_at 차이 보장을 위해 살짝 wait — 같은 ms 일 수 있어 명시적 update
    const t2 = createThread(db, { id: 'b', title: 'B' });
    db.prepare(`UPDATE threads SET updated_at = ? WHERE id = 'a'`).run(t2.updated_at + 1000);

    const all = listThreads(db);
    expect(all.map((t) => t.id)).toEqual(['a', 'b']);

    archiveThread(db, 'a');
    expect(listThreads(db).map((t) => t.id)).toEqual(['b']);
    expect(listThreads(db, { includeArchived: true }).map((t) => t.id)).toContain('a');
  });

  it('rename updates title and updated_at', () => {
    const t = createThread(db, { id: 'r1', title: '옛 제목' });
    renameThread(db, 'r1', '새 제목');
    const after = getThread(db, 'r1');
    expect(after?.title).toBe('새 제목');
    expect(after!.updated_at).toBeGreaterThanOrEqual(t.updated_at);
  });

  it('delete removes thread and cascades messages + citations + thread_docs', () => {
    createThread(db, { id: 'd1', title: 'D' });
    appendMessage(db, {
      id: 'm1',
      thread_id: 'd1',
      role: 'user',
      content: '질문',
      meta_json: null,
      citations: [
        { doc_type: 'xlsx', doc_id: 'PK_HUD', doc_title: 'HUD', snippet: 's', score: 0.9, rank: 0, url: null },
      ],
    });
    upsertThreadDoc(db, { thread_id: 'd1', doc_id: 'PK_HUD', doc_type: 'xlsx', doc_title: 'HUD', pinned: 0 });

    deleteThread(db, 'd1');
    expect(getThread(db, 'd1')).toBeNull();
    expect(listMessages(db, 'd1')).toEqual([]);
    expect(listThreadDocs(db, 'd1')).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM citations`).get()).toEqual({ n: 0 });
  });
});

describe('messages + citations', () => {
  beforeEach(() => {
    createThread(db, { id: 't', title: 'T' });
  });

  it('appends a message with citations atomically', () => {
    const m = appendMessage(db, {
      id: 'm1',
      thread_id: 't',
      role: 'assistant',
      content: '답변 본문',
      meta_json: JSON.stringify({ model: 'claude' }),
      citations: [
        { doc_type: 'xlsx', doc_id: 'PK_HUD', doc_title: 'HUD', snippet: 's1', score: 0.91, rank: 0, url: null },
        { doc_type: 'confluence', doc_id: 'page42', doc_title: '디자인', snippet: 's2', score: 0.7, rank: 1, url: 'https://x' },
      ],
    });
    expect(m.id).toBe('m1');

    const msgs = listMessages(db, 't');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(JSON.parse(msgs[0].meta_json!)).toEqual({ model: 'claude' });

    const cites = listCitations(db, 'm1');
    expect(cites).toHaveLength(2);
    expect(cites[0].rank).toBe(0); // sorted by rank asc
    expect(cites[1].url).toBe('https://x');
  });

  it('appendMessage touches thread.updated_at', async () => {
    const before = getThread(db, 't')!.updated_at;
    await new Promise((r) => setTimeout(r, 10));
    appendMessage(db, { id: 'mm', thread_id: 't', role: 'user', content: 'q', meta_json: null });
    const after = getThread(db, 't')!;
    expect(after.updated_at).toBeGreaterThan(before);
  });
});

describe('thread_docs', () => {
  beforeEach(() => {
    createThread(db, { id: 't', title: 'T' });
  });

  it('upsert is idempotent on (thread_id, doc_id, doc_type) and refreshes added_at', () => {
    upsertThreadDoc(db, { thread_id: 't', doc_id: 'd1', doc_type: 'xlsx', doc_title: '1', pinned: 0 });
    upsertThreadDoc(db, { thread_id: 't', doc_id: 'd1', doc_type: 'xlsx', doc_title: '갱신', pinned: 0 });
    const docs = listThreadDocs(db, 't');
    expect(docs).toHaveLength(1);
    expect(docs[0].doc_title).toBe('갱신');
  });

  it('setThreadDocPinned sorts pinned first', () => {
    upsertThreadDoc(db, { thread_id: 't', doc_id: 'a', doc_type: 'xlsx', doc_title: 'A', pinned: 0 });
    upsertThreadDoc(db, { thread_id: 't', doc_id: 'b', doc_type: 'xlsx', doc_title: 'B', pinned: 0 });
    setThreadDocPinned(db, 't', 'b', 'xlsx', true);
    const docs = listThreadDocs(db, 't');
    expect(docs[0].doc_id).toBe('b');
    expect(docs[0].pinned).toBe(1);
  });
});
