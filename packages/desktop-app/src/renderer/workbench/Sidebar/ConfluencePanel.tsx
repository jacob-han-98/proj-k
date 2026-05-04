import { useEffect, useState, type ReactElement } from 'react';
import type { TreeNode, ConfluenceTreeResult } from '../../../shared/types';
import { iconNodeFor } from './tree-icons';
import {
  TREE_PERSIST_KEYS,
  loadExpanded,
  pruneExpanded,
  saveExpanded,
} from './tree-state-persist';

// PR3: Confluence 사이드바 패널. 트리만. 헤더/탭 없음.

interface Props {
  selectedId: string | null;
  onOpenConfluencePage: (node: TreeNode) => void;
}

export function ConfluencePanel({ selectedId, onOpenConfluencePage }: Props) {
  const [confluence, setConfluence] = useState<ConfluenceTreeResult | null>(null);
  // 펼쳐진 폴더/페이지 ID 영속. mount 시 prefill, 트리 도착 시 invalid id 는 prune.
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    loadExpanded(TREE_PERSIST_KEYS.CONFLUENCE_EXPANDED),
  );

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

  // 트리 도착 시 영속된 expanded 중 사라진 id 제거 (없어진 페이지에 무리한 복원 시도 방지).
  // 빈 트리 (사이드카 starting / 데이터 미설정) 에선 prune skip — 영속값이 빈 set 으로 덮여
  // 영구 손실되는 race 차단 (P4Panel 과 동일 fix).
  useEffect(() => {
    if (!confluence || confluence.nodes.length === 0) return;
    const valid = collectAllIds(confluence.nodes);
    setExpanded((prev) => {
      const pruned = pruneExpanded(prev, valid);
      if (pruned.size === prev.size) {
        let same = true;
        for (const id of prev) {
          if (!pruned.has(id)) { same = false; break; }
        }
        if (same) return prev;
      }
      saveExpanded(TREE_PERSIST_KEYS.CONFLUENCE_EXPANDED, pruned);
      return pruned;
    });
  }, [confluence]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpanded(TREE_PERSIST_KEYS.CONFLUENCE_EXPANDED, next);
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
          <span className="icon">{iconNodeFor(node)}</span>
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

// 트리 walk — 모든 노드의 id 를 수집. expanded prune 시 valid 검증에 사용.
function collectAllIds(nodes: TreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode) => {
    out.add(n.id);
    if (n.children) for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

