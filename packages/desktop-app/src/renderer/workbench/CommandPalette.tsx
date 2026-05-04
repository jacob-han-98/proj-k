// A2: Command Palette — VS Code 의 Ctrl+P 등가물.
//
// 사용자 트리거:
//   Ctrl+P (또는 Cmd+P) → modal overlay → input + 결과 list
//   ESC: 닫기
//   Enter / 클릭: 선택 → 기존 openTab 흐름으로 위임
//
// 데이터 source 3 개 통합:
//   1) P4 워크스페이스 local — sidecar /tree/p4 (이미 캐시된 트리 노드를 walk).
//   2) P4 depot cache — main 의 P4_DEPOT_CACHE_LIST IPC (이미 보기 한 적 있는 depot 파일들).
//   3) Confluence — sidecar /tree/confluence (page 노드들).
//
// 매칭은 fuzzy.ts 의 메모리 알고리즘 — 백엔드 호출 없음, 즉시 (수 ms).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TreeNode, ConfluenceTreeResult, P4TreeResult } from '../../shared/types';
import { useWorkbenchStore } from './store';
import { rankItems, type ScoredItem, type SearchableItem } from './fuzzy';
import { ExcelFileIcon } from './Sidebar/tree-icons';
import { ConfluenceIcon, PerforceIcon } from './ActivityBar';
import { TREE_PERSIST_KEYS, loadString, saveString } from './Sidebar/tree-state-persist';

// CommandPalette 의 source 필터. Perforce 는 p4-local + p4-depot 모두 포함 (사용자 멘탈모델).
// 기본 모두 ON. 사용자 명시적 토글 (Alt+P / Alt+C) 결과만 영속.
interface PaletteFilters {
  p4: boolean;
  confluence: boolean;
}

const DEFAULT_FILTERS: PaletteFilters = { p4: true, confluence: true };

