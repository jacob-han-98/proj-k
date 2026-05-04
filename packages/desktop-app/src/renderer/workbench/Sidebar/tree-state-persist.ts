// 트리 사이드바의 사용자 브라우징 상태를 localStorage 에 영속.
//
// 영속 대상:
//   - 펼쳐진 폴더 ID 집합 (expanded)
//   - 마지막으로 포커스된 노드 ID (selectedId, App.tsx 가 직접 사용)
//   - P4Panel 의 source 탭 (local vs depot)
//
// 정책 (사용자 요구): "유지하려고 시도하는데, 항목이 없어졌다면 무리하게 탐색하거나
// 포커스하려고 하지 않음." → 트리 데이터가 도착한 시점에 walk 해서 valid id 만 유지하고
// orphaned id 는 silently 제거. focus 도 valid 일 때만 복원.
//
// recent-docs.ts 와 같은 가벼운 localStorage 패턴.

const SCHEMA_VERSION = 1;

interface ExpandedShape {
  schemaVersion: number;
  ids: string[];
}

function safeParseExpanded(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExpandedShape>;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.ids)) return null;
    return parsed.ids.filter((s): s is string => typeof s === 'string');
  } catch {
    return null;
  }
}

export function loadExpanded(key: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const ids = safeParseExpanded(localStorage.getItem(key));
    return new Set(ids ?? []);
  } catch {
    return new Set();
  }
}

export function saveExpanded(key: string, ids: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: ExpandedShape = { schemaVersion: SCHEMA_VERSION, ids: Array.from(ids) };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* quota / private mode — 무시 */
  }
}

// 트리 데이터 도착 후 호출. 트리에 존재하지 않는 id 는 제거 (없어진 항목에 무리한
// 복원 시도 방지). validIds 는 caller 가 트리를 walk 해서 만든 set.
export function pruneExpanded(stored: Set<string>, validIds: Set<string>): Set<string> {
  if (stored.size === 0) return stored;
  const next = new Set<string>();
  for (const id of stored) {
    if (validIds.has(id)) next.add(id);
  }
  return next;
}

// 단일 string 영속용 — selectedId, P4 source 탭 등.
export function loadString(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 무시 */
  }
}

export function clearString(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* 무시 */
  }
}

// localStorage 키 — 한 곳에서 관리해 collision / typo 회피.
export const TREE_PERSIST_KEYS = {
  P4_LOCAL_EXPANDED: 'klaud.tree.p4-local.expanded',
  P4_DEPOT_EXPANDED: 'klaud.tree.p4-depot.expanded',
  CONFLUENCE_EXPANDED: 'klaud.tree.confluence.expanded',
  P4_SOURCE_TAB: 'klaud.tree.p4-source-tab', // 'local' | 'depot'
  // App.tsx 가 사용 — 마지막으로 포커스된 트리 노드 ID + kind. 부팅 시 트리 도착 후 valid
  // 여부 확인 후에만 복원 (탭 자동 open 까지 이어짐).
  LAST_SELECTION: 'klaud.tree.lastSelection', // JSON: { kind: 'sheet'|'confluence', nodeId: string }
  // CommandPalette 의 source 필터 — Perforce / Confluence 토글. JSON: { p4: bool, confluence: bool }
  CMD_PALETTE_FILTERS: 'klaud.cmd-palette.filters',
} as const;
