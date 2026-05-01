// PR10: Quick Find 활성화 — agent-sdk-poc /quick_find (sidecar proxy) 호출.
// typing-as-you-search: input 입력 중 200ms debounce → fast=true 호출 (~50ms L1 only).
// 사용자가 Enter 누르면 fast=false (auto v2.1, ~300ms) 로 풀 quality.
// hit 클릭 → editor 탭 open. doc_id 의 prefix 로 confluence/xlsx 분기.

import { useEffect, useRef, useState } from 'react';
import { quickFind } from '../../api';
import type { QuickFindHit, QuickFindResult, TreeNode } from '../../../shared/types';
import { useWorkbenchStore } from '../store';

interface State {
  query: string;
  hits: QuickFindHit[];
  status: string;
  busy: boolean;
  error?: string;
  expanded?: boolean;
  latencyMs?: number;
}

const initial: State = { query: '', hits: [], status: '', busy: false };

// hit 의 doc_id / type 으로부터 store.openTab 의 spec 만들기. xlsx 와 confluence 가
// hit shape 의 어디에 path/id 를 들고 있는지 contract 메시지 참조:
//   xlsx::      doc_id = "xlsx::<workbook>::<sheet>", path 표시용. content_md_path 는 본문.
//   conf::      doc_id = "conf::<path>",   confluencePageId 는 hit 에 직접 없음 (TODO: backend 가 제공해주면 정확).
// 임시: workbook + path 로 가짜 TreeNode 만들고 selection 채우는 식 (QnATab 의 thread-doc 클릭과 같은 패턴).
function hitToTabSpec(hit: QuickFindHit) {
  const node: TreeNode = {
    id: `${hit.type}:${hit.doc_id}`,
    type: hit.type === 'confluence' ? 'page' : 'sheet',
    title: hit.title,
    relPath: hit.path,
    // Confluence 페이지 ID 는 doc_id 끝부분 (있으면) — 정확한 form 은 backend 가 추후 hit 에 추가 예정.
    confluencePageId: hit.type === 'confluence' ? hit.doc_id : undefined,
  };
  return {
    kind: hit.type === 'confluence' ? ('confluence' as const) : ('excel' as const),
    node,
  };
}

function badge(source: 'l1' | 'vector' | 'expand'): { glyph: string; title: string } {
  if (source === 'l1') return { glyph: '⚡', title: '키워드 매칭' };
  if (source === 'vector') return { glyph: '🧬', title: '의미 검색' };
  return { glyph: '🔮', title: '동의어 확장' };
}

function iconFor(type: 'xlsx' | 'confluence'): string {
  return type === 'xlsx' ? '📄' : '📘';
}

export function QuickFindPanel() {
  const [state, setState] = useState<State>(initial);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    setState((s) => ({ ...s, hits: [], status: '', busy: true, error: undefined, expanded: undefined, latencyMs: undefined }));
    try {
      await quickFind(
        query,
        { fast, limit: 10, signal: controller.signal },
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

  // input 변경 → 200ms debounce → fast=true.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(state.query, true);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.query]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter 면 debounce 우회하고 즉시 풀 quality.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void runSearch(state.query, false);
    }
  };

  const onHitClick = (hit: QuickFindHit) => {
    useWorkbenchStore.getState().openTab(hitToTabSpec(hit));
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
        {state.hits.map((hit) => {
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
                {iconFor(hit.type)}
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
