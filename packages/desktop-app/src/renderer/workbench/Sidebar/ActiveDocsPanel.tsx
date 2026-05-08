import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActiveConfluenceDraft,
  ActiveP4File,
  TreeNode,
} from '../../../shared/types';
import { useWorkbenchStore } from '../store';

// 액티비티 바 5번 ("내 작업 중 문서") — 사용자가 P4 에서 체크아웃했거나 Confluence 에
// draft 상태로 작성/편집중인 문서를 한 패널에 모아 보여준다.
//
// 폴링: 패널이 보일 때만 30s 주기. 숨겨지면 interval 정리.
//   "보일 때" = workbench store 의 activeIcon === 'active'.
//   SidebarHost 가 모든 패널을 동시 mount + display:none toggle 하기 때문에 visibility 만으로
//   판단 가능 (mount/unmount 신호 없음).
//
// P4 클릭: depot path 로 openDepotFile (download + OneDrive upload) → 결과 URL 로 excel 탭 open.
//   P4DepotTree.openDepotFile 와 동일한 흐름 — 같은 (path, revision) 캐시 hit 면 재업로드 skip.
// Confluence 클릭: pageId 로 TreeNode 합성 → onOpenConfluencePage. Confluence 패널의 정상 흐름과
//   동일한 URL/인증 처리.

interface Props {
  onOpenSheet: (node: TreeNode) => void;
  onOpenConfluencePage: (node: TreeNode) => void;
}

interface FetchState<T> {
  loading: boolean;
  data: T[] | null;
  error: string | null;
  fetchedAt: number | null;
}

const POLL_MS = 30_000;

