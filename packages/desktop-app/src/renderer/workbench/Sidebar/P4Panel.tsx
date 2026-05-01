import { useEffect, useState, type ReactElement } from 'react';
import type { TreeNode, P4TreeResult } from '../../../shared/types';

// PR3: P4 (Perforce 기획서) 사이드바 패널.
// 위쪽에 local / depot 소스 탭 (depot 는 다음 마일스톤 — disabled).
// 아래는 트리. 트리 렌더 로직은 panels/TreeSidebar.tsx 의 P4 부분과 의도적으로 동일하게.

interface Props {
  selectedId: string | null;
  onOpenSheet: (node: TreeNode) => void;
}

export function P4Panel({ selectedId, onOpenSheet }: Props) {
  const [p4, setP4] = useState<P4TreeResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

    const onClick = () => {
      if (hasChildren) toggle(node.id);
      else if (node.type === 'sheet') onOpenSheet(node);
    };

    return (
      <div key={node.id}>
        <div
          className={`tree-row ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={onClick}
          title={node.title}
        >
          <span className="caret">{hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
          <span className="icon">{iconFor(node)}</span>
          <span className="label">{node.title}</span>
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
          aria-selected="true"
          className="p4-source-tab active"
          data-testid="p4-source-local"
        >
          <i className="codicon codicon-folder" aria-hidden="true" /> local
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          className="p4-source-tab disabled"
          data-testid="p4-source-depot"
          disabled
          title="다음 마일스톤에서 활성화"
        >
          <i className="codicon codicon-cloud" aria-hidden="true" /> depot
        </button>
      </div>
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
  );
}

function iconFor(node: TreeNode): string {
  if (node.type === 'category') return '📁';
  if (node.type === 'workbook') return '📘';
  if (node.type === 'sheet') return '📄';
  return '•';
}
