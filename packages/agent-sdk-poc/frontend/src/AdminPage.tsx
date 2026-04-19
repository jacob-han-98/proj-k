import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'
import { fetchConversations, fetchConversationDetail, forkConversation } from './api'
import type { ConversationSummary, ConversationDetail, Source } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'

// ── Theme (App.tsx와 동일) ──
type ThemeMode = 'system' | 'light' | 'dark';

function getResolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

const MermaidBlock = ({ code, theme }: { code: string; theme: 'light' | 'dark' }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark' })
    if (ref.current) {
      const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`
      mermaid.render(id, code)
        .then((res) => { if (ref.current) ref.current.innerHTML = res.svg })
        .catch(() => { if (ref.current) ref.current.innerHTML = '<pre>Error rendering diagram</pre>' })
    }
  }, [code, theme])
  return <div ref={ref} className="mermaid-wrapper" />
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

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function AdminPage() {
  const [convList, setConvList] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleShare = () => {
    if (!selectedId) return
    const base = window.location.origin + import.meta.env.BASE_URL
    const url = `${base}shared/${encodeURIComponent(selectedId)}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleFork = async () => {
    if (!detail) return
    try {
      // 백엔드에서 대화 복제 (새 ID 발급, Admin에 표시됨)
      const result = await forkConversation(detail.id)
      // 복제된 대화를 메인 QnA에서 열기
      const forkData = {
        id: result.conversation_id,
        title: result.title,
        turns: detail.turns,
      }
      sessionStorage.setItem('fork-conv', JSON.stringify(forkData))
      window.location.href = import.meta.env.BASE_URL
    } catch (e) {
      alert('Fork 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    (localStorage.getItem('qna-theme') as ThemeMode) || 'system'
  )
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    getResolvedTheme((localStorage.getItem('qna-theme') as ThemeMode) || 'system')
  )

  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode)
    localStorage.setItem('qna-theme', mode)
    applyTheme(mode)
    setResolvedTheme(getResolvedTheme(mode))
  }, [])

  useEffect(() => {
    applyTheme(themeMode)
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => { if (themeMode === 'system') setResolvedTheme(getResolvedTheme('system')) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [themeMode])

  // 대화 목록 로드 + 30초 자동 갱신
  useEffect(() => {
    const load = () => {
      fetchConversations()
        .then(data => { setConvList(data.conversations); setLoading(false); setError(null) })
        .catch(e => { setError(e.message); setLoading(false) })
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  // 선택된 대화 상세 로드
  useEffect(() => {
    if (selectedId) {
      fetchConversationDetail(selectedId)
        .then(setDetail)
        .catch(() => setDetail(null))
    } else {
      setDetail(null)
    }
  }, [selectedId])

  const renderSources = (sources: Source[]) => {
    if (!sources || sources.length === 0) return null
    return (
      <div className="message-sources">
        <p className="sources-title">출처:</p>
        <div className="source-cards-container">
          {sources.map((src, i) => {
            const isConfluence = src.workbook.startsWith('Confluence')
            let link = '#'
            if (src.source_url) {
              link = src.source_url
            } else if (isConfluence) {
              const searchTerm = src.sheet || src.workbook.split('/').pop()
              link = `https://bighitcorp.atlassian.net/wiki/search?text=${encodeURIComponent(searchTerm || '')}&where=PK`
            }
            return (
              <a key={i} href={link} target={link !== '#' ? '_blank' : undefined} rel="noreferrer" className="source-link-card glass">
                <span className="source-icon">{isConfluence ? <ConfluenceIcon /> : <ExcelIcon />}</span>
                <span className="source-text">{src.workbook}{src.sheet ? ` / ${src.sheet}` : ''}</span>
                <span className="source-score">({src.score.toFixed(2)})</span>
              </a>
            )
          })}
        </div>
      </div>
    )
  }

  // 턴 → 메시지 변환
  const messages = detail?.turns.flatMap(turn => [
    { role: 'user' as const, content: turn.question, sources: undefined as Source[] | undefined },
    { role: 'assistant' as const, content: turn.answer, sources: turn.sources },
  ]) ?? []

  return (
    <div className="layout">
      {/* Mobile top bar */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
        <span className="mobile-title">Admin</span>
      </div>
      {/* Sidebar */}
      <aside className={`sidebar glass ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <h2 className="logo">Admin</h2>
        </div>
        <div className="admin-stats">
          {convList.length}개 대화 {loading && '(로딩...)'}
          {error && <span style={{color: '#ef4444'}}> (연결 실패)</span>}
        </div>
        <div className="sidebar-section">
          <p className="section-title">전체 대화</p>
          <div className="history-list">
            {convList.map(conv => (
              <div
                key={conv.id}
                className={`history-item ${selectedId === conv.id ? 'active' : ''}`}
                onClick={() => setSelectedId(conv.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="history-title">{conv.title}</span>
                  <div className="conv-meta">
                    {conv.turn_count}턴 · {formatTime(conv.updated_at)}
                  </div>
                </div>
              </div>
            ))}
            {convList.length === 0 && !loading && (
              <div style={{ padding: '20px 12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                아직 대화가 없습니다.
              </div>
            )}
          </div>
        </div>
        <div className="sidebar-footer">
          <div className="theme-selector">
            <button className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => handleThemeChange('system')}>System</button>
            <button className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>Light</button>
            <button className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>Dark</button>
          </div>
          <div className="status-text">Admin · PoC v0.2.0</div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="chat-scroll-area">
          {!selectedId ? (
            <div className="welcome-area animate-fade-in">
              <h1 className="main-title">Admin Dashboard</h1>
              <p className="sub-title">왼쪽에서 대화를 선택하면 전체 내용을 볼 수 있습니다.</p>
              <div className="admin-summary-cards">
                <div className="admin-card glass">
                  <div className="admin-card-number">{convList.length}</div>
                  <div className="admin-card-label">전체 대화</div>
                </div>
                <div className="admin-card glass">
                  <div className="admin-card-number">{convList.reduce((s, c) => s + c.turn_count, 0)}</div>
                  <div className="admin-card-label">총 질문 수</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="chat-container">
              {/* 대화 메타 헤더 */}
              {detail && (
                <div className="admin-conv-header glass">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <h3>{detail.title}</h3>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="share-btn" onClick={handleFork} title="이 대화를 복제하여 QnA에서 이어서 대화">
                        Fork
                      </button>
                      <button className="share-btn" onClick={handleShare}>
                        {copied ? 'Copied!' : '공유 링크'}
                      </button>
                    </div>
                  </div>
                  <div className="admin-conv-meta-row">
                    <span>ID: {detail.id.slice(0, 8)}...</span>
                    <span>생성: {formatTime(detail.created_at)}</span>
                    <span>{detail.turns.length}턴</span>
                    {detail.turns[0] && (detail.turns[0] as any).cost_usd != null && <span>총 비용: ${((detail.turns as any[]).reduce((s, t) => s + (t.cost_usd || 0), 0)).toFixed(3)}</span>}
                  </div>
                </div>
              )}
              {/* 메시지 (Chat과 동일한 UI) */}
              {messages.map((msg, idx) => (
                <div key={idx} className={`message-wrapper ${msg.role}`}>
                  <div className={`message glass ${msg.role}`}>
                    <div className="message-content markdown-body">
                      {msg.role === 'user' ? (
                        msg.content
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ className, children, ...props }: any) {
                              const match = /language-(\w+)/.exec(className || '')
                              if (match && match[1] === 'mermaid') {
                                return <MermaidBlock code={String(children).replace(/\n$/, '')} theme={resolvedTheme} />
                              }
                              return <code className={className} {...props}>{children}</code>
                            }
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      )}
                    </div>
                    {msg.sources && renderSources(msg.sources)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default AdminPage
