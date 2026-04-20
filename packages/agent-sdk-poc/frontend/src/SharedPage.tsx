import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import './App.css'
import { fetchConversationDetail } from './api'
import type { ConversationDetail, Source } from './api'
import {
  RenderAssistantMarkdown,
  RenderSourceCards,
  FollowUpCards,
  SourceViewPanel,
  ScreenshotModal,
  useSourceAndScreenshot,
} from './assistantRender'

// ── Theme ──
type ThemeMode = 'system' | 'light' | 'dark';
function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

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

  const sv = useSourceAndScreenshot()

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
    {
      role: 'user' as const,
      content: turn.question,
      sources: undefined as Source[] | undefined,
      seconds: turn.api_seconds,
      qaWarnings: undefined as string[] | undefined,
      followUps: undefined as string[] | undefined,
      toolTrace: undefined as any[] | undefined,
    },
    {
      role: 'assistant' as const,
      content: turn.answer,
      sources: turn.sources,
      seconds: turn.api_seconds,
      qaWarnings: (turn as any).qa_warnings as string[] | undefined,
      followUps: (turn as any).follow_ups as string[] | undefined,
      toolTrace: (turn as any).tool_trace as any[] | undefined,
    },
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
                    <>
                      {msg.qaWarnings && msg.qaWarnings.length > 0 && (
                        <div className="qa-warnings" title="품질 체크 경고">
                          {msg.qaWarnings.map((w, wi) => (
                            <span key={wi} className="qa-warning-badge">⚠ {w}</span>
                          ))}
                        </div>
                      )}
                      {msg.toolTrace && msg.toolTrace.length > 0 && (
                        <details className="progress-panel">
                          <summary className="progress-summary">
                            <span className="progress-head">🔧 진행 내역 펼치기 · 툴 {msg.toolTrace.length}회</span>
                          </summary>
                          <div className="progress-body">
                            {msg.toolTrace.map((t, ti) => (
                              <details key={ti} className="tool-entry tool-done">
                                <summary>
                                  <span className="tool-label">🔧 {t.tool} {t.input?.file_path ? `· ${t.input.file_path.split('/').slice(-3).join('/')}` : t.input?.pattern ? `· \`${t.input.pattern}\`` : ''}</span>
                                </summary>
                                {t.input && (
                                  <div className="tool-entry-body">
                                    <pre className="tool-input"><code>{JSON.stringify(t.input, null, 2)}</code></pre>
                                  </div>
                                )}
                              </details>
                            ))}
                          </div>
                        </details>
                      )}
                      <RenderAssistantMarkdown
                        content={msg.content}
                        sources={msg.sources}
                        onOpenSource={sv.openSource}
                        theme={resolvedTheme}
                      />
                    </>
                  )}
                </div>
                {msg.sources && msg.role === 'assistant' && (
                  <RenderSourceCards sources={msg.sources} onOpen={sv.openSource} />
                )}
                {msg.role === 'assistant' && (
                  <FollowUpCards followUps={msg.followUps} disabled onPick={() => {}} />
                )}
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
      <SourceViewPanel
        sourceView={sv.sourceView}
        loading={sv.loading}
        err={sv.err}
        onClose={sv.closeSource}
        onScreenshot={sv.openScreenshot}
      />
      <ScreenshotModal state={sv.screenshot} onClose={sv.closeScreenshot} />
    </div>
  )
}

export default SharedPage