function loadFilters(): PaletteFilters {
  const raw = loadString(TREE_PERSIST_KEYS.CMD_PALETTE_FILTERS);
  if (!raw) return DEFAULT_FILTERS;
  try {
    const parsed = JSON.parse(raw);
    return {
      p4: typeof parsed.p4 === 'boolean' ? parsed.p4 : true,
      confluence: typeof parsed.confluence === 'boolean' ? parsed.confluence : true,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(f: PaletteFilters): void {
  saveString(TREE_PERSIST_KEYS.CMD_PALETTE_FILTERS, JSON.stringify(f));
}

function passesFilter(source: SearchableItem['source'], f: PaletteFilters): boolean {
  if (source === 'confluence') return f.confluence;
  return f.p4; // p4-local + p4-depot
}

// 트리 walk — TreeNode 의 leaf 들 (sheet / page) 을 SearchableItem 으로 평탄화.
function walkP4Local(nodes: TreeNode[] | undefined, out: SearchableItem[]): void {
  if (!nodes) return;
  for (const n of nodes) {
    if (n.type === 'sheet' && n.relPath) {
      out.push({ source: 'p4-local', refId: n.relPath, title: n.title, path: n.relPath });
    }
    if (n.children) walkP4Local(n.children, out);
  }
}

function walkConfluence(nodes: TreeNode[] | undefined, out: SearchableItem[]): void {
  if (!nodes) return;
  for (const n of nodes) {
    if (n.type === 'page') {
      out.push({
        source: 'confluence',
        refId: n.confluencePageId ?? n.id,
        title: n.title,
        path: n.relPath ?? n.title,
        confluencePageId: n.confluencePageId,
      });
    }
    if (n.children) walkConfluence(n.children, out);
  }
}

function depotCacheToItems(list: Array<{ path: string; revision: number }>): SearchableItem[] {
  return list.map(({ path }) => {
    const name = path.split('/').filter(Boolean).pop() ?? path;
    return { source: 'p4-depot', refId: path, title: name, path };
  });
}

// 결과 행 아이콘 — 트리 아이콘과 같은 시각 언어. 사용자가 "엑셀이면 엑셀 아이콘, 컨플은
// 컨플 아이콘" 으로 한눈에 구분. source 라벨 (P4 LOCAL / P4 DEPOT / CONFLUENCE) 은 우측에
// 별도 표시되므로 좌측 아이콘은 *콘텐츠 종류* 만 표현 (depot 도 결국 .xlsx).
function renderRowIcon(source: SearchableItem['source']): ReactNode {
  if (source === 'confluence') return <ConfluenceIcon size={16} />;
  // p4-local / p4-depot 모두 .xlsx — Excel SVG.
  return <ExcelFileIcon size={16} />;
}

function sourceLabel(source: SearchableItem['source']): string {
  if (source === 'confluence') return 'Confluence';
  if (source === 'p4-depot') return 'P4 depot';
  return 'P4 local';
}

export function CommandPalette() {
  const open = useWorkbenchStore((s) => s.paletteOpen);
  const close = useWorkbenchStore((s) => s.closePalette);
  const openTab = useWorkbenchStore((s) => s.openTab);

  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchableItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<PaletteFilters>(() => loadFilters());
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 필터 토글 + 영속. Alt+P / Alt+C / 칩 클릭 모두 이리로.
  const toggleFilter = (kind: keyof PaletteFilters) => {
    setFilters((prev) => {
      const next = { ...prev, [kind]: !prev[kind] };
      saveFilters(next);
      return next;
    });
    setSelectedIdx(0);
  };
  // 결과 컨테이너 ref — selectedIdx 변경 시 화면 밖 row 를 스크롤 동기화하는 데 사용.
  // 이전 회귀: 검색 결과가 컨테이너 max-height 보다 길 때 ↓ 키로 화면 밖 row 까지 갔는데
  // active 표시가 안 보여 사용자가 어디까지 갔는지 가늠 못 함. 자동 scrollIntoView 로 해결.
  const resultsRef = useRef<HTMLDivElement | null>(null);
  // mouseEnter 로 인한 selectedIdx 변경엔 scroll 하지 않음 (사용자가 마우스로 hover 한 row 가
  // 어차피 보이는 위치). ↑↓ 키로 인한 변경에만 scroll.
  const lastNavRef = useRef<'kbd' | 'mouse' | null>(null);

  // open 될 때 트리 데이터 fetch — 매번 fresh (사용자가 짧은 시간 내 재진입해도 비용 작음).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIdx(0);
    setLoading(true);
    let cancelled = false;
    void (async () => {
      const all: SearchableItem[] = [];
      try {
        const [p4, conf, depot] = await Promise.all([
          window.projk.getP4Tree() as Promise<P4TreeResult>,
          window.projk.getConfluenceTree() as Promise<ConfluenceTreeResult>,
          window.projk.p4.cachedPaths().catch(() => [] as Array<{ path: string; revision: number }>),
        ]);
        if (cancelled) return;
        walkP4Local(p4?.nodes, all);
        walkConfluence(conf?.nodes, all);
        all.push(...depotCacheToItems(depot ?? []));
      } catch (e) {
        console.warn('[CommandPalette] tree fetch 실패:', (e as Error).message);
      }
      if (cancelled) return;
      setItems(all);
      setLoading(false);
      // input 에 focus.
      setTimeout(() => inputRef.current?.focus(), 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 매 query 변경마다 ranking — 메모리 안 작업이라 동기.
  // filter 가 OFF 인 source 는 ranking 전에 제외.
  const ranked = useMemo<ScoredItem[]>(() => {
    if (!query.trim()) return [];
    const visible = items.filter((it) => passesFilter(it.source, filters));
    return rankItems(visible, query, 50);
  }, [items, query, filters]);

  // selectedIdx 가 결과 길이 벗어나면 0 으로.
  useEffect(() => {
    if (selectedIdx >= ranked.length && ranked.length > 0) setSelectedIdx(0);
  }, [ranked.length, selectedIdx]);

  // 키보드 ↑↓ 로 selectedIdx 가 화면 밖으로 이동하면 자동 스크롤.
  // block:'nearest' — 위로 가면 위에 붙고, 아래로 가면 아래에 붙음. 보이는 위치면 no-op.
  useEffect(() => {
    if (lastNavRef.current !== 'kbd') return;
    const root = resultsRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>(`[data-row-idx="${selectedIdx}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // 선택 — 해당 source 에 맞는 openTab 흐름으로 위임.
  const choose = (it: ScoredItem) => {
    if (it.source === 'p4-local') {
      const node: TreeNode = {
        id: `sheet:${it.refId}`,
        type: 'sheet',
        title: it.title,
        relPath: it.refId,
      };
      openTab({ kind: 'excel', node });
    } else if (it.source === 'p4-depot') {
      // depot 파일은 별도 흐름 (`p4 print` → OneDrive 업로드) — P4DepotTree 의 openDepotFile 가
      // tab 에 넣는데 여기서는 단순화 차원에 임시로 sheet 노드처럼 핸들러 위임. 향후 정확화 가능.
      const node: TreeNode = {
        id: `depot-cmd:${it.refId}`,
        type: 'sheet',
        title: it.title,
        relPath: it.refId,
      };
      openTab({ kind: 'excel', node });
    } else if (it.source === 'confluence') {
      const node: TreeNode = {
        id: `page:${it.confluencePageId ?? it.refId}`,
        type: 'page',
        title: it.title,
        relPath: it.path,
        confluencePageId: it.confluencePageId,
      };
      openTab({ kind: 'confluence', node });
    }
    close();
  };

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      lastNavRef.current = 'kbd';
      setSelectedIdx((i) => Math.min(ranked.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      lastNavRef.current = 'kbd';
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = ranked[selectedIdx];
      if (sel) choose(sel);
      return;
    }
    // Alt+P / Alt+C — source 필터 토글. input focus 중에도 동작 (palette 안에서만 의미 있음).
    // ctrl/meta 함께 누르면 다른 단축키와 충돌 가능 → Alt 단독만.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'p') {
        e.preventDefault();
        toggleFilter('p4');
        return;
      }
      if (k === 'c') {
        e.preventDefault();
        toggleFilter('confluence');
        return;
      }
    }
  };

  return (
    <div
      className="cmd-palette-backdrop"
      data-testid="cmd-palette-backdrop"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      <div
        className="cmd-palette"
        data-testid="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="cmd-palette-input"
          data-testid="cmd-palette-input"
          type="text"
          spellCheck={false}
          placeholder="파일 / 페이지 검색  (Ctrl+P)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
        />
        <div className="cmd-palette-filters" role="group" aria-label="검색 source 필터">
          <FilterChip
            active={filters.p4}
            label="Perforce"
            shortcutLabel="Alt+P"
            icon={<PerforceIcon size={14} />}
            onToggle={() => toggleFilter('p4')}
            testId="cmd-palette-filter-p4"
          />
          <FilterChip
            active={filters.confluence}
            label="Confluence"
            shortcutLabel="Alt+C"
            icon={<ConfluenceIcon size={14} />}
            onToggle={() => toggleFilter('confluence')}
            testId="cmd-palette-filter-confluence"
          />
        </div>
        <div
          ref={resultsRef}
          className="cmd-palette-results"
          data-testid="cmd-palette-results"
          role="listbox"
        >
          {loading && <div className="cmd-palette-empty">로딩 중…</div>}
          {!loading && !query.trim() && (
            <div className="cmd-palette-empty">
              파일명이나 경로 일부를 입력하세요. (예: <code>pkhud</code>, <code>골드</code>, <code>설정</code>)
            </div>
          )}
          {!loading && query.trim() && ranked.length === 0 && !filters.p4 && !filters.confluence && (
            <div className="cmd-palette-empty">
              모든 source 필터가 꺼져 있습니다. <strong>Alt+P</strong> 또는 <strong>Alt+C</strong> 로 다시 켜세요.
            </div>
          )}
          {!loading && query.trim() && ranked.length === 0 && (filters.p4 || filters.confluence) && (
            <div className="cmd-palette-empty">결과 없음 — 다른 키워드로 시도하세요.</div>
          )}
          {!loading &&
            ranked.map((it, idx) => {
              const active = idx === selectedIdx;
              return (
                <button
                  key={`${it.source}:${it.refId}`}
                  type="button"
                  className={`cmd-palette-row${active ? ' active' : ''}`}
                  data-testid={`cmd-palette-row-${idx}`}
                  data-row-idx={idx}
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(it)}
                  onMouseEnter={() => {
                    lastNavRef.current = 'mouse';
                    setSelectedIdx(idx);
                  }}
                >
                  <span className="cmd-palette-icon" aria-hidden="true">{renderRowIcon(it.source)}</span>
                  <span className="cmd-palette-body">
                    <span className="cmd-palette-title">{it.title}</span>
                    <span className="cmd-palette-path">{it.path}</span>
                  </span>
                  <span className="cmd-palette-source" title={sourceLabel(it.source)}>
                    {sourceLabel(it.source)}
                  </span>
                </button>
              );
            })}
        </div>
        <div className="cmd-palette-footer">
          <span>↑↓ 이동 · Enter 열기 · Esc 닫기 · Alt+P/C 필터 토글</span>
          <span>{ranked.length > 0 ? `${ranked.length}건` : ''}</span>
        </div>
      </div>
    </div>
  );
}

// 필터 칩 — 토글형. 활성 시 brand 색 + ✓, 비활성 시 회색 + 빈 박스. 단축키도 같이 표시해
// 사용자가 어떤 키를 누르면 토글되는지 한눈에. 클릭으로도 동일 toggleFilter 호출.
function FilterChip({
  active,
  label,
  shortcutLabel,
  icon,
  onToggle,
  testId,
}: {
  active: boolean;
  label: string;
  shortcutLabel: string;
  icon: ReactNode;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={`cmd-palette-filter-chip${active ? ' on' : ' off'}`}
      data-testid={testId}
      aria-pressed={active}
      title={`${label} ${active ? 'ON' : 'OFF'} (${shortcutLabel})`}
      // mousedown 으로 처리 — click 이면 input focus 가 잠깐 빠져 e.altKey 핸들러 동작 안 함.
      onMouseDown={(e) => {
        e.preventDefault();
        onToggle();
      }}
    >
      <span className="cmd-palette-filter-checkbox" aria-hidden="true">{active ? '☑' : '☐'}</span>
      <span className="cmd-palette-filter-icon" aria-hidden="true">{icon}</span>
      <span className="cmd-palette-filter-label">{label}</span>
      <span className="cmd-palette-filter-kbd">{shortcutLabel}</span>
    </button>
  );
}
