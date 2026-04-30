import { useEffect, useMemo, useRef, useState } from 'react';
// (useRef 이미 import. prev threadId tracking 위해 사용.)
import { askStream, searchDocs } from '../api';
import { annotateCitedHits } from '../citations';
import type { SearchHit, ThreadMessage } from '../../shared/types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
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

  // hits 와 마지막 assistant 메시지 내용으로부터 cited 상태 derive.
  const annotatedHits = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return hits.map((h) => ({ ...h, cited: false }));
    return annotateCitedHits(lastAssistant.content, hits);
  }, [hits, messages]);

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
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>{m.content || '…'}</div>
        ))}
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
