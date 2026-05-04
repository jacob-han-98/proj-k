import type { ReactNode } from 'react';
import type { TreeNode } from '../../../shared/types';

// 트리 노드 아이콘 — P4Panel / ConfluencePanel 공유. 노드 type 별로 시각화 분기.
//
// 결정 배경: P4Panel.iconFor 가 옛날엔 category/workbook/sheet 만 알았는데, sidecar 의
// _build_p4_tree 가 서브디렉토리를 type='folder' 로 emit 하면서 매칭이 안 되어 fallback
// '•' 글리프가 표시되는 회귀 (사용자 보고 "2depth 폴더가 폴더 모양이 아님"). 두 패널의
// iconFor 를 한 곳에서 관리해서 새 type 추가 시 한쪽만 빠지는 일 방지.

// Microsoft Excel 의 그린 박스 + 흰 X 모티브. .xlsx sheet 노드 전용.
// 색은 Excel 2019+ 의 #107C41. inline SVG 라 외부 asset 없이 항상 동작.
// CommandPalette 결과 행에서도 같은 아이콘 사용 — 트리와 검색의 시각 언어 일치.
export function ExcelFileIcon({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <rect x="3" y="2" width="18" height="20" rx="2" fill="#107C41" />
      <path
        d="M8 7 L16 17 M16 7 L8 17"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

// TreeNode → 표시할 아이콘 (이모지 또는 SVG).
// .icon span 의 width 16px 안에 들어가도록 SVG 는 14px.
//
// Confluence 트리는 manifest 의 page 노드가 *자식 페이지* 를 가질 수 있어 (Confluence 의
// 페이지 = 폴더 역할 겸용), type 만으론 사용자 멘탈모델 ("폴더 vs 단일 문서") 을 못
// 표현. children 이 있으면 폴더로 표시.
export function iconNodeFor(node: TreeNode): ReactNode {
  const hasChildren = !!node.children && node.children.length > 0;
  switch (node.type) {
    case 'category':
    case 'folder':
      return '📁';
    case 'workbook':
      // legacy fallback 트리 (tree-core.ts) 에서만 emit. sidecar 트리에선 안 나옴.
      return '📘';
    case 'sheet':
      // sidecar _build_p4_tree 의 sheet 는 모두 .xlsx — Excel 풍 아이콘.
      return <ExcelFileIcon />;
    case 'page':
      // Confluence 페이지가 하위 페이지를 거느린 경우 사용자 인식 = 폴더.
      return hasChildren ? '📁' : '📄';
    case 'space':
      return '🗂️';
    default:
      return '•';
  }
}
