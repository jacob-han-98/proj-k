import { useEffect, useMemo, useRef, useState } from 'react';
import { askStream, getPresetPrompts, searchDocs, setDocContext, type PresetPrompt } from '../../api';
import { annotateCitedHits } from '../../citations';
// citations.splitAnswerWithCitations 는 Phase C 부터 미사용 — RenderAssistantMarkdown 이 대체.
// Phase J: SourceModal (centered modal) → SourceViewPanel (right split). 우측 패널 형태로
// 본문 전체 + section_range 하이라이트 + Esc 닫기.
// Phase K: 출처 클릭 시 우선 새 탭 (Confluence/xlsx/datasheet) 시도, 매칭 안 되면
// SourceViewPanel 로 fallback.
import { SourceViewPanel, useSourceView } from '../../qna/SourceViewPanel';
import { specForSource } from '../../qna/openSource';
import {
  readFollowUps,
  readResultData,
  readSources,
  readStatus,
  readThinking,
  readToken,
  readToolEnd,
  readToolStart,
  type StreamEvent,
} from '../../stream-events';
import type { SearchHit, ThreadDocRef } from '../../../shared/types';
import { useWorkbenchStore } from '../store';
import { AttachmentChips } from '../../qna/AttachmentChips';
import { buildAttachmentPrompt, type QnAAttachment } from '../../qna/attachments';
import { QnAWelcome } from '../../qna/Welcome';
import {
  FollowUpCards,
  ProgressTimeline,
  RenderAssistantMarkdown,
  RenderSourceCards,
  type ProgressEvent,
  type QnASource,
} from '../../qna/render';

// Phase J: 옛 CitationTarget (modal 용) 제거 — useSourceView 훅이 path/section 직접 받음.

// PR6: 사이드바 "+ 새" 가 만든 default 제목. 사용자가 직접 rename 하기 전엔 이 값이라
// QnATab 의 첫 메시지가 도착하면 자동으로 그 메시지 30자로 갈아낀다.
const DEFAULT_THREAD_TITLE = '새 스레드';

// 빈 첨부 array 는 컴포넌트 외부에 한 번 정의 — zustand selector 가 매 render 마다
// 새 array 를 만들면 useEffect dep 비교가 동등성을 잃어 무한 루프 가능. 같은 ref 로 안정.
const EMPTY_ATTACHMENTS: readonly QnAAttachment[] = Object.freeze([]);

// PR5: editor 영역의 QnA 대화 탭. PR4까지 우측 360px ChatPanel 이 하던 일을 여기로 이전.
// review/changes 는 ReviewSplitPane (PR4) 으로 이미 이전됨. 자동 thread 생성도 제거 —
// QnATab 은 항상 threadId 가 결정된 채 mount 된다 (사이드바 ThreadList 의 + 새 / row 클릭이
// store.openTab(qna-thread) 를 호출).

