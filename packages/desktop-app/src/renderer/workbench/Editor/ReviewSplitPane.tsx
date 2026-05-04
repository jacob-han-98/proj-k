import { useEffect, useMemo, useState } from 'react';
import { reviewStream, suggestEditsStream, type ChangeItem } from '../../api';
import { ReviewCard, type ReviewData } from '../../panels/ReviewCard';
import { ChangesCard } from '../../panels/ChangesCard';
import {
  hashContent,
  invalidateFixture,
  loadFixture,
  saveFixture,
} from '../../panels/review-fixture-cache';
import {
  toBackendPayload,
  type ReviewOptions,
} from '../../panels/review-options-mapping';
import { readErrorMessage, readToken } from '../../stream-events';

// PR4: ChatPanel 에 있던 리뷰/변경안 파이프라인을 editor 탭의 우측 split 으로 이전.
// 탭별 isolated — props 로 받은 (tabId, trigger, title, text) 가 바뀌면 (= 새 리뷰 요청)
// 새 stream 시작. 닫기 X 누르면 store.closeSplit(tabId) 호출 → 컴포넌트 unmount.
//
// 헬퍼 (parseReviewResult, parseChangesResult, stripMarkdownFence, readToken/Status/Error,
// hasReviewShape) 는 ChatPanel.tsx 와 의도적으로 동일 — PR5 에서 ChatPanel 이 사라진 후
// 이 파일이 단독 소스가 된다.

interface ReviewState {
  data: ReviewData | null;
  streaming: boolean;
  error?: string;
  streamBuffer?: string;
  status?: string;
  // B2-2: localStorage 에서 불러온 캐시 fixture 의 메타. UI 에서 "💾 X분 전 · model" 표시.
  // null = fresh stream 결과. 새 stream 시작하면 다시 null.
  cachedAt?: number | null;
  cachedModel?: string | null;
}

interface ChangesState {
  items: ChangeItem[] | null;
  streaming: boolean;
  error?: string;
  streamBuffer?: string;
  status?: string;
}

interface Props {
  tabId: string;
  title: string;
  text: string;
  // 새 리뷰 요청 시점의 timestamp. 같은 페이지 재요청도 effect 재발동시키는 dedupe key.
  trigger: number;
  // P2: 사용자가 옵션 패널에서 고른 옵션. P0/Excel sheet review 흐름은 미지정 (undefined)
  // — backend 가 받지 않으면 기존 동작.
  reviewOptions?: ReviewOptions;
  // Confluence 탭이면 페이지 ID, Excel 탭이면 null. Apply 시 PUT 대상.
  confluencePageId: string | null;
  onClose: () => void;
}

function readStatus(e: { [k: string]: unknown }): string | null {
  const v = e.message ?? e.payload;
  return typeof v === 'string' ? v : null;
}
const readError = readErrorMessage;
function stripMarkdownFence(s: string): string {
  return s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
}
function hasReviewShape(o: object): boolean {
  return 'score' in o || 'issues' in o || 'suggestions' in o || 'verifications' in o;
}
function parseReviewResult(e: { [k: string]: unknown }): ReviewData | null {
  const data = e.data as { review?: unknown } | undefined;
  if (data && typeof data.review === 'string') {
    const stripped = stripMarkdownFence(data.review);
    try {
      return JSON.parse(stripped) as ReviewData;
    } catch {
      /* fall through */
    }
  }
  if (data && typeof data === 'object' && !('review' in data) && hasReviewShape(data)) {
    return data as ReviewData;
  }
  if (e.payload && typeof e.payload === 'object') return e.payload as ReviewData;
  return null;
}
function parseChangesResult(e: { [k: string]: unknown }): ChangeItem[] | null {
  const data = e.data as { changes?: unknown } | undefined;
  if (data && Array.isArray(data.changes)) return data.changes as ChangeItem[];
  const payload = e.payload as { changes?: unknown } | unknown[] | undefined;
  if (Array.isArray(payload)) return payload as ChangeItem[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { changes?: unknown }).changes)) {
    return (payload as { changes: ChangeItem[] }).changes;
  }
  return null;
}

