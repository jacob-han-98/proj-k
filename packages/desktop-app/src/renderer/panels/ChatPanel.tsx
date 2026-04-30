import { useEffect, useMemo, useRef, useState } from 'react';
// (useRef 이미 import. prev threadId tracking 위해 사용.)
import { askStream, reviewStream, searchDocs, suggestEditsStream, type ChangeItem } from '../api';
import { annotateCitedHits } from '../citations';
import type { SearchHit, ThreadMessage } from '../../shared/types';
import { ReviewCard, type ReviewData } from './ReviewCard';
import { ChangesCard } from './ChangesCard';

interface ReviewState {
  title: string;
  data: ReviewData | null;
  streaming: boolean;
  error?: string;
  // Phase 4-3.5: "원본 수정" 시 그대로 다시 보내야 하므로 review 발동 시점의 본문을
  // 같이 들고 있는다. CenterPane 의 webview executeJavaScript 결과가 여기로.
  originalText: string;
  // Phase 4-3.5+: WSL agent 의 token 이벤트 누적. streaming 중 가시화용.
  streamBuffer?: string;
  status?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  // Phase 4-3: assistant 메시지가 review 응답이면 content 대신 이 필드를 채워 카드로 렌더.
  // 영속(thread DB) 안 함 — 리뷰는 채팅 turn 이 아니라 ad-hoc 액션 결과라 그 thread 의
  // 검색-답변 연속성을 깨면 안 됨. 부팅 후엔 카드 사라지고 user 메시지("📋 리뷰 요청: ...")
  // 만 history 에 남는 게 의도된 동작.
  review?: ReviewState;
  // Phase 4-3.5: review 의 "원본 수정" 클릭 → 새 assistant 메시지에 changes 필드.
  changes?: {
    items: ChangeItem[] | null;
    streaming: boolean;
    error?: string;
    streamBuffer?: string;
    status?: string;
  };
}

// WSL agent 가 NDJSON 으로 흘리는 이벤트의 필드를 defensive 하게 추출. WSL 은
// {type, message/data}, 기존 chrome-extension/스텁은 {type, payload} — 둘 다 허용.
function readStatus(e: { [k: string]: unknown }): string | null {
  const v = e.message ?? e.payload;
  return typeof v === 'string' ? v : null;
}
function readToken(e: { [k: string]: unknown }): string | null {
  const v = e.token ?? e.payload ?? e.text ?? e.delta;
  return typeof v === 'string' ? v : null;
}
function readError(e: { [k: string]: unknown }): string | null {
  const v = e.error ?? e.message ?? e.payload;
  return typeof v === 'string' ? v : null;
}
// WSL agent 가 LLM 출력을 그대로 흘릴 때 ```json ... ``` 마크다운 코드펜스로 감싸서 옴.
// JSON.parse 전에 펜스를 벗겨야 한다.
function stripMarkdownFence(s: string): string {
  return s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function parseReviewResult(e: { [k: string]: unknown }): ReviewData | null {
  // WSL: {type:"result", data:{review: <JSON string or ```json ... ```>, model, usage}}
  // legacy/stub: {type:"result", payload: <ReviewData object>}
  const data = e.data as { review?: unknown } | undefined;
  console.log('[review] result event — data keys:', data ? Object.keys(data) : null,
    '| review type:', typeof data?.review,
    '| review start:', typeof data?.review === 'string' ? (data.review as string).slice(0, 60) : data?.review);
  if (data && typeof data.review === 'string') {
    const stripped = stripMarkdownFence(data.review);
    console.log('[review] after stripMarkdownFence start:', stripped.slice(0, 60));
    try {
      const parsed = JSON.parse(stripped) as ReviewData;
      console.log('[review] JSON.parse OK — score:', parsed.score, '| keys:', Object.keys(parsed));
      return parsed;
    } catch (err) {
      console.error('[review] JSON.parse FAILED:', err, '| stripped[:100]:', stripped.slice(0, 100));
      /* fall through */
    }
  }
  if (data && typeof data === 'object' && !('review' in data) && hasReviewShape(data)) {
    console.log('[review] using data directly (no review wrapper)');
    return data as ReviewData;
  }
  if (e.payload && typeof e.payload === 'object') {
    console.log('[review] using payload directly');
    return e.payload as ReviewData;
  }
  console.error('[review] parseReviewResult failed — no matching branch. full event:', JSON.stringify(e).slice(0, 200));
  return null;
}
function parseChangesResult(e: { [k: string]: unknown }): ChangeItem[] | null {
  // WSL: {type:"result", data:{changes:[...], ...}}
  // legacy: {type:"result", payload:{changes:[...]}} or {type:"result", payload:[...]}
  const data = e.data as { changes?: unknown } | undefined;
  if (data && Array.isArray(data.changes)) return data.changes as ChangeItem[];
  const payload = e.payload as { changes?: unknown } | unknown[] | undefined;
  if (Array.isArray(payload)) return payload as ChangeItem[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { changes?: unknown }).changes)) {
    return (payload as { changes: ChangeItem[] }).changes;
  }
  return null;
}
function hasReviewShape(o: object): boolean {
  return 'score' in o || 'issues' in o || 'suggestions' in o || 'verifications' in o;
}

