// VS Code 4-pane workbench 타입.
// PR1: SidebarKind (Activity Bar 토글 단위).
// PR2: DocTab (editor 영역의 문서 탭) — confluence / excel.
// PR3: qna-thread 탭 종류 추가. quick-find 탭은 도입 안함 (사이드바 전용).

import type { TreeNode } from '../../shared/types';

export type SidebarKind = 'p4' | 'confluence' | 'find' | 'qna' | 'active';

export type DocTabKind = 'confluence' | 'excel' | 'qna-thread' | 'agent-web';

// Editor 탭. union 으로 종류별 필요한 페이로드만 들고 있게.
export type DocTab =
  | { id: string; kind: 'confluence'; node: TreeNode }
  | { id: string; kind: 'excel'; node: TreeNode }
  | { id: string; kind: 'qna-thread'; threadId: string; title: string }
  | { id: string; kind: 'agent-web' };

// openTab 액션 인풋. id 는 store 가 tabIdOf 로 자동 생성.
export type OpenTabSpec =
  | { kind: 'confluence'; node: TreeNode }
  | { kind: 'excel'; node: TreeNode }
  | { kind: 'qna-thread'; threadId: string; title: string }
  | { kind: 'agent-web' };

export function tabIdOf(spec: OpenTabSpec): string {
  if (spec.kind === 'confluence') {
    return `confluence:${spec.node.confluencePageId ?? spec.node.id}`;
  }
  if (spec.kind === 'excel') {
    // PR9c: depot 파일은 oneDriveUrl 직접 매칭 + node.id 가 revision 포함 (예: 'depot:<path>#rev42').
    // 같은 file 의 다른 revision 은 별도 탭으로 유지 (사용자가 비교할 수 있게). local 시트는 기존처럼 relPath 기반.
    if (spec.node.oneDriveUrl) return `excel:${spec.node.id}`;
    return `excel:${spec.node.relPath ?? spec.node.id}`;
  }
  if (spec.kind === 'qna-thread') return `qna:${spec.threadId}`;
  // agent-web: 단일 인스턴스. 같은 ID 로 항상 매칭 → 두 번째 클릭은 focus 만.
  return 'agent-web:singleton';
}

// 편집 모드 추적용 안정 키. 같은 depot 파일의 여러 revision (각각 독립 탭) 도 같은 docKey 를
// 공유하도록 revision 부분 제거. 트리뷰의 ✏ 아이콘이 이 키로 store 에 토글한다.
export function docKeyOfLocal(relPath: string): string {
  return `local:${relPath}`;
}
export function docKeyOfDepot(depotPath: string): string {
  return `depot:${depotPath}`;
}
export function docKeyOfConfluence(pageId: string): string {
  return `confluence:${pageId}`;
}
// TreeNode 가 어떤 종류인지에 따라 docKey 도출. depot 노드는 id 가 'depot:<path>#rev<n>'.
// Confluence 는 pageId 가 안정 키 — 같은 페이지를 다른 경로에서 열어도 키 충돌 없음.
export function docKeyOfNode(node: {
  id: string;
  relPath?: string;
  oneDriveUrl?: string;
  confluencePageId?: string;
}): string | null {
  if (node.confluencePageId) return `confluence:${node.confluencePageId}`;
  if (node.oneDriveUrl && node.id.startsWith('depot:')) {
    const m = node.id.match(/^depot:(.+?)(?:#rev\d+)?$/);
    return m ? `depot:${m[1]}` : null;
  }
  if (node.relPath) return `local:${node.relPath}`;
  return null;
}

// 2026-05-13: Ctrl+Tab MRU 스위처 helper. focusTab/openTab 마다 호출 — id 가 이미 있으면
// 제거 후 head 에 unshift, 없으면 head 에 push. 결과는 가장 최근 사용 탭이 [0], 그 다음이 [1]...
// 순수 함수 — 단위 테스트로 분기 검증.
export function bumpFocusOrder(order: string[], id: string): string[] {
  if (order[0] === id) return order;
  const filtered = order.filter((p) => p !== id);
  return [id, ...filtered];
}

// 2026-05-13: Ctrl+Tab MRU 후보 list. 현재 활성 탭 다음으로 가장 최근 사용한 탭부터.
// 첫 Ctrl+Tab → cursor=1 (현재 [0], 다음 [1]). Shift+Tab → 끝에서부터 (cursor = len-1).
// stale 한 id (openTabs 에 없는) 는 제외.
export function tabSwitcherCandidates(openTabs: DocTab[], focusOrder: string[]): string[] {
  if (openTabs.length === 0) return [];
  const known = new Set(openTabs.map((t) => t.id));
  const inOrder = focusOrder.filter((id) => known.has(id));
  const missing = openTabs.filter((t) => !inOrder.includes(t.id)).map((t) => t.id);
  return [...inOrder, ...missing];
}

// 2026-05-12: Chrome 스타일 탭 표시 순서. pinned 가 좌측에 pinnedTabIds 순서대로 먼저
// 나오고, 그 뒤에 unpinned 가 openTabs 원본 순서대로. pinnedTabIds 에 있지만 openTabs
// 에는 없는 id 는 stale 로 간주해 제외 (closeTab 청소 누락 방어). 순수 함수 — 단위 테스트
// 로 분기 검증.
export function getDisplayedTabs(openTabs: DocTab[], pinnedTabIds: string[]): DocTab[] {
  if (pinnedTabIds.length === 0) return openTabs;
  const byId = new Map(openTabs.map((t) => [t.id, t]));
  const pinned: DocTab[] = [];
  for (const id of pinnedTabIds) {
    const t = byId.get(id);
    if (t) pinned.push(t);
  }
  const pinnedSet = new Set(pinned.map((t) => t.id));
  const unpinned = openTabs.filter((t) => !pinnedSet.has(t.id));
  return [...pinned, ...unpinned];
}
