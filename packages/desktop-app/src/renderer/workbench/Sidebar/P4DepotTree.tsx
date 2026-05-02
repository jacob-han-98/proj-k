import { useEffect, useState, type ReactElement } from 'react';
import type { P4DepotEntry, TreeNode } from '../../../shared/types';
import { useWorkbenchStore } from '../store';
import { docKeyOfDepot } from '../types';

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
  const [discovering, setDiscovering] = useState(false);
  const [discoveryMsg, setDiscoveryMsg] = useState<string | null>(null);
  // depot 파일 클릭 → openDepotFile 진행 중인 path. 같은 파일 다중 클릭 방지 + tree-row 에 "다운로드 중…" 표시.
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openErrorPath, setOpenErrorPath] = useState<{ path: string; msg: string } | null>(null);
  // 캐시된 depot path 집합 — mount + refresh + 파일 open 후 갱신. 트리에 📥 아이콘 표시.
  const [cachedPaths, setCachedPaths] = useState<Set<string>>(new Set());
  const editingDocs = useWorkbenchStore((s) => s.editingDocs);
  const setDocEditing = useWorkbenchStore((s) => s.setDocEditing);

  const reloadCachedPaths = async () => {
    try {
      const list = await window.projk.p4.cachedPaths();
      setCachedPaths(new Set(list.map((e) => e.path)));
    } catch (e) {
      console.warn('cachedPaths fetch failed', e);
    }
  };

  // depot 파일 클릭 시: head revision 으로 캐시 lookup → cache miss 면 p4 print + OneDrive 업로드 →
  // 결과 URL 로 새 excel 탭 open. CenterPane 의 sheet 분기에서 node.oneDriveUrl 을 우선 사용.
  const openDepotFile = async (entry: P4DepotEntry) => {
    if (openingPath) return; // 이미 진행 중
    setOpeningPath(entry.path);
    setOpenErrorPath(null);
    try {
      const r = await window.projk.p4.openDepotFile(entry.path);
      if (!r.ok || !r.url) {
        setOpenErrorPath({ path: entry.path, msg: r.error ?? '실패' });
        return;
      }
      // 임시 TreeNode — id 가 path + revision 으로 unique 하고, tabIdOf 가 oneDriveUrl 있을 때
      // node.id 를 그대로 탭 id 로 사용 → 같은 파일의 다른 revision 은 별도 탭으로 유지.
      const node: TreeNode = {
        id: `depot:${entry.path}#rev${r.revision}`,
        type: 'sheet',
        title: entry.name,
        relPath: entry.path.replace(/^\/\//, ''),
        oneDriveUrl: r.url,
      };
      useWorkbenchStore.getState().openTab({ kind: 'excel', node });
      // 캐시 manifest 가 갱신됐으니 트리의 📥 아이콘도 즉시 반영.
      void reloadCachedPaths();
    } catch (e) {
      setOpenErrorPath({ path: entry.path, msg: (e as Error).message });
    } finally {
      setOpeningPath(null);
    }
  };

  // settings 가 비어있어 트리가 안 뜰 때 inline 으로 자동 발견 + 저장 + 즉시 새로고침.
  // SettingsModal 의 discover 는 form 만 채우고 사용자가 "저장하고 적용" 까지 눌러야 반영
  // 되어 막힘. 사이드바에서 한 번 클릭으로 끝나게 한다.
  const runDiscoverAndSave = async () => {
    setDiscovering(true);
    setDiscoveryMsg(null);
    try {
      const info = await window.projk.p4.discover();
      if (info.ok) {
        // PoC 2C — p4 info 의 Client root 까지 settings 에 박아두면 sidecar /xlsx_raw 가
        // OneDrive 자동 매핑 시 첫 file picker 없이 바로 fetch. 사용자가 다른 사이드바 (host/user/client)
        // 와 똑같이 한 번 클릭으로 끝남.
        await window.projk.setSettings({
          p4Host: info.host,
          p4User: info.user,
          p4Client: info.client,
          p4WorkspaceRoot: info.clientRoot,
        });
        const candidates =
          info.candidates && info.candidates.length > 0
            ? ` (다른 후보: ${info.candidates.join(', ')})`
            : '';
        const rootHint = info.clientRoot ? ` / root ${info.clientRoot}` : '';
        setDiscoveryMsg(
          `✓ 발견 + 저장 — ${info.host} / ${info.user} / ${info.client ?? '(client 없음)'}${rootHint}${candidates}`,
        );
        setRefreshKey((k) => k + 1);
      } else {
        setDiscoveryMsg(`✗ ${info.diagnostics ?? '발견 실패'}`);
      }
    } catch (e) {
      setDiscoveryMsg(`✗ 호출 실패: ${(e as Error).message}`);
    } finally {
      setDiscovering(false);
    }
  };

  // mount 시 + 새로고침 클릭 시 root 재 fetch + 2단계 깊이까지 auto-expand.
  // stream workspace (단일 root '//main/ProjectK') 에서는 root + 그 자식까지 자동 펼침이라
  // 첫 진입에 ART/Build/Design/... 이 즉시 보임.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await window.projk.p4.depotRoots();
      if (cancelled) return;
      if (!r.ok || r.entries.length === 0) {
        setState((s) => ({
          ...s,
          loaded: true,
          ok: r.ok,
          rootEntries: r.entries,
          diagnostics: r.diagnostics,
          childrenByPath: new Map(),
          loadingPaths: new Set(),
          errorByPath: new Map(),
        }));
        setExpanded(new Set());
        return;
      }
      // 각 root 의 자식 병렬 fetch — 2단계 auto-expand 위해.
      const childResults = await Promise.all(
        r.entries.map((e) =>
          window.projk.p4.depotDirs(e.path).catch((err) => ({
            ok: false as const,
            entries: [] as P4DepotEntry[],
            diagnostics: (err as Error).message,
          })),
        ),
      );
      if (cancelled) return;
      const childrenByPath = new Map<string, P4DepotEntry[]>();
      const errorByPath = new Map<string, string>();
      r.entries.forEach((e, i) => {
        const cr = childResults[i];
        childrenByPath.set(e.path, cr.entries);
        if (!cr.ok && cr.diagnostics) errorByPath.set(e.path, cr.diagnostics);
      });
      setState({
        loaded: true,
        ok: r.ok,
        rootEntries: r.entries,
        diagnostics: r.diagnostics,
        childrenByPath,
        loadingPaths: new Set(),
        errorByPath,
      });
      // 모든 root 를 expanded 로 만들어서 첫 자식까지 한 번에 보이게.
      setExpanded(new Set(r.entries.map((e) => e.path)));
    })();
    void reloadCachedPaths();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const toggle = async (entry: P4DepotEntry) => {
    if (entry.kind === 'file') {
      // PR9c: depot 파일 보기 — `p4 print` → OneDrive depot 폴더 → read-only Excel for the Web.
      // 편집은 P4 checkout 흐름 (별도, 향후).
      void openDepotFile(entry);
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

    const isOpening = openingPath === path && entry.kind === 'file';
    const openErr = openErrorPath && openErrorPath.path === path ? openErrorPath.msg : null;
    const isFile = entry.kind === 'file';
    const docKey = isFile ? docKeyOfDepot(entry.path) : null;
    const isEditing = !!docKey && !!editingDocs[docKey];

    // 편집 토글 — 파일이 아직 OneDrive 캐시에 없으면 openDepotFile 로 download + upload 부터.
    // 그 다음 store 의 editingDocs 에 토글 → CenterPane 의 DepotSheetView 가 src 를 ?action=edit
    // 으로 swap + reload.
    const onToggleEdit = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!docKey) return;
      // 탭이 없으면 openDepotFile 로 다운로드 + 탭 open.
      if (!cachedPaths.has(entry.path) && !isOpening) {
        void openDepotFile(entry);
      }
      setDocEditing(docKey, !isEditing);
    };

    return (
      <div key={path}>
        <div
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12, opacity: isOpening ? 0.6 : 1 }}
          onClick={() => void toggle(entry)}
          title={openErr ? openErr : path}
          data-testid={`depot-row-${path}`}
        >
          <span className="caret">{entry.kind === 'file' ? '' : isOpen ? '▾' : '▸'}</span>
          <span className="icon">
            {entry.kind === 'depot'
              ? '🗄️'
              : entry.kind === 'dir'
              ? '📁'
              : cachedPaths.has(entry.path)
              ? '📥'
              : '📄'}
          </span>
          <span className="label">{entry.name}</span>
          {isOpening && (
            <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-dim)' }}>다운로드 중…</span>
          )}
          {openErr && !isOpening && (
            <span style={{ marginLeft: 6, fontSize: 10, color: '#dc2626' }} title={openErr}>
              ⚠
            </span>
          )}
          {isFile && (
            <button
              type="button"
              className={`tree-edit-toggle${isEditing ? ' editing' : ''}`}
              onClick={onToggleEdit}
              data-testid={`depot-edit-toggle-${entry.path}`}
              title={isEditing ? '편집 모드 끄기 (임베드 뷰로 reload)' : '편집 모드 켜기 (P4 에는 영향 없음)'}
              aria-label={isEditing ? '편집 중' : '편집 시작'}
              aria-pressed={isEditing}
            >
              {isEditing ? '📝' : '✏'}
            </button>
          )}
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

  // settings.json 에 p4Host/p4User/p4Client 가 없으면 main 이 "P4 좌표 미설정" 으로 응답.
  // 그 케이스를 별도 empty-state 로 잡아서 자동 발견 CTA 를 강조한다.
  const isUnconfigured =
    state.loaded && !state.ok && !!state.diagnostics && state.diagnostics.includes('미설정');

  return (
    <div className="sidebar" data-testid="depot-tree-container">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <button
          type="button"
          onClick={() => void runDiscoverAndSave()}
          disabled={discovering}
          data-testid="depot-discover"
          style={{
            all: 'unset',
            cursor: discovering ? 'wait' : 'pointer',
            color: 'var(--text)',
            fontSize: 11,
            padding: '2px 6px',
            border: '1px solid var(--border)',
            borderRadius: 3,
            opacity: discovering ? 0.6 : 1,
          }}
          title="p4tickets.txt + Windows registry 로 P4 좌표 자동 발견 + 즉시 저장 + 트리 갱신"
        >
          {discovering ? '발견 중…' : '🔍 자동 발견'}
        </button>
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
      {discoveryMsg && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 10,
            color: discoveryMsg.startsWith('✓') ? '#16a34a' : '#dc2626',
            lineHeight: 1.4,
            borderBottom: '1px solid var(--border)',
          }}
          data-testid="depot-discover-msg"
        >
          {discoveryMsg}
        </div>
      )}
      <div className="tree" data-testid="depot-tree">
        {!state.loaded && (
          <div className="tree-row" style={{ color: 'var(--text-dim)', paddingLeft: 12 }}>
            로딩 중…
          </div>
        )}
        {isUnconfigured && (
          <div
            style={{ padding: '12px 12px', color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.5 }}
            data-testid="depot-tree-unconfigured"
          >
            P4 좌표가 설정되지 않았습니다.
            <br />위 <strong>🔍 자동 발견</strong> 버튼을 누르면 P4V 설정에서 자동으로 좌표를 찾아 저장합니다.
          </div>
        )}
        {state.loaded && !state.ok && !isUnconfigured && (
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
