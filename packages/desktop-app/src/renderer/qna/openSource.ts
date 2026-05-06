// Phase K (2026-05-06): 출처 클릭 → 새 탭 디스패처. agent-sdk-poc 웹은 우측 패널이지만
// desktop-app 은 워크벤치 4-pane 이라 Confluence/Excel webview 탭이 이미 존재 — 그
// 시스템을 재활용하는 게 자연스럽다. 사용자 결정 (2026-05-06).
//
// 분기:
//   - source 'confluence': origin_url 또는 path 에서 pageId 추출 → Confluence 탭
//   - source 'xlsx': xlsx-extractor output path 에서 <category>/<workbook>/<sheet>
//     추출 → P4 sheet 탭. path 패턴 미매칭이면 fallback.
//   - source 'datasheet': workbook 이름 → 'Resource/design/<workbook>.xlsx' 매핑.
//     P4 client view 에 따라 prefix 다를 수 있어 best-effort.
//   - 그 외 (external/web/summary/other): null 반환 → 호출자가 SourceViewPanel
//     (우측 패널) 로 fallback.
//
// 모든 매핑이 best-effort — 사용자 환경의 P4 트리 / Confluence 권한에 따라 탭이 열려도
// 콘텐츠 로드 실패 가능. 그 경우 LocalSheetView / ConfluencePane 자체가 사용자에게
// 안내 (cloud-not-ready 등).

import type { TreeNode } from '../../shared/types';
import type { OpenTabSpec } from '../workbench/types';
import type { QnASource } from './render';

// Confluence URL 에서 pageId 추출. 두 패턴:
//   - /wiki/spaces/<KEY>/pages/<PAGEID>/...
//   - /wiki/pages/viewpage.action?pageId=<PAGEID>
function parseConfluencePageId(url?: string): string | null {
  if (!url) return null;
  const m1 = url.match(/[?&]pageId=(\d+)/);
  if (m1) return m1[1] ?? null;
  const m2 = url.match(/\/pages\/(\d+)/);
  if (m2) return m2[1] ?? null;
  return null;
}

// xlsx-extractor output path → OneDrive mirror 용 워크북 relPath (확장자 .xlsx 포함).
// path 예: 'packages/xlsx-extractor/output/7_System/PK_변신/주요_정의/_final/content.md'
//   → workbook relPath: '7_System/PK_변신.xlsx'
//
// 사용자 보고 (2026-05-06): 시트 단위 path 그대로 쓰면 OneDrive 에 그 path 가 없어 404.
// 워크북 .xlsx 단위로 변환 필수.
function xlsxPathToRelPath(p: string | undefined): { workbook: string; sheet: string } | null {
  if (!p) return null;
  const m = p.match(/output\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  const cat = m[1];
  const wb = m[2];
  const sh = m[3] ?? '';
  return { workbook: `${cat}/${wb}.xlsx`, sheet: sh ? `${cat}/${wb}/${sh}` : '' };
}

// DataSheet workbook 이름 정제 ('DataSheet / MonsterClass' / 'MonsterClass' / 'MonsterClass.xlsx').
// P4 client view 의 일반적인 layout: '<category>/Resource/design/<file>.xlsx'.
// 사용자 환경마다 prefix 다를 수 있어 best-effort — 단순 'Resource/design/<file>.xlsx' 사용.
function datasheetRelPath(workbook: string | undefined): string | null {
  if (!workbook) return null;
  const cleaned = workbook
    .replace(/^DataSheet\s*\/\s*/i, '')
    .replace(/\.xlsx$/i, '')
    .trim();
  if (!cleaned) return null;
  return `Resource/design/${cleaned}.xlsx`;
}

// 메인 디스패처. 매칭 가능한 경우 OpenTabSpec 반환. 외 null 반환 (호출자 fallback).
export function specForSource(source: QnASource): OpenTabSpec | null {
  if (source.source === 'confluence') {
    const pageId =
      parseConfluencePageId(source.origin_url) ?? parseConfluencePageId(source.path);
    if (!pageId) return null;
    const node: TreeNode = {
      id: `confluence:${pageId}`,
      type: 'page',
      title: source.origin_label ?? source.workbook ?? 'Confluence',
      confluencePageId: pageId,
    };
    return { kind: 'confluence', node };
  }
  if (source.source === 'xlsx') {
    const m = xlsxPathToRelPath(source.path);
    if (!m) return null;
    const node: TreeNode = {
      id: `workbook:${m.workbook}`,
      type: 'workbook',
      title: source.workbook ?? m.workbook,
      relPath: m.workbook,
    };
    return { kind: 'excel', node };
  }
  if (source.source === 'datasheet') {
    const relPath = datasheetRelPath(source.workbook ?? source.origin_label);
    if (!relPath) return null;
    const title = relPath.split('/').pop() ?? relPath;
    const node: TreeNode = {
      id: `workbook:${relPath}`,
      type: 'workbook',
      title,
      relPath,
    };
    return { kind: 'excel', node };
  }
  // external / web / summary / other — 우측 SourceViewPanel 이 더 적합 (호출자 fallback).
  return null;
}
