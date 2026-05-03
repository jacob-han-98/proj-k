// Phase 4-3: chrome-extension/sidebar/sidebar.js 의 renderReviewCard 를 React 로 포팅.
// A5 (2026-05-03): 사용자 명시 요청 — chrome ext 의 가독성 (점진 표현 + 예쁜 per-item) 가
// 다 옮겨오지 못한 상태였던 것을 보강:
//   1) streamBuffer 의 partial JSON 을 자체 parse → 완결된 항목부터 즉시 카드에 등장.
//   2) 각 item 에 👍 / 👎 / ✏ feedback 버튼. default liked. dislike 면 회색 처리.
//      edited 면 textarea 로 사용자 수정 instruction 노출.
//   3) perspective 를 색상 chip ([프로그래머] / [리더]) 으로 시각화.
// 사용자 통제: 어떤 항목을 Apply 할지 골라서 정리 — onFixRequest 에 filtered 데이터 전달.

import { useMemo, useState, type CSSProperties } from 'react';
import { parsePartialReviewJSON } from './partial-review-parser';

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

type ItemStatus = 'liked' | 'disliked' | 'edited';
interface ItemFeedback {
  status: ItemStatus;
  editText?: string;
}
type FeedbackMap = Record<string, ItemFeedback>;

interface Props {
  title: string;
  data: ReviewData | null;
  streaming: boolean;
  error?: string;
  // Phase 4-3.5+: WSL agent 의 token 이벤트 누적 — streaming 중 가시화. status 는
  // {type:"status", message:"📨 분석 중..."} 같은 짧은 진행 라벨.
  streamBuffer?: string;
  status?: string;
  // Phase 4-3.5: "✏️ 원본 수정" 클릭 — A5 부터 feedback-filter 된 데이터를 받음.
  // dislike 한 item 은 제외, edited 는 사용자 instruction 추가.
  onFixRequest?: (filtered: ReviewData) => void;
}

