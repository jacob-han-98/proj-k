import { useEffect, useState, type ReactElement } from 'react';
import type { TreeNode, ConfluenceTreeResult } from '../../../shared/types';
import { iconNodeFor } from './tree-icons';
import { useWorkbenchStore } from '../store';
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
  onOpenSettings: () => void;
  // App.tsx 의 SettingsModal onSaved 시 +1. 변경 감지해 testSpace 인디케이터 refetch.
  settingsVersion: number;
}

export function ConfluencePanel({
  selectedId,
  onOpenConfluencePage,
  onOpenSettings,
  settingsVersion,
}: Props) {
  const [confluence, setConfluence] = useState<ConfluenceTreeResult | null>(null);
  const [testSpace, setTestSpace] = useState<{ key?: string; parentId?: string } | null>(null);
  // 사본 직후 / 설정 변경 직후 트리 재조회 트리거. store 의 bumpConfluenceTree 호출 시 +1.
  const confluenceTreeVersion = useWorkbenchStore((s) => s.confluenceTreeVersion);
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
    // settingsVersion / confluenceTreeVersion 변경 시 — testSpace 설정 변경 또는 사본 직후 —
    // 트리를 라이브 재조회. main 의 getConfluenceTree 가 testSpace 자식을 v2 API 로 다시 가져옴.
  }, [settingsVersion, confluenceTreeVersion]);

  // 테스트 스페이스 인디케이터 — 트리는 로컬 다운로드 manifest 기반이라 운영 테스트 스페이스가
  // 자동으로 보이지 않는다. 사용자에게 "사본이 어디로 가는지" + "설정 OK 인지" 가시화.
  // settingsVersion 이 바뀌면 (= SettingsModal 저장 직후) 재조회.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await window.projk.getSettings();
        if (cancelled) return;
        const key = s.confluenceTestSpaceKey?.trim();
        const parentId = s.confluenceTestParentPageId?.trim();
        setTestSpace({ key: key || undefined, parentId: parentId || undefined });
      } catch {
        if (!cancelled) setTestSpace({});
      }
    })();
    return () => { cancelled = true; };
  }, [settingsVersion]);

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

  const hasTestSpace = !!testSpace?.key;
  return (
    <div className="sidebar" data-testid="confluence-panel">
      <button
        type="button"
        className={`confluence-test-space-indicator${hasTestSpace ? '' : ' unset'}`}
        data-testid="confluence-test-space-indicator"
        data-state={hasTestSpace ? 'set' : 'unset'}
        onClick={onOpenSettings}
        title={
          hasTestSpace
            ? `'테스트로 복사' 클릭 시 이 스페이스에 사본 생성 — 클릭하여 설정 변경`
            : '테스트 스페이스가 설정되지 않아 doc-header 의 📋 테스트로 복사 버튼이 안 뜹니다. 클릭하여 설정.'
        }
      >
        {hasTestSpace ? (
          <>
            <span className="label">📋 테스트 스페이스: <strong>{testSpace!.key}</strong></span>
            {testSpace!.parentId && (
              <span className="sub">parent {testSpace!.parentId.slice(0, 12)}{testSpace!.parentId.length > 12 ? '…' : ''}</span>
            )}
          </>
        ) : (
          <span className="label">⚠ 테스트 스페이스 미설정 — 클릭하여 설정</span>
        )}
      </button>
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

