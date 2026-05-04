import { useEffect, useRef, useState } from 'react';
import { askStream, clearDocContext, setDocContext } from '../../api';
import { readErrorMessage, readResultData, readToken } from '../../stream-events';

// P3: 일반 Agent 모드 — 현재 열린 문서를 backend 에 stash 후 자유 대화.
// QnATab 과 달리 thread DB / preset chips / 검색 결과 패널 없음. 단순 chat:
// - mount: conversation_id 생성 → setDocContext(title, content)
// - 사용자 입력 → askStream(question, conversation_id) → backend agent 가
//   read_current_doc tool 로 본문 lazy load → 답변
// - unmount: clearDocContext (메모리 절약)
// - 본문이 변경되면 (props.trigger 새 값) 새 conversation 시작 + re-stash
//
// 회귀 보장:
// - 백엔드 미연결 → setDocContext 실패해도 UI 가 안 멈춤. 입력은 가능, askStream 이
//   기존 stub 응답.
// - 같은 탭의 모드 전환 → DocAssistantPane 의 onClose/setSplitMode 가 정리.

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  title: string;
  text: string;
  trigger: number;
  pageId: string | null;
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DocFocusedChat({ title, text, trigger, pageId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [stashStatus, setStashStatus] = useState<'idle' | 'stashing' | 'ok' | 'failed'>('idle');
  const conversationIdRef = useRef<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // trigger 갱신 시 새 conversation 시작 + re-stash. cleanup 에서 이전 conv clear.
  useEffect(() => {
    const newConv = `klaud-doc-${genId()}`;
    conversationIdRef.current = newConv;
    setMessages([]);
    setStashStatus('stashing');

    let cancelled = false;
    void (async () => {
      const result = await setDocContext(newConv, {
        title,
        page_id: pageId ?? undefined,
        doc_type: pageId ? 'confluence' : 'xlsx',
        content: text,
      });
      if (cancelled) return;
      setStashStatus(result.ok ? 'ok' : 'failed');
    })();

    return () => {
      cancelled = true;
      // unmount 또는 trigger 갱신 — 이전 conv 의 doc_context 정리.
      // ok=false 응답은 무시 (서버 없을 수도).
      const convToClear = newConv;
      void clearDocContext(convToClear).catch(() => {});
    };
    // title/text/pageId 는 trigger 와 함께 갱신되므로 trigger 만 의존성으로.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  // 새 메시지 추가 시 자동 스크롤.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onSend = async () => {
    const q = input.trim();
    if (!q || streaming) return;
    setInput('');
    const userMsg: Message = { id: genId(), role: 'user', content: q };
    const assistantId = genId();
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '' };
    setMessages((cur) => [...cur, userMsg, assistantMsg]);
    setStreaming(true);

    let buffer = '';
    try {
      await askStream(
        q,
        (event) => {
          const e = event as unknown as { type: string; [k: string]: unknown };
          if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) {
              buffer += tok;
              setMessages((cur) =>
                cur.map((m) => (m.id === assistantId ? { ...m, content: buffer } : m)),
              );
            }
          } else if (e.type === 'result') {
            const data = readResultData(e);
            const answer = (data && typeof data.answer === 'string') ? data.answer : null;
            if (answer) {
              buffer = answer;
              setMessages((cur) =>
                cur.map((m) => (m.id === assistantId ? { ...m, content: answer } : m)),
              );
            }
          } else if (e.type === 'error') {
            const msg = readErrorMessage(e) ?? '알 수 없는 오류';
            setMessages((cur) =>
              cur.map((m) =>
                m.id === assistantId ? { ...m, content: `[오류] ${msg}` } : m,
              ),
            );
          }
        },
        conversationIdRef.current,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((cur) =>
        cur.map((m) => (m.id === assistantId ? { ...m, content: `[오류] ${msg}` } : m)),
      );
    } finally {
      setStreaming(false);
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void onSend();
    }
  };

  return (
    <div className="doc-focused-chat" data-testid="doc-focused-chat">
      {stashStatus === 'stashing' && (
        <div className="doc-focused-status" data-testid="doc-focused-stash-status">
          📎 문서 컨텍스트 준비 중…
        </div>
      )}
      {stashStatus === 'failed' && (
        <div className="doc-focused-status doc-focused-status-warn" data-testid="doc-focused-stash-status">
          ⚠ 문서 컨텍스트 등록 실패 — 답변 시 본문 인용이 제한될 수 있습니다.
        </div>
      )}

      <div className="doc-focused-messages" ref={scrollRef} data-testid="doc-focused-messages">
        {messages.length === 0 && stashStatus === 'ok' && (
          <div className="doc-focused-empty" data-testid="doc-focused-empty">
            "{title}" 문서에 대해 자유롭게 질문하세요.
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              에이전트가 본문을 직접 읽어 답변합니다. 필요 시 KB 검색도 함께.
            </span>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`doc-focused-msg doc-focused-msg-${m.role}`}
            data-testid={`doc-focused-msg-${m.role}`}
          >
            {m.content || (streaming && m.role === 'assistant' ? <span className="dots" /> : null)}
          </div>
        ))}
      </div>

      <div className="doc-focused-input-row">
        <textarea
          className="doc-focused-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="질문을 입력하세요. Enter 로 전송, Shift+Enter 로 줄바꿈."
          disabled={streaming}
          rows={2}
          data-testid="doc-focused-input"
        />
        <button
          type="button"
          className="doc-focused-send"
          onClick={() => void onSend()}
          disabled={streaming || !input.trim()}
          data-testid="doc-focused-send"
        >
          {streaming ? '…' : '전송'}
        </button>
      </div>
    </div>
  );
}
