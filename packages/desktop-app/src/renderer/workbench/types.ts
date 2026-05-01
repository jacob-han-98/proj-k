// VS Code 4-pane workbench 타입.
// PR1: SidebarKind (Activity Bar 토글 단위).
// PR2: DocTab (editor 영역의 문서 탭) — confluence / excel.
// PR3: qna-thread 탭 종류 추가. quick-find 탭은 도입 안함 (사이드바 전용).

import type { TreeNode } from '../../shared/types';

export type SidebarKind = 'p4' | 'confluence' | 'find' | 'qna';

export type DocTabKind = 'confluence' | 'excel' | 'qna-thread';

// Editor 탭. union 으로 종류별 필요한 페이로드만 들고 있게.
export type DocTab =
  | { id: string; kind: 'confluence'; node: TreeNode }
  | { id: string; kind: 'excel'; node: TreeNode }
  | { id: string; kind: 'qna-thread'; threadId: string; title: string };

// openTab 액션 인풋. id 는 store 가 tabIdOf 로 자동 생성.
export type OpenTabSpec =
  | { kind: 'confluence'; node: TreeNode }
  | { kind: 'excel'; node: TreeNode }
  | { kind: 'qna-thread'; threadId: string; title: string };

export function tabIdOf(spec: OpenTabSpec): string {
  if (spec.kind === 'confluence') {
    return `confluence:${spec.node.confluencePageId ?? spec.node.id}`;
  }
  if (spec.kind === 'excel') {
    return `excel:${spec.node.relPath ?? spec.node.id}`;
  }
  return `qna:${spec.threadId}`;
}
