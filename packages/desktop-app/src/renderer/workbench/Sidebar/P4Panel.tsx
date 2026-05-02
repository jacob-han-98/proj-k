import { useEffect, useState, type ReactElement } from 'react';
import type { TreeNode, P4TreeResult } from '../../../shared/types';
import { P4DepotTree } from './P4DepotTree';
import { useWorkbenchStore } from '../store';
import { docKeyOfLocal } from '../types';

// PR3: P4 (Perforce 기획서) 사이드바 패널.
// PR9b: depot 탭 활성화. local 탭은 데이터 루트 기반 트리, depot 탭은 P4 좌표 기반 lazy 트리.

type P4Source = 'local' | 'depot';

interface Props {
  selectedId: string | null;
  onOpenSheet: (node: TreeNode) => void;
}

export function P4Panel({ selectedId, onOpenSheet }: Props) {
  // PR9b: source 탭 토글 — local (데이터 루트 미러) vs depot (Perforce 서버 직접 조회, 보기 전용).
  const [source, setSource] = useState<P4Source>('local');
  const [p4, setP4] = useState<P4TreeResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const editingDocs = useWorkbenchStore((s) => s.editingDocs);
  const setDocEditing = useWorkbenchStore((s) => s.setDocEditing);

  useEffect(() => {
    const fetchTree = () => {
      window.projk.getP4Tree().then(setP4).catch((e) => console.error('p4 tree', e));
    };
    fetchTree();
    // sidecar 가 starting → ready 로 바뀌면 재요청 (TreeSidebar 와 동일 패턴 유지).
    const off = window.projk.onSidecarStatus((s) => {
      if (s.state === 'ready') fetchTree();
    });
    return off;
  }, []);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number): ReactElement => {
    const hasChildren = !!node.children && node.children.length > 0;
    const isOpen = expanded.has(node.id);
    const isActive = selectedId === node.id;
    const isSheet = node.type === 'sheet' && !!node.relPath;
    const docKey = isSheet ? docKeyOfLocal(node.relPath!) : null;
    const isEditing = !!docKey && !!editingDocs[docKey];

    const onClick = () => {
      if (hasChildren) toggle(node.id);
      else if (node.type === 'sheet') onOpenSheet(node);
    };

    // 편집 토글 버튼 — 탭 열기 + editing on/off.
    // 처음 클릭 (view 상태): 탭 열고 edit 모드로. 다시 클릭: edit 끄고 view 로.
    // tree-row onClick 으로 버블링되면 행 자체 select 가 또 일어나므로 stopPropagation.
    const onToggleEdit = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!docKey) return;
      onOpenSheet(node); // 탭이 없으면 열기 + 있으면 focus
      setDocEditing(docKey, !isEditing);
    };

    return (
      <div key={node.id}>
        <div
          className={`tree-row ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={onClick}
          title={node.title}
          data-testid={`p4-row-${node.id}`}
        >
          <span className="caret">{hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
          <span className="icon">{iconFor(node)}</span>
          <span className="label">{node.title}</span>
          {isSheet && (
            <button
              type="button"
              className={`tree-edit-toggle${isEditing ? ' editing' : ''}`}
              onClick={onToggleEdit}
              data-testid={`sheet-edit-toggle-${node.relPath}`}
              title={isEditing ? '편집 모드 끄기 (보기 전용으로 reload)' : '편집 모드 켜기 (Excel 풀 chrome)'}
              aria-label={isEditing ? '편집 중' : '편집 시작'}
              aria-pressed={isEditing}
            >
              {isEditing ? '📝' : '✏'}
            </button>
          )}
        </div>
        {hasChildren && isOpen && (
          <div className="tree-children">
            {node.children!.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p4-panel" data-testid="p4-panel">
      <div className="p4-source-tabs" role="tablist" aria-label="P4 source">
        <button
          type="button"
          role="tab"
          aria-selected={source === 'local'}
          className={`p4-source-tab${source === 'local' ? ' active' : ''}`}
          data-testid="p4-source-local"
          onClick={() => setSource('local')}
        >
          <i className="codicon codicon-folder" aria-hidden="true" /> local
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === 'depot'}
          className={`p4-source-tab${source === 'depot' ? ' active' : ''}`}
          data-testid="p4-source-depot"
          onClick={() => setSource('depot')}
          title="depot 보기 전용 — 편집은 P4 checkout 흐름"
        >
          <i className="codicon codicon-cloud" aria-hidden="true" /> depot
        </button>
      </div>
      {/* local + depot 둘 다 mount 유지 + display:none 토글. unmount 시 트리 expanded
          state / depot 캐시된 children 등이 사라져 사용자가 탭 갔다오면 처음 상태로 돌아가는
          regression 방지. SidebarHost / EditorHost 와 동일 패턴. */}
      <div
        className={`p4-source-pane${source === 'local' ? '' : ' hidden'}`}
        data-testid="p4-source-pane-local"
        aria-hidden={source !== 'local'}
      >
        <div className="sidebar" data-testid="p4-tree-container">
          <div className="tree" data-testid="p4-tree">
            {!p4 && (
              <div className="tree-row" style={{ color: 'var(--text-dim)', paddingLeft: 12 }}>
                로딩 중…
              </div>
            )}
            {p4 && p4.nodes.length === 0 && (
              <div
                style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.5 }}
                data-testid="p4-tree-empty"
              >
                데이터를 찾지 못했습니다.
                <br />⚙ 설정에서 <strong>데이터 루트</strong>를 확인하세요.
                <br />
                <span style={{ fontSize: 10 }}>
                  대상 경로: <code>{p4.rootDir || '(미설정)'}</code>
                </span>
              </div>
            )}
            {p4 && p4.nodes.length > 0 && p4.nodes.map((n) => renderNode(n, 0))}
          </div>
        </div>
      </div>
      <div
        className={`p4-source-pane${source === 'depot' ? '' : ' hidden'}`}
        data-testid="p4-source-pane-depot"
        aria-hidden={source !== 'depot'}
      >
        <P4DepotTree />
      </div>
    </div>
  );
}

function iconFor(node: TreeNode): string {
  if (node.type === 'category') return '📁';
  if (node.type === 'workbook') return '📘';
  if (node.type === 'sheet') return '📄';
  return '•';
}
