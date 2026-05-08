// PR10: Quick Find 활성화 — agent-sdk-poc /quick_find (sidecar proxy) 호출.
// typing-as-you-search: input 입력 중 200ms debounce → fast=true 호출 (~50ms L1 only).
// 사용자가 Enter 누르면 fast=false (auto v2.1, ~300ms) 로 풀 quality.
// hit 클릭 → editor 탭 open. doc_id 의 prefix 로 confluence/xlsx 분기.

import { useEffect, useRef, useState } from 'react';
import { quickFind } from '../../api';
import type { QuickFindHit, QuickFindResult, TreeNode } from '../../../shared/types';
import { useWorkbenchStore } from '../store';
import {
  buildConfluencePathMap,
  groupHits,
  lookupConfluencePageId,
  normalizeXlsxPath,
} from './quick-find-grouping';

interface State {
  query: string;
  hits: QuickFindHit[];
  status: string;
  busy: boolean;
  error?: string;
  expanded?: boolean;
  latencyMs?: number;
  // 펼친 워크북 그룹의 key 집합. 기본 비어있음 (모두 접힘). 새 검색 시작 시 reset.
  expandedGroups: Set<string>;
  // 결과 개수 옵션 — 사용자 선택, localStorage 에 영속.
  limit: number;
}

const LIMIT_OPTIONS = [10, 20, 50, 100] as const;
const LIMIT_STORAGE_KEY = 'qf-limit';
const DEFAULT_LIMIT = 20;