export function ReviewCard({
  title,
  data,
  streaming,
  error,
  streamBuffer,
  status,
  onFixRequest,
}: Props) {
  // streamBuffer 에서 partial parse — final data 가 도착하기 전에도 sections 등장.
  const partialData = useMemo<ReviewData | null>(() => {
    if (data) return null; // 최종 데이터 있으면 partial 무시
    if (!streamBuffer || !streaming) return null;
    return parsePartialReviewJSON(streamBuffer);
  }, [data, streamBuffer, streaming]);
  const effectiveData = data ?? partialData;

  // Per-item feedback. key = stable id (category + index + 50자 hash) 로 streaming 중에도
  // 같은 item 이 같은 key 유지하도록.
  const [feedback, setFeedback] = useState<FeedbackMap>({});

  if (error) {
    return (
      <div className="review-card error" data-testid="review-card">
        <div className="review-card-header">📋 {title}</div>
        <div className="review-error">[리뷰 오류] {error}</div>
      </div>
    );
  }

  if (!effectiveData && streaming) {
    return (
      <div className="review-card" data-testid="review-card">
        <div className="review-card-header">📋 {title}</div>
        <StreamingIndicator status={status} buffer={streamBuffer} />
      </div>
    );
  }

  if (!effectiveData) return null;

  const setItemStatus = (id: string, nextStatus: ItemStatus) => {
    setFeedback((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { status: 'liked' }), status: nextStatus },
    }));
  };
  const setItemEdit = (id: string, text: string) => {
    setFeedback((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { status: 'edited' }), editText: text },
    }));
  };

  return (
    <div className="review-card" data-testid="review-card">
      <div className="review-card-header">📋 {title}</div>

      {effectiveData.score != null && <ScoreBar score={effectiveData.score} label="전체 평가" />}

      <ReviewSection
        kind="warning"
        title={`⚠️ 보강 필요 (${effectiveData.issues?.length ?? 0}건)`}
        category="issues"
        items={effectiveData.issues}
        feedback={feedback}
        onSetStatus={setItemStatus}
        onSetEdit={setItemEdit}
      />
      <ReviewSection
        kind="info"
        title={`🔍 검증 필요 (${effectiveData.verifications?.length ?? 0}건)`}
        category="verifications"
        items={effectiveData.verifications}
        feedback={feedback}
        onSetStatus={setItemStatus}
        onSetEdit={setItemEdit}
      />
      <ReviewSection
        kind="suggestion"
        title={`💡 제안 (${effectiveData.suggestions?.length ?? 0}건)`}
        category="suggestions"
        items={effectiveData.suggestions}
        feedback={feedback}
        onSetStatus={setItemStatus}
        onSetEdit={setItemEdit}
      />

      {effectiveData.flow && (
        <div className="review-section flow">
          <div className="review-section-title">🔀 로직 플로우</div>
          <div className="review-flow-content">{formatFlow(effectiveData.flow)}</div>
        </div>
      )}

      {effectiveData.qa_checklist && effectiveData.qa_checklist.length > 0 && (
        <div className="review-section checklist">
          <div className="review-section-title">✅ QA 체크리스트 ({effectiveData.qa_checklist.length}건)</div>
          <div className="review-checklist-items">
            {effectiveData.qa_checklist.map((item, i) => (
              <label key={i} className="review-checklist-item">
                <input type="checkbox" />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {effectiveData.readability && (
        <div className="review-section readability">
          <div className="review-section-title">
            📖 문서 가독성{effectiveData.readability.score != null ? ` (${effectiveData.readability.score}/100)` : ''}
          </div>
          {effectiveData.readability.score != null && (
            <ScoreBar score={effectiveData.readability.score} compact />
          )}
          {effectiveData.readability.issues?.map((item, i) => (
            <div key={i} className="review-item">{item}</div>
          ))}
        </div>
      )}

      {streaming && <StreamingIndicator status={status} buffer={streamBuffer} />}

      {!streaming && !error && onFixRequest && hasActionable(effectiveData) && (
        <div className="review-cta">
          <button
            onClick={() => onFixRequest(filterByFeedback(effectiveData, feedback))}
            data-testid="review-fix"
          >
            ✏️ 원본 수정안 정리
          </button>
          <span className="review-cta-hint">
            👍 반영 · 👎 무시 · ✏️ 수정 방향 입력 — 위 항목별로 선택하세요
          </span>
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

// 스트리밍 가시화 — 상단에 status 라벨 + dots, 하단에 token 누적 raw 텍스트의 끝 ~280자
// 만 monospace 로. JSON 이라 시각적으론 어수선하지만 "진짜 흘러오고 있다" 가 보여야
// 사용자가 멈춘 게 아닌 줄 안다 (사용자 요청 — "기능이 동작하는 것을 알 수 있어").
export function StreamingIndicator({ status, buffer }: { status?: string; buffer?: string }) {
  const tail = buffer ? buffer.slice(-280) : '';
  const charCount = buffer?.length ?? 0;
  return (
    <div className="review-stream-area">
      <div className="review-streaming">
        {status ?? '리뷰 생성 중'}<span className="dots" />
        {charCount > 0 && <span className="review-tok-count"> · {charCount}자</span>}
      </div>
      {tail && <pre className="review-stream-tail">{tail}</pre>}
    </div>
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

interface SectionProps {
  kind: 'warning' | 'info' | 'suggestion';
  title: string;
  category: 'issues' | 'verifications' | 'suggestions';
  items?: (ReviewItem | string)[];
  feedback: FeedbackMap;
  onSetStatus: (id: string, status: ItemStatus) => void;
  onSetEdit: (id: string, text: string) => void;
}

function ReviewSection({ kind, title, category, items, feedback, onSetStatus, onSetEdit }: SectionProps) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`review-section ${kind}`}>
      <div className="review-section-title">{title}</div>
      {items.map((item, i) => {
        const text = typeof item === 'string' ? item : item.text;
        const perspective = typeof item === 'string' ? undefined : item.perspective;
        const id = itemId(category, i, text);
        const fb = feedback[id] ?? { status: 'liked' as ItemStatus };
        return (
          <ReviewItemRow
            key={id}
            id={id}
            text={text}
            perspective={perspective}
            status={fb.status}
            editText={fb.editText ?? ''}
            onSetStatus={(s) => onSetStatus(id, s)}
            onSetEdit={(t) => onSetEdit(id, t)}
          />
        );
      })}
    </div>
  );
}

function ReviewItemRow({
  id,
  text,
  perspective,
  status,
  editText,
  onSetStatus,
  onSetEdit,
}: {
  id: string;
  text: string;
  perspective?: string;
  status: ItemStatus;
  editText: string;
  onSetStatus: (s: ItemStatus) => void;
  onSetEdit: (t: string) => void;
}) {
  return (
    <div className={`review-item-outer ${status}`} data-testid={`ri-${id}`}>
      <div className="review-item-wrap">
        <div className="review-item-content">
          {perspective && <PerspectiveChip perspective={perspective} />}
          {text}
        </div>
        <div className="review-item-feedback">
          <button
            type="button"
            className={`ri-btn ${status === 'liked' ? 'active' : ''}`}
            onClick={() => onSetStatus('liked')}
            title="좋아요 — 반영 대상"
            aria-label="liked"
            aria-pressed={status === 'liked'}
            data-testid={`ri-like-${id}`}
          >👍</button>
          <button
            type="button"
            className={`ri-btn ${status === 'disliked' ? 'active' : ''}`}
            onClick={() => onSetStatus('disliked')}
            title="싫어요 — 무시"
            aria-label="disliked"
            aria-pressed={status === 'disliked'}
            data-testid={`ri-dislike-${id}`}
          >👎</button>
          <button
            type="button"
            className={`ri-btn ${status === 'edited' ? 'active' : ''}`}
            onClick={() => onSetStatus('edited')}
            title="수정 방향 추가"
            aria-label="edited"
            aria-pressed={status === 'edited'}
            data-testid={`ri-edit-${id}`}
          >✏️</button>
        </div>
      </div>
      {status === 'edited' && (
        <div className="ri-edit-area">
          <textarea
            className="ri-edit-input"
            placeholder="수정 방향을 입력하세요..."
            rows={2}
            value={editText}
            onChange={(e) => onSetEdit(e.target.value)}
            data-testid={`ri-edit-area-${id}`}
          />
        </div>
      )}
    </div>
  );
}

function PerspectiveChip({ perspective }: { perspective: string }) {
  // perspective 별 색상 — 프로그래머 (cool) / 리더 (warm) / 기타 (gray).
  let cls = 'review-perspective';
  if (perspective.includes('프로그래머') || /dev/i.test(perspective)) cls += ' dev';
  else if (perspective.includes('리더') || /lead/i.test(perspective)) cls += ' lead';
  return <span className={cls}>{perspective}</span>;
}

// 같은 review 안 stable id — category + index + text 의 짧은 hash. text 가 streaming 중
// 변하면 id 도 변할 수 있지만 final 도착 후엔 안정.
function itemId(category: string, index: number, text: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 50); i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `${category}-${index}-${(hash >>> 0).toString(36).slice(0, 6)}`;
}

// feedback 이 disliked 면 해당 item 제외, edited 면 text 뒤에 사용자 instruction 추가.
function filterByFeedback(data: ReviewData, fb: FeedbackMap): ReviewData {
  const out: ReviewData = { ...data };
  for (const cat of ['issues', 'verifications', 'suggestions'] as const) {
    const src = data[cat];
    if (!src) continue;
    const filtered: (ReviewItem | string)[] = [];
    src.forEach((item, i) => {
      const text = typeof item === 'string' ? item : item.text;
      const id = itemId(cat, i, text);
      const f = fb[id];
      if (f?.status === 'disliked') return;
      if (f?.status === 'edited' && f.editText) {
        const newText = `${text}\n\n[사용자 수정 방향] ${f.editText.trim()}`;
        if (typeof item === 'string') filtered.push(newText);
        else filtered.push({ ...item, text: newText });
      } else {
        filtered.push(item);
      }
    });
    out[cat] = filtered;
  }
  return out;
}

// "1. 첫 번째. 2. 두 번째." 처럼 한 줄에 붙어 들어오는 케이스가 잦아서 번호 앞에서
// 줄바꿈을 강제. chrome-extension 의 동일 처리 그대로.
function formatFlow(flow: string): string {
  return flow.replace(/(\d+)\.\s/g, '\n$1. ').replace(/^\n/, '');
}