// Phase 4-2: Confluence webview body 리뷰 트리거. App 이 CenterPane 의 버튼
// 클릭으로부터 받아서 ChatPanel 로 내려보내고, 한 번 처리되면 onReviewConsumed
// 로 App 의 trigger state 를 비운다. id 는 같은 페이지를 다시 리뷰 요청해도
// useEffect 가 다시 발동되도록 dedupe key. body 추출은 CenterPane 책임.
export interface ReviewTrigger {
  id: number;
  title: string;
  text: string;
}

interface Props {
  onOpenHit: (hit: SearchHit) => void;
  // Phase 3.4: 영속 wiring. threadId 가 없으면 첫 입력 시 auto-create.
  threadId: string | null;
  initialMessages: ThreadMessage[];
  initialDocs?: import('../../shared/types').ThreadDocRef[];
  onThreadCreated: (id: string) => void;
  onMessagesChanged: () => void; // ThreadList refresh 트리거
  onOpenDoc?: (doc: { doc_id: string; doc_type: 'xlsx' | 'confluence'; doc_title: string | null }) => void;
  reviewTrigger?: ReviewTrigger | null;
  onReviewConsumed?: () => void;
  // Phase 4-4: 현재 열려있는 Confluence 페이지 ID. Apply 시 PUT 대상.
  confluencePageId?: string | null;
}

function genMsgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 검색-우선 UX:
//   1) 입력 → /search_docs (~150ms) 즉시 페인트
//   2) /ask_stream 답변 스트림 동시 시작
//   3) 스트림 안 (출처: ...) 매칭으로 hit 에 cited 배지 부착
//
// 사용자 인터뷰의 1순위 ("관련 문서가 가장 편하다") 를 시각으로 풀어내는 핵심 패널.

