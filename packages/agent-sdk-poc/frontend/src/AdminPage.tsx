import { useState, useEffect, useCallback } from 'react'
import './App.css'
import { fetchConversations, fetchConversationDetail, forkConversation } from './api'
import type { ConversationSummary, ConversationDetail, Source } from './api'
import {
  RenderAssistantMarkdown,
  RenderSourceCards,
  FollowUpCards,
  SourceViewPanel,
  ScreenshotModal,
  useSourceAndScreenshot,
} from './assistantRender'

// ── Theme (App.tsx와 동일) ──
type ThemeMode = 'system' | 'light' | 'dark';

function getResolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

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

  // 우측 패널 + 스크린샷 모달 상태
  const sv = useSourceAndScreenshot()

  // 턴 → 메시지 변환 (tool_trace/qa_warnings/follow_ups 포함)
  const messages = detail?.turns.flatMap(turn => [
    {
      role: 'user' as const,
      content: turn.question,
      sources: undefined as Source[] | undefined,
      qaWarnings: undefined as string[] | undefined,
      followUps: undefined as string[] | undefined,
      toolTrace: undefined as any[] | undefined,
    },
    {
      role: 'assistant' as const,
      content: turn.answer,
      sources: turn.sources,
      qaWarnings: (turn as any).qa_warnings as string[] | undefined,
      followUps: (turn as any).follow_ups as string[] | undefined,
      toolTrace: (turn as any).tool_trace as any[] | undefined,
    },
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
          )}
        </div>
      </main>
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

export default AdminPage
