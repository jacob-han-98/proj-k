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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode, ConfluenceTreeResult, P4TreeResult } from '../../shared/types';
import { useWorkbenchStore } from './store';
import { rankItems, type ScoredItem, type SearchableItem } from './fuzzy';

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

function iconFor(source: SearchableItem['source']): string {
  if (source === 'confluence') return '📘';
  if (source === 'p4-depot') return '🗄️';
  return '📄';
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
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  const ranked = useMemo<ScoredItem[]>(() => {
    if (!query.trim()) return [];
    return rankItems(items, query, 50);
  }, [items, query]);

  // selectedIdx 가 결과 길이 벗어나면 0 으로.
  useEffect(() => {
    if (selectedIdx >= ranked.length && ranked.length > 0) setSelectedIdx(0);
  }, [ranked.length, selectedIdx]);

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
      setSelectedIdx((i) => Math.min(ranked.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = ranked[selectedIdx];
      if (sel) choose(sel);
      return;
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
          placeholder="파일 / 페이지 빠르게 찾기 (P4 local · depot · Confluence 통합)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
        />
        <div className="cmd-palette-results" data-testid="cmd-palette-results" role="listbox">
          {loading && <div className="cmd-palette-empty">로딩 중…</div>}
          {!loading && !query.trim() && (
            <div className="cmd-palette-empty">
              파일명이나 경로 일부를 입력하세요. (예: <code>pkhud</code>, <code>골드</code>, <code>설정</code>)
            </div>
          )}
          {!loading && query.trim() && ranked.length === 0 && (
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
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(it)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                >
                  <span className="cmd-palette-icon" aria-hidden="true">{iconFor(it.source)}</span>
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
          <span>↑↓ 이동 · Enter 열기 · Esc 닫기</span>
          <span>{ranked.length > 0 ? `${ranked.length}건` : ''}</span>
        </div>
      </div>
    </div>
  );
}
