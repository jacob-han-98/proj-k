import { useEffect, useMemo, useRef, useState } from 'react';
import { askStream, getPresetPrompts, searchDocs, setDocContext, type PresetPrompt } from '../../api';
import { annotateCitedHits } from '../../citations';
// citations.splitAnswerWithCitations 는 Phase C 부터 미사용 — RenderAssistantMarkdown 이 대체.
import { SourceModal } from '../../panels/SourceModal';
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
import {
  FollowUpCards,
  RenderAssistantMarkdown,
  RenderSourceCards,
  type QnASource,
} from '../../qna/render';

// A3-b: 답변 안 (출처: ...) 클릭 → modal. 클릭 시 selectedCitation 으로 modal 띄움.
interface CitationTarget {
  raw: string;
  path: string;
  section: string;
}

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
}

// Phase C: streaming 중 진행 상태. status/thinking/tool 이벤트 누적.
// streaming 끝나면 reset. 사용자가 "동작 중인지" 즉시 인지 — 빈 화면 / 무반응 방지.
interface Progress {
  status: string | null;
  thinkingPreview: string | null;
  activeTools: { id: string; label: string }[];
}
const EMPTY_PROGRESS: Progress = { status: null, thinkingPreview: null, activeTools: [] };

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

// A3-a: agent 의 큐레이션된 추천 prompt — 카테고리별로 grouping 후 chips. 사용자가 빈
// 화면에서 "뭐부터 물어볼지" 가 어려운 진입 장벽을 제거. 클릭 → input 채움 (자동 send X
// — 사용자가 추가 편집 가능).
function PresetChips({
  presets,
  onPick,
}: {
  presets: PresetPrompt[];
  onPick: (p: PresetPrompt) => void;
}) {
  // category 별 grouping. 정의된 순서 보존 (agent 의 PRESETS 정렬 의도 유지).
  const grouped = useMemo(() => {
    const order: string[] = [];
    const map: Record<string, PresetPrompt[]> = {};
    for (const p of presets) {
      const cat = p.category ?? '기타';
      if (!(cat in map)) {
        order.push(cat);
        map[cat] = [];
      }
      map[cat]!.push(p);
    }
    return order.map((cat) => ({ cat, items: map[cat]! }));
  }, [presets]);

  return (
    <div className="preset-chips" data-testid="preset-chips">
      <div className="preset-chips-hint">💡 추천 질문 — 클릭해서 시작하세요</div>
      {grouped.map(({ cat, items }) => (
        <div key={cat} className="preset-chips-group">
          <div className="preset-chips-cat" data-testid={`preset-cat-${cat}`}>{categoryLabel(cat)}</div>
          <div className="preset-chips-row">
            {items.map((p, i) => (
              <button
                key={`${cat}-${i}`}
                type="button"
                className="preset-chip"
                onClick={() => onPick(p)}
                title={p.prompt}
                data-testid={`preset-chip-${cat}-${i}`}
              >{p.label}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function categoryLabel(cat: string): string {
  // agent PRESETS 가 쓰는 category 키 → 한글 라벨. 모르는 키는 그대로.
  const map: Record<string, string> = {
    system: '시스템',
    spec: '수치·공식',
    cross: '크로스 시스템',
    content: '컨텐츠',
    overview: '개요',
    datasheet: '데이터시트',
    other: '기타',
  };
  return map[cat] ?? cat;
}

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
  // A3-b: citation 클릭 → /source_view modal. null 이면 닫힘.
  const [selectedCitation, setSelectedCitation] = useState<CitationTarget | null>(null);
  // Phase C: streaming 중 progress. send() 마다 reset, streaming 끝나면 cleared.
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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
    setProgress(EMPTY_PROGRESS); // 새 send 시작 — 옛 progress 클리어.

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
    setMessages((m) => [...m, { role: 'assistant', content: '' }]);
    try {
      await askStream(
        questionForBackend,
        (event) => {
          const e = event as unknown as StreamEvent;
          if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) {
              assembled += tok;
              setMessages((m) => {
                const copy = [...m];
                copy[copy.length - 1] = { role: 'assistant', content: assembled };
                return copy;
              });
            }
          } else if (e.type === 'status') {
            // Phase C: 진행 라벨 — Progress 라인의 메인. "📨 분석 중..." 등.
            const s = readStatus(e);
            if (s) setProgress((p) => ({ ...p, status: s }));
          } else if (e.type === 'thinking') {
            // 모델 reasoning preview. 60자만 잘라 progress 의 보조 라벨로.
            const t = readThinking(e);
            if (t) setProgress((p) => ({ ...p, thinkingPreview: t.slice(0, 60) }));
          } else if (e.type === 'tool_start') {
            const ts = readToolStart(e);
            if (ts) {
              setProgress((p) => ({
                ...p,
                activeTools: [...p.activeTools, { id: ts.id, label: ts.label }],
              }));
            }
          } else if (e.type === 'tool_end') {
            const te = readToolEnd(e);
            if (te) {
              setProgress((p) => ({
                ...p,
                activeTools: p.activeTools.filter((t) => t.id !== te.id),
              }));
            }
          } else if (e.type === 'result') {
            // result 도착 — 최종 answer + sources + follow_ups 메시지에 영속.
            const data = readResultData(e);
            const ans = data && typeof data.answer === 'string' ? data.answer : null;
            const sources = readSources(data) as QnASource[];
            const followUps = readFollowUps(data);
            if (ans) {
              assembled = ans;
            }
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = {
                role: 'assistant',
                content: assembled,
                sources: sources.length > 0 ? sources : undefined,
                followUps: followUps.length > 0 ? followUps : undefined,
              };
              return copy;
            });
          }
        },
        conversationId,
      );
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
      setProgress(EMPTY_PROGRESS); // streaming 끝 — progress 클리어. 다음 send 까지 빈 상태.
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
        {messages.map((m, i) => {
          const isLastAssistant =
            m.role === 'assistant' && i === messages.length - 1 && !busy;
          return (
            <div key={i} className={`msg ${m.role}`} data-testid={`msg-${m.role}-${i}`}>
              {m.role === 'assistant' && m.content ? (
                <RenderAssistantMarkdown
                  content={m.content}
                  sources={m.sources}
                  onOpenSource={(path, section) => {
                    // 인라인 출처 클릭 — SourceModal 열기. raw 라벨은 path § section 형태로 재조립.
                    const raw = section ? `${path} § ${section}` : path;
                    setSelectedCitation({ raw, path, section });
                  }}
                />
              ) : (
                m.content || '…'
              )}
              {/* Phase D: assistant 메시지의 출처 카드 그룹 (PK / 타게임 / 웹). 본문 끝에. */}
              {m.role === 'assistant' && m.sources && (
                <RenderSourceCards
                  sources={m.sources}
                  onOpen={(path, section) => {
                    const raw = section ? `${path} § ${section}` : path;
                    setSelectedCitation({ raw, path, section });
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
        {/* Phase C: streaming 중 progress 라인 — 메시지 영역 끝에 sticky 로 보여줌. */}
        {busy && (progress.status || progress.thinkingPreview || progress.activeTools.length > 0) && (
          <ProgressLine progress={progress} />
        )}
      </div>

      {messages.length === 0 && presets.length > 0 && (
        <PresetChips
          presets={presets}
          onPick={(p) => {
            setInput(p.prompt);
            // textarea focus — 사용자가 즉시 편집 또는 Enter 가능.
            setTimeout(() => taRef.current?.focus(), 0);
          }}
        />
      )}

      <AttachmentChips
        attachments={pendingAttachments}
        onDetach={(id) => detachFromQnA(threadId, id)}
      />

      <div className="input-row">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            pendingAttachments.length > 0
              ? '첨부 컨텍스트에 대해 질문하세요 (Ctrl+Enter)'
              : '질문을 입력하세요 (Ctrl+Enter)'
          }
          data-testid="chat-input"
        />
        <button onClick={() => void send()} disabled={busy} data-testid="chat-send">
          {busy ? '…' : '보내기'}
        </button>
      </div>

      {selectedCitation && (
        <SourceModal
          raw={selectedCitation.raw}
          path={selectedCitation.path}
          section={selectedCitation.section}
          onClose={() => setSelectedCitation(null)}
        />
      )}
    </aside>
  );
}

// Phase C: streaming progress 한 라인 — status 메인 라벨 + thinking 보조 라벨 + 활성 tool 칩.
function ProgressLine({ progress }: { progress: Progress }) {
  return (
    <div className="qna-progress" data-testid="qna-progress">
      <div className="qna-progress-main">
        <span className="dots" aria-hidden="true" />
        <span>{progress.status ?? '응답 생성 중'}</span>
        {progress.activeTools.map((t) => (
          <span key={t.id} className="qna-progress-tool" data-testid={`qna-progress-tool-${t.id}`}>
            🔧 {t.label}
          </span>
        ))}
      </div>
      {progress.thinkingPreview && (
        <div className="qna-progress-thinking" title={progress.thinkingPreview}>
          {progress.thinkingPreview}
        </div>
      )}
    </div>
  );
}
