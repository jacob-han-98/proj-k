import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import './App.css'
import { fetchConversationDetail } from './api'
import type { ConversationDetail, Source } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'

// ── Theme ──
type ThemeMode = 'system' | 'light' | 'dark';
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
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#217346" />
    <path d="M4.5 4.5L8 9L4.5 13.5H6.5L9 10L11.5 13.5H13.5L10 9L13.5 4.5H11.5L9 8L6.5 4.5H4.5Z" fill="white" />
  </svg>
)
const ConfluenceIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#1868DB" />
    <path d="M3.5 12.5C3.5 12.5 4 11.5 5 11.5C6.5 11.5 7 13 9 13C11 13 12 11 13.5 11C14.5 11 14.5 12 14.5 12L14.5 13.5C14.5 13.5 14 14.5 13 14.5C11.5 14.5 11 13 9 13C7 13 6 15 4.5 15C3.5 15 3.5 14 3.5 14V12.5Z" fill="white" />
    <path d="M14.5 5.5C14.5 5.5 14 6.5 13 6.5C11.5 6.5 11 5 9 5C7 5 6 7 4.5 7C3.5 7 3.5 6 3.5 6L3.5 4.5C3.5 4.5 4 3.5 5 3.5C6.5 3.5 7 5 9 5C11 5 12 3 13.5 3C14.5 3 14.5 4 14.5 4V5.5Z" fill="white" />
  </svg>
)

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function getResolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function SharedPage() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
    const handler = () => {
      if (themeMode === 'system') setResolvedTheme(getResolvedTheme('system'))
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [themeMode])

  useEffect(() => {
    if (!id) return
    fetchConversationDetail(id)
      .then(d => { setDetail(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [id])

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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

  if (loading) {
    return (
      <div className="shared-page">
        <div className="shared-loading"><span className="loading-spinner" /> Loading...</div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="shared-page">
        <div className="shared-error">
          <h2>대화를 찾을 수 없습니다</h2>
          <p>{error || '존재하지 않는 대화 ID입니다.'}</p>
          <a href={`${import.meta.env.BASE_URL}`} className="shared-home-link">Project K QnA로 이동</a>
        </div>
      </div>
    )
  }

  const messages = detail.turns.flatMap(turn => [
    { role: 'user' as const, content: turn.question, sources: undefined as Source[] | undefined, seconds: turn.api_seconds },
    { role: 'assistant' as const, content: turn.answer, sources: turn.sources, seconds: turn.api_seconds },
  ])

  return (
    <div className="shared-page">
      {/* Header */}
      <header className="shared-header glass">
        <div className="shared-header-left">
          <a href={`${import.meta.env.BASE_URL}`} className="shared-logo">Project K QnA</a>
          <span className="shared-badge">공유된 대화</span>
        </div>
        <div className="shared-header-right">
          <div className="theme-selector" style={{ margin: 0 }}>
            <button className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => handleThemeChange('system')}>System</button>
            <button className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>Light</button>
            <button className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>Dark</button>
          </div>
          <button className="shared-copy-btn" onClick={handleCopyLink}>
            {copied ? 'Copied!' : 'Link 복사'}
          </button>
        </div>
      </header>

      {/* Conversation */}
      <div className="shared-content">
        <div className="shared-meta">
          <h1 className="shared-title">{detail.title}</h1>
          <div className="shared-meta-row">
            <span>{detail.turns.length}개 질문</span>
            <span>{formatTime(detail.created_at)}</span>
            {detail.turns[0] && (detail.turns[0] as any).cost_usd != null && <span>총 비용: ${((detail.turns as any[]).reduce((s, t) => s + (t.cost_usd || 0), 0)).toFixed(3)}</span>}
          </div>
        </div>

        <div className="shared-messages">
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

        {/* Footer CTA */}
        <div className="shared-footer">
          <a href={`${import.meta.env.BASE_URL}`} className="shared-cta-btn">
            Project K QnA에서 직접 질문하기 &rarr;
          </a>
        </div>
      </div>
    </div>
  )
}

export default SharedPage