interface Message {
  role: 'user' | 'assistant';
  content: string;
  // Phase C: assistant 메시지의 출처 / 후속질문. backend result 이벤트에서 도착.
  // sources 는 인라인 출처 클릭 시 origin_label 매칭으로 정확한 path 매핑에 사용.
  // followUps 는 마지막 assistant 메시지에만 FollowUpCards 로 노출.
  sources?: QnASource[];
  followUps?: string[];
  // Phase E: 진행 내역 (status / thinking / tool calls). streaming 끝나면 collapse 가
  // default — 사용자가 "✅ 진행 내역 펼치기" 클릭 시 표시. 영속 X (메모리만), thread
  // 다시 mount 하면 안 보임.
  progressEvents?: ProgressEvent[];
  progressExpanded?: boolean;
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

// Phase G: 옛 PresetChips / categoryLabel 제거 — Welcome.tsx 의 카드 그리드가 대체.
// 새 디자인은 카테고리 라벨을 헤더로 분리하지 않고, 카드 자체에 아이콘 prefix (📊/📋/🔵)
// 로 카테고리 신호 표현. agent-sdk-poc 웹 (사용자 스크린샷) 과 동일 패턴.

export function QnATab({ threadId, onMessagesChanged, onOpenHit, onOpenDoc }: Props) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [docs, setDocs] = useState<ThreadDocRef[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searchTookMs, setSearchTookMs] = useState<number | null>(null);
  // PR6: 자동 rename 가능 여부 판단용. mount 시 fetch 결과의 thread.title 을 들고 있다가
  // 첫 메시지 시 default 면 q.slice(0,30) 으로 자동 갈아낀다.
  const [threadTitle, setThreadTitle] = useState<string>('');
  // A3-a: agent 의 큐레이션된 추천 prompt — empty 화면의 진입 장벽 제거. messages.length===0
  // 일 때만 노출. 클릭 시 input 자동 채움 (사용자가 추가 편집 후 보낼 수 있게 send 자동 X).
  const [presets, setPresets] = useState<PresetPrompt[]>([]);
  // Phase J: 출처 클릭 → 우측 split panel 로 본문 표시. useSourceView 훅이 fetch/loading/
  // err/Esc 모두 관리. open(path, section) 호출 시 panel 열림 + backend 호출.
  const sourceView = useSourceView();
  // Phase F: 입력창 옆 토글 — 모델 선택 / Deep Research / 정지 버튼.
  // localStorage 영속 — 사용자 선호 보존 (다음 thread 도 같은 default).
  const [model, setModel] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return 'opus';
    return localStorage.getItem('klaud.qna.model') ?? 'opus';
  });
  const [compareMode, setCompareMode] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('klaud.qna.compareMode') === 'true';
  });
  const abortRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    try { localStorage.setItem('klaud.qna.model', model); } catch { /* quota */ }
  }, [model]);
  useEffect(() => {
    try { localStorage.setItem('klaud.qna.compareMode', String(compareMode)); } catch { /* quota */ }
  }, [compareMode]);

  // Phase A1: 이 thread 의 미발송 첨부. 진입점 2/3 (Phase A2/A3) 가 store.attachToQnA 로
  // push 해두고, 사용자가 qna 액티비티로 와서 첫 메시지 보낼 때 prepend 후 clear.
  const pendingAttachments = useWorkbenchStore(
    (s) => s.qnaPendingAttachments[threadId] ?? EMPTY_ATTACHMENTS,
  );
  const detachFromQnA = useWorkbenchStore((s) => s.detachFromQnA);
  const clearPendingAttachments = useWorkbenchStore((s) => s.clearPendingAttachments);

  // backend 의 conversation 단위 컨텍스트를 thread 와 1:1 로 묶음. 같은 thread 의 모든
  // turn 이 같은 conversation_id 로 askStream → backend 가 그 conv 의 turns 누적해 답변.
  // thread DB (frontend SQLite) 와 conversation (backend) 이 이중 영속이지만 thread 가
  // truth, conversation 은 backend 가 인용 대상으로 활용.
  const conversationId = `klaud-thread-${threadId}`;

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
        setThreadTitle(bundle.thread.title || '');
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

  // A3-a: 첫 mount 시 1회 fetch — 옛 messages 가 없는 thread 에서만 chips 노출되니
  // mount 시 한 번 받아두고 messages 비어있는 동안 노출.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getPresetPrompts();
        if (!cancelled) setPresets(list);
      } catch { /* 무시 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const annotatedHits = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return hits.map((h) => ({ ...h, cited: false }));
    return annotateCitedHits(lastAssistant.content, hits);
  }, [hits, messages]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;

    // PR6: 첫 메시지 + thread title 이 default 인 경우 자동 rename. 사용자가 직접 rename 한
    // thread (예: "이번주 회의") 는 건드리지 않는다.
    const shouldAutoRename =
      messages.length === 0 && (threadTitle === DEFAULT_THREAD_TITLE || threadTitle === '');
    if (shouldAutoRename) {
      const newTitle = q.slice(0, 30);
      try {
        await window.projk.threads.rename({ id: threadId, title: newTitle });
        setThreadTitle(newTitle);
        // 탭바에 표시되는 title 도 갱신 — store.openTab 은 같은 ID 면 title 만 바꾼다 (PR3).
        useWorkbenchStore.getState().openTab({
          kind: 'qna-thread',
          threadId,
          title: newTitle,
        });
      } catch (e) {
        console.warn('thread rename 실패', e);
      }
    }

    setBusy(true);
    setInput('');
    setHits([]);
    setSearchTookMs(null);

    // Phase A1: 첫 메시지에 한해 pendingAttachments 를 system prefix 로 변환해 question
    // 앞에 prepend. 두 번째 메시지부터는 backend conversation 이 컨텍스트를 유지하므로
    // 다시 보내지 않는다. UI 의 사용자 turn 은 q 그대로 표시 (사용자가 친 그대로) — backend
    // 로 보내는 것만 prepend 된 형태.
    const isFirstMessage = messages.length === 0;
    const attachmentsToConsume: readonly QnAAttachment[] = isFirstMessage
      ? pendingAttachments
      : EMPTY_ATTACHMENTS;
    const prefix = buildAttachmentPrompt(attachmentsToConsume);
    const questionForBackend = prefix ? `${prefix}\n${q}` : q;

    setMessages((m) => [...m, { role: 'user', content: q }]);

    // user 영속 — attachments meta 도 함께 (추후 분석/감사용). 본문은 사용자가 본 그대로.
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

    // Phase A2: 첨부 중 doc kind 이고 본문(text) 있으면 backend 에 stash. 진입점 2 (문서
    // → qna) 의 dispatch 가 본문을 한 번 추출해 attachment.ref.text 에 담아둔 형태.
    // backend 의 read_current_doc tool 이 이 stash 를 lazy 인용 — prompt prefix 에 본문
    // 통째로 박는 것보다 토큰 효율적. 첫 doc 첨부만 stash (현 backend setDocContext 가
    // single doc API). multi-doc 지원은 향후 backend 변경 후.
    const docAttWithText = attachmentsToConsume.find(
      (a): a is Extract<QnAAttachment, { kind: 'doc' }> => a.kind === 'doc' && !!a.ref.text,
    );
    if (docAttWithText) {
      try {
        await setDocContext(conversationId, {
          title: docAttWithText.title,
          page_id: docAttWithText.ref.pageId,
          doc_type: docAttWithText.ref.type,
          content: docAttWithText.ref.text!,
        });
      } catch (e) {
        // backend 미가용 시 stash 실패 — UI 안 멈춤. 이후 askStream 에 prefix 만으로 진행.
        console.warn('setDocContext 실패 (계속 진행)', e);
      }
    }

    // 첨부 consume — 다음 mount 때 다시 보이지 않게 store 에서 제거. 첫 메시지 보낸
    // 시점이 적절한 cutoff (사용자가 ✕ 눌러 떼는 거 외엔 자동으로 떼지 않음).
    if (attachmentsToConsume.length > 0) {
      clearPendingAttachments(threadId);
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

    // ask stream — backend 로 보내는 question 은 첨부 prefix 가 prepend 된 형태.
    // conversation_id 도입으로 backend 가 thread 단위 turn 을 누적해 컨텍스트 유지.
    let assembled = '';
    // Phase E: 새 assistant message 가 자기 progress 를 들고 있도록 빈 events 로 시작.
    // streaming 중에는 자동 expanded — 끝나면 user 가 다시 펼칠 때까지 collapse.
    setMessages((m) => [...m, { role: 'assistant', content: '', progressEvents: [], progressExpanded: false }]);
    const appendProgress = (ev: ProgressEvent) => {
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.role !== 'assistant') return m;
        copy[copy.length - 1] = {
          ...last,
          progressEvents: [...(last.progressEvents ?? []), ev],
        };
        return copy;
      });
    };
    const updateLastTool = (id: string, summary: string) => {
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.role !== 'assistant' || !last.progressEvents) return m;
        copy[copy.length - 1] = {
          ...last,
          progressEvents: last.progressEvents.map((e) =>
            e.kind === 'tool' && e.id === id ? { ...e, summary, ended: true } : e,
          ),
        };
        return copy;
      });
    };
    try {
      // Phase F: 새 AbortController — 사용자가 ⏹ 클릭 시 fetch cancel.
      const ac = new AbortController();
      abortRef.current = ac;
      await askStream(
        questionForBackend,
        (event) => {
          const e = event as unknown as StreamEvent;
          // DEBUG (2026-05-06): 사용자 보고 — 진행 내역 비어있음. backend 가 보내는데
          // 도달 안 하는지, 또는 처리 안 되는지 한눈에 보이게 console 로그. F12 Console 확인.
          // 안정 후 제거.
          // eslint-disable-next-line no-console
          console.log('[qna-event]', e.type, e);
          if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) {
              assembled += tok;
              setMessages((m) => {
                const copy = [...m];
                const last = copy[copy.length - 1];
                // BUGFIX (2026-05-06): spread 로 progressEvents / sources / followUps 보존.
                // 옛 코드는 매 token 마다 last 를 통째 갈아끼워서 progressEvents 가 누적
                // 도중 날아가고, result 도착 시점에 last.progressEvents 가 빈 상태였음.
                copy[copy.length - 1] = { ...last, role: 'assistant', content: assembled };
                return copy;
              });
            }
          } else if (e.type === 'status') {
            const s = readStatus(e);
            if (s) appendProgress({ kind: 'status', text: s });
          } else if (e.type === 'thinking') {
            const t = readThinking(e);
            if (t) appendProgress({ kind: 'thinking', text: t });
          } else if (e.type === 'tool_start') {
            const ts = readToolStart(e);
            if (ts) appendProgress({ kind: 'tool', id: ts.id, label: ts.label, ended: false });
          } else if (e.type === 'tool_end') {
            const te = readToolEnd(e);
            if (te) updateLastTool(te.id, te.summary);
          } else if (e.type === 'result') {
            // result 도착 — 최종 answer + sources + follow_ups 메시지에 영속.
            // progressEvents 는 spread (...last) 로 보존 — 사용자가 결론 확인 후 진행 내역
            // 펼치기로 어떤 도구를 몇 번 호출했는지 다시 볼 수 있게.
            const data = readResultData(e);
            const ans = data && typeof data.answer === 'string' ? data.answer : null;
            const sources = readSources(data) as QnASource[];
            const followUps = readFollowUps(data);
            if (ans) {
              assembled = ans;
            }
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = {
                ...last,
                role: 'assistant',
                content: assembled,
                sources: sources.length > 0 ? sources : undefined,
                followUps: followUps.length > 0 ? followUps : undefined,
                progressExpanded: false, // streaming 끝 → 자동 collapse, 토글로 펼침 가능.
              };
              return copy;
            });
          }
        },
        conversationId,
        { model, compareMode, signal: ac.signal },
      );
    } catch (e) {
      // AbortError — 사용자가 정지 버튼 누른 케이스. 오류 message 대신 "(중단됨)" 마커.
      if (e instanceof DOMException && e.name === 'AbortError') {
        assembled = assembled || '(사용자가 중단)';
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, role: 'assistant', content: assembled };
          return copy;
        });
        // finally 가 abortRef 정리.
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      assembled = `[오류] ${msg}`;
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, role: 'assistant', content: assembled };
        return copy;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
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
      {/* Phase J: 가운데 컬럼 (docs / hits / messages / input) + 우측 split panel
          (SourceViewPanel, sourceView 열려있을 때만). chat-main 이 flex 1 차지. */}
      <div className="chat-main">
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
        {/* Phase G: 빈 thread welcome 화면 — 큰 타이틀 + 부제 + preset 카드 그리드.
            agent-sdk-poc 웹 (사용자 스크린샷) 과 동등한 look&feel. */}
        {messages.length === 0 && (
          <QnAWelcome
            presets={presets}
            onPick={(p) => {
              setInput(p.prompt);
              if (p.compare_mode) setCompareMode(true);
              setTimeout(() => taRef.current?.focus(), 0);
            }}
          />
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const isStreaming = m.role === 'assistant' && isLast && busy;
          const isLastAssistant = m.role === 'assistant' && isLast && !busy;
          return (
            <div key={i} className={`msg ${m.role}`} data-testid={`msg-${m.role}-${i}`}>
              {/* Phase E + 2026-05-06 fix: assistant 메시지면 항상 토글 노출. backend 가
                  progress 이벤트를 한 개도 안 흘리는 케이스에서도 "진행 내역 없음" 라벨을
                  보여 사용자가 사라진 것으로 오해하지 않게. */}
              {m.role === 'assistant' && (
                <ProgressTimeline
                  events={m.progressEvents ?? []}
                  expanded={!!m.progressExpanded}
                  streaming={isStreaming}
                  onToggle={() => {
                    setMessages((cur) => {
                      const copy = [...cur];
                      const target = copy[i];
                      if (!target || target.role !== 'assistant') return cur;
                      copy[i] = { ...target, progressExpanded: !target.progressExpanded };
                      return copy;
                    });
                  }}
                />
              )}
              {m.role === 'assistant' && m.content ? (
                <RenderAssistantMarkdown
                  content={m.content}
                  sources={m.sources}
                  onOpenSource={(path, section) => {
                    // Phase K: 인라인 출처 클릭 — sources list 에서 path/origin_label 매칭
                    // 후 source 객체로 dispatch. 매칭 실패면 우측 panel.
                    const matched =
                      m.sources?.find((s) => s.path === path) ??
                      m.sources?.find((s) => (s.origin_label ?? '').trim() === path.trim());
                    if (matched) {
                      const spec = specForSource(matched);
                      if (spec) {
                        useWorkbenchStore.getState().openTab(spec);
                        return;
                      }
                    }
                    sourceView.open(path, section);
                  }}
                />
              ) : (
                m.content || '…'
              )}
              {/* Phase D: assistant 메시지의 출처 카드 그룹 (PK / 타게임 / 웹). 본문 끝에.
                  Phase K: 카드 클릭 → 새 탭 (Confluence/xlsx/datasheet 매칭 시) 또는 우측 panel. */}
              {m.role === 'assistant' && m.sources && (
                <RenderSourceCards
                  sources={m.sources}
                  onOpen={(source, section) => {
                    const spec = specForSource(source);
                    if (spec) {
                      useWorkbenchStore.getState().openTab(spec);
                      return;
                    }
                    sourceView.open(source.path ?? source.origin_label ?? '', section);
                  }}
                />
              )}
              {/* Phase C: 마지막 assistant 메시지 + 답변 완료 시 follow-ups. busy 중엔 숨김. */}
              {isLastAssistant && m.followUps && (
                <FollowUpCards
                  followUps={m.followUps}
                  onPick={(q) => {
                    setInput(q);
                    setTimeout(() => taRef.current?.focus(), 0);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Phase G: 옛 PresetChips (입력창 위 한 줄 wrap) 제거 — Welcome 의 카드 그리드가 대체. */}

      {/* Phase G: 입력창 박스 통합 — 라운드 카드 안에 attachments + textarea + 옵션 라인.
          agent-sdk-poc 웹 (사용자 스크린샷) 의 입력 박스 패턴 동일. 보내기는 ↑ 화살표 형태. */}
      <div className="qna-input-box" data-testid="qna-input-box">
        <AttachmentChips
          attachments={pendingAttachments}
          onDetach={(id) => detachFromQnA(threadId, id)}
        />
        <textarea
          ref={taRef}
          className="qna-input-ta"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            pendingAttachments.length > 0
              ? '첨부 컨텍스트에 대해 질문하세요... (Ctrl+Enter로 전송)'
              : '기획 질문을 입력하세요... (Ctrl+Enter로 전송)'
          }
          data-testid="chat-input"
        />
        <div className="qna-input-bottom">
          <select
            className="qna-model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            data-testid="qna-model-select"
            title="응답 생성 모델"
          >
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
          <label
            className={`qna-compare-toggle${compareMode ? ' on' : ''}`}
            title="Deep Research — oracle 큐레이트 타게임 + WebSearch fallback"
            data-testid="qna-compare-toggle"
          >
            <input
              type="checkbox"
              checked={compareMode}
              onChange={(e) => setCompareMode(e.target.checked)}
              disabled={busy}
            />
            <span>🌟 Deep Research</span>
          </label>
          <span className="qna-input-spacer" aria-hidden="true" />
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              data-testid="chat-stop"
              title="응답 정지"
              className="qna-input-send qna-input-stop"
              aria-label="정지"
            >
              ⏹
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              data-testid="chat-send"
              className="qna-input-send"
              aria-label="보내기"
              disabled={!input.trim()}
            >
              ↑
            </button>
          )}
        </div>
      </div>

      </div>
      <SourceViewPanel
        sourceView={sourceView.sourceView}
        loading={sourceView.loading}
        err={sourceView.err}
        onClose={sourceView.close}
      />
    </aside>
  );
}

// Phase E: 옛 ProgressLine 은 ProgressTimeline 으로 대체. 이 자리는 비어있음.
