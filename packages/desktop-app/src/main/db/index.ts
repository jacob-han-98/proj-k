// 스레드 DB singleton — process 단위 1개. app.whenReady 시점에 init.
//
// 부팅 실패 (e.g. 디스크 read-only, 권한 문제) 시 DB 가 null 인 채로 두고 IPC 호출 측에서
// 명확한 에러 응답. 사이드바/검색 등 다른 기능은 정상 동작.

import { app } from 'electron';
import { join } from 'node:path';
import { openDatabase, type DB } from './threads-db';

let _db: DB | null = null;
let _initError: Error | null = null;

export function dbPath(): string {
  return join(app.getPath('userData'), 'threads.db');
}

export async function initThreadsDb(): Promise<void> {
  if (_db) return;
  try {
    _db = await openDatabase(dbPath());
    console.log(`[threads-db] opened ${dbPath()}`);
  } catch (e) {
    _initError = e as Error;
    console.error(`[threads-db] init 실패: ${(e as Error).message}`);
  }
}

export function getDb(): DB {
  if (_db) return _db;
  throw new Error(_initError?.message ?? 'threads db not initialized');
}

export function tryDb(): DB | null {
  return _db;
}

export function closeThreadsDb(): void {
  if (!_db) return;
  try {
    _db.close();
  } catch (e) {
    console.warn(`[threads-db] close 실패: ${(e as Error).message}`);
  }
  _db = null;
}
