// QuickFindPanel 의 hit grouping 순수 로직. 컴포넌트와 분리해서 단위 테스트 가능하게 분리.
//
// 세 종류 그룹:
// 1) **xlsx workbook** — backend (commit c3cbb23) 가 워크북 단위로 fold 한 hit (matched_sheets
//    동봉) 이거나, legacy/mock 의 시트 hit 들을 클라이언트 측에서 fold.
// 2) **confluence 2-depth folder** — confluence 페이지의 path 첫 2 segments 를 prefix 로 묶음.
//    예: "시스템 디자인 / 성장 벨런스 / X" 와 "시스템 디자인 / 성장 벨런스 / Y" → 같은 그룹.
//    엑셀 워크북:시트 관계와 동일한 트리 표현. path 가 ≤2 segments 면 single.
// 3) **single** — 위 분기 안 맞는 단일 hit.

import type { MatchedSheet, QuickFindHit, TreeNode } from '../../../shared/types';

export type Group =
  | { kind: 'workbook'; key: string; workbook: string; path: string; sheets: QuickFindHit[] }
  | { kind: 'confluence-folder'; key: string; folderPath: string; pages: QuickFindHit[] }
  | { kind: 'single'; key: string; hit: QuickFindHit };

// hit.path 는 "7_System / PK_HUD / HUD_기본" 식 — 마지막 segment 가 시트명. 워크북 헤더는 그 앞 부분.
export function workbookPath(hit: QuickFindHit): string {
  if (!hit.path) return '';
  const parts = hit.path.split(' / ');
  if (parts.length <= 1) return hit.path;
  return parts.slice(0, -1).join(' / ');
}

// xlsx 시트 hit 클릭 시 OneDrive relPath 로 변환. backend display path 는 " / " separator
// (공백+슬래시+공백) 라 segment trim + 빈 segment 제거 필수 — 안 하면 trailing space 가
// SharePoint 404 유발. 마지막 segment(시트명) 는 제거하여 워크북 path 로 정규화.
// **.xlsx 는 부착하지 않음** — 호출자 (buildEmbedUrl, pollSharePointReady 등) 가 강제로
// .xlsx 부착하므로 중복 방지. (2026-05-06 bugfix: 이전엔 양쪽이 부착해 .xlsx.xlsx 발생.)
export function normalizeXlsxPath(rawPath: string): string {
  // 입력에 이미 .xlsx 붙어있을 수도 있어 떼어냄 (호출자가 다시 부착).
  const stripped = rawPath.endsWith('.xlsx') ? rawPath.slice(0, -'.xlsx'.length) : rawPath;
  const parts = stripped
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length >= 3) {
    return parts.slice(0, -1).join('/');
  }
  return parts.join('/');
}

// matched_sheets 의 entry 를 QuickFindHit shape 으로 normalize — 누락 필드는 부모 워크북 hit
// 에서 채움. UI 가 시트 child 도 hit 처럼 동일하게 렌더할 수 있도록.
function matchedSheetToHit(sheet: MatchedSheet, parent: QuickFindHit): QuickFindHit {
  return {
    doc_id: sheet.doc_id,
    type: 'xlsx',
    title: sheet.title ?? sheet.sheet,
    path: parent.path ? `${parent.path} / ${sheet.sheet}` : sheet.sheet,
    workbook: parent.workbook ?? null,
    space: null,
    summary: sheet.summary ?? '',
    score: sheet.score ?? 0,
    matched_via: sheet.matched_via ?? '',
    rank: 0,
    content_md_path: sheet.content_md_path ?? '',
    source: sheet.source ?? parent.source,
  };
}

// confluence path 의 부모 폴더 (마지막 segment 제외). path depth 자유 — 결과의 같은 부모
// 끼리 ≥2 면 묶이는 정책. depth=1 (root only) hit 은 부모 없음 → null.
export function confluenceParentPath(path: string): string | null {
  if (!path) return null;
  const parts = path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join(' / ');
}

