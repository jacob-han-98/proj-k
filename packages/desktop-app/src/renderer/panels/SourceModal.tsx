// A3-b: 답변 안 (출처: ...) 클릭 시 띄우는 modal. /source_view 호출 → content.md 본문
// (markdown plain text 로 일단) + section_range 표시. 향후 markdown 렌더링 / highlight
// 보강 가능.

import { useEffect, useState } from 'react';
import { getSourceView, type SourceView } from '../api';

interface Props {
  raw: string;       // 원본 citation 텍스트 — modal title
  path: string;
  section: string;
  onClose: () => void;
}

export function SourceModal({ raw, path, section, onClose }: Props) {
  const [data, setData] = useState<SourceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const r = await getSourceView(path, section);
        if (cancelled) return;
        if (!r) {
          setError('출처를 찾을 수 없음 (agent 미설정 또는 경로 매칭 실패)');
          setLoading(false);
          return;
        }
        setData(r);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, section]);

  // section_range 이 있으면 그 범위 highlight, 없으면 전체 본문.
  // content 가 매우 길 수도 있어 modal 내부 scroll.
  const sliced = sliceForDisplay(data);

  return (
    <div
      className="source-modal-backdrop"
      data-testid="source-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="source-modal"
        data-testid="source-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="source-modal-header">
          <span className="source-modal-icon" aria-hidden="true">📑</span>
          <span className="source-modal-title" title={raw}>{raw}</span>
          {data?.origin_url && (
            <a
              href={data.origin_url}
              target="_blank"
              rel="noreferrer"
              className="source-modal-external"
              title="외부 브라우저에서 원본 페이지 열기"
            >↗</a>
          )}
          <button
            type="button"
            className="source-modal-close"
            onClick={onClose}
            aria-label="닫기"
            data-testid="source-modal-close"
          >×</button>
        </header>
        <div className="source-modal-body">
          {loading && <div className="source-modal-status">로딩 중…</div>}
          {error && <div className="source-modal-error" data-testid="source-modal-error">{error}</div>}
          {!loading && !error && data && (
            <>
              {data.origin_label && (
                <div className="source-modal-origin" data-testid="source-modal-origin">{data.origin_label}</div>
              )}
              <pre className="source-modal-content" data-testid="source-modal-content">{sliced}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// section_range 가 있으면 그 부분만, 없으면 전체. 너무 길면 cap (성능).
function sliceForDisplay(data: SourceView | null): string {
  if (!data) return '';
  const MAX = 20_000;
  if (Array.isArray(data.section_range) && data.section_range.length === 2) {
    const [start, end] = data.section_range;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      return data.content.slice(start, Math.min(end, start + MAX));
    }
  }
  if (data.content.length > MAX) {
    return data.content.slice(0, MAX) + `\n\n... (전체 ${data.content.length} 자 중 처음 ${MAX} 자만 표시)`;
  }
  return data.content;
}
