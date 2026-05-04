import { type ReactNode } from 'react';
import { relativeTime } from './summary-fixture-cache';

// P1: 요약 모드 결과 카드. backend `/summary_stream` 의 result.data.summary (markdown
// 문자열) 또는 streaming 중 token buffer 를 표시.
//
// 렌더링 정책:
// - markdown 라이브러리 의존 X (번들 사이즈 + maintenance). 간단한 인라인 변환 —
//   ## 헤더 → <strong>, - / * 불릿 → <li>, 빈 줄 → 단락 구분.
// - streaming 중엔 부분 markdown 도 자연스럽게 흘러 보이도록 (헤더가 미완성이어도
//   tail 까지 전부 표시).
// - 캐시 hit 일 때만 "💾 캐시된 요약 · X분 전 · model" + 🔁 새 요약 버튼.

interface Props {
  title: string;
  summary: string | null;
  streaming: boolean;
  error?: string;
  streamBuffer?: string;
  status?: string;
  cachedAt?: number | null;
  cachedModel?: string | null;
  onReRunRequest?: () => void;
}

export function SummaryCard({
  title,
  summary,
  streaming,
  error,
  streamBuffer,
  status,
  cachedAt,
  cachedModel,
  onReRunRequest,
}: Props) {
  const text = summary ?? streamBuffer ?? '';
  const hasContent = text.length > 0;

  return (
    <div className="summary-card" data-testid="summary-card">
      <header className="summary-card-header">
        <span className="summary-card-icon" aria-hidden="true">📄</span>
        <span className="summary-card-title" title={title}>{title}</span>
      </header>

      {cachedAt != null && !streaming && !error && (
        <div className="summary-cache-badge" data-testid="summary-cache-badge">
          <span aria-hidden="true">💾</span>
          <span>
            캐시된 요약 · {relativeTime(cachedAt)}
            {cachedModel ? ` · ${cachedModel}` : ''}
          </span>
          {onReRunRequest && (
            <button
              type="button"
              className="summary-rerun"
              onClick={onReRunRequest}
              data-testid="summary-rerun"
              title="새 요약 받기 (캐시 무시)"
            >
              🔁 새 요약
            </button>
          )}
        </div>
      )}

      {streaming && (
        <div className="summary-streaming" data-testid="summary-streaming">
          {status ?? '요약 생성 중'}<span className="dots" />
          {streamBuffer && <span className="summary-tok-count"> · {streamBuffer.length}자</span>}
        </div>
      )}

      {error && (
        <div className="summary-error" data-testid="summary-error">
          [요약 오류] {error}
        </div>
      )}

      {hasContent && (
        <div className="summary-body" data-testid="summary-body">
          {renderMarkdown(text)}
        </div>
      )}

      {!hasContent && !streaming && !error && (
        <div className="summary-empty" data-testid="summary-empty">
          요약을 생성하지 못했습니다.
        </div>
      )}
    </div>
  );
}

// 단순 markdown 변환 — `## 헤더`, `- bullet`, 빈 줄 단락. 풀 spec 미지원이지만 backend
// 의 `_SUMMARY_SYSTEM_DEFAULT` 가 만드는 마크업은 모두 커버. streaming 중 미완성 줄도
// 자연스럽게 표시.
function renderMarkdown(text: string): ReactNode {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let bulletGroup: string[] = [];
  let key = 0;

  const flushBullets = () => {
    if (bulletGroup.length === 0) return;
    out.push(
      <ul key={`ul-${key++}`} className="summary-bullets">
        {bulletGroup.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    );
    bulletGroup = [];
  };

  for (const raw of lines) {
    const line = raw;
    if (/^##\s+/.test(line)) {
      flushBullets();
      out.push(
        <h3 key={`h-${key++}`} className="summary-heading">
          {line.replace(/^##\s+/, '')}
        </h3>,
      );
    } else if (/^-\s+/.test(line) || /^\*\s+/.test(line)) {
      bulletGroup.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flushBullets();
      out.push(<div key={`spacer-${key++}`} className="summary-spacer" />);
    } else {
      flushBullets();
      out.push(
        <p key={`p-${key++}`} className="summary-paragraph">
          {line}
        </p>,
      );
    }
  }
  flushBullets();
  return out;
}