export function ChatPanel({
  onOpenHit,
  threadId,
  initialMessages,
  initialDocs,
  onThreadCreated,
  onMessagesChanged,
  onOpenDoc,
  reviewTrigger,
  onReviewConsumed,
  confluencePageId,
}: Props) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searchTookMs, setSearchTookMs] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // selectedThread 변경 시 messages 를 그 thread 의 history 로 reset.
  // 단 send() 안의 자동 thread 생성은 reset 안 함 (selfCreatedRef 로 표시).
  // 부팅 시 lastThreadId 자동 select 또는 ThreadList 클릭은 reset → history 복원.
  const selfCreatedRef = useRef(false);
  const prevThreadIdRef = useRef<string | null>(threadId);
  useEffect(() => {
    if (selfCreatedRef.current) {
      // 자동 생성 케이스 — 이미 send() 가 user message 를 추가했으니 skip.
      selfCreatedRef.current = false;
      prevThreadIdRef.current = threadId;
      return;
    }
    const isThreadSwitch = prevThreadIdRef.current !== threadId;
    prevThreadIdRef.current = threadId;

    const next = initialMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // history 가 더 풍부할 때만 reset. 같은 thread 안에서 영속 직후 fetch 된 결과로
    // dropping 회귀 회피 (현재 messages 가 더 신선할 수 있음).
    setMessages((prev) => (next.length >= prev.length ? next : prev));
    // 검색 결과 / took 는 다른 thread 로 진짜 전환됐을 때만 reset. 같은 thread 안에서
    // initialMessages 만 갱신된 케이스 (onMessagesChanged 후) 는 hits 보존.
    if (isThreadSwitch) {
      setHits([]);
      setSearchTookMs(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, initialMessages]);

  // Auto-grow textarea
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // Phase 4-2: reviewTrigger 가 새로 들어오면 1회 리뷰 stream 실행. busy 면 무시
  // (사용자가 다른 stream 진행 중에 리뷰 버튼 다시 누른 케이스). 처리 끝나면
  // onReviewConsumed 로 trigger 비움 → 같은 페이지 재요청 시 새 id 로 재발동.
  // 4-3 에서 result 의 JSON 파싱해 review-card 컴포넌트로 swap 예정.
  useEffect(() => {
    if (!reviewTrigger) return;
    if (busy) {
      onReviewConsumed?.();
      return;
    }
    let cancelled = false;
    void (async () => {
      setBusy(true);
      setMessages((m) => [
        ...m,
        { role: 'user', content: `📋 리뷰 요청: ${reviewTrigger.title}` },
        {
          role: 'assistant',
          content: '',
          review: {
            title: reviewTrigger.title,
            data: null,
            streaming: true,
            originalText: reviewTrigger.text,
          },
        },
      ]);
      const updateReview = (next: Partial<NonNullable<Message['review']>>) =>
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last.review) {
            copy[copy.length - 1] = { ...last, review: { ...last.review, ...next } };
          }
          return copy;
        });
      try {
        await reviewStream(
          { title: reviewTrigger.title, text: reviewTrigger.text },
          (event) => {
            if (cancelled) return;
            const e = event as unknown as { type: string; [k: string]: unknown };
            if (e.type === 'status') {
              const s = readStatus(e);
              if (s) updateReview({ status: s });
            } else if (e.type === 'token') {
              const tok = readToken(e);
              if (tok) {
                setMessages((m) => {
                  const copy = [...m];
                  const last = copy[copy.length - 1];
                  if (last.review) {
                    copy[copy.length - 1] = {
                      ...last,
                      review: { ...last.review, streamBuffer: (last.review.streamBuffer ?? '') + tok },
                    };
                  }
                  return copy;
                });
              }
            } else if (e.type === 'result') {
              const data = parseReviewResult(e);
              if (data) updateReview({ data, streaming: false });
              else updateReview({ error: 'result 파싱 실패 — data.review 또는 payload 없음', streaming: false });
            } else if (e.type === 'error') {
              const msg = readError(e) ?? '알 수 없는 오류';
              updateReview({ error: msg, streaming: false });
            }
          },
        );
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        updateReview({ error: msg, streaming: false });
      } finally {
        if (!cancelled) {
          setBusy(false);
          onReviewConsumed?.();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // reviewTrigger.id 만 의존 — title/text 가 같은 instance 안에서 mutation 될 일은 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewTrigger?.id]);

  // hits 와 마지막 assistant 메시지 내용으로부터 cited 상태 derive.
  const annotatedHits = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return hits.map((h) => ({ ...h, cited: false }));
    return annotateCitedHits(lastAssistant.content, hits);
  }, [hits, messages]);

  // Phase 4-3.5: review 카드의 "원본 수정" 클릭 → 변경안(changes) 생성. busy 면 무시.
  // 항목별 deselect UI 가 아직 없어서 issues/verifications/suggestions 전부를 instruction
  // 으로 묶어 보냄. 사용자가 일부만 반영하고 싶으면 4-X 의 per-item 토글 도입 후 가능.
  const startFix = async (review: ReviewState) => {
    if (busy || !review.data) return;
    const items: string[] = [];
    const labelMap = { issues: '⚠️ 보강', verifications: '🔍 검증', suggestions: '💡 제안' };
    (['issues', 'verifications', 'suggestions'] as const).forEach((cat) => {
      (review.data?.[cat] ?? []).forEach((it) => {
        const text = typeof it === 'string' ? it : it.text;
        if (text) items.push(`[${labelMap[cat]}] ${text}`);
      });
    });
    if (items.length === 0) return;
    const instruction = `다음 리뷰 항목을 반영하여 문서를 수정해주세요:\n${items
      .map((t, i) => `${i + 1}. ${t}`)
      .join('\n')}`;

    setBusy(true);
    setMessages((m) => [
      ...m,
      {
        role: 'user',
        content: `✏️ 리뷰 반영 수정 요청 (${items.length}건)`,
      },
      {
        role: 'assistant',
        content: '',
        changes: { items: null, streaming: true },
      },
    ]);
    const updateChanges = (next: Partial<NonNullable<Message['changes']>>) =>
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last.changes) copy[copy.length - 1] = { ...last, changes: { ...last.changes, ...next } };
        return copy;
      });
    try {
      await suggestEditsStream(
        {
          title: review.title,
          text: review.originalText,
          instruction,
          maxChanges: items.length,
        },
        (event) => {
          const e = event as unknown as { type: string; [k: string]: unknown };
          if (e.type === 'status') {
            const s = readStatus(e);
            if (s) updateChanges({ status: s });
          } else if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) {
              setMessages((m) => {
                const copy = [...m];
                const last = copy[copy.length - 1];
                if (last.changes) {
                  copy[copy.length - 1] = {
                    ...last,
                    changes: { ...last.changes, streamBuffer: (last.changes.streamBuffer ?? '') + tok },
                  };
                }
                return copy;
              });
            }
          } else if (e.type === 'result') {
            const items = parseChangesResult(e);
            if (items) updateChanges({ items, streaming: false });
            else updateChanges({ error: 'result 파싱 실패 — data.changes 또는 payload 없음', streaming: false });
          } else if (e.type === 'error') {
            const msg = readError(e) ?? '알 수 없는 오류';
            updateChanges({ error: msg, streaming: false });
          }
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateChanges({ error: msg, streaming: false });
    } finally {
      setBusy(false);
    }
  };

  // Phase 4-4: ChangesCard 의 "✓ Confluence 에 반영" → IPC → main → PUT
  const applyToConfluence = async (items: ChangeItem[]) => {
    if (!confluencePageId) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: '[Apply 오류] 현재 열린 Confluence 페이지 ID 없음 — 페이지를 선택한 상태에서 리뷰 후 적용하세요.' },
      ]);
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: '⏳ Confluence 에 반영 중…' }]);
    try {
      const result = await window.projk.confluenceApplyEdits(confluencePageId, items);
      const summary = result.ok
        ? `✅ ${result.applied}건 반영 완료${result.skipped > 0 ? ` (${result.skipped}건 미매칭 — 텍스트 불일치)` : ''}${result.pageUrl ? `\n페이지: ${result.pageUrl}` : ''}`
        : `[Apply 오류] ${result.error ?? '알 수 없는 오류'}${result.applied > 0 ? ` (${result.applied}건은 반영됨)` : ''}`;
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'assistant', content: summary };
        return copy;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'assistant', content: `[Apply 오류] ${msg}` };
        return copy;
      });
    }
  };

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setBusy(true);
    setInput('');
    setHits([]);
    setSearchTookMs(null);

    // Phase 3.4: thread 가 없으면 자동 생성 (title = 첫 30자) + App 에 알림.
    // 주의: setMessages(user) 는 thread 생성 *후* 호출 — 그래야 useEffect 의 [threadId]
    // cascade reset 이 먼저 발동하고 user message 가 그 후에 추가되어 보존된다.
    let activeThreadId = threadId;
    if (!activeThreadId) {
      try {
        const t = await window.projk.threads.create({
          id: genMsgId(),
          title: q.slice(0, 30) || '새 스레드',
        });
        activeThreadId = t.id;
        // useEffect 의 reset 회피 표식 — onThreadCreated 직후 props 변경으로 발동될 useEffect 가 보고 자기 호출 skip.
        selfCreatedRef.current = true;
        onThreadCreated(t.id);
      } catch (e) {
        console.warn('threads.create 실패 — 영속 없이 진행', e);
      }
    }
    setMessages((m) => [...m, { role: 'user', content: q }]);

    // user message 영속 (thread 가 있을 때만).
    const userMsgId = genMsgId();
    if (activeThreadId) {
      try {
        await window.projk.threads.appendMessage({
          id: userMsgId,
          thread_id: activeThreadId,
          role: 'user',
          content: q,
        });
      } catch (e) {
        console.warn('appendMessage(user) 실패', e);
      }
    }

    // Stage 1: search-first
    let searchHits: SearchHit[] = [];
    try {
      const search = await searchDocs(q, 12);
      searchHits = search.results;
      setHits(searchHits);
      setSearchTookMs(search.took_ms);
    } catch (e) {
      console.warn('search_docs failed', e);
    }

    // 검색 결과를 thread_docs 에 upsert (워크스페이스 누적).
    if (activeThreadId) {
      for (const h of searchHits.slice(0, 5)) {
        try {
          await window.projk.threads.upsertDoc({
            thread_id: activeThreadId,
            doc_id: h.doc_id,
            doc_type: h.type,
            doc_title: h.title,
            pinned: 0,
          });
        } catch (e) {
          console.warn('upsertDoc 실패', e);
        }
      }
    }

    // Stage 2: stream answer
    let assembled = '';
    setMessages((m) => [...m, { role: 'assistant', content: '' }]);
    try {
      await askStream(q, (event) => {
        const e = event as { type: string; payload: unknown };
        if (e.type === 'token' && typeof e.payload === 'string') {
          assembled += e.payload;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: 'assistant', content: assembled };
            return copy;
          });
        } else if (
          e.type === 'result' &&
          typeof e.payload === 'object' &&
          e.payload &&
          'answer' in (e.payload as Record<string, unknown>)
        ) {
          const ans = String((e.payload as Record<string, unknown>).answer ?? '');
          assembled = ans;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: 'assistant', content: assembled };
            return copy;
          });
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assembled = `[오류] ${msg}`;
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'assistant', content: assembled };
        return copy;
      });
    } finally {
      setBusy(false);
    }

    // assistant message 영속. 빈 응답 (stream 중단 등) 도 placeholder 로 영속해서
    // thread history 에 turn 자체는 남기고, 다음 부팅 복원 시 사용자가 무엇을 이미
    // 시도했는지 알 수 있게 한다.
    if (activeThreadId) {
      const finalContent = assembled || '[빈 응답 — 스트림이 끝나기 전에 종료됨]';
      const cited = assembled
        ? annotateCitedHits(assembled, searchHits)
            .filter((h) => h.cited)
            .map((h, i) => ({
              doc_type: h.type,
              doc_id: h.doc_id,
              doc_title: h.title,
              snippet: h.snippet ?? null,
              score: h.score ?? null,
              rank: i,
              url: h.url ?? null,
            }))
        : [];
      try {
        await window.projk.threads.appendMessage({
          id: genMsgId(),
          thread_id: activeThreadId,
          role: 'assistant',
          content: finalContent,
          citations: cited,
        });
      } catch (e) {
        console.warn('appendMessage(assistant) 실패', e);
      }
    }

    // ThreadList 의 updated_at 변경 반영.
    onMessagesChanged();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };

  return (
    <aside className="chat" data-testid="chat-panel">
      {threadId && initialDocs && initialDocs.length > 0 && (
        <div className="thread-docs-row" data-testid="thread-docs">
          <span className="thread-docs-label">📚 누적 문서</span>
          {initialDocs.map((d) => (
            <button
              key={`${d.doc_type}:${d.doc_id}`}
              className={`thread-doc-chip ${d.doc_type}${d.pinned ? ' pinned' : ''}`}
              onClick={() => onOpenDoc?.({ doc_id: d.doc_id, doc_type: d.doc_type, doc_title: d.doc_title })}
              title={d.doc_title ?? d.doc_id}
              data-testid={`thread-doc-${d.doc_id}`}
              type="button"
            >
              {d.doc_type === 'xlsx' ? '📄' : '📘'} {d.doc_title ?? d.doc_id}
            </button>
          ))}
        </div>
      )}

      {annotatedHits.length > 0 && (
        <div className="search-results" data-testid="search-results">
          <div className="search-results-header">
            <span className="count">관련 문서 {annotatedHits.length}개</span>
            {searchTookMs != null && <span className="meta">({searchTookMs}ms)</span>}
            <span className="hint">클릭해서 열기</span>
          </div>
          {annotatedHits.map((h) => (
            <button
              key={h.doc_id}
              className={`hit-card ${h.type} ${h.cited ? 'cited' : ''}`}
              onClick={() => onOpenHit(h)}
              data-testid={`hit-${h.doc_id}`}
              data-cited={h.cited ? 'true' : 'false'}
              type="button"
            >
              <span className="hit-icon" aria-hidden="true">
                {h.type === 'xlsx' ? '📄' : '📘'}
              </span>
              <span className="hit-body">
                <span className="hit-title">
                  {h.title}
                  {h.cited && <span className="cited-badge" title="답변에서 인용됨">📌 인용</span>}
                </span>
                <span className="hit-path">{h.path}</span>
                {h.snippet && <span className="hit-snippet">{h.snippet}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 4 }}>
            질문을 입력하면 관련 문서가 먼저 표시되고 답변이 이어 스트림됩니다.
          </div>
        )}
        {messages.map((m, i) => {
          if (m.review) {
            const rv = m.review;
            return (
              <ReviewCard
                key={i}
                title={rv.title}
                data={rv.data}
                streaming={rv.streaming}
                error={rv.error}
                streamBuffer={rv.streamBuffer}
                status={rv.status}
                onFixRequest={() => void startFix(rv)}
              />
            );
          }
          if (m.changes) {
            return (
              <ChangesCard
                key={i}
                changes={m.changes.items}
                streaming={m.changes.streaming}
                error={m.changes.error}
                streamBuffer={m.changes.streamBuffer}
                status={m.changes.status}
                onApply={m.changes.items && m.changes.items.length > 0 ? applyToConfluence : undefined}
              />
            );
          }
          return <div key={i} className={`msg ${m.role}`}>{m.content || '…'}</div>;
        })}
      </div>

      <div className="input-row">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="질문을 입력하세요 (Ctrl+Enter)"
          data-testid="chat-input"
        />
        <button onClick={send} disabled={busy} data-testid="chat-send">{busy ? '…' : '보내기'}</button>
      </div>
    </aside>
  );
}
