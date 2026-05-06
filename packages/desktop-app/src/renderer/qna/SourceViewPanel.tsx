// Phase J (2026-05-06): 출처 클릭 → 우측 split panel 로 본문 표시. agent-sdk-poc 웹의
// SourceViewPanel 이식 (양쪽 분리, cross-claude-bridge 동기화).
//
// 동작: getSourceView(path, section) 으로 backend 에서 content + section_range 받아
// markdown 렌더. section_range 가 있으면 그 영역만 강조 (3-split: before / highlight /
// after). Esc 또는 ✕ 클릭으로 닫기. 원본 링크(origin_url) 가 있으면 ↗ 새 창.

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSourceView, type SourceView } from '../api';

export interface SourceTarget {
  path: string;
  section: string;
}

export function useSourceView() {
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const [sourceView, setSourceView] = useState<SourceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = (path: string, section: string) => {
    setTarget({ path, section });
  };
  const close = () => {
    setTarget(null);
    setSourceView(null);
    setErr(null);
  };

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setSourceView(null);
    void (async () => {
      try {
        const v = await getSourceView(target.path, target.section);
        if (!cancelled) {
          if (v) setSourceView(v);
          else setErr('출처를 찾을 수 없습니다.');
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Esc 로 닫기.
  useEffect(() => {
    if (!target && !sourceView && !loading && !err) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, sourceView, loading, err]);

  return { target, sourceView, loading, err, open, close };
}

interface PanelProps {
  sourceView: SourceView | null;
  loading: boolean;
  err: string | null;
  onClose: () => void;
}

export function SourceViewPanel({ sourceView, loading, err, onClose }: PanelProps) {
  const highlightRef = useRef<HTMLDivElement>(null);

  // section_range 가 있으면 그 영역으로 자동 스크롤.
  useEffect(() => {
    if (!sourceView || !sourceView.section_range) return;
    let alive = true;
    const tryScroll = () => {
      if (!alive) return;
      const el = highlightRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const id1 = requestAnimationFrame(() => requestAnimationFrame(tryScroll));
    const backup = setTimeout(tryScroll, 350);
    return () => {
      alive = false;
      cancelAnimationFrame(id1);
      clearTimeout(backup);
    };
  }, [sourceView?.path, sourceView?.section, sourceView?.section_range?.[0]]);

  if (!sourceView && !loading && !err) return null;

  const lines = sourceView?.content.split('\n') ?? [];
  const sr = sourceView?.section_range;
  // backend 의 section_range 는 tuple [start_line, end_line] (api.ts 에 정의).
  const startLine = sr?.[0];
  const endLine = sr?.[1];

  return (
    <aside className="qna-source-view-panel" data-testid="qna-source-view-panel">
      <header className="qna-source-view-header">
        <div className="qna-source-view-title">
          {sourceView?.source === 'summary' && (
            <span
              className="qna-source-view-badge"
              title="Haiku 로 생성한 요약본입니다. 원본이 아닙니다."
            >
              📝 요약본
            </span>
          )}
          {sourceView?.origin_label ?? (loading ? '로딩 중...' : '출처 뷰')}
        </div>
        {sourceView?.origin_url && (
          <a
            href={sourceView.origin_url}
            target="_blank"
            rel="noreferrer"
            className="qna-source-view-ext"
            title="원본 링크 새 창"
          >
            ↗ 원본
          </a>
        )}
        <button
          type="button"
          className="qna-source-view-close"
          onClick={onClose}
          title="닫기 (Esc)"
          aria-label="닫기"
        >
          ✕
        </button>
      </header>
      {sourceView?.source === 'summary' && (
        <div className="qna-source-view-notice">
          ⚠ 이 문서는 <strong>원본 기획서가 아니라 검색용 요약본</strong>입니다. 세부 내용은 원본
          문서를 확인해 주세요.
        </div>
      )}
      {loading && (
        <div className="qna-source-view-loading">
          <span className="dots" /> 로딩 중...
        </div>
      )}
      {err && <div className="qna-source-view-error">오류: {err}</div>}
      {sourceView && (
        <>
          {startLine != null && endLine != null && (
            <div className="qna-source-view-section-badge">
              하이라이트: {sourceView.section} · 라인 {startLine}–{endLine}
            </div>
          )}
          <div className="qna-source-view-body qna-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {startLine != null && endLine != null
                ? lines.slice(0, startLine - 1).join('\n')
                : sourceView.content}
            </ReactMarkdown>
            {startLine != null && endLine != null && (
              <div className="qna-source-view-highlight" ref={highlightRef}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {lines.slice(startLine - 1, endLine).join('\n')}
                </ReactMarkdown>
              </div>
            )}
            {startLine != null && endLine != null && (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {lines.slice(endLine).join('\n')}
              </ReactMarkdown>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
