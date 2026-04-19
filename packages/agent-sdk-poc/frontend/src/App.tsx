import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'
import { askQuestionStream, fetchPresetPrompts, fetchSourceView } from './api'
import type { AskResponse, StreamEvent, PresetPrompt, SourceView } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import html2pdf from 'html2pdf.js'

// ── Theme ──
type ThemeMode = 'system' | 'light' | 'dark';

function getResolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

// ── 답변 본문의 `(출처: …)` 를 클릭 가능한 링크로 전처리 ───
// balanced-paren 스캔으로 중첩된 `(n)` · `§` 섹션을 안전하게 포함.
// 결과: `[(출처: body)](projk-source:<encoded-body>)` — ReactMarkdown 이 anchor 로 렌더,
// href prefix 로 감지해 핸들러가 우측 뷰를 연다.
function linkifyInlineSources(text: string): string {
  if (!text) return text
  const re = /\(\s*출처\s*[:：]\s*/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const afterPrefix = m.index + m[0].length
    let depth = 1
    let i = afterPrefix
    while (i < text.length) {
      const ch = text[i]
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) break }
      i++
    }
    if (i >= text.length) break
    const body = text.slice(afterPrefix, i).trim()
    // 링크 표시 텍스트에서 [ ] 는 escape (markdown 파서가 중첩 bracket 을 오해석하지 않게)
    const displayBody = body.replace(/[\[\]]/g, (c) => '\\' + c)
    const enc = encodeURIComponent(body)
    out += text.slice(last, start) + `[(출처: ${displayBody})](projk-source:${enc})`
    last = i + 1
    re.lastIndex = last
  }
  out += text.slice(last)
  return out
}

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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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

  // 본문 인라인 출처 클릭 — 라벨을 해당 메시지의 sources 에서 찾아 path 로 변환 후 오픈.
  // 매칭 실패 시 라벨을 그대로 전달 (서버가 _path_to_source_meta 로 해석).
  // 복합 섹션 인용(§ A, § B, § C)은 **첫 섹션만** 하이라이트 대상으로 사용.
  const openInlineSource = useCallback((body: string, sources?: AskResponse['sources']) => {
    let label = body
    let section = ''
    const sep = body.indexOf('§')
    if (sep >= 0) {
      label = body.slice(0, sep).trim()
      let sec = body.slice(sep + 1).trim()
      // `2-3 대미지 증가, § 2-4 치명타 판정` → `2-3 대미지 증가`
      const nextSec = sec.search(/[,;]\s*§/)
      if (nextSec >= 0) sec = sec.slice(0, nextSec).trim()
      section = sec
    }
    const match = sources?.find(s => ((s.origin_label || '').trim()) === label)
    if (match?.path) {
      openSourceView(match.path, section)
      return
    }
    openSourceView(label, section)
  }, [openSourceView])

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
          { role: 'assistant' as const, content: t.answer, sources: t.sources },
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

  const handleSend = async () => {
    if (!input.trim()) return;
    // 현재 스레드가 로딩 중이면 차단 (다른 스레드는 OK)
    if (activeThreadId && loadingThreads.has(activeThreadId)) return;

    const userMsg = input.trim();
    setInput('');

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

  const ExcelIcon = () => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{flexShrink: 0}}>
      <rect width="18" height="18" rx="3" fill="#217346"/>
      <path d="M4.5 4.5L8 9L4.5 13.5H6.5L9 10L11.5 13.5H13.5L10 9L13.5 4.5H11.5L9 8L6.5 4.5H4.5Z" fill="white"/>
    </svg>
  )

  const ConfluenceIcon = () => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{flexShrink: 0}}>
      <rect width="18" height="18" rx="3" fill="#1868DB"/>
      <path d="M3.5 12.5C3.5 12.5 4 11.5 5 11.5C6.5 11.5 7 13 9 13C11 13 12 11 13.5 11C14.5 11 14.5 12 14.5 12L14.5 13.5C14.5 13.5 14 14.5 13 14.5C11.5 14.5 11 13 9 13C7 13 6 15 4.5 15C3.5 15 3.5 14 3.5 14V12.5Z" fill="white"/>
      <path d="M14.5 5.5C14.5 5.5 14 6.5 13 6.5C11.5 6.5 11 5 9 5C7 5 6 7 4.5 7C3.5 7 3.5 6 3.5 6L3.5 4.5C3.5 4.5 4 3.5 5 3.5C6.5 3.5 7 5 9 5C11 5 12 3 13.5 3C14.5 3 14.5 4 14.5 4V5.5Z" fill="white"/>
    </svg>
  )

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

  const renderSources = (sources: AskResponse['sources']) => {
    if (!sources || sources.length === 0) return null;
    type SrcAny = typeof sources[number] & { path?: string; source?: string; origin_label?: string; origin_url?: string };
    // path 기준 그룹화 → 한 문서의 여러 섹션은 한 카드로 접힘
    const groups = new Map<string, { src: SrcAny; sections: string[] }>();
    sources.forEach((s: SrcAny) => {
      const key = s.path || `${s.workbook}/${s.sheet}`;
      const g = groups.get(key);
      const sec = (s.section_path || '').trim();
      if (g) {
        if (sec && !g.sections.includes(sec)) g.sections.push(sec);
      } else {
        groups.set(key, { src: s, sections: sec ? [sec] : [] });
      }
    });
    return (
      <div className="message-sources">
        <p className="sources-title">출처</p>
        <div className="source-cards-container">
          {Array.from(groups.values()).map(({ src, sections }, i) => {
            const isConfluence = src.source === 'confluence' || src.workbook.startsWith('Confluence');
            // 사용자 표시 라벨: 원본 라벨(origin_label) 우선 → 없으면 워크북/시트
            const displayLabel =
              src.origin_label ||
              [src.workbook, src.sheet].filter(Boolean).join(' / ') ||
              src.path || '(unknown)';
            // 클릭 동작:
            //  - 주 클릭: 우측 스플릿 뷰 오픈 (해당 문서 섹션 하이라이트)
            //  - 원본 링크(Confluence 등)는 별도 ↗ 버튼
            const extLink = src.origin_url || src.source_url || '';
            const firstSection = sections[0] || '';
            const canOpen = !!src.path;
            return (
              <div key={i} className="source-link-card glass" title={src.path || displayLabel}>
                <button
                  className="source-card-main"
                  onClick={() => canOpen && openSourceView(src.path!, firstSection)}
                  disabled={!canOpen}
                  type="button"
                >
                  <span className="source-icon">{isConfluence ? <ConfluenceIcon /> : <ExcelIcon />}</span>
                  <div className="source-body">
                    <span className="source-text">{displayLabel}</span>
                    {sections.length > 0 && (
                      <span className="source-sections">{sections.slice(0, 4).join(' · ')}{sections.length > 4 ? ` …+${sections.length - 4}` : ''}</span>
                    )}
                  </div>
                </button>
                {extLink && (
                  <a
                    className="source-card-ext"
                    href={extLink}
                    target="_blank"
                    rel="noreferrer"
                    title="원본 링크 새 창에서 열기"
                  >↗</a>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

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
          <button className="source-view-close" onClick={closeSourceView} title="닫기">✕</button>
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
                <div className="source-view-highlight">
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
                    className="prompt-card glass"
                    onClick={() => { setInput(p.prompt); inputRef.current?.focus() }}
                    title={p.prompt}
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
                          {msg.qaWarnings && msg.qaWarnings.length > 0 && (
                            <div className="qa-warnings" title="이 답변의 품질 체크 경고">
                              {msg.qaWarnings.map((w, wi) => (
                                <span key={wi} className="qa-warning-badge">⚠ {w}</span>
                              ))}
                            </div>
                          )}
                          {msg.progress && renderProgress(msg.progress, { collapsed: true, loading: false })}
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            urlTransform={(url) => url}
                            components={{
                              code({ node, inline, className, children, ...props }: any) {
                                const match = /language-(\w+)/.exec(className || '');
                                if (!inline && match && match[1] === 'mermaid') {
                                  return <MermaidBlock code={String(children).replace(/\n$/, '')} theme={resolvedTheme} />;
                                }
                                return <code className={className} {...props}>{children}</code>;
                              },
                              a({ href, children, ...props }: any) {
                                const h = href || '';
                                if (h.startsWith('projk-source:')) {
                                  const body = decodeURIComponent(h.slice('projk-source:'.length));
                                  return (
                                    <a
                                      href="#"
                                      className="inline-source-link"
                                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openInlineSource(body, msg.sources); }}
                                      title="우측 패널에서 열기"
                                    >{children}</a>
                                  );
                                }
                                return <a href={h} target="_blank" rel="noreferrer" {...props}>{children}</a>;
                              }
                            }}
                          >
                            {linkifyInlineSources(msg.content)}
                          </ReactMarkdown>
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
                    {msg.sources && renderSources(msg.sources)}
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
          {isCurrentLoading ? (
            <button className="stop-btn" onClick={handleStop} title="응답 중단">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect width="14" height="14" rx="2"/></svg>
            </button>
          ) : (
            <button className="send-btn" onClick={handleSend} disabled={!input.trim()}>↑</button>
          )}
        </div>
      </main>
      {renderSourceViewPanel()}
    </div>
  )
}

export default App

