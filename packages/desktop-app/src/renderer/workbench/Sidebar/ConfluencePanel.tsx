import { useEffect, useState, type ReactElement } from 'react';
import type { TreeNode, ConfluenceTreeResult } from '../../../shared/types';

// PR3: Confluence 사이드바 패널. 트리만. 헤더/탭 없음.

interface Props {
  selectedId: string | null;
  onOpenConfluencePage: (node: TreeNode) => void;
}

export function ConfluencePanel({ selectedId, onOpenConfluencePage }: Props) {
  const [confluence, setConfluence] = useState<ConfluenceTreeResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchTree = () => {
      window.projk
        .getConfluenceTree()
        .then(setConfluence)
        .catch((e) => console.error('confluence tree', e));
    };
    fetchTree();
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
      else if (node.type === 'page') onOpenConfluencePage(node);
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
    <div className="sidebar" data-testid="confluence-panel">
      <div className="tree" data-testid="confluence-tree">
        {!confluence && (
          <div className="tree-row" style={{ color: 'var(--text-dim)', paddingLeft: 12 }}>
            로딩 중…
          </div>
        )}
        {confluence && confluence.nodes.length === 0 && (
          <div
            style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.5 }}
            data-testid="confluence-tree-empty"
          >
            데이터를 찾지 못했습니다.
            <br />⚙ 설정에서 <strong>데이터 루트</strong>를 확인하세요.
            <br />
            <span style={{ fontSize: 10 }}>
              대상 경로: <code>{confluence.rootDir || '(미설정)'}</code>
            </span>
          </div>
        )}
        {confluence && confluence.nodes.length > 0 && confluence.nodes.map((n) => renderNode(n, 0))}
      </div>
    </div>
  );
}

function iconFor(node: TreeNode): string {
  if (node.type === 'folder') return '📁';
  if (node.type === 'page') return '📄';
  return '•';
}