function loadLimit(): number {
  try {
    const raw = window.localStorage.getItem(LIMIT_STORAGE_KEY);
    if (!raw) return DEFAULT_LIMIT;
    const n = Number(raw);
    return LIMIT_OPTIONS.includes(n as (typeof LIMIT_OPTIONS)[number]) ? n : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}

function saveLimit(limit: number): void {
  try {
    window.localStorage.setItem(LIMIT_STORAGE_KEY, String(limit));
  } catch {
    /* localStorage unavailable — silently ignore. */
  }
}

const initial: State = {
  query: '',
  hits: [],
  status: '',
  busy: false,
  expandedGroups: new Set(),
  limit: DEFAULT_LIMIT,
};

// hit 의 doc_id / type 으로부터 store.openTab 의 spec 만들기. xlsx 와 confluence 가
// hit shape 의 어디에 path/id 를 들고 있는지 contract 메시지 참조:
//   xlsx::      doc_id = "xlsx::<workbook>::<sheet>", path 표시용. content_md_path 는 본문.
//   conf::      doc_id = "conf::<path>",   confluencePageId 는 hit 에 직접 없음 (TODO: backend 가 제공해주면 정확).
// 임시: workbook + path 로 가짜 TreeNode 만들고 selection 채우는 식 (QnATab 의 thread-doc 클릭과 같은 패턴).
//
// normalizeXlsxPath: quick-find-grouping.ts 로 이동 — 단위 테스트 가능하게 분리.

function hitToTabSpec(hit: QuickFindHit, confluencePathMap: Map<string, string>) {
  const relPath = hit.type === 'xlsx' ? normalizeXlsxPath(hit.path) : hit.path;
  // id 도 워크북 단위로 통일 — 같은 워크북의 다른 시트 클릭 시 같은 탭 reuse.
  const id = hit.type === 'xlsx' ? `xlsx:${relPath}` : `${hit.type}:${hit.doc_id}`;
  // 시트 hit (workbook 그룹의 자식) 은 doc_id "xlsx::<wb>::<sheet>" 형태 — sheet 부분만
  // 추출하여 sheetName 에 넣어 Excel for the Web 이 그 시트 탭으로 점프하게 함.
  // 워크북 단위 single hit (sheet 정보 없음) 은 sheetName 비움 → default (첫 시트).
  const sheetName = hit.type === 'xlsx' ? extractSheetName(hit.doc_id) : undefined;
  // Confluence 페이지 numeric id 우선순위:
  //   1) backend hit.confluence_page_id (commit f991367 이후) — 가장 정확
  //   2) sidecar tree lookup (manifest 매칭 실패 케이스 fallback)
  //   3) undefined — ConfluencePage 가 placeholder
  const confluencePageId =
    hit.type === 'confluence'
      ? hit.confluence_page_id ?? lookupConfluencePageId(confluencePathMap, hit.path)
      : undefined;
  const node: TreeNode = {
    id,
    type: hit.type === 'confluence' ? 'page' : 'sheet',
    title: hit.title,
    relPath,
    confluencePageId,
    sheetName,
  };
  return {
    kind: hit.type === 'confluence' ? ('confluence' as const) : ('excel' as const),
    node,
  };
}

// "xlsx::<workbook>::<sheet>" → "<sheet>". 시트 부분 없으면 undefined (워크북 자체 hit).
function extractSheetName(docId: string): string | undefined {
  if (!docId.startsWith('xlsx::')) return undefined;
  const rest = docId.slice('xlsx::'.length);
  const idx = rest.indexOf('::');
  if (idx === -1) return undefined;
  return rest.slice(idx + 2) || undefined;
}

function badge(source: 'l1' | 'vector' | 'expand'): { glyph: string; title: string } {
  if (source === 'l1') return { glyph: '⚡', title: '키워드 매칭' };
  if (source === 'vector') return { glyph: '🧬', title: '의미 검색' };
  return { glyph: '🔮', title: '동의어 확장' };
}

// 워크북 (Excel) 아이콘 — Microsoft Excel 의 녹색 X 모양을 단순화.
// 공식 로고를 그대로 쓰지는 않지만 색/모양으로 식별 가능.
function WorkbookIcon() {
  return (
    <svg className="qf-icon-svg" viewBox="0 0 32 32" width="14" height="14" aria-hidden="true">
      <rect x="2" y="3" width="28" height="26" rx="2" fill="#107C41" />
      <rect x="2" y="3" width="28" height="9" fill="#185C37" />
      <path
        d="M9 16 L13 21 L9 26 H12 L15 22.2 L18 26 H21 L17 21 L21 16 H18 L15 19.8 L12 16 Z"
        fill="white"
      />
    </svg>
  );
}

// 시트 아이콘 — 워크북 안의 개별 시트. 작은 grid 모양으로 스프레드시트 느낌.
function SheetIcon() {
  return (
    <svg className="qf-icon-svg" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="1.5" fill="none" stroke="#16a34a" strokeWidth="1.4" />
      <line x1="3.5" y1="9" x2="20.5" y2="9" stroke="#16a34a" strokeWidth="1.2" />
      <line x1="3.5" y1="14" x2="20.5" y2="14" stroke="#16a34a" strokeWidth="1.2" />
      <line x1="9" y1="4.5" x2="9" y2="19.5" stroke="#16a34a" strokeWidth="1.2" />
      <line x1="15" y1="4.5" x2="15" y2="19.5" stroke="#16a34a" strokeWidth="1.2" />
    </svg>
  );
}

// Confluence 아이콘 — Atlassian 의 파란 페이지에 두 개의 곡선 (sphere/wedge) 모티프를 단순화.
function ConfluenceIcon() {
  return (
    <svg className="qf-icon-svg" viewBox="0 0 32 32" width="14" height="14" aria-hidden="true">
      <rect x="2" y="3" width="28" height="26" rx="3" fill="#0052CC" />
      <path
        d="M7 22 Q11 17 16 19 Q21 21 25 17"
        stroke="#FFFFFF"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M7 14 Q11 9 16 11 Q21 13 25 9"
        stroke="#B3D4FF"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Confluence 페이지 아이콘 — 자식 페이지 row 에 사용. 단순 outline page (folded corner).
function PageIcon() {
  return (
    <svg className="qf-icon-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
      <path d="M5 3 H14 L19 8 V21 H5 Z" stroke="#0052CC" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M14 3 V8 H19" stroke="#0052CC" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function QuickFindPanel() {
  const [state, setState] = useState<State>(() => ({ ...initial, limit: loadLimit() }));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Confluence 페이지 path → numeric pageId 매핑. mount 시 1회 fetch.
  // backend 가 hit 에 confluence_page_id 추가하면 이 lookup 은 제거 가능.
  const [confluencePathMap, setConfluencePathMap] = useState<Map<string, string>>(new Map());
  // size > 0 까지 매 render 시 1회 시도 (idempotent guard via ref). HMR 후 useEffect deps=[]
  // 가 재실행 안 되는 한계 회피 — fetch 성공 후엔 size 가 차서 더 이상 fetch X.
  // size > 0 까지 매 render 시 1회 시도 (idempotent guard via ref). HMR 후 useEffect deps=[]
  // 가 재실행 안 되는 한계 회피 — fetch 성공 후엔 size 가 차서 더 이상 fetch X.
  const fetchInflightRef = useRef(false);
  useEffect(() => {
    if (confluencePathMap.size > 0 || fetchInflightRef.current) return;
    fetchInflightRef.current = true;
    void (async () => {
      try {
        const tree = await window.projk.getConfluenceTree();
        const m = buildConfluencePathMap(tree?.nodes ?? []);
        if (m.size > 0) setConfluencePathMap(m);
      } catch (e) {
        console.warn('[quick-find] confluence tree load fail:', (e as Error).message);
      } finally {
        fetchInflightRef.current = false;
      }
    })();
  });

  // input 변경 시 debounce 후 fast=true 로 호출. Enter 면 즉시 fast=false.
  const runSearch = async (query: string, fast: boolean) => {
    abortRef.current?.abort();
    if (!query.trim()) {
      setState((s) => ({ ...s, hits: [], status: '', busy: false, error: undefined }));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // 새 stream 시작 — 이전 hits 즉시 비우기 (typing 중 stale 결과 잔존 방지).
    // 펼친 그룹 상태도 reset — 결과 셋이 통째로 바뀌니 이전 펼침 상태는 의미 없음.
    setState((s) => ({ ...s, hits: [], status: '', busy: true, error: undefined, expanded: undefined, latencyMs: undefined, expandedGroups: new Set() }));
    try {
      await quickFind(
        query,
        { fast, limit: state.limit, signal: controller.signal },
        (event) => {
          if (controller.signal.aborted) return;
          if (event.type === 'status') {
            const msg = typeof event.message === 'string' ? event.message : '';
            if (msg) setState((s) => ({ ...s, status: msg }));
          } else if (event.type === 'hit') {
            const data = event.data as QuickFindHit | undefined;
            if (data) setState((s) => ({ ...s, hits: [...s.hits, data] }));
          } else if (event.type === 'result') {
            const data = event.data as QuickFindResult | undefined;
            if (data) {
              setState((s) => ({
                ...s,
                busy: false,
                expanded: data.expanded,
                latencyMs: data.latency_ms,
              }));
            } else {
              setState((s) => ({ ...s, busy: false }));
            }
          } else if (event.type === 'error') {
            const msg = typeof event.message === 'string' ? event.message : '검색 실패';
            setState((s) => ({ ...s, busy: false, error: msg }));
          }
        },
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, busy: false, error: msg }));
    }
  };

  // input 변경 또는 limit 변경 → 200ms debounce → fast=true 재검색.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(state.query, true);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.query, state.limit]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter 면 debounce 우회하고 즉시 풀 quality.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void runSearch(state.query, false);
    }
  };

  const onHitClick = (hit: QuickFindHit) => {
    if (hit.type === 'confluence') {
      const fromHit = hit.confluence_page_id;
      const fromTree = fromHit ? null : lookupConfluencePageId(confluencePathMap, hit.path);
      if (!fromHit && !fromTree) {
        console.warn(
          `[quick-find] confluence pageId not resolved: path="${hit.path}" tree.size=${confluencePathMap.size}`,
        );
      }
    }
    useWorkbenchStore.getState().openTab(hitToTabSpec(hit, confluencePathMap));
  };

  const toggleGroup = (key: string) => {
    setState((s) => {
      const next = new Set(s.expandedGroups);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...s, expandedGroups: next };
    });
  };

  const onLimitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = Number(e.target.value);
    saveLimit(next);
    setState((s) => ({ ...s, limit: next }));
  };

  return (
    <div className="quick-find-panel" data-testid="quick-find-panel">
      <div className="qf-input-row">
        <i className="codicon codicon-search qf-input-icon" aria-hidden="true" />
        <input
          type="text"
          className="qf-input"
          placeholder="문서 / 시트 / 워크북 빠르게 찾기 (Enter = 풀 검색)"
          value={state.query}
          onChange={(e) => setState((s) => ({ ...s, query: e.target.value }))}
          onKeyDown={onKeyDown}
          data-testid="qf-input"
          spellCheck={false}
        />
        <select
          className="qf-limit-select"
          value={state.limit}
          onChange={onLimitChange}
          title="결과 개수"
          aria-label="결과 개수"
          data-testid="qf-limit-select"
        >
          {LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {state.busy && (
        <div className="qf-status" data-testid="qf-status">
          {state.status || '검색 중…'}
        </div>
      )}
      {state.error && (
        <div className="qf-error" data-testid="qf-error">
          {state.error}
        </div>
      )}
      {!state.busy && state.hits.length > 0 && (
        <div className="qf-meta" data-testid="qf-meta">
          {state.hits.length}건
          {state.latencyMs != null ? ` · ${state.latencyMs}ms` : ''}
          {state.expanded ? ' · 🔮 동의어 확장' : ''}
        </div>
      )}
      <div className="qf-results" data-testid="qf-results">
        {groupHits(state.hits).map((group) => {
          if (group.kind === 'single') {
            const hit = group.hit;
            const b = badge(hit.source);
            return (
              <button
                key={hit.doc_id}
                type="button"
                className={`qf-hit ${hit.type}`}
                onClick={() => onHitClick(hit)}
                data-testid={`qf-hit-${hit.doc_id}`}
                title={hit.path}
              >
                <span className="qf-hit-icon" aria-hidden="true">
                  {hit.type === 'xlsx' ? <WorkbookIcon /> : <ConfluenceIcon />}
                </span>
                <span className="qf-hit-body">
                  <span className="qf-hit-title">
                    <span className="qf-hit-source" title={b.title}>
                      {b.glyph}
                    </span>
                    {hit.title}
                  </span>
                  <span className="qf-hit-path">{hit.path}</span>
                  {hit.summary && <span className="qf-hit-summary">{hit.summary}</span>}
                </span>
              </button>
            );
          }
          // workbook (xlsx) 또는 confluence-folder 그룹 — 같은 트리 UI, kind 별 metadata 분기.
          const isWorkbook = group.kind === 'workbook';
          const titleText = isWorkbook ? group.workbook : group.folderPath;
          const subpathText = isWorkbook ? group.path : '';
          const childrenList = isWorkbook ? group.sheets : group.pages;
          const countText = isWorkbook
            ? `${group.sheets.length} 시트`
            : `${group.pages.length} 페이지`;
          const HeaderIcon = isWorkbook ? WorkbookIcon : ConfluenceIcon;
          const ChildIcon = isWorkbook ? SheetIcon : PageIcon;
          const colorClass = isWorkbook ? 'xlsx' : 'confluence';
          const isExpanded = state.expandedGroups.has(group.key);
          return (
            <div
              key={group.key}
              className={`qf-group ${colorClass} ${isExpanded ? 'expanded' : 'collapsed'}`}
              data-testid={`qf-group-${group.key}`}
            >
              <button
                type="button"
                className="qf-group-header"
                onClick={() => toggleGroup(group.key)}
                aria-expanded={isExpanded}
                title={subpathText || titleText}
                data-testid={`qf-group-header-${group.key}`}
              >
                <span className="qf-group-chevron" aria-hidden="true">
                  {isExpanded ? '▾' : '▸'}
                </span>
                <span className="qf-hit-icon" aria-hidden="true">
                  <HeaderIcon />
                </span>
                <span className="qf-group-body">
                  <span className="qf-group-title">
                    {titleText}
                    <span className="qf-group-count">· {countText}</span>
                  </span>
                  {subpathText && <span className="qf-hit-path">{subpathText}</span>}
                </span>
              </button>
              {isExpanded &&
                childrenList.map((hit) => {
                  const b = badge(hit.source);
                  return (
                    <button
                      key={hit.doc_id}
                      type="button"
                      className={`qf-hit qf-hit-child ${colorClass}`}
                      onClick={() => onHitClick(hit)}
                      data-testid={`qf-hit-${hit.doc_id}`}
                      title={hit.path}
                    >
                      <span className="qf-hit-icon" aria-hidden="true">
                        <ChildIcon />
                      </span>
                      <span className="qf-hit-body">
                        <span className="qf-hit-title">
                          <span className="qf-hit-source" title={b.title}>
                            {b.glyph}
                          </span>
                          {hit.title}
                        </span>
                        {hit.summary && <span className="qf-hit-summary">{hit.summary}</span>}
                      </span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
      {!state.busy && !state.error && state.hits.length === 0 && state.query.trim() && (
        <div className="qf-empty" data-testid="qf-empty">
          결과 없음
        </div>
      )}
      {!state.query.trim() && (
        <div className="qf-empty" data-testid="qf-empty">
          query 를 입력하면 즉시 keyword 검색이 시작됩니다. Enter 로 풀 검색.
        </div>
      )}
    </div>
  );
}