export function groupHits(hits: QuickFindHit[]): Group[] {
  // Pre-pass: confluence hit 의 parent 별 카운트. ≥2 인 parent 만 그룹화 candidate.
  // "합친 것을 또 합치지는 말고" — 한 번만 그룹핑 (자식 그룹의 parent 로 또 묶기 X).
  const confluenceParentCount = new Map<string, number>();
  for (const hit of hits) {
    if (hit.type !== 'confluence') continue;
    const parent = confluenceParentPath(hit.path);
    if (parent == null) continue;
    confluenceParentCount.set(parent, (confluenceParentCount.get(parent) ?? 0) + 1);
  }
  const groupableParents = new Set<string>();
  for (const [parent, count] of confluenceParentCount) {
    if (count >= 2) groupableParents.add(parent);
  }

  const groups: Group[] = [];
  const legacyWorkbookIdx = new Map<string, number>();
  const confluenceFolderIdx = new Map<string, number>();
  for (const hit of hits) {
    // 1) 백엔드가 fold 해서 보낸 워크북 hit (matched_sheets 동봉)
    if (hit.type === 'xlsx' && hit.matched_sheets && hit.matched_sheets.length > 0) {
      groups.push({
        kind: 'workbook',
        key: hit.doc_id,
        workbook: hit.workbook ?? hit.title,
        path: hit.path,
        sheets: hit.matched_sheets.map((s) => matchedSheetToHit(s, hit)),
      });
      continue;
    }
    // 2) Legacy / mock — xlsx 시트 단위 hit 을 클라이언트 측에서 fold
    if (hit.type === 'xlsx' && hit.workbook) {
      const key = `xlsx::${hit.workbook}`;
      const existing = legacyWorkbookIdx.get(key);
      if (existing != null) {
        const g = groups[existing];
        if (g.kind === 'workbook') g.sheets.push(hit);
        continue;
      }
      legacyWorkbookIdx.set(key, groups.length);
      groups.push({
        kind: 'workbook',
        key,
        workbook: hit.workbook,
        path: workbookPath(hit),
        sheets: [hit],
      });
      continue;
    }
    // 3) Confluence parent-folder fold — 같은 parent 가 결과에 ≥2 hit 있을 때만 묶음.
    if (hit.type === 'confluence') {
      const parent = confluenceParentPath(hit.path);
      if (parent != null && groupableParents.has(parent)) {
        const key = `conf::${parent}`;
        const existing = confluenceFolderIdx.get(key);
        if (existing != null) {
          const g = groups[existing];
          if (g.kind === 'confluence-folder') g.pages.push(hit);
          continue;
        }
        confluenceFolderIdx.set(key, groups.length);
        groups.push({
          kind: 'confluence-folder',
          key,
          folderPath: parent,
          pages: [hit],
        });
        continue;
      }
    }
    // 4) 그 외 (xlsx workbook 누락, confluence ≤2 segments 등) — single
    groups.push({ kind: 'single', key: hit.doc_id, hit });
  }
  return groups;
}

// ---------- confluence 페이지 path → numeric pageId 매핑 ----------
// backend 의 quick_find hit 은 현재 doc_id="conf::<path>" 형태라 진짜 numeric Confluence pageId
// 가 없음. 그래서 ConfluencePage open URL (`viewpage.action?pageId=<numeric>`) 빌드 실패.
// 임시 처리: sidecar /tree/confluence 의 manifest tree 가 confluencePageId 를 들고 있으니,
// 거기서 path → pageId map 을 빌드해 hit.path 를 lookup. backend 가 hit 에 confluence_page_id
// 필드 추가하면 (request id 20260506-102104-63428e) 이 lookup 은 제거 가능.

// 공백+슬래시+공백 separator → 단일 슬래시. segment 양쪽 공백 trim. 빈 segment 제거.
// `:` 콜론 → `_` 언더스코어 변환 — manifest tree 는 원본 (예: "필드: 가시나무 숲") 보존,
// backend quick_find 는 file-safe form ("필드_ 가시나무 숲") 으로 인덱싱. 양쪽을 같은 키로
// 매칭하려고 콜론을 언더스코어로 통일.
function normalizeConfluencePath(path: string): string {
  return path
    .split('/')
    .map((s) => s.trim().replace(/:/g, '_'))
    .filter((s) => s.length > 0)
    .join('/');
}

// tree 평탄화 — 각 page 노드의 모든 path suffix 를 키로 등록.
// backend hit.path 가 root prefix 를 일부만 들고와도 매칭되도록 (예: tree 가
// "Design/컨텐츠 디자인/..." 인데 hit.path 는 "컨텐츠 디자인/..." 일 수 있음).
export function buildConfluencePathMap(roots: TreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(node: TreeNode, parentSegs: string[]): void {
    const segs = node.title ? [...parentSegs, node.title] : parentSegs;
    if (node.confluencePageId && node.type === 'page') {
      // 모든 suffix 등록 — segs.length 부터 1 까지. normalize 해서 file-safe form 으로 키 통일
      // (콜론 → 언더스코어), backend hit.path 의 normalize 결과와 매칭되게.
      for (let i = 0; i < segs.length; i++) {
        const suffix = normalizeConfluencePath(segs.slice(i).join('/'));
        if (suffix && !map.has(suffix)) {
          // 첫 등록 우선 — 동명 페이지 충돌 시 더 깊은 (full) 경로가 먼저 등록되도록
          // walk 순서가 자연스럽게 처리. 단순 lookup 으로 충분.
          map.set(suffix, node.confluencePageId);
        }
      }
    }
    if (node.children) for (const c of node.children) walk(c, segs);
  }
  for (const r of roots) walk(r, []);
  return map;
}

// hit.path 를 normalize 후, full path → 짧은 suffix 순으로 lookup. 못 찾으면 undefined.
export function lookupConfluencePageId(
  pathMap: Map<string, string>,
  hitPath: string,
): string | undefined {
  if (!hitPath) return undefined;
  const normalized = normalizeConfluencePath(hitPath);
  if (!normalized) return undefined;
  const direct = pathMap.get(normalized);
  if (direct) return direct;
  // suffix 짧혀가며 시도 — root prefix 차이 흡수.
  const segs = normalized.split('/');
  for (let i = 1; i < segs.length; i++) {
    const sub = segs.slice(i).join('/');
    const v = pathMap.get(sub);
    if (v) return v;
  }
  return undefined;
}
