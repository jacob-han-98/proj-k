// VS Code 4-pane workbench 타입.
// PR1: SidebarKind (Activity Bar 토글 단위).
// PR2: DocTab (editor 영역의 문서 탭) — confluence / excel.
// PR3: qna-thread 탭 종류 추가. quick-find 탭은 도입 안함 (사이드바 전용).

import type { TreeNode } from '../../shared/types';

export type SidebarKind = 'p4' | 'confluence' | 'find' | 'qna' | 'recent';

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
// TreeNode 가 어떤 종류인지에 따라 docKey 도출. depot 노드는 id 가 'depot:<path>#rev<n>'.
export function docKeyOfNode(node: { id: string; relPath?: string; oneDriveUrl?: string }): string | null {
  if (node.oneDriveUrl && node.id.startsWith('depot:')) {
    const m = node.id.match(/^depot:(.+?)(?:#rev\d+)?$/);
    return m ? `depot:${m[1]}` : null;
  }
  if (node.relPath) return `local:${node.relPath}`;
  return null;
}
