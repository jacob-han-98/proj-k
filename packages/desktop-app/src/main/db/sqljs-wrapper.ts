// sql.js 위의 가벼운 wrapper. better-sqlite3 와 비슷한 시그니처 제공해서
// threads-db.ts 의 코드를 native module 변경 없이 동작하게 한다.
//
// 차이점:
//   - 초기화는 async (`await openDatabase(path)`).
//   - 영속화는 in-memory + dirty flag → file flush. 호출자가 save() 또는
//     close() 시 disk 에 export. main process 의 IPC 핸들러가 매 mutation 후 save() 권장.
//   - WAL 등 SQLite 고급 기능 일부 미지원 (sql.js 의 SQLite WASM 빌드는 기본 mode).

import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let SQL: SqlJsStatic | null = null;

async function ensureSql(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  // node_modules/sql.js/dist/sql-wasm.wasm 의 절대경로를 명시 → asar 안에서도 정상 load.
  // (default fetch 는 file:// 환경에서 깨질 수 있음.)
  let locate: ((file: string) => string) | undefined;
  try {
    // require.resolve 는 dev 와 packaged(asar) 모두 동작.
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    locate = () => wasmPath;
  } catch {
    // resolve fail 시 default 로 둠.
  }
  SQL = await initSqlJs(locate ? { locateFile: locate } : undefined);
  return SQL;
}

export interface Statement<R = Record<string, unknown>> {
  run: (...params: unknown[]) => void;
  get: (...params: unknown[]) => R | undefined;
  all: (...params: unknown[]) => R[];
}

export interface Database {
  prepare<R = Record<string, unknown>>(sql: string): Statement<R>;
  exec: (sql: string) => void;
  pragma: (sql: string, opts?: { simple?: boolean }) => unknown;
  transaction: <T>(fn: () => T) => () => T;
  save: () => void;
  close: () => void;
}

type BindArg = unknown[] | Record<string, unknown>;

function asBindArg(params: unknown[]): BindArg {
  // 단일 객체: 명명 binding (`.run({id, title, ...})`).
  if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
    const obj = params[0] as Record<string, unknown>;
    const named: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      named['@' + k] = v;
      named[':' + k] = v;
      named['$' + k] = v;
    }
    return named;
  }
  // 단일 array: 그대로 positional (`.run([a, b])`).
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0];
  }
  // rest: 한 개든 여러 개든 array 로 wrap (`.run(threadId)` 또는 `.run(a, b)`).
  return params;
}

// number/string/null 등의 SQL 값을 sql.js 의 bind 가 안전히 받을 수 있는 형태로 강제.
// 우리 SQLite 컬럼은 INTEGER / TEXT / REAL 만 사용 — boolean 은 0/1 로 변환.
function coerce(arg: BindArg): BindArg {
  const fix = (v: unknown): unknown => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };
  if (Array.isArray(arg)) return arg.map(fix);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(arg)) out[k] = fix(v);
  return out;
}

export async function openDatabase(path: string): Promise<Database> {
  const SQL = await ensureSql();
  let db: SqlJsDatabase;
  if (path !== ':memory:' && existsSync(path)) {
    const buf = readFileSync(path);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }

  let dirty = false;
  const save = () => {
    if (path === ':memory:') return;
    if (!dirty) return;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = db.export();
    writeFileSync(path, Buffer.from(data));
    dirty = false;
  };

  const wrap = (): Database => ({
    prepare<R = Record<string, unknown>>(sql: string): Statement<R> {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          const arg = coerce(asBindArg(params));
          stmt.run(arg as never);
          stmt.reset();
          dirty = true;
        },
        get: (...params: unknown[]): R | undefined => {
          const arg = coerce(asBindArg(params));
          stmt.bind(arg as never);
          if (stmt.step()) {
            const row = stmt.getAsObject() as unknown as R;
            stmt.reset();
            return row;
          }
          stmt.reset();
          return undefined;
        },
        all: (...params: unknown[]): R[] => {
          const arg = coerce(asBindArg(params));
          stmt.bind(arg as never);
          const rows: R[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as unknown as R);
          stmt.reset();
          return rows;
        },
      };
    },
    exec: (sql: string) => {
      db.exec(sql);
      dirty = true;
    },
    pragma: (sql: string, opts?: { simple?: boolean }) => {
      const stripped = sql.replace(/^\s*/, '');
      // 'user_version = 1' 같은 set 문은 exec 로.
      if (/=/.test(stripped) && !/^select\s/i.test(stripped)) {
        db.exec(`PRAGMA ${stripped}`);
        dirty = true;
        return undefined;
      }
      const res = db.exec(`PRAGMA ${stripped}`);
      const first = res[0];
      if (!first || !first.values.length) return opts?.simple ? 0 : [];
      if (opts?.simple) {
        return first.values[0][0];
      }
      return first.values.map((v: unknown[]) => {
        const obj: Record<string, unknown> = {};
        first.columns.forEach((col: string, i: number) => (obj[col] = v[i]));
        return obj;
      });
    },
    transaction: <T,>(fn: () => T) => {
      // sql.js 가 BEGIN/COMMIT/ROLLBACK 지원. 단순 wrapping.
      return () => {
        db.exec('BEGIN');
        try {
          const r = fn();
          db.exec('COMMIT');
          dirty = true;
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      };
    },
    save,
    close: () => {
      save();
      db.close();
    },
  });

  return wrap();
}
