import { useEffect, useState, type ReactElement } from 'react';
import type { TreeNode, P4TreeResult, ConfluenceTreeResult } from '../../shared/types';

interface Props {
  onOpenSheet: (node: TreeNode) => void;
  onOpenConfluencePage: (node: TreeNode) => void;
  selectedId: string | null;
}

export function TreeSidebar({ onOpenSheet, onOpenConfluencePage, selectedId }: Props) {
  const [p4, setP4] = useState<P4TreeResult | null>(null);
  const [confluence, setConfluence] = useState<ConfluenceTreeResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchTrees = () => {
      window.projk.getP4Tree().then(setP4).catch((e) => console.error('p4 tree', e));
      window.projk.getConfluenceTree().then(setConfluence).catch((e) => console.error('confluence tree', e));
    };
    fetchTrees();
    // 사이드카가 starting → ready 로 바뀌면 재요청. 첫 부팅 직후 sidecar 가 아직
    // 안 떠있을 때 빈 결과를 받아 화면이 stale 로 남는 회귀 (0.1.26) fix.
    const off = window.projk.onSidecarStatus((s) => {
      if (s.state === 'ready') fetchTrees();
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

  const renderNode = (node: TreeNode, depth: number, kind: 'p4' | 'confluence'): ReactElement => {
    const hasChildren = !!node.children && node.children.length > 0;
    const isOpen = expanded.has(node.id);
    const isLeaf = !hasChildren;
    const isActive = selectedId === node.id;

    const onClick = () => {
      if (hasChildren) {
        toggle(node.id);
      } else if (kind === 'p4' && node.type === 'sheet') {
        onOpenSheet(node);
      } else if (kind === 'confluence' && node.type === 'page') {
        onOpenConfluencePage(node);
      }
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
          <span className="icon">{iconFor(node, kind)}</span>
          <span className="label">{node.title}</span>
        </div>
        {hasChildren && isOpen && (
          <div className="tree-children">
            {node.children!.map((c) => renderNode(c, depth + 1, kind))}
          </div>
        )}
      </div>
    );
  };

  const renderTree = (
    result: P4TreeResult | ConfluenceTreeResult | null,
    kind: 'p4' | 'confluence',
    testid: string,
  ) => {
    if (!result) {
      return <div className="tree-row" style={{ color: 'var(--text-dim)', paddingLeft: 12 }}>로딩 중…</div>;
    }
    if (result.nodes.length === 0) {
      // 0개 — 데이터 미러 경로 못 찾는 거의 100% 케이스. ⚙ 설정 / DevTools 안내.
      return (
        <div
          style={{
            padding: '8px 12px',
            color: 'var(--text-dim)',
            fontSize: 11,
            lineHeight: 1.5,
          }}
          data-testid={`${testid}-empty`}
        >
          데이터를 찾지 못했습니다.
          <br />
          ⚙ 설정에서 <strong>데이터 루트</strong>를 확인하세요.
          <br />
          <span style={{ fontSize: 10 }}>대상 경로: <code>{result.rootDir || '(미설정)'}</code></span>
        </div>
      );
    }
    return result.nodes.map((n) => renderNode(n, 0, kind));
  };

  return (
    <aside className="sidebar">
      <div className="group-title">P4 기획서</div>
      <div className="tree" data-testid="p4-tree">{renderTree(p4, 'p4', 'p4-tree')}</div>
      <div className="group-title" style={{ marginTop: 12 }}>Confluence</div>
      <div className="tree" data-testid="confluence-tree">{renderTree(confluence, 'confluence', 'confluence-tree')}</div>
    </aside>
  );
}

function iconFor(node: TreeNode, kind: 'p4' | 'confluence'): string {
  if (kind === 'p4') {
    if (node.type === 'category') return '📁';
    if (node.type === 'workbook') return '📘';
    if (node.type === 'sheet') return '📄';
  } else {
    if (node.type === 'folder') return '📁';
    if (node.type === 'page') return '📄';
  }
  return '•';
}
