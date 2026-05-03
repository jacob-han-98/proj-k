// A4: "최근 작업 문서" 활동바 패널 — localStorage 기반 가벼운 history.
//
// store.openTab 이 호출될 때마다 touchRecentDoc 으로 한 entry 갱신. 사이드바 5번
// 활동에서 listRecentDocs 로 최신순 (lastVisitedAt desc) 표시. 클릭 → 같은 OpenTabSpec
// 으로 다시 store.openTab.
//
// 스토어 선택 (localStorage):
//   - 가벼움: 부팅 직후 로드, 의존성 0, 인스톨/계정 무관 항상 동작
//   - 단점: 인스톨 새로 받으면 사라짐, 다른 PC 에서 sync 안됨
//   - SQLite (workspace.db) 로의 마이그레이션은 다음 PR — 사용자 피드백 기다림
//
// 형태: { schemaVersion, entries: RecentDocEntry[] } — JSON 직렬화. cap 50.

const STORAGE_KEY = 'klaud.recents';
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 50;

export type RecentDocKind = 'excel' | 'confluence' | 'qna-thread';

export interface RecentDocEntry {
  // OpenTabSpec 과 동일하게 store.openTab 으로 다시 열 수 있는 만큼만 보존.
  kind: RecentDocKind;
  // tabIdOf 와 동일한 안정 key — kind+id 조합으로 dedupe.
  id: string;
  title: string;
  // Excel/Confluence 의 트리 path 또는 QnA 의 마지막 메시지 prefix 등 보조 라벨.
  subtitle?: string;
  // ms epoch.
  lastVisitedAt: number;
  // 누적 open 횟수 — pinned 화면에 활용 가능.
  openCount: number;
  // kind 별 추가 식별자 — 클릭 reopen 시 OpenTabSpec 복원에 사용.
  // excel/confluence: TreeNode 의 핵심 필드 (id, relPath, title, oneDriveUrl, confluencePageId 등)
  // qna-thread: threadId
  payload: Record<string, unknown>;
}

interface StoredShape {
  schemaVersion: number;
  entries: RecentDocEntry[];
}

function safeParse(raw: string | null): StoredShape | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.schemaVersion === SCHEMA_VERSION &&
      Array.isArray(parsed.entries)
    ) {
      return parsed as StoredShape;
    }
    return null;
  } catch {
    return null;
  }
}

function load(): StoredShape {
  if (typeof localStorage === 'undefined') {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }
  return safeParse(localStorage.getItem(STORAGE_KEY)) ?? {
    schemaVersion: SCHEMA_VERSION,
    entries: [],
  };
}

function save(state: StoredShape): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota 초과 등 — silently 무시. 다음 호출에 다시 시도.
  }
}

// 외부 (예: store.openTab) 에서 호출. 같은 id 가 있으면 lastVisitedAt 만 갱신 + openCount++,
// 새로운 id 면 push. 결과적으로 list 는 최신순으로 정렬되도록 항상 lastVisitedAt = now.
export function touchRecentDoc(
  partial: Omit<RecentDocEntry, 'lastVisitedAt' | 'openCount'> & {
    lastVisitedAt?: number;
    openCount?: number;
  },
): void {
  const now = partial.lastVisitedAt ?? Date.now();
  const state = load();
  const idx = state.entries.findIndex((e) => e.id === partial.id);
  if (idx >= 0) {
    const cur = state.entries[idx]!;
    state.entries[idx] = {
      ...cur,
      title: partial.title,
      subtitle: partial.subtitle,
      payload: partial.payload,
      lastVisitedAt: now,
      openCount: cur.openCount + 1,
    };
  } else {
    state.entries.push({
      kind: partial.kind,
      id: partial.id,
      title: partial.title,
      subtitle: partial.subtitle,
      payload: partial.payload,
      lastVisitedAt: now,
      openCount: 1,
    });
  }
  // cap — 가장 오래된 entry 부터 제거. lastVisitedAt 기준 sort 후 trim.
  state.entries.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.length = MAX_ENTRIES;
  }
  save(state);
  // 패널의 React 상태가 즉시 반응하도록 storage 이벤트 시뮬레이션.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('klaud:recents-changed'));
  }
}

export function listRecentDocs(): RecentDocEntry[] {
  const state = load();
  return state.entries
    .slice()
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
}

export function removeRecentDoc(id: string): void {
  const state = load();
  const next = state.entries.filter((e) => e.id !== id);
  if (next.length === state.entries.length) return;
  save({ schemaVersion: SCHEMA_VERSION, entries: next });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('klaud:recents-changed'));
  }
}

export function clearRecentDocs(): void {
  save({ schemaVersion: SCHEMA_VERSION, entries: [] });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('klaud:recents-changed'));
  }
}

// 사람-가독 상대 시간. "방금", "12분 전", "3시간 전", "어제", "5일 전".
// 7일 초과 시 절대 날짜.
export function relativeVisitTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '어제';
  if (day < 7) return `${day}일 전`;
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
