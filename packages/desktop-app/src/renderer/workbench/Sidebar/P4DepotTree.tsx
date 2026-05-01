import { useEffect, useState, type ReactElement } from 'react';
import type { P4DepotEntry } from '../../../shared/types';

// PR9b: depot 트리 — lazy expand. mount 시 root depot list, 폴더 expand 시 자식 fetch.
// 보기 전용. 파일 클릭 시 안내만 (편집은 별도 P4 checkout 흐름).
//
// 캐시 정책: 한 번 fetch 한 path 의 자식은 컴포넌트 lifetime 동안 보존 (P4Panel 자체가 항상
// mount 이라 활동바 토글로도 안 사라짐). "🔄 새로고침" 버튼으로 사용자가 명시 invalidate.
// settings 의 P4 좌표 변경은 사용자가 SettingsModal 닫은 후 새로고침 누르면 반영.

interface State {
  loaded: boolean;
  ok: boolean;
  diagnostics?: string;
  rootEntries: P4DepotEntry[];
  // path → children (undefined = 아직 fetch 안 함, [] = 빈 폴더)
  childrenByPath: Map<string, P4DepotEntry[]>;
  // path → 진행 중 (loading spinner 표시)
  loadingPaths: Set<string>;
  // path → fetch 실패 메시지
  errorByPath: Map<string, string>;
}

const initial: State = {
  loaded: false,
  ok: false,
  rootEntries: [],
  childrenByPath: new Map(),
  loadingPaths: new Set(),
  errorByPath: new Map(),
};

export function P4DepotTree() {
  const [state, setState] = useState<State>(initial);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);

  // mount 시 + 새로고침 클릭 시 root 재 fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await window.projk.p4.depotRoots();
      if (cancelled) return;
      setState((s) => ({
        ...s,
        loaded: true,
        ok: r.ok,
        rootEntries: r.entries,
        diagnostics: r.diagnostics,
        // 새로고침 시 자식 캐시 / 펼침 상태도 모두 invalidate.
        childrenByPath: new Map(),
        loadingPaths: new Set(),
        errorByPath: new Map(),
      }));
      setExpanded(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const toggle = async (entry: P4DepotEntry) => {
    if (entry.kind === 'file') {
      // 보기 전용 — 알림만. 편집은 P4 checkout 흐름.
      alert(
        `${entry.path}\n\n이 파일은 depot 보기 전용입니다.\n` +
          `편집하려면 P4V 또는 \`p4 sync\` + \`p4 edit\` 로 local 워크스페이스에 받은 뒤 ` +
          `P4 사이드바의 local 탭에서 여세요.`,
      );
      return;
    }
    const path = entry.path;
    const isOpen = expanded.has(path);
    if (isOpen) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((prev) => new Set(prev).add(path));
    // 자식이 캐시에 없으면 fetch (loading 중이거나 이전에 실패해도 한 번 더 시도하려면 새로고침).
    if (!state.childrenByPath.has(path) && !state.loadingPaths.has(path)) {
      setState((s) => {
        const loading = new Set(s.loadingPaths);
        loading.add(path);
        return { ...s, loadingPaths: loading };
      });
      const r = await window.projk.p4.depotDirs(path);
      setState((s) => {
        const loading = new Set(s.loadingPaths);
        loading.delete(path);
        const childrenByPath = new Map(s.childrenByPath);
        const errorByPath = new Map(s.errorByPath);
        if (r.ok) {
          childrenByPath.set(path, r.entries);
          errorByPath.delete(path);
        } else {
          childrenByPath.set(path, []);
          if (r.diagnostics) errorByPath.set(path, r.diagnostics);
        }
        return { ...s, loadingPaths: loading, childrenByPath, errorByPath };
      });
    }
  };

  const renderEntry = (entry: P4DepotEntry, depth: number): ReactElement => {
    const path = entry.path;
    const isOpen = expanded.has(path);
    const children = state.childrenByPath.get(path);
    const loading = state.loadingPaths.has(path);
    const error = state.errorByPath.get(path);

    return (
      <div key={path}>
        <div
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => void toggle(entry)}
          title={path}
          data-testid={`depot-row-${path}`}
        >
          <span className="caret">{entry.kind === 'file' ? '' : isOpen ? '▾' : '▸'}</span>
          <span className="icon">
            {entry.kind === 'depot' ? '🗄️' : entry.kind === 'dir' ? '📁' : '📄'}
          </span>
          <span className="label">{entry.name}</span>
        </div>
        {isOpen && entry.kind !== 'file' && (
          <div className="tree-children">
            {loading && (
              <div className="tree-row" style={{ paddingLeft: 8 + (depth + 1) * 12, color: 'var(--text-dim)' }}>
                로딩 중…
              </div>
            )}
            {error && (
              <div
                className="tree-row"
                style={{ paddingLeft: 8 + (depth + 1) * 12, color: '#dc2626', fontSize: 11 }}
              >
                {error}
              </div>
            )}
            {!loading && children && children.length === 0 && !error && (
              <div className="tree-row" style={{ paddingLeft: 8 + (depth + 1) * 12, color: 'var(--text-dim)' }}>
                (비어있음)
              </div>
            )}
            {children?.map((c) => renderEntry(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="sidebar" data-testid="depot-tree-container">
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '4px 8px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          data-testid="depot-refresh"
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--text-dim)',
            fontSize: 11,
            padding: '2px 6px',
          }}
          title="depot 트리 새로고침 (좌표 변경 후)"
        >
          🔄 새로고침
        </button>
      </div>
      <div className="tree" data-testid="depot-tree">
        {!state.loaded && (
          <div className="tree-row" style={{ color: 'var(--text-dim)', paddingLeft: 12 }}>
            로딩 중…
          </div>
        )}
        {state.loaded && !state.ok && (
          <div
            style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.5 }}
            data-testid="depot-tree-error"
          >
            {state.diagnostics ?? '발견 실패'}
          </div>
        )}
        {state.loaded && state.ok && state.rootEntries.length === 0 && (
          <div
            style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11 }}
            data-testid="depot-tree-empty"
          >
            depot 가 비어있습니다.
          </div>
        )}
        {state.loaded && state.ok && state.rootEntries.map((e) => renderEntry(e, 0))}
      </div>
    </div>
  );
}