function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '어제';
  if (day < 7) return `${day}일 전`;
  const d = new Date(t);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function basename(path: string): string {
  // P4 depot path 구분자는 항상 / — Windows 변환 불필요.
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function ActiveDocsPanel({ onOpenSheet, onOpenConfluencePage }: Props) {
  const activeIcon = useWorkbenchStore((s) => s.activeIcon);
  const isVisible = activeIcon === 'active';

  const [p4State, setP4State] = useState<FetchState<ActiveP4File>>({
    loading: false,
    data: null,
    error: null,
    fetchedAt: null,
  });
  const [confState, setConfState] = useState<FetchState<ActiveConfluenceDraft>>({
    loading: false,
    data: null,
    error: null,
    fetchedAt: null,
  });

  // P4 file 클릭 시 openDepotFile 진행 중인 path — 중복 클릭 방지 + UI "여는 중…" 표시.
  const [openingP4Path, setOpeningP4Path] = useState<string | null>(null);
  const [openP4Error, setOpenP4Error] = useState<{ path: string; msg: string } | null>(null);

  const fetchAll = useCallback(async () => {
    setP4State((s) => ({ ...s, loading: true }));
    setConfState((s) => ({ ...s, loading: true }));
    // 두 endpoint 병렬 — 한쪽 실패해도 다른 쪽은 표시.
    const [p4Res, confRes] = await Promise.allSettled([
      window.projk.activeDocs.p4(),
      window.projk.activeDocs.confluence(),
    ]);
    const now = Date.now();
    if (p4Res.status === 'fulfilled') {
      const r = p4Res.value;
      setP4State({
        loading: false,
        data: r.ok ? r.files : [],
        error: r.ok ? null : r.diagnostics ?? '실패',
        fetchedAt: now,
      });
    } else {
      setP4State({ loading: false, data: [], error: (p4Res.reason as Error).message, fetchedAt: now });
    }
    if (confRes.status === 'fulfilled') {
      const r = confRes.value;
      setConfState({
        loading: false,
        data: r.ok ? r.drafts : [],
        error: r.ok ? null : r.diagnostics ?? '실패',
        fetchedAt: now,
      });
    } else {
      setConfState({ loading: false, data: [], error: (confRes.reason as Error).message, fetchedAt: now });
    }
  }, []);

  // 보일 때만 즉시 1회 + 30s 주기. activeIcon 이 다른 값으로 바뀌면 cleanup 으로 interval 해제.
  // ref 로 fetch 함수를 들고 있어 effect 가 fetchAll identity 변화로 다시 트리거되지 않게.
  const fetchRef = useRef(fetchAll);
  fetchRef.current = fetchAll;
  useEffect(() => {
    if (!isVisible) return;
    void fetchRef.current();
    const id = window.setInterval(() => void fetchRef.current(), POLL_MS);
    return () => window.clearInterval(id);
  }, [isVisible]);

  const openP4File = async (file: ActiveP4File) => {
    if (openingP4Path) return;
    setOpeningP4Path(file.depotPath);
    setOpenP4Error(null);
    try {
      const r = await window.projk.p4.openDepotFile(file.depotPath);
      if (!r.ok || !r.url) {
        setOpenP4Error({ path: file.depotPath, msg: r.error ?? '실패' });
        return;
      }
      // P4DepotTree.openDepotFile 와 동일한 임시 TreeNode 합성. tabIdOf 가 oneDriveUrl 있을 때
      // node.id 를 그대로 탭 id 로 — 같은 파일의 다른 revision 도 별도 탭.
      const node: TreeNode = {
        id: `depot:${file.depotPath}#rev${r.revision}`,
        type: 'sheet',
        title: basename(file.depotPath),
        relPath: file.depotPath.replace(/^\/\//, ''),
        oneDriveUrl: r.url,
      };
      onOpenSheet(node);
    } catch (e) {
      setOpenP4Error({ path: file.depotPath, msg: (e as Error).message });
    } finally {
      setOpeningP4Path(null);
    }
  };

  const openConfluenceDraft = (draft: ActiveConfluenceDraft) => {
    // ConfluencePanel 의 정상 흐름과 동일한 TreeNode shape — confluencePageId 가 있어야
    // tabIdOf / CenterPane 의 confluence 분기가 정상 동작.
    const node: TreeNode = {
      id: `conf:${draft.pageId}`,
      type: 'page',
      title: draft.title,
      confluencePageId: draft.pageId,
    };
    onOpenConfluencePage(node);
  };

  const totalCount = (p4State.data?.length ?? 0) + (confState.data?.length ?? 0);
  const anyLoading = p4State.loading || confState.loading;

  return (
    <div className="active-docs-panel" data-testid="active-docs-panel">
      <div className="active-docs-toolbar">
        <span className="active-docs-count">{totalCount}건</span>
        <button
          type="button"
          className="active-docs-refresh"
          onClick={() => void fetchAll()}
          disabled={anyLoading}
          title="새로고침"
          data-testid="active-docs-refresh"
        >
          {anyLoading ? '…' : '↻'}
        </button>
      </div>

      <Section
        title={`P4 체크아웃${p4State.data ? ` (${p4State.data.length})` : ''}`}
        testidPrefix="active-docs-p4"
      >
        {p4State.error ? (
          <div className="active-docs-error" data-testid="active-docs-p4-error">{p4State.error}</div>
        ) : p4State.data === null ? (
          <div className="active-docs-empty">로딩 중…</div>
        ) : p4State.data.length === 0 ? (
          <div className="active-docs-empty" data-testid="active-docs-p4-empty">체크아웃한 파일이 없어요.</div>
        ) : (
          <ul className="active-docs-list">
            {p4State.data.map((f) => {
              const opening = openingP4Path === f.depotPath;
              const errMsg = openP4Error?.path === f.depotPath ? openP4Error.msg : null;
              return (
                <li key={f.depotPath} className="active-doc-row p4">
                  <button
                    type="button"
                    className="active-doc-main"
                    onClick={() => void openP4File(f)}
                    disabled={!!openingP4Path}
                    title={f.depotPath}
                    data-testid={`active-docs-p4-row-${f.depotPath}`}
                  >
                    <span className="active-doc-icon" aria-hidden="true">📄</span>
                    <span className="active-doc-body">
                      <span className="active-doc-title">{basename(f.depotPath)}</span>
                      <span className="active-doc-subtitle">{f.depotPath}</span>
                      <span className="active-doc-meta">
                        {f.action} · #{f.revision}
                        {opening && <span> · 여는 중…</span>}
                        {errMsg && <span className="active-doc-err"> · {errMsg}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title={`Confluence 수정 중${confState.data ? ` (${confState.data.length})` : ''}`}
        testidPrefix="active-docs-confluence"
      >
        {confState.error ? (
          <div className="active-docs-error" data-testid="active-docs-confluence-error">{confState.error}</div>
        ) : confState.data === null ? (
          <div className="active-docs-empty">로딩 중…</div>
        ) : confState.data.length === 0 ? (
          <div className="active-docs-empty" data-testid="active-docs-confluence-empty">draft 상태인 문서가 없어요.</div>
        ) : (
          <ul className="active-docs-list">
            {confState.data.map((d) => (
              <li key={d.pageId} className="active-doc-row confluence">
                <button
                  type="button"
                  className="active-doc-main"
                  onClick={() => openConfluenceDraft(d)}
                  title={d.title}
                  data-testid={`active-docs-confluence-row-${d.pageId}`}
                >
                  <span className="active-doc-icon" aria-hidden="true">📘</span>
                  <span className="active-doc-body">
                    <span className="active-doc-title">{d.title}</span>
                    <span className="active-doc-subtitle">{d.spaceKey}</span>
                    <span className="active-doc-meta">
                      {relativeTime(d.lastModified)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// 작은 collapsible-less 섹션 헤더. 시각적 구분만.
function Section({
  title,
  testidPrefix,
  children,
}: {
  title: string;
  testidPrefix: string;
  children: React.ReactNode;
}) {
  return (
    <div className="active-docs-section" data-testid={`${testidPrefix}-section`}>
      <div className="active-docs-section-header">{title}</div>
      {children}
    </div>
  );
}
