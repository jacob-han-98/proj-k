// P4 depot 파일 보기 캐시 — `userData/depot-cache.json` 에 path → {revision, url, localPath}
// 매핑 보관. 같은 (path, revision) 재요청이면 OneDrive 재업로드 skip 하고 기존 URL 반환.
// depot 의 head revision 이 올라가면 cache miss → 새 업로드 → manifest 갱신.
//
// 주의: OneDrive 폴더 안의 파일은 revision 마다 별도로 저장 안 함 — head 만 보관 (덮어쓰기).
// 의도: 사용자는 항상 latest depot 본문을 본다. revision 추적은 manifest 의 메타데이터로 충분.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

interface CacheEntry {
  revision: number;
  url: string;
  localPath: string;
  uploadedAt: number;
}

interface Manifest {
  // depot path (예: '//main/ProjectK/Design/7_System/PK_HUD.xlsx') → entry
  entries: Record<string, CacheEntry>;
}

function manifestFile(): string {
  return join(app.getPath('userData'), 'depot-cache.json');
}

function readManifest(): Manifest {
  try {
    const raw = readFileSync(manifestFile(), 'utf-8');
    const parsed = JSON.parse(raw) as Manifest;
    return parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeManifest(m: Manifest): void {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(manifestFile(), JSON.stringify(m, null, 2), 'utf-8');
}

// path 로 캐시 lookup. revision 이 일치할 때만 hit. 다르면 (또는 entry 없으면) null.
export function lookupDepotCache(depotPath: string, revision: number): CacheEntry | null {
  const m = readManifest();
  const e = m.entries[depotPath];
  if (!e) return null;
  if (e.revision !== revision) return null;
  return e;
}

export function setDepotCache(depotPath: string, entry: CacheEntry): void {
  const m = readManifest();
  m.entries[depotPath] = entry;
  writeManifest(m);
}

// 트리 표시용 — 어떤 depot path 가 캐시되어 있는지 + 그 revision. 트리는 한 파일 클릭 전에
// p4 fstat 호출 안 하므로 "fresh" 까지 확인하지 않고 단순 "이전에 열어본 적 있음" 만 표시.
// 클릭 시 실제 head rev 비교 → cache hit 이면 즉시 URL 반환 / miss 면 재페치.
export function listCachedPaths(): Array<{ path: string; revision: number }> {
  const m = readManifest();
  return Object.entries(m.entries).map(([path, e]) => ({ path, revision: e.revision }));
}