export function ReviewSplitPane({ tabId: _tabId, title, text, trigger, reviewOptions, confluencePageId, onClose }: Props) {
  const [review, setReview] = useState<ReviewState>({ data: null, streaming: true });
  const [changes, setChanges] = useState<ChangesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  // B2-2: "🔁 새 리뷰" 클릭 시 +1 — 같은 trigger 라도 effect 재발동시키기 위함.
  const [refreshNonce, setRefreshNonce] = useState(0);

  // contentHash 는 본문 변경 detect 용. confluencePageId + hash 로 fixture key 잡음.
  // Excel 탭 (confluencePageId=null) 은 캐시 안 함 — Excel 리뷰는 향후 별도 흐름.
  const contentHash = useMemo(() => hashContent(text), [text]);

  // 새 trigger 또는 refreshNonce 변경 시 review 재시작 — 단, refreshNonce 가 0 이 아닐
  // 때만 cache 무시 (forceFresh).
  useEffect(() => {
    let cancelled = false;
    const forceFresh = refreshNonce > 0;
    setReview({ data: null, streaming: true });
    setChanges(null);
    setApplyMessage(null);
    setBusy(true);

    // 1) 캐시 hit 시도 (forceFresh 면 skip)
    if (!forceFresh && confluencePageId) {
      const fixture = loadFixture(confluencePageId, contentHash);
      if (fixture) {
        setReview({
          data: fixture.data,
          streaming: false,
          cachedAt: fixture.savedAt,
          cachedModel: fixture.model ?? null,
        });
        setBusy(false);
        return; // 백엔드 호출 안 함
      }
    }
    // refreshNonce > 0 인 경우 — 기존 fixture 무효화 + 새 stream
    if (forceFresh && confluencePageId) {
      invalidateFixture(confluencePageId, contentHash);
    }

    void (async () => {
      try {
        const reviewPayload: { title: string; text: string; review_options?: ReturnType<typeof toBackendPayload> } = { title, text };
        if (reviewOptions) reviewPayload.review_options = toBackendPayload(reviewOptions);
        await reviewStream(reviewPayload, (event) => {
          if (cancelled) return;
          const e = event as unknown as { type: string; [k: string]: unknown };
          if (e.type === 'status') {
            const s = readStatus(e);
            if (s) setReview((r) => ({ ...r, status: s }));
          } else if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) setReview((r) => ({ ...r, streamBuffer: (r.streamBuffer ?? '') + tok }));
          } else if (e.type === 'result') {
            const data = parseReviewResult(e);
            if (data) {
              setReview((r) => ({ ...r, data, streaming: false }));
              // 결과 도착 → 캐시 저장. model 은 result.data.model 에서 추출 (있으면).
              if (confluencePageId) {
                const resultData = e.data as { model?: unknown } | undefined;
                const model = typeof resultData?.model === 'string' ? resultData.model : undefined;
                saveFixture(confluencePageId, contentHash, data, model);
              }
            } else setReview((r) => ({ ...r, error: 'result 파싱 실패 — data.review 또는 payload 없음', streaming: false }));
          } else if (e.type === 'error') {
            const msg = readError(e) ?? '알 수 없는 오류';
            setReview((r) => ({ ...r, error: msg, streaming: false }));
          }
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setReview((r) => ({ ...r, error: msg, streaming: false }));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // title/text 는 trigger 와 함께 갱신되므로 trigger / refreshNonce 만 의존성으로.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, refreshNonce]);

  // A5: filtered 는 ReviewCard 의 per-item feedback 적용 결과 — dislike 제외,
  // edited 는 사용자 instruction 추가된 채. 이게 prompt 로 들어감 → 사용자가 정밀 통제.
  const startFix = async (filtered?: ReviewData) => {
    if (busy || !review.data) return;
    const source = filtered ?? review.data;
    const items: string[] = [];
    const labelMap = { issues: '⚠️ 보강', verifications: '🔍 검증', suggestions: '💡 제안' };
    (['issues', 'verifications', 'suggestions'] as const).forEach((cat) => {
      (source[cat] ?? []).forEach((it) => {
        const t = typeof it === 'string' ? it : it.text;
        if (t) items.push(`[${labelMap[cat]}] ${t}`);
      });
    });
    if (items.length === 0) return;
    const instruction = `다음 리뷰 항목을 반영하여 문서를 수정해주세요:\n${items
      .map((t, i) => `${i + 1}. ${t}`)
      .join('\n')}`;

    setBusy(true);
    setChanges({ items: null, streaming: true });
    setApplyMessage(null);
    try {
      await suggestEditsStream(
        { title, text, instruction, maxChanges: items.length },
        (event) => {
          const e = event as unknown as { type: string; [k: string]: unknown };
          if (e.type === 'status') {
            const s = readStatus(e);
            if (s) setChanges((c) => (c ? { ...c, status: s } : c));
          } else if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) {
              setChanges((c) => (c ? { ...c, streamBuffer: (c.streamBuffer ?? '') + tok } : c));
            }
          } else if (e.type === 'result') {
            const list = parseChangesResult(e);
            if (list) setChanges((c) => (c ? { ...c, items: list, streaming: false } : c));
            else setChanges((c) => (c ? { ...c, error: 'result 파싱 실패 — data.changes 또는 payload 없음', streaming: false } : c));
          } else if (e.type === 'error') {
            const msg = readError(e) ?? '알 수 없는 오류';
            setChanges((c) => (c ? { ...c, error: msg, streaming: false } : c));
          }
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChanges((c) => (c ? { ...c, error: msg, streaming: false } : c));
    } finally {
      setBusy(false);
    }
  };

  const applyToConfluence = async (items: ChangeItem[]) => {
    if (!confluencePageId) {
      setApplyMessage('[Apply 오류] 현재 탭이 Confluence 페이지가 아닙니다 — Excel 탭의 Apply 는 다음 마일스톤.');
      return;
    }
    setApplyMessage('⏳ Confluence 에 반영 중…');
    try {
      const result = await window.projk.confluenceApplyEdits(confluencePageId, items);
      const summary = result.ok
        ? `✅ ${result.applied}건 반영 완료${
            result.skipped > 0 ? ` (${result.skipped}건 미매칭 — 텍스트 불일치)` : ''
          }${result.pageUrl ? `\n페이지: ${result.pageUrl}` : ''}`
        : `[Apply 오류] ${result.error ?? '알 수 없는 오류'}${
            result.applied > 0 ? ` (${result.applied}건은 반영됨)` : ''
          }`;
      setApplyMessage(summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setApplyMessage(`[Apply 오류] ${msg}`);
    }
  };

  return (
    <aside className="review-split-pane" data-testid="review-split-pane">
      <header className="review-split-header">
        <span className="review-split-title">
          <i className="codicon codicon-checklist" aria-hidden="true" /> 리뷰 — {title}
        </span>
        <button
          type="button"
          className="review-split-close"
          onClick={onClose}
          aria-label="리뷰 닫기"
          title="리뷰 닫기"
          data-testid="review-split-close"
        >
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      <div className="review-split-body">
        <ReviewCard
          title={title}
          data={review.data}
          streaming={review.streaming}
          error={review.error}
          streamBuffer={review.streamBuffer}
          status={review.status}
          cachedAt={review.cachedAt ?? null}
          cachedModel={review.cachedModel ?? null}
          onReRunRequest={() => setRefreshNonce((n) => n + 1)}
          onFixRequest={(filtered) => void startFix(filtered)}
        />
        {changes && (
          <ChangesCard
            changes={changes.items}
            streaming={changes.streaming}
            error={changes.error}
            streamBuffer={changes.streamBuffer}
            status={changes.status}
            confluencePageId={confluencePageId}
            onApply={changes.items && changes.items.length > 0 ? applyToConfluence : undefined}
          />
        )}
        {applyMessage && (
          <div className="review-apply-msg" data-testid="review-apply-msg">
            {applyMessage}
          </div>
        )}
      </div>
    </aside>
  );
}
