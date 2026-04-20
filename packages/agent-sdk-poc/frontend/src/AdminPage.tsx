import { useState, useEffect, useCallback } from 'react'
import './App.css'
import {
  fetchConversations,
  fetchConversationDetail,
  forkConversation,
  fetchRefactorOverview,
  fetchRefactorTargets,
} from './api'
import type {
  ConversationSummary,
  ConversationDetail,
  Source,
  RefactorOverview,
  RefactorTarget,
  RefactorTargetsReport,
  Grade,
} from './api'
import {
  RenderAssistantMarkdown,
  RenderSourceCards,
  FollowUpCards,
  SourceViewPanel,
  ScreenshotModal,
  useSourceAndScreenshot,
} from './assistantRender'
import { RefactorOverviewView, RefactorPanel } from './RefactorPanel'

type AdminSection = 'conversations' | 'refactor'

const GRADE_COLOR: Record<Grade, string> = {
  S: '#ef4444',
  A: '#f59e0b',
  B: '#3b82f6',
  C: '#6b7280',
}

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
  const [section, setSection] = useState<AdminSection>(() => {
    const saved = localStorage.getItem('admin-section') as AdminSection | null
    return saved === 'refactor' ? 'refactor' : 'conversations'
  })
  const switchSection = (s: AdminSection) => {
    setSection(s)
    localStorage.setItem('admin-section', s)
  }

  const [convList, setConvList] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Refactor state
  const [refactorOverview, setRefactorOverview] = useState<RefactorOverview | null>(null)
  const [refactorReport, setRefactorReport] = useState<RefactorTargetsReport | null>(null)
  const [refactorError, setRefactorError] = useState<string | null>(null)
  const [selectedTargetName, setSelectedTargetName] = useState<string | null>(null)
  const [author, setAuthor] = useState<string>(() => localStorage.getItem('admin-author') || 'jacob')

  const reloadRefactor = useCallback(() => {
    fetchRefactorOverview()
      .then(setRefactorOverview)
      .catch(e => setRefactorError(e.message))
    fetchRefactorTargets()
      .then(setRefactorReport)
      .catch(e => {
        // 404인 경우: refactor_targets.json 없음
        setRefactorReport(null)
        setRefactorError(e.message)
      })
  }, [])

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

  // Refactor 섹션 진입 시 한 번 로드
  useEffect(() => {
    if (section === 'refactor' && refactorOverview === null && refactorError === null) {
      reloadRefactor()
    }
  }, [section, refactorOverview, refactorError, reloadRefactor])

  const selectedTarget: RefactorTarget | null = selectedTargetName && refactorReport
    ? refactorReport.targets.find(t => t.name === selectedTargetName) ?? null
    : null

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

        {/* 섹션 전환 탭 — 로고 바로 아래, 큼직하게 */}
        <div style={{
          display: 'flex',
          gap: 6,
          padding: '0 12px 12px',
          marginBottom: 6,
          borderBottom: '1px solid var(--border-color)',
        }}>
          <button
            type="button"
            onClick={() => switchSection('conversations')}
            style={{
              flex: 1,
              padding: '10px 8px',
              borderRadius: 8,
              background: section === 'conversations' ? 'var(--accent, #7aa2ff)' : 'transparent',
              color: section === 'conversations' ? '#fff' : 'var(--text-primary)',
              border: `1px solid ${section === 'conversations' ? 'var(--accent, #7aa2ff)' : 'var(--border-color)'}`,
              cursor: 'pointer',
              fontSize: '0.88rem',
              fontWeight: section === 'conversations' ? 700 : 500,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >💬 대화</button>
          <button
            type="button"
            onClick={() => switchSection('refactor')}
            style={{
              flex: 1,
              padding: '10px 8px',
              borderRadius: 8,
              background: section === 'refactor' ? 'var(--accent, #7aa2ff)' : 'transparent',
              color: section === 'refactor' ? '#fff' : 'var(--text-primary)',
              border: `1px solid ${section === 'refactor' ? 'var(--accent, #7aa2ff)' : 'var(--border-color)'}`,
              cursor: 'pointer',
              fontSize: '0.88rem',
              fontWeight: section === 'refactor' ? 700 : 500,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >🛠 기획서 정리</button>
        </div>

        {section === 'conversations' ? (
          <>
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
          </>
        ) : (
          <>
            <div className="admin-stats">
              {refactorReport
                ? `${refactorReport.targets.length}개 타겟 · dims: ${refactorReport.dimensions_used.join(', ')}`
                : (refactorError ? <span style={{color: '#ef4444'}}>Ranker 결과 없음</span> : '로딩...')
              }
            </div>
            <div className="sidebar-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px 8px' }}>
                <p className="section-title" style={{ margin: 0 }}>리팩토링 타겟</p>
                <button
                  className="share-btn"
                  onClick={() => { setRefactorError(null); reloadRefactor(); }}
                  style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                  title="Overview / targets 재로드"
                >↻</button>
              </div>
              <div className="history-list">
                {refactorReport?.targets.map(t => {
                  const color = GRADE_COLOR[t.grade] || '#6b7280'
                  return (
                    <div
                      key={t.name}
                      className={`history-item ${selectedTargetName === t.name ? 'active' : ''}`}
                      onClick={() => setSelectedTargetName(t.name)}
                    >
                      <span style={{
                        display: 'inline-block', minWidth: 20, textAlign: 'center',
                        padding: '1px 6px', borderRadius: 4, marginRight: 8,
                        background: color, color: 'white', fontWeight: 700, fontSize: '0.7rem',
                      }}>{t.grade}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="history-title">#{t.rank} {t.name}</span>
                        <div className="conv-meta">
                          {Object.entries(t.dimension_scores)
                            .map(([k, s]) => `${k}: ${s.value.toFixed(1)}`)
                            .join(' · ')}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {refactorReport && refactorReport.targets.length === 0 && (
                  <div style={{ padding: '20px 12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    Ranker 결과가 비어 있습니다.
                  </div>
                )}
                {!refactorReport && refactorError && (
                  <div style={{ padding: '20px 12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    Ranker 를 먼저 실행해야 합니다.<br/>
                    <code style={{ fontSize: '0.75rem' }}>python scripts/rank_refactor_targets.py --dimensions conflict,hub --limit-systems 30</code>
                  </div>
                )}
              </div>
            </div>
            <div className="sidebar-section" style={{ padding: '0 12px' }}>
              <p className="section-title">저자</p>
              <input
                type="text"
                value={author}
                onChange={e => { setAuthor(e.target.value); localStorage.setItem('admin-author', e.target.value); }}
                style={{
                  width: '100%', padding: '6px 8px', borderRadius: 6,
                  border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)', fontSize: '0.85rem',
                }}
                placeholder="결정/피드백 기록 시 남길 이름"
              />
            </div>
          </>
        )}

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
          {section === 'refactor' ? (
            selectedTarget ? (
              <RefactorPanel
                target={selectedTarget}
                author={author}
                onSaved={reloadRefactor}
              />
            ) : (
              <RefactorOverviewView overview={refactorOverview} />
            )
          ) : !selectedId ? (
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
