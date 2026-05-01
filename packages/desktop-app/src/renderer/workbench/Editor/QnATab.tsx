import { useEffect, useMemo, useRef, useState } from 'react';
import { askStream, searchDocs } from '../../api';
import { annotateCitedHits } from '../../citations';
import type { SearchHit, ThreadDocRef } from '../../../shared/types';

// PR5: editor 영역의 QnA 대화 탭. PR4까지 우측 360px ChatPanel 이 하던 일을 여기로 이전.
// review/changes 는 ReviewSplitPane (PR4) 으로 이미 이전됨. 자동 thread 생성도 제거 —
// QnATab 은 항상 threadId 가 결정된 채 mount 된다 (사이드바 ThreadList 의 + 새 / row 클릭이
// store.openTab(qna-thread) 를 호출).

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  threadId: string;
  // ThreadList 의 updated_at 갱신 트리거 (App 이 refreshKey 증가).
  onMessagesChanged: () => void;
  // 검색 결과 hit 클릭 — App 이 트리에서 그 문서 탭 open.
  onOpenHit?: (hit: SearchHit) => void;
  // 누적 doc chip 클릭 — App 이 그 문서 탭 open.
  onOpenDoc?: (doc: { doc_id: string; doc_type: 'xlsx' | 'confluence'; doc_title: string | null }) => void;
}

function genMsgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function QnATab({ threadId, onMessagesChanged, onOpenHit, onOpenDoc }: Props) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [docs, setDocs] = useState<ThreadDocRef[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searchTookMs, setSearchTookMs] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // mount 시 자기 thread bundle 자체 fetch — 영속된 messages/docs 복원.
  // threadId 는 탭 lifetime 동안 불변이므로 [threadId] 의존성은 사실상 mount 한 번.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bundle = await window.projk.threads.get(threadId);
        if (cancelled || !bundle) return;
        setMessages(
          bundle.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        );
        setDocs(bundle.docs);
      } catch (e) {
        console.warn('threads.get', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // textarea auto-grow
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

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

    setMessages((m) => [...m, { role: 'user', content: q }]);

    // user 영속
    try {
      await window.projk.threads.appendMessage({
        id: genMsgId(),
        thread_id: threadId,
        role: 'user',
        content: q,
      });
    } catch (e) {
      console.warn('appendMessage(user) 실패', e);
    }

    // search-first
    let searchHits: SearchHit[] = [];
    try {
      const search = await searchDocs(q, 12);
      searchHits = search.results;
      setHits(searchHits);
      setSearchTookMs(search.took_ms);
    } catch (e) {
      console.warn('search_docs failed', e);
    }

    // thread_docs upsert (워크스페이스 누적)
    for (const h of searchHits.slice(0, 5)) {
      try {
        await window.projk.threads.upsertDoc({
          thread_id: threadId,
          doc_id: h.doc_id,
          doc_type: h.type,
          doc_title: h.title,
          pinned: 0,
        });
      } catch (e) {
        console.warn('upsertDoc 실패', e);
      }
    }

    // ask stream
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

    // assistant 영속
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
        thread_id: threadId,
        role: 'assistant',
        content: finalContent,
        citations: cited,
      });
    } catch (e) {
      console.warn('appendMessage(assistant) 실패', e);
    }

    // upsert 후 docs 가 늘었을 수 있음 — 자기 docs state 갱신.
    try {
      const bundle = await window.projk.threads.get(threadId);
      if (bundle) setDocs(bundle.docs);
    } catch (e) {
      console.warn('threads.get docs 실패', e);
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
    <aside className="chat" data-testid="qna-tab">
      {docs.length > 0 && (
        <div className="thread-docs-row" data-testid="thread-docs">
          <span className="thread-docs-label">📚 누적 문서</span>
          {docs.map((d) => (
            <button
              key={`${d.doc_type}:${d.doc_id}`}
              className={`thread-doc-chip ${d.doc_type}${d.pinned ? ' pinned' : ''}`}
              onClick={() =>
                onOpenDoc?.({ doc_id: d.doc_id, doc_type: d.doc_type, doc_title: d.doc_title })
              }
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
              onClick={() => onOpenHit?.(h)}
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
                  {h.cited && (
                    <span className="cited-badge" title="답변에서 인용됨">
                      📌 인용
                    </span>
                  )}
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
          <div key={i} className={`msg ${m.role}`}>
            {m.content || '…'}
          </div>
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
        <button onClick={() => void send()} disabled={busy} data-testid="chat-send">
          {busy ? '…' : '보내기'}
        </button>
      </div>
    </aside>
  );
}
