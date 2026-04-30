// Phase 4-3: chrome-extension/sidebar/sidebar.js 의 renderReviewCard 를 React 로 포팅.
// 4-3 범위: 데이터 렌더 + streaming indicator. 4-4 가 들어오면 각 item 의 👍👎
// feedback, "✏️ 원본 수정" CTA (Confluence REST PUT), 복사/댓글 버튼이 추가된다.
//
// 데이터 모델은 chrome-extension PROMPTS.review (background.js) 의 출력 schema 와 동일 —
// agent 가 그 prompt 를 그대로 쓰면 desktop 도 같은 JSON 을 받는다.

import type { CSSProperties } from 'react';

export interface ReviewItem {
  text: string;
  perspective?: string;
}

export interface ReviewData {
  score?: number;
  issues?: (ReviewItem | string)[];
  verifications?: (ReviewItem | string)[];
  suggestions?: (ReviewItem | string)[];
  flow?: string;
  qa_checklist?: string[];
  readability?: {
    score?: number;
    issues?: string[];
  };
}

interface Props {
  title: string;
  data: ReviewData | null;
  streaming: boolean;
  error?: string;
  // Phase 4-3.5: "✏️ 원본 수정" 클릭. data 가 있고 streaming/error 둘 다 false 일 때만 노출.
  onFixRequest?: () => void;
}

export function ReviewCard({ title, data, streaming, error, onFixRequest }: Props) {
  if (error) {
    return (
      <div className="review-card error" data-testid="review-card">
        <div className="review-card-header">📋 {title}</div>
        <div className="review-error">[리뷰 오류] {error}</div>
      </div>
    );
  }

  if (!data && streaming) {
    return (
      <div className="review-card" data-testid="review-card">
        <div className="review-card-header">📋 {title}</div>
        <div className="review-streaming">리뷰 생성 중<span className="dots" /></div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="review-card" data-testid="review-card">
      <div className="review-card-header">📋 {title}</div>

      {data.score != null && <ScoreBar score={data.score} label="전체 평가" />}

      <ReviewSection
        kind="warning"
        title={`⚠️ 보강 필요 (${data.issues?.length ?? 0}건)`}
        items={data.issues}
      />
      <ReviewSection
        kind="info"
        title={`🔍 검증 필요 (${data.verifications?.length ?? 0}건)`}
        items={data.verifications}
      />
      <ReviewSection
        kind="suggestion"
        title={`💡 제안 (${data.suggestions?.length ?? 0}건)`}
        items={data.suggestions}
      />

      {data.flow && (
        <div className="review-section flow">
          <div className="review-section-title">🔀 로직 플로우</div>
          <div className="review-flow-content">{formatFlow(data.flow)}</div>
        </div>
      )}

      {data.qa_checklist && data.qa_checklist.length > 0 && (
        <div className="review-section checklist">
          <div className="review-section-title">✅ QA 체크리스트 ({data.qa_checklist.length}건)</div>
          <div className="review-checklist-items">
            {data.qa_checklist.map((item, i) => (
              <label key={i} className="review-checklist-item">
                <input type="checkbox" />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {data.readability && (
        <div className="review-section readability">
          <div className="review-section-title">
            📖 문서 가독성{data.readability.score != null ? ` (${data.readability.score}/100)` : ''}
          </div>
          {data.readability.score != null && (
            <ScoreBar score={data.readability.score} compact />
          )}
          {data.readability.issues?.map((item, i) => (
            <div key={i} className="review-item">{item}</div>
          ))}
        </div>
      )}

      {streaming && <div className="review-streaming">계속 생성 중<span className="dots" /></div>}

      {!streaming && !error && onFixRequest && hasActionable(data) && (
        <div className="review-cta">
          <button onClick={onFixRequest} data-testid="review-fix">✏️ 원본 수정안 정리</button>
        </div>
      )}
    </div>
  );
}

function hasActionable(data: ReviewData): boolean {
  return (
    (data.issues?.length ?? 0) > 0 ||
    (data.verifications?.length ?? 0) > 0 ||
    (data.suggestions?.length ?? 0) > 0
  );
}

function ScoreBar({ score, label, compact }: { score: number; label?: string; compact?: boolean }) {
  const pct = Math.max(0, Math.min(100, score));
  const style: CSSProperties = compact ? { marginBottom: 8 } : {};
  return (
    <div className="review-score" style={style}>
      {label && <span className="review-score-label">{label}</span>}
      <div className="review-score-bar">
        <div className="review-score-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="review-score-num">{score}/100</span>
    </div>
  );
}

function ReviewSection({
  kind,
  title,
  items,
}: {
  kind: 'warning' | 'info' | 'suggestion';
  title: string;
  items?: (ReviewItem | string)[];
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`review-section ${kind}`}>
      <div className="review-section-title">{title}</div>
      {items.map((item, i) => {
        const text = typeof item === 'string' ? item : item.text;
        const perspective = typeof item === 'string' ? undefined : item.perspective;
        return (
          <div key={i} className="review-item">
            {perspective && <span className="review-perspective">[{perspective}]</span>}
            {text}
          </div>
        );
      })}
    </div>
  );
}

// "1. 첫 번째. 2. 두 번째." 처럼 한 줄에 붙어 들어오는 케이스가 잦아서 번호 앞에서
// 줄바꿈을 강제. chrome-extension 의 동일 처리 그대로.
function formatFlow(flow: string): string {
  return flow.replace(/(\d+)\.\s/g, '\n$1. ').replace(/^\n/, '');
}
