import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'
import { askQuestionStream, fetchPresetPrompts, fetchSourceView, screenshotUrl } from './api'
import type { AskResponse, StreamEvent, PresetPrompt, SourceView } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import html2pdf from 'html2pdf.js'
// 단일 source of truth — App / SharedPage / AdminPage 가 모두 여기서 import.
// inline 으로 ExcelIcon / parseInlineSourceBody 등을 또 만들면 화면별 갈라짐 재발.
import { RenderAssistantMarkdown, RenderSourceCards } from './assistantRender'

// ── Theme ──
type ThemeMode = 'system' | 'light' | 'dark';

function getResolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

// 본문 전처리 / 인라인 출처 파서는 assistantRender 의 단일 구현 사용 (여기 inline 정의 두지 말 것).

// Mermaid component for rendering diagrams
const MermaidBlock = ({ code, theme }: { code: string; theme: 'light' | 'dark' }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark' })
    if (ref.current) {
      const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`
      mermaid.render(id, code)
        .then((res) => {
          if (ref.current) ref.current.innerHTML = res.svg;
        })
        .catch(err => {
          console.error('Mermaid render error:', err)
          if (ref.current) ref.current.innerHTML = `<pre>Error rendering diagram</pre>`;
        })
    }
  }, [code, theme])

  return <div ref={ref} className="mermaid-wrapper" />
}

interface ToolCallEntry {
  id: string;          // SDK tool_use id
  tool: string;        // "Grep" / "Read" / "mcp__projk__…"
  input: any;
  label: string;       // 진행 중 "🔎 `변신` 검색 중 …"
  doneLabel?: string;  // 완료 후 "🔎 `변신` 검색 …"
  summary?: string;    // "Found 1 file" 등
  preview?: string;    // 전체 결과 일부 (상세 펼치기용)
}

interface Progress {
  thinking: string[];            // 누적 사고 (최신이 마지막)
  tools: ToolCallEntry[];        // 호출된 툴 목록 (시간순)
  lastStatus: string;            // 현재 진행 상태 (원시 message)
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: AskResponse['sources'];
  progress?: Progress;           // assistant 메시지 기준 실시간 진행 스냅샷
  qaWarnings?: string[];         // 서버 품질 체크 경고 (Confluence 미탐색 등)
  followUps?: string[];          // 후속 질문 제안 (3~5)
  compareMode?: boolean;         // 이 턴이 비교 모드로 실행됨 (badge 표기용)
}

interface Thread {
  id: string;
  title: string;
  messages: Message[];
}

function App() {
  const [input, setInput] = useState('')
  const [threads, setThreads] = useState<Thread[]>(() => {
    const saved = sessionStorage.getItem('qna-threads')
    if (saved) {
      try { return JSON.parse(saved) } catch(e) {}
    }
    return []
  })
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>()
  const [loadingThreads, setLoadingThreads] = useState<Set<string>>(new Set())
  const [threadStatuses, setThreadStatuses] = useState<Record<string, string>>({})
  const [threadProgress, setThreadProgress] = useState<Record<string, Progress>>({})
  const threadProgressRef = useRef<Record<string, Progress>>({})
  useEffect(() => { threadProgressRef.current = threadProgress }, [threadProgress])
  const abortControllers = useRef<Record<string, AbortController>>({})
  const [model, setModel] = useState<'opus' | 'sonnet'>(() => {
    return (localStorage.getItem('projk-model') as 'opus' | 'sonnet') || 'opus'
  })
  useEffect(() => { localStorage.setItem('projk-model', model) }, [model])
  const [compareMode, setCompareMode] = useState<boolean>(() => {
    return localStorage.getItem('projk-compare-mode') === '1'
  })
  useEffect(() => { localStorage.setItem('projk-compare-mode', compareMode ? '1' : '0') }, [compareMode])
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem('qna-theme') as ThemeMode) || 'system'
  })
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => getResolvedTheme(
    (localStorage.getItem('qna-theme') as ThemeMode) || 'system'
  ))

  const [presets, setPresets] = useState<PresetPrompt[]>([])
  const [sourceView, setSourceView] = useState<SourceView | null>(null)
  const [sourceViewLoading, setSourceViewLoading] = useState(false)
  const [sourceViewError, setSourceViewError] = useState<string | null>(null)
  const [screenshotState, setScreenshotState] = useState<{ url: string; label: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sourceHighlightRef = useRef<HTMLDivElement>(null)

  // 우측 패널 로드 완료 후 section 하이라이트가 있으면 해당 위치로 자동 스크롤.
  useEffect(() => {
    if (!sourceView || !sourceView.section_range) return
    let alive = true
    const tryScroll = () => {
      if (!alive) return
      sourceHighlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const id1 = requestAnimationFrame(() => requestAnimationFrame(tryScroll))
    const backup = setTimeout(tryScroll, 350)
    return () => { alive = false; cancelAnimationFrame(id1); clearTimeout(backup) }
  }, [sourceView?.path, sourceView?.section, sourceView?.section_range?.start_line])

  const openSourceView = useCallback(async (path: string, section: string) => {
    setSourceViewLoading(true)
    setSourceViewError(null)
    try {
      const v = await fetchSourceView(path, section)
      setSourceView(v)
    } catch (e: any) {
      setSourceViewError(e?.message || String(e))
    } finally {
      setSourceViewLoading(false)
    }
  }, [])
  const closeSourceView = useCallback(() => {
    setSourceView(null); setSourceViewError(null)
  }, [])
  const closeScreenshot = useCallback(() => setScreenshotState(null), [])
  // ESC 로 모달/패널 닫기 — 모달 우선
  useEffect(() => {
    if (!sourceView && !sourceViewLoading && !sourceViewError && !screenshotState) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (screenshotState) { closeScreenshot(); return }
      closeSourceView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sourceView, sourceViewLoading, sourceViewError, screenshotState, closeScreenshot, closeSourceView])

  // openInlineSource(body, sources) 정규화는 assistantRender.openInlineSourceFromBody 가 처리.
  // App.tsx 는 RenderAssistantMarkdown 의 onOpenSource 에 openSourceView 만 넘기면 됨.

  useEffect(() => {
    fetchPresetPrompts()
      .then(d => setPresets(d.presets))
      .catch(e => console.error('preset fetch failed:', e))
  }, [])

  // Theme: apply on mount and when changed
  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode)
    localStorage.setItem('qna-theme', mode)
    applyTheme(mode)
    setResolvedTheme(getResolvedTheme(mode))
  }, [])

  useEffect(() => {
    applyTheme(themeMode)
    // OS 테마 변경 감지 (system 모드일 때)
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => {
      if (themeMode === 'system') {
        setResolvedTheme(getResolvedTheme('system'))
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [themeMode])

  // Save threads to session storage whenever they change (탭별 격리)
  useEffect(() => {
    sessionStorage.setItem('qna-threads', JSON.stringify(threads))
  }, [threads])

  const activeThread = threads.find(t => t.id === activeThreadId)
  const messages = activeThread ? activeThread.messages : []
  const isCurrentLoading = activeThreadId ? loadingThreads.has(activeThreadId) : false
  const activeStatus = activeThreadId ? (threadStatuses[activeThreadId] || '') : ''
  const activeProgress = activeThreadId ? threadProgress[activeThreadId] : undefined

  // 마지막 user 메시지를 화면 상단에 정렬 — 질문과 답변을 함께 보기 좋게.
  const scrollLastUserToTop = useCallback(() => {
    const els = document.querySelectorAll('.message-wrapper.user')
    const last = els[els.length - 1] as HTMLElement | undefined
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // (1) 새 user 메시지가 추가되면(방금 질문 보낸 시점) 상단 정렬
  const lastMsgRoleRef = useRef<'user' | 'assistant' | undefined>(undefined)
  const lastMsgLenRef = useRef<number>(0)
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    const grew = messages.length > lastMsgLenRef.current
    if (grew && lastMsg?.role === 'user') {
      setTimeout(scrollLastUserToTop, 60)
    }
    lastMsgLenRef.current = messages.length
    lastMsgRoleRef.current = lastMsg?.role
  }, [messages, scrollLastUserToTop])

  // (2) 답변이 방금 완료됐을 때 다시 한 번 정렬 (진행 타임라인 접힘 등으로 높이 재계산됨)
  const prevLoadingRef = useRef(false)
  useEffect(() => {
    if (prevLoadingRef.current && !isCurrentLoading) {
      setTimeout(scrollLastUserToTop, 120)
    }
    prevLoadingRef.current = isCurrentLoading
  }, [isCurrentLoading, scrollLastUserToTop])

  // 초기 랜딩 시 자동 포커스 + fork 대화 로드
  useEffect(() => {
    inputRef.current?.focus()

    // Admin에서 Fork한 대화가 있으면 로드
    const forkRaw = sessionStorage.getItem('fork-conv')
    if (forkRaw) {
      sessionStorage.removeItem('fork-conv')
      try {
        const fork = JSON.parse(forkRaw)
        const messages: Message[] = fork.turns.flatMap((t: any) => [
          { role: 'user' as const, content: t.question },
          {
            role: 'assistant' as const,
            content: t.answer,
            sources: t.sources,
            qaWarnings: t.qa_warnings || [],
            followUps: t.follow_ups || [],
            // tool_trace 는 실시간 SSE 용 ToolCallEntry 스키마와 달라
            // progress 로 변환 시 id/label 매핑이 복잡해 생략 (Admin/Shared 에서 보존).
          },
        ])
        const newThread: Thread = {
          id: fork.id,
          title: `(fork) ${fork.title}`,
          messages,
        }
        setThreads(prev => [newThread, ...prev])
        setActiveThreadId(fork.id)
      } catch (e) { /* ignore */ }
    }
  }, [])

  const handleNewChat = () => {
    setActiveThreadId(undefined)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleSelectThread = (id: string) => {
    setActiveThreadId(id)
  }

  const handleDeleteThread = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const newThreads = threads.filter(t => t.id !== id)
    setThreads(newThreads)
    if (activeThreadId === id) {
      setActiveThreadId(undefined)
    }
  }

  const handleSend = async (override?: string) => {
    const src = (override ?? input).trim();
    if (!src) return;
    // 현재 스레드가 로딩 중이면 차단 (다른 스레드는 OK)
    if (activeThreadId && loadingThreads.has(activeThreadId)) return;

    const userMsg = src;
    if (!override) setInput('');

    let currentThreadId = activeThreadId;

    // Create new thread if none is active
    if (!currentThreadId) {
      currentThreadId = Date.now().toString();
      const newThread: Thread = {
        id: currentThreadId,
        title: userMsg.slice(0, 20) + (userMsg.length > 20 ? '...' : ''),
        messages: [{ role: 'user', content: userMsg }]
      };
      setThreads(prev => [newThread, ...prev]);
      setActiveThreadId(currentThreadId);
    } else {
      setThreads(prev => prev.map(t =>
        t.id === currentThreadId
          ? { ...t, messages: [...t.messages, { role: 'user', content: userMsg }] }
          : t
      ));
    }

    // 이 스레드를 로딩 상태로 표시
    const threadId = currentThreadId;
    const ac = new AbortController();
    abortControllers.current[threadId] = ac;
    setLoadingThreads(prev => new Set(prev).add(threadId));

    // 진행 스냅샷 초기화
    setThreadProgress(prev => ({ ...prev, [threadId]: { thinking: [], tools: [], lastStatus: '' } }));

    try {
      await askQuestionStream(
        userMsg,
        (event: StreamEvent) => {
          if (event.type === 'status') {
            setThreadStatuses(prev => ({ ...prev, [threadId]: event.message }));
            setThreadProgress(prev => ({
              ...prev,
              [threadId]: { ...(prev[threadId] || { thinking: [], tools: [] }), lastStatus: event.message },
            }));
          } else if (event.type === 'thinking') {
            setThreadProgress(prev => {
              const cur = prev[threadId] || { thinking: [], tools: [], lastStatus: '' };
              return { ...prev, [threadId]: { ...cur, thinking: [...cur.thinking, event.text] } };
            });
          } else if (event.type === 'tool_start') {
            setThreadProgress(prev => {
              const cur = prev[threadId] || { thinking: [], tools: [], lastStatus: '' };
              return {
                ...prev,
                [threadId]: {
                  ...cur,
                  tools: [...cur.tools, { id: event.id, tool: event.tool, input: event.input, label: event.label }],
                },
              };
            });
          } else if (event.type === 'tool_end') {
            setThreadProgress(prev => {
              const cur = prev[threadId] || { thinking: [], tools: [], lastStatus: '' };
              return {
                ...prev,
                [threadId]: {
                  ...cur,
                  tools: cur.tools.map(t => t.id === event.id ? {
                    ...t,
                    summary: event.summary,
                    doneLabel: event.label || t.label.replace(/\s중\b/g, ''),
                    preview: event.preview,
                  } : t),
                },
              };
            });
          } else if (event.type === 'result') {
            const res = event.data;
            const realId = res.conversation_id || threadId;

            const finalProgress = (threadProgressRef.current[threadId]) || { thinking: [], tools: [], lastStatus: '' };
            setThreads(prev => prev.map(t => {
              if (t.id === threadId) {
                return {
                  ...t,
                  id: realId,
                  messages: [...t.messages, {
                    role: 'assistant',
                    content: res.answer,
                    sources: res.sources,
                    progress: finalProgress,
                    qaWarnings: res.qa_warnings || [],
                    followUps: res.follow_ups || [],
                    compareMode: !!res.compare_mode,
                  }]
                }
              }
              return t;
            }));
            setLoadingThreads(prev => {
              const next = new Set(prev);
              next.delete(threadId);
              return next;
            });
            setActiveThreadId(prev => prev === threadId ? realId : prev);
          } else if (event.type === 'error') {
            setThreads(prev => prev.map(t =>
              t.id === threadId
                ? { ...t, messages: [...t.messages, { role: 'assistant', content: `오류: ${event.message}` }] }
                : t
            ));
          }
        },
        model,
        undefined,
        threadId,
        ac.signal,
        undefined,
        compareMode,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setThreads(prev => prev.map(t =>
          t.id === threadId
            ? { ...t, messages: [...t.messages, { role: 'assistant', content: '(응답이 중단되었습니다)' }] }
            : t
        ));
      } else {
        console.error(error);
        setThreads(prev => prev.map(t =>
          t.id === threadId
            ? { ...t, messages: [...t.messages, { role: 'assistant', content: '오류가 발생했습니다. 서버가 실행 중인지 확인해주세요.' }] }
            : t
        ));
      }
    } finally {
      delete abortControllers.current[threadId];
      setLoadingThreads(prev => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
      setThreadStatuses(prev => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    }
  }

  const handleStop = () => {
    if (activeThreadId && abortControllers.current[activeThreadId]) {
      abortControllers.current[activeThreadId].abort();
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  // Icons (ExcelIcon/ConfluenceIcon/ExternalIcon/WebIcon) 는 assistantRender 단일 정의 사용.

  // ── PDF Export ──
  const [pdfExporting, setPdfExporting] = useState<string | null>(null) // 'all' | message index | null

  const exportToPdf = useCallback(async (element: HTMLElement, filename: string) => {
    const clone = element.cloneNode(true) as HTMLElement
    // Plain document style — white background, black text
    clone.style.cssText = `
      color: #1a1a1a; background: #fff; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; line-height: 1.6;
    `
    // Reset all inner elements: no glass, no shadows, plain colors
    clone.querySelectorAll<HTMLElement>('*').forEach(el => {
      if (el.closest('svg')) return
      el.style.background = 'transparent'
      el.style.backdropFilter = 'none'
      el.style.color = '#1a1a1a'
      el.style.borderColor = '#e2e8f0'
      el.style.boxShadow = 'none'
    })
    // Style user messages — light blue bubble
    clone.querySelectorAll<HTMLElement>('.message.user').forEach(el => {
      el.style.background = '#e8f0fe'
      el.style.borderRadius = '12px'
      el.style.padding = '12px 16px'
      el.style.border = 'none'
    })
    // Style assistant messages — light gray bubble
    clone.querySelectorAll<HTMLElement>('.message.assistant').forEach(el => {
      el.style.background = '#f8f9fa'
      el.style.borderRadius = '12px'
      el.style.padding = '12px 16px'
      el.style.border = 'none'
    })
    // Remove UI-only elements from PDF
    clone.querySelectorAll('.copy-msg-btn, .pdf-msg-btn, .proposal-cta, .pdf-export-bar').forEach(el => el.remove())

    const opt = {
      margin: [10, 10, 10, 10] as [number, number, number, number],
      filename,
      image: { type: 'jpeg' as const, quality: 0.85 },
      html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
    }

    await html2pdf().set(opt).from(clone).save()
  }, [])

  const handleExportConversation = useCallback(async () => {
    const chatContainer = document.querySelector('.chat-container') as HTMLElement
    if (!chatContainer) return
    setPdfExporting('all')
    try {
      const title = activeThread?.title || 'conversation'
      const safeTitle = title.replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 30)
      await exportToPdf(chatContainer, `${safeTitle}.pdf`)
    } finally {
      setPdfExporting(null)
    }
  }, [activeThread, exportToPdf])

  const handleExportMessage = useCallback(async (idx: number) => {
    const msgEls = document.querySelectorAll('.message-wrapper')
    const el = msgEls[idx] as HTMLElement
    if (!el) return
    setPdfExporting(String(idx))
    try {
      const role = messages[idx]?.role || 'message'
      const threadTitle = activeThread?.title || 'msg'
      const safeTitle = threadTitle.replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 20)
      await exportToPdf(el, `${safeTitle}_${role}_${idx + 1}.pdf`)
    } finally {
      setPdfExporting(null)
    }
  }, [messages, activeThread, exportToPdf])

  // 출처 카드 렌더는 assistantRender.RenderSourceCards 단일 구현 사용
  // (App / SharedPage / AdminPage 동일 — web/external 그룹 분리, 아이콘, 클릭 동작 일관)

  // ── 진행 타임라인 렌더 ──────────────────────────────────
  const renderProgress = (progress: Progress, opts: { collapsed?: boolean; loading?: boolean }) => {
    const { thinking, tools, lastStatus } = progress;
    if (thinking.length === 0 && tools.length === 0 && !lastStatus) return null;
    return (
      <details className="progress-panel" open={!opts.collapsed}>
        <summary className="progress-summary">
          {opts.loading ? (
            <>
              <span className="loading-spinner" />
              <span className="progress-head">{lastStatus || '처리 중...'}</span>
            </>
          ) : (
            <span className="progress-head">
              ✅ 진행 내역 펼치기 · 툴 {tools.length}회{thinking.length ? ` · 사고 ${thinking.length}` : ''}
            </span>
          )}
        </summary>
        <div className="progress-body">
          {tools.map((t, i) => {
            const displayLabel = t.doneLabel || t.label;
            const hasDetail = !!t.preview || !!t.input;
            // Read 툴이면 클릭 시 우측 패널 오픈. 내부 인덱스 파일은 제외.
            const readPath: string = (t.tool === 'Read' && t.input && typeof t.input.file_path === 'string')
              ? t.input.file_path : '';
            const isInternalIdx = /^index\/(MASTER_INDEX|TERM_INDEX)\.md$/.test(readPath);
            const canOpenInView = !!readPath && !isInternalIdx;
            return (
              <details key={t.id || i} className={`tool-entry ${t.summary ? 'tool-done' : 'tool-running'}`}>
                <summary>
                  {canOpenInView ? (
                    <button
                      className="tool-label-link"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openSourceView(readPath, ''); }}
                      title="우측 패널에서 열기"
                      type="button"
                    >{displayLabel}</button>
                  ) : (
                    <span className="tool-label">{displayLabel}</span>
                  )}
                  {t.summary && <span className="tool-summary">· {t.summary}</span>}
                  {!t.summary && <span className="loading-spinner inline-spinner" />}
                </summary>
                {hasDetail && (
                  <div className="tool-entry-body">
                    {t.input && (
                      <pre className="tool-input"><code>{JSON.stringify(t.input, null, 2)}</code></pre>
                    )}
                    {t.preview && (
                      <pre className="tool-preview"><code>{t.preview}</code></pre>
                    )}
                  </div>
                )}
              </details>
            );
          })}
          {thinking.length > 0 && (
            <details className="thinking-entry">
              <summary>💭 사고 {thinking.length}회</summary>
              {thinking.map((t, i) => (
                <div key={i} className="thinking-chunk">{t}</div>
              ))}
            </details>
          )}
        </div>
      </details>
    );
  }

  const renderSourceViewPanel = () => {
    if (!sourceView && !sourceViewLoading && !sourceViewError) return null;
    const lines = sourceView?.content.split('\n') ?? [];
    const sr = sourceView?.section_range;
    return (
      <aside className="source-view-panel glass">
        <header className="source-view-header">
          <div className="source-view-title">
            {sourceView?.source === 'summary' && (
              <span className="source-view-summary-badge" title="Haiku 로 생성한 요약본입니다. 원본이 아닙니다.">📝 요약본</span>
            )}
            {sourceView?.origin_label || (sourceViewLoading ? '로딩 중...' : '출처 뷰')}
          </div>
          {sourceView?.origin_url && (
            <a href={sourceView.origin_url} target="_blank" rel="noreferrer" className="source-view-ext" title="원본 링크">↗ 원본</a>
          )}
          {sourceView?.source === 'xlsx' && sourceView?.path && (
            <button
              className="source-view-ext"
              type="button"
              title="엑셀 원본 스크린샷 보기"
              onClick={() => setScreenshotState({
                url: screenshotUrl(sourceView.path),
                label: sourceView.origin_label || sourceView.path,
              })}
            >📸 원본 스크린샷</button>
          )}
          <button className="source-view-close" onClick={closeSourceView} title="닫기 (Esc)">✕</button>
        </header>
        {sourceView?.source === 'summary' && (
          <div className="source-view-summary-notice">
            ⚠ 이 문서는 <strong>원본 기획서가 아니라 검색용 요약본</strong>입니다. 세부 내용은 원본 문서를 확인해 주세요.
          </div>
        )}
        {sourceViewLoading && <div className="source-view-loading"><span className="loading-spinner" /> 로딩 중...</div>}
        {sourceViewError && <div className="source-view-error">오류: {sourceViewError}</div>}
        {sourceView && (
          <>
            {sr && (
              <div className="source-view-section-badge">
                하이라이트: {sourceView.section}  ·  라인 {sr.start_line}–{sr.end_line}
              </div>
            )}
            <div className="source-view-body markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || '');
                    if (match && match[1] === 'mermaid') {
                      return <MermaidBlock code={String(children).replace(/\n$/, '')} theme={resolvedTheme} />;
                    }
                    return <code className={className} {...props}>{children}</code>;
                  },
                  // 하이라이트된 섹션 감싸기: 간단히 별도 <section> 으로 split
                } as any}
              >
                {/* 섹션 range 가 있으면 세 구간으로 분리 렌더 */}
                {sr
                  ? lines.slice(0, sr.start_line - 1).join('\n')
                  : sourceView.content}
              </ReactMarkdown>
              {sr && (
                <div className="source-view-highlight" ref={sourceHighlightRef}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {lines.slice(sr.start_line - 1, sr.end_line).join('\n')}
                  </ReactMarkdown>
                </div>
              )}
              {sr && (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {lines.slice(sr.end_line).join('\n')}
                </ReactMarkdown>
              )}
            </div>
          </>
        )}
      </aside>
    );
  };

  return (
    <div className={`layout ${sourceView || sourceViewLoading || sourceViewError ? 'has-source-view' : ''}`}>
      {/* Sidebar */}
      <aside className="sidebar glass">
        <div className="sidebar-header">
          <h2 className="logo">🎮 Project K QnA</h2>
        </div>
        <button className="new-chat-btn" onClick={handleNewChat}>
          <span className="icon">+</span> 새 대화
        </button>
        <div className="sidebar-section">
          <p className="section-title">히스토리</p>
          <div className="history-list">
            {threads.map(t => (
              <div
                key={t.id}
                className={`history-item ${activeThreadId === t.id ? 'active' : ''}`}
                onClick={() => handleSelectThread(t.id)}
              >
                {loadingThreads.has(t.id) && <span className="loading-spinner" style={{width: 12, height: 12, marginRight: 6}} />}
                <span className="history-title">{t.title}</span>
                <div className="history-actions">
                  <button className="share-thread-btn" title="공유 링크 복사" onClick={(e) => {
                    e.stopPropagation()
                    const url = `${window.location.origin}${import.meta.env.BASE_URL}shared/${encodeURIComponent(t.id)}`
                    navigator.clipboard.writeText(url)
                    const btn = e.currentTarget
                    btn.textContent = '✓'
                    setTimeout(() => { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>' }, 1500)
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                  </button>
                  <button className="delete-thread-btn" onClick={(e) => handleDeleteThread(e, t.id)}>×</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="sidebar-footer">
          <a href={`${import.meta.env.BASE_URL}admin`} target="_blank" rel="noreferrer" className="kb-btn" style={{width: '100%', textAlign: 'center', textDecoration: 'none'}}>
            Admin
          </a>
          <div className="theme-selector">
            <button className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => handleThemeChange('system')}>System</button>
            <button className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>Light</button>
            <button className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>Dark</button>
          </div>
          <div className="status-text">Agent SDK PoC · v0.1</div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="chat-scroll-area">
          {messages.length === 0 ? (
            <div className="welcome-area animate-fade-in">
              <h1 className="main-title">Project K 기획 QnA</h1>
              <p className="sub-title">튜토리얼, 변신, 스킬 등 기획서에 대해 무엇이든 물어보세요.</p>
              
              <div className="suggested-prompts">
                {presets.map((p, i) => (
                  <button
                    key={i}
                    className={`prompt-card glass${p.compare_mode ? ' prompt-card-deepresearch' : ''}`}
                    onClick={() => {
                      setInput(p.prompt);
                      // Google Deep Research 프리셋 — 비교 모드 자동 ON (사용자가 따로 토글 안 켜도 동작)
                      if (p.compare_mode) setCompareMode(true);
                      inputRef.current?.focus();
                    }}
                    title={p.compare_mode ? `${p.prompt}\n\n[Google Deep Research 자동 ON — 내부 크롤링 + Gemini google_search 웹 검색]` : p.prompt}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-container">
              <div className="pdf-export-bar">
                <button
                  className="pdf-export-all-btn glass"
                  onClick={handleExportConversation}
                  disabled={pdfExporting !== null}
                  title="전체 대화를 PDF로 내보내기"
                >
                  {pdfExporting === 'all' ? (
                    <><span className="loading-spinner" style={{width: 14, height: 14}} /> PDF 생성 중...</>
                  ) : (
                    <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg> 전체 대화 PDF</>
                  )}
                </button>
              </div>
              {messages.map((msg, idx) => (
                <div key={idx} className={`message-wrapper ${msg.role}`}>
                  <div className={`message glass ${msg.role}`}>
                    <div className="message-content markdown-body">
                      {msg.role === 'user' ? (
                        <div className="user-message-row">
                          <span>{msg.content}</span>
                          <button className="copy-msg-btn" title="복사" onClick={() => navigator.clipboard.writeText(msg.content)}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                          </button>
                          <button className="pdf-msg-btn" title="이 메시지 PDF" onClick={() => handleExportMessage(idx)} disabled={pdfExporting !== null}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          </button>
                        </div>
                      ) : (
                        <>
                          {msg.compareMode && (
                            <div className="compare-mode-badge-row" title="이 답변은 Google Deep Research 모드 — 내부 크롤링 데이터 + Gemini google_search grounding 으로 생성되었습니다">
                              <span className="compare-mode-badge">✨ Google Deep Research</span>
                            </div>
                          )}
                          {msg.qaWarnings && msg.qaWarnings.length > 0 && (
                            <div className="qa-warnings" title="이 답변의 품질 체크 경고">
                              {msg.qaWarnings.map((w, wi) => (
                                <span key={wi} className="qa-warning-badge">⚠ {w}</span>
                              ))}
                            </div>
                          )}
                          {msg.progress && renderProgress(msg.progress, { collapsed: true, loading: false })}
                          <RenderAssistantMarkdown
                            content={msg.content}
                            sources={msg.sources}
                            onOpenSource={openSourceView}
                            theme={resolvedTheme}
                          />
                        </>
                      )}
                    </div>
                    {msg.role === 'assistant' && (
                      <div className="assistant-actions">
                        <button className="pdf-msg-btn" title="이 메시지 PDF" onClick={() => handleExportMessage(idx)} disabled={pdfExporting !== null}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          <span>PDF</span>
                        </button>
                        <button className="copy-msg-btn" title="복사" onClick={() => navigator.clipboard.writeText(msg.content)} style={{opacity: undefined}}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                        </button>
                      </div>
                    )}
                    {msg.sources && msg.sources.length > 0 && (
                      <RenderSourceCards sources={msg.sources} onOpen={openSourceView} />
                    )}
                    {msg.role === 'assistant' && msg.followUps && msg.followUps.length > 0 && (
                      <div className="followups">
                        <p className="followups-title">이어서 물어볼 만한 질문</p>
                        <div className="followups-cards">
                          {msg.followUps.map((q, qi) => (
                            <button
                              key={qi}
                              className="followup-card"
                              type="button"
                              disabled={!!activeThreadId && loadingThreads.has(activeThreadId)}
                              title="이 질문으로 이어서 물어보기"
                              onClick={() => handleSend(q)}
                            >
                              <span className="followup-arrow">›</span>
                              <span className="followup-text">{q}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isCurrentLoading && (
                <div className="message-wrapper assistant">
                  <div className="message glass assistant loading">
                    {activeProgress
                      ? renderProgress(activeProgress, { collapsed: false, loading: true })
                      : (
                        <span className="loading-status">
                          <span className="loading-spinner"></span>
                          {activeStatus || '처리 중...'}
                        </span>
                      )}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="input-container glass">
          <textarea
            ref={inputRef}
            placeholder="기획 질문을 입력하세요... (Ctrl+Enter로 전송)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = Math.min(t.scrollHeight, 120) + 'px';
            }}
          />
          <div className="model-selector">
            <select value={model} onChange={(e) => setModel(e.target.value as 'opus' | 'sonnet')} title="Claude 모델 선택">
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
            </select>
          </div>
          <label
            className={`compare-mode-toggle ${compareMode ? 'on' : ''}`}
            title="Google Deep Research — 내부 크롤링 데이터(타게임 oracle KG·raw) + Gemini google_search grounding 으로 인터넷 웹을 함께 검색합니다. 답변이 풍부해지지만 느려질 수 있습니다."
          >
            <input
              type="checkbox"
              checked={compareMode}
              onChange={(e) => setCompareMode(e.target.checked)}
            />
            <span className="compare-mode-toggle-label">✨ Google Deep Research</span>
          </label>
          {isCurrentLoading ? (
            <button className="stop-btn" onClick={handleStop} title="응답 중단">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect width="14" height="14" rx="2"/></svg>
            </button>
          ) : (
            <button className="send-btn" onClick={() => handleSend()} disabled={!input.trim()}>↑</button>
          )}
        </div>
      </main>
      {renderSourceViewPanel()}
      {screenshotState && (
        <div className="screenshot-modal-backdrop" onClick={closeScreenshot}>
          <div className="screenshot-modal glass" onClick={(e) => e.stopPropagation()}>
            <header className="screenshot-modal-header">
              <span className="screenshot-modal-title" title={screenshotState.label}>
                📸 {screenshotState.label}
              </span>
              <button className="screenshot-modal-close" onClick={closeScreenshot} title="닫기 (Esc)" type="button">✕</button>
            </header>
            <div className="screenshot-modal-body">
              <img src={screenshotState.url} alt={screenshotState.label} loading="lazy" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

