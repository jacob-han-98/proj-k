import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import './App.css'
import {
  fetchKlaudLogs,
  fetchKlaudReports,
  fetchKlaudReport,
  fetchKlaudStats,
  fetchKlaudCrawlResources,
  fetchKlaudCrawlStats,
  purgeKlaudCrawl,
  reindexKlaudCrawl,
  getKlaudAdminToken,
  setKlaudAdminToken,
  clearKlaudAdminToken,
  KlaudAuthError,
  type KlaudLogEntry,
  type KlaudLogsFilter,
  type KlaudLogsResponse,
  type KlaudReportSummary,
  type KlaudReportDetail,
  type KlaudStats,
  type KlaudCrawlResource,
  type KlaudCrawlStats,
} from './api'

// ── Theme (App/AdminPage 와 동일) ──
type ThemeMode = 'system' | 'light' | 'dark'

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode)
}

type KlaudTab = 'logs' | 'reports' | 'crawl'

const CRAWL_STATUS_COLOR: Record<string, string> = {
  fresh: '#34d399',
  stale: '#f59e0b',
  failed: '#ef4444',
  purged: '#6b7280',
}

const CRAWL_SOURCE_LABEL: Record<string, string> = {
  'p4-xlsx': 'P4 / XLSX',
  'confluence-projk': 'Confluence / Project K',
  'confluence-art': 'Confluence / Art',
}

const LEVEL_BG: Record<string, string> = {
  error: 'rgba(239, 68, 68, 0.12)',
  warn: 'rgba(245, 158, 11, 0.12)',
  info: 'transparent',
  log: 'transparent',
}

const LEVEL_COLOR: Record<string, string> = {
  error: '#ef4444',
  warn: '#f59e0b',
  info: 'var(--text-secondary)',
  log: 'var(--text-secondary)',
}

const SOURCE_COLOR: Record<string, string> = {
  renderer: '#7aa2ff',
  main: '#a78bfa',
  sidecar: '#34d399',
  agent: '#fb923c',
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return iso
  }
}

function fmtIsoLocal(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ── Token Gate ──

function TokenGate({ onSubmit, error }: { onSubmit: (token: string) => void; error: string | null }) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault()
      onSubmit(value.trim())
    }
  }

  return (
    <div className="welcome-area animate-fade-in" style={{ maxWidth: 480, margin: '8vh auto' }}>
      <h1 className="main-title">Klaud 모니터링</h1>
      <p className="sub-title">관리자 토큰을 입력하면 로그/제보를 조회할 수 있어.</p>
      <div className="glass" style={{ padding: 20, borderRadius: 12, marginTop: 20 }}>
        <label style={{ display: 'block', marginBottom: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          KLAUD_ADMIN_TOKEN
        </label>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Bearer 토큰 (env 와 동일한 값)"
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 8,
            border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
            color: 'var(--text-primary)', fontSize: '0.9rem', fontFamily: 'monospace',
          }}
        />
        <button
          type="button"
          disabled={!value.trim()}
          onClick={() => value.trim() && onSubmit(value.trim())}
          style={{
            marginTop: 12, padding: '10px 16px', borderRadius: 8,
            background: 'var(--accent, #7aa2ff)', color: '#fff', border: 'none',
            cursor: value.trim() ? 'pointer' : 'not-allowed',
            opacity: value.trim() ? 1 : 0.5, fontSize: '0.9rem', fontWeight: 600,
          }}
        >저장 후 진입</button>
        {error && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', fontSize: '0.85rem' }}>
            {error}
          </div>
        )}
        <div style={{ marginTop: 16, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          • 토큰은 브라우저 localStorage 에만 저장됨 (서버 전송 X).<br/>
          • 401 발생 시 자동으로 재입력 prompt.<br/>
          • 서버 env <code>KLAUD_ADMIN_TOKEN</code> 미설정이면 503 반환.
        </div>
      </div>
    </div>
  )
}

// ── Filters ──

interface FilterState {
  user_email: string
  machine_id: string
  session_id: string
  source: string
  level: string
  ts_from: string
  ts_to: string
}

const EMPTY_FILTER: FilterState = {
  user_email: '', machine_id: '', session_id: '', source: '', level: '', ts_from: '', ts_to: '',
}

function FilterBar({
  filter,
  onChange,
  onApply,
  onReset,
  loading,
  tab,
}: {
  filter: FilterState
  onChange: (f: FilterState) => void
  onApply: () => void
  onReset: () => void
  loading: boolean
  tab: KlaudTab
}) {
  const handleEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onApply()
    }
  }
  const inputStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.85rem',
    minWidth: 0,
  }

  return (
    <div
      className="glass"
      style={{
        padding: 12, borderRadius: 10, marginBottom: 12,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 8,
      }}
      onKeyDown={handleEnter}
    >
      <input
        type="text" placeholder="user_email" value={filter.user_email}
        onChange={e => onChange({ ...filter, user_email: e.target.value })} style={inputStyle}
      />
      <input
        type="text" placeholder="machine_id" value={filter.machine_id}
        onChange={e => onChange({ ...filter, machine_id: e.target.value })} style={inputStyle}
      />
      {tab === 'logs' && (
        <>
          <input
            type="text" placeholder="session_id" value={filter.session_id}
            onChange={e => onChange({ ...filter, session_id: e.target.value })} style={inputStyle}
          />
          <select
            value={filter.source}
            onChange={e => onChange({ ...filter, source: e.target.value })} style={inputStyle}
          >
            <option value="">source: all</option>
            <option value="renderer">renderer</option>
            <option value="main">main</option>
            <option value="sidecar">sidecar</option>
            <option value="agent">agent</option>
          </select>
          <select
            value={filter.level}
            onChange={e => onChange({ ...filter, level: e.target.value })} style={inputStyle}
          >
            <option value="">level: all</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="log">log</option>
          </select>
        </>
      )}
      <input
        type="datetime-local" value={filter.ts_from} title="ts_from"
        onChange={e => onChange({ ...filter, ts_from: e.target.value })} style={inputStyle}
      />
      <input
        type="datetime-local" value={filter.ts_to} title="ts_to"
        onChange={e => onChange({ ...filter, ts_to: e.target.value })} style={inputStyle}
      />
      <div style={{ display: 'flex', gap: 6, gridColumn: '1 / -1' }}>
        <button
          type="button" onClick={onApply} disabled={loading}
          style={{
            padding: '6px 14px', borderRadius: 6, background: 'var(--accent, #7aa2ff)',
            color: '#fff', border: 'none', cursor: loading ? 'wait' : 'pointer',
            fontSize: '0.85rem', fontWeight: 600,
          }}
        >{loading ? '조회 중…' : '조회'}</button>
        <button
          type="button" onClick={onReset}
          style={{
            padding: '6px 14px', borderRadius: 6, background: 'transparent',
            color: 'var(--text-primary)', border: '1px solid var(--border-color)',
            cursor: 'pointer', fontSize: '0.85rem',
          }}
        >리셋</button>
      </div>
    </div>
  )
}

// ── Logs Tab ──

function LogRow({ log, expanded, onToggle }: {
  log: KlaudLogEntry; expanded: boolean; onToggle: () => void
}) {
  const hasExtra = log.extra && Object.keys(log.extra).length > 0
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: hasExtra ? 'pointer' : 'default',
          background: LEVEL_BG[log.level] || 'transparent',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <td style={{ padding: '6px 10px', fontSize: '0.78rem', fontFamily: 'monospace', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
          {fmtTime(log.ts)}
        </td>
        <td style={{ padding: '6px 10px', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
          <span style={{ color: SOURCE_COLOR[log.source] || 'inherit', fontWeight: 600 }}>{log.source}</span>
        </td>
        <td style={{ padding: '6px 10px', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
          <span style={{ color: LEVEL_COLOR[log.level], fontWeight: 600 }}>{log.level}</span>
        </td>
        <td style={{ padding: '6px 10px', fontSize: '0.82rem', wordBreak: 'break-word' }}>
          {log.message}
          {hasExtra && (
            <span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              {expanded ? '▾' : '▸'} extra
            </span>
          )}
        </td>
        <td style={{ padding: '6px 10px', fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {log.user_email || log.machine_id?.slice(0, 8) || '—'}
        </td>
      </tr>
      {expanded && hasExtra && (
        <tr style={{ background: 'var(--bg-secondary)' }}>
          <td colSpan={5} style={{ padding: '8px 14px' }}>
            <pre style={{
              margin: 0, fontSize: '0.75rem', fontFamily: 'monospace',
              color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{JSON.stringify(log.extra, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  )
}

function LogsTab({
  filter, refreshTick,
}: {
  filter: FilterState; refreshTick: number;
}) {
  const [logs, setLogs] = useState<KlaudLogEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const filterToApi = (cursorOverride?: number | null): KlaudLogsFilter => ({
    user_email: filter.user_email || undefined,
    machine_id: filter.machine_id || undefined,
    session_id: filter.session_id || undefined,
    source: filter.source || undefined,
    level: filter.level || undefined,
    ts_from: filter.ts_from ? new Date(filter.ts_from).toISOString() : undefined,
    ts_to: filter.ts_to ? new Date(filter.ts_to).toISOString() : undefined,
    cursor: cursorOverride ?? undefined,
    limit: 100,
  })

  const load = useCallback(async (cursorOverride: number | null, append: boolean) => {
    setLoading(true); setErr(null)
    try {
      const r: KlaudLogsResponse = await fetchKlaudLogs(filterToApi(cursorOverride))
      setLogs(prev => append ? [...prev, ...r.logs] : r.logs)
      setNextCursor(r.next_cursor)
      if (!append) setCursor(null)
    } catch (e) {
      if (e instanceof KlaudAuthError) throw e
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // 필터 변경 / 재조회 트리거 시 처음부터
  useEffect(() => { load(null, false) }, [load, refreshTick])

  const toggleExpand = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {logs.length}건 표시 {nextCursor !== null && '(더 있음)'}
        </span>
        {err && <span style={{ color: '#ef4444', fontSize: '0.82rem' }}>오류: {err}</span>}
      </div>

      <div className="glass" style={{ borderRadius: 10, overflow: 'auto', maxHeight: '70vh' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 1 }}>
            <tr>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>ts</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>source</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>level</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>message</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>who</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(log => (
              <LogRow key={log.id} log={log} expanded={expanded.has(log.id)} onToggle={() => toggleExpand(log.id)} />
            ))}
            {logs.length === 0 && !loading && (
              <tr>
                <td colSpan={5} style={{ padding: 30, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  조건에 맞는 로그가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor !== null && (
        <div style={{ marginTop: 10, textAlign: 'center' }}>
          <button
            type="button" onClick={() => { setCursor(nextCursor); load(nextCursor, true) }}
            disabled={loading}
            style={{
              padding: '8px 18px', borderRadius: 6, background: 'transparent',
              color: 'var(--text-primary)', border: '1px solid var(--border-color)',
              cursor: loading ? 'wait' : 'pointer', fontSize: '0.85rem',
            }}
          >{loading ? '로딩…' : '더 보기 (Next)'}</button>
          <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            cursor={cursor ?? 0} → {nextCursor}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Reports Tab ──

function ReportsTab({
  filter, refreshTick, onAuthError,
}: {
  filter: FilterState; refreshTick: number; onAuthError: (e: KlaudAuthError) => void
}) {
  const [reports, setReports] = useState<KlaudReportSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<KlaudReportDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetchKlaudReports({
        user_email: filter.user_email || undefined,
        machine_id: filter.machine_id || undefined,
        ts_from: filter.ts_from ? new Date(filter.ts_from).toISOString() : undefined,
        ts_to: filter.ts_to ? new Date(filter.ts_to).toISOString() : undefined,
        limit: 100,
      })
      setReports(r.reports)
    } catch (e) {
      if (e instanceof KlaudAuthError) onAuthError(e)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filter, onAuthError])

  useEffect(() => { load() }, [load, refreshTick])

  // 선택된 report 상세 로드
  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    setDetailLoading(true)
    fetchKlaudReport(selectedId)
      .then(setDetail)
      .catch(e => {
        if (e instanceof KlaudAuthError) onAuthError(e)
        else setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setDetailLoading(false))
  }, [selectedId, onAuthError])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 12 }}>
      {/* 목록 */}
      <div className="glass" style={{ borderRadius: 10, padding: 8, maxHeight: '70vh', overflow: 'auto' }}>
        <div style={{ padding: '4px 8px 8px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          {reports.length}개 제보
          {err && <span style={{ color: '#ef4444', marginLeft: 8 }}>오류: {err}</span>}
        </div>
        {reports.map(rep => (
          <div
            key={rep.report_uuid}
            onClick={() => setSelectedId(rep.report_uuid)}
            style={{
              padding: 10, borderRadius: 8, cursor: 'pointer', marginBottom: 4,
              background: selectedId === rep.report_uuid ? 'var(--accent, #7aa2ff)' : 'transparent',
              color: selectedId === rep.report_uuid ? '#fff' : 'var(--text-primary)',
              border: '1px solid ' + (selectedId === rep.report_uuid ? 'var(--accent, #7aa2ff)' : 'var(--border-color)'),
            }}
          >
            <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: 2 }}>
              {rep.note?.slice(0, 80) || '(메모 없음)'}
            </div>
            <div style={{ fontSize: '0.72rem', opacity: 0.85 }}>
              {fmtTime(rep.ts)} · {rep.user_email || rep.machine_id.slice(0, 8)}
              {rep.klaud_version && ` · v${rep.klaud_version}`}
            </div>
          </div>
        ))}
        {reports.length === 0 && !loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
            제보가 없습니다.
          </div>
        )}
      </div>

      {/* 상세 */}
      <div className="glass" style={{ borderRadius: 10, padding: 16, maxHeight: '70vh', overflow: 'auto' }}>
        {!selectedId && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-secondary)' }}>
            왼쪽에서 제보를 선택하면 상세 + 묶인 로그가 표시됩니다.
          </div>
        )}
        {selectedId && detailLoading && (
          <div style={{ color: 'var(--text-secondary)' }}>로딩 중…</div>
        )}
        {detail && <ReportDetail detail={detail} />}
      </div>
    </div>
  )
}

function ReportDetail({ detail }: { detail: KlaudReportDetail }) {
  const [shotOpen, setShotOpen] = useState(false)
  const r = detail.report
  return (
    <div>
      <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{r.note || '(메모 없음)'}</h3>
      <div style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
        report_uuid: <code>{r.report_uuid}</code> · {fmtTime(r.ts)}
      </div>
      <div style={{ marginTop: 10, fontSize: '0.82rem', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <span>user: <code>{r.user_email || '—'}</code></span>
        <span>machine: <code>{r.machine_id.slice(0, 12)}…</code></span>
        <span>session: <code>{r.session_id?.slice(0, 12) || '—'}…</code></span>
        {r.klaud_version && <span>v{r.klaud_version}</span>}
      </div>

      {r.context && (
        <details open style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>context</summary>
          <pre style={{
            margin: '6px 0 0', padding: 10, borderRadius: 6, background: 'var(--bg-secondary)',
            fontSize: '0.78rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap',
          }}>{JSON.stringify(r.context, null, 2)}</pre>
        </details>
      )}

      {r.screenshot_b64 && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button" onClick={() => setShotOpen(true)}
            style={{
              padding: '6px 12px', borderRadius: 6, background: 'var(--accent, #7aa2ff)',
              color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.82rem',
            }}
          >📷 스크린샷 펼쳐 보기</button>
        </div>
      )}

      <h4 style={{ marginTop: 18, marginBottom: 6, fontSize: '0.95rem' }}>
        묶인 로그 (직전 {detail.log_window_minutes}분 · {detail.logs.length}건)
      </h4>
      <div style={{ borderRadius: 6, overflow: 'auto', maxHeight: 320, border: '1px solid var(--border-color)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <tbody>
            {detail.logs.map(log => (
              <tr
                key={log.id}
                style={{
                  background: LEVEL_BG[log.level] || 'transparent',
                  borderBottom: '1px solid var(--border-color)',
                }}
              >
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  {fmtTime(log.ts)}
                </td>
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: SOURCE_COLOR[log.source] || 'inherit' }}>{log.source}</span>
                </td>
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: LEVEL_COLOR[log.level] }}>{log.level}</span>
                </td>
                <td style={{ padding: '4px 8px', wordBreak: 'break-word' }}>{log.message}</td>
              </tr>
            ))}
            {detail.logs.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 14, textAlign: 'center', color: 'var(--text-secondary)' }}>이 window 에 로그가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {shotOpen && r.screenshot_b64 && (
        <ScreenshotModal b64={r.screenshot_b64} onClose={() => setShotOpen(false)} />
      )}
    </div>
  )
}

function ScreenshotModal({ b64, onClose }: { b64: string; onClose: () => void }) {
  // ESC 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <img
        src={src} alt="screenshot"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}
      />
    </div>
  )
}

// ── Main Page ──

function KlaudAdminPage() {
  // theme
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    (localStorage.getItem('qna-theme') as ThemeMode) || 'system'
  )
  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode)
    localStorage.setItem('qna-theme', mode)
    applyTheme(mode)
  }, [])
  useEffect(() => { applyTheme(themeMode) }, [themeMode])

  // token gate
  const [token, setToken] = useState<string | null>(() => getKlaudAdminToken())
  const [authErr, setAuthErr] = useState<string | null>(null)
  const handleSubmitToken = (t: string) => {
    setKlaudAdminToken(t)
    setToken(t)
    setAuthErr(null)
    setRefreshTick(x => x + 1)
  }
  const handleAuthError = (e: KlaudAuthError) => {
    clearKlaudAdminToken()
    setToken(null)
    setAuthErr(e.status === 503
      ? '서버 env KLAUD_ADMIN_TOKEN 미설정. 운영자에게 문의.'
      : '관리자 토큰이 잘못됨 (401). 다시 입력.')
  }

  // tab
  const [tab, setTab] = useState<KlaudTab>(() => {
    const saved = localStorage.getItem('klaud-admin-tab')
    if (saved === 'reports' || saved === 'crawl') return saved
    return 'logs'
  })
  const switchTab = (t: KlaudTab) => {
    setTab(t)
    localStorage.setItem('klaud-admin-tab', t)
  }

  // filter (입력 vs 적용 분리 — 입력만 바꾸고 [조회] 눌러야 반영)
  const [draftFilter, setDraftFilter] = useState<FilterState>(EMPTY_FILTER)
  const [appliedFilter, setAppliedFilter] = useState<FilterState>(EMPTY_FILTER)
  const [refreshTick, setRefreshTick] = useState(0)

  const apply = () => {
    setAppliedFilter(draftFilter)
    setRefreshTick(x => x + 1)
  }
  const reset = () => {
    setDraftFilter(EMPTY_FILTER)
    setAppliedFilter(EMPTY_FILTER)
    setRefreshTick(x => x + 1)
  }

  // auto-refresh (default OFF, 15s)
  const [autoRefresh, setAutoRefresh] = useState(false)
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => setRefreshTick(x => x + 1), 15000)
    return () => clearInterval(id)
  }, [autoRefresh])

  // stats (queue size / dropped count) — token 있을 때만, 30초마다
  const [stats, setStats] = useState<KlaudStats | null>(null)
  useEffect(() => {
    if (!token) { setStats(null); return }
    let cancelled = false
    const load = async () => {
      try {
        const s = await fetchKlaudStats()
        if (!cancelled) setStats(s)
      } catch (e) {
        if (e instanceof KlaudAuthError) handleAuthError(e)
      }
    }
    load()
    const id = setInterval(load, 30000)
    return () => { cancelled = true; clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refreshTick])

  const handleLogout = () => {
    clearKlaudAdminToken()
    setToken(null)
    setStats(null)
    setAuthErr(null)
  }

  // helpful preset: ts_to = now, ts_from = 1h ago
  const presetLastHour = () => {
    const now = new Date()
    const past = new Date(now.getTime() - 60 * 60 * 1000)
    setDraftFilter({ ...draftFilter, ts_from: fmtIsoLocal(past), ts_to: fmtIsoLocal(now) })
  }

  if (!token) {
    return (
      <div className="app-container" style={{ padding: 20 }}>
        <TokenGate onSubmit={handleSubmitToken} error={authErr} />
      </div>
    )
  }

  return (
    <div className="app-container" style={{ padding: '14px 20px 30px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: '1.15rem' }}>Klaud 모니터링</h1>
          {stats && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              총 {stats.log_count?.toLocaleString()} 로그 · {stats.report_count} 제보
              {stats.queue_size != null && stats.queue_size > 0 && (
                <span> · 큐 {stats.queue_size}</span>
              )}
              {stats.dropped_count != null && stats.dropped_count > 0 && (
                <span style={{ color: '#f59e0b' }}> · drop {stats.dropped_count}</span>
              )}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.82rem', cursor: 'pointer' }}>
            <input
              type="checkbox" checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            자동 새로고침 15s
          </label>
          <button
            type="button" onClick={() => setRefreshTick(x => x + 1)}
            style={{
              padding: '4px 12px', borderRadius: 6, background: 'transparent',
              border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: '0.82rem',
              color: 'var(--text-primary)',
            }}
          >↻ 새로고침</button>
          <a
            href={`${import.meta.env.BASE_URL}admin`}
            style={{
              padding: '4px 12px', borderRadius: 6, background: 'transparent',
              border: '1px solid var(--border-color)', textDecoration: 'none',
              color: 'var(--text-primary)', fontSize: '0.82rem',
            }}
          >← Admin</a>
          <button
            type="button" onClick={handleLogout} title="토큰 삭제"
            style={{
              padding: '4px 12px', borderRadius: 6, background: 'transparent',
              border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: '0.82rem',
              color: 'var(--text-secondary)',
            }}
          >로그아웃</button>
          <div className="theme-selector" style={{ display: 'flex', gap: 4 }}>
            <button className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => handleThemeChange('system')}>S</button>
            <button className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>☀</button>
            <button className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>🌙</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: '1px solid var(--border-color)' }}>
        <button
          type="button" onClick={() => switchTab('logs')}
          style={{
            padding: '8px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
            borderBottom: tab === 'logs' ? '2px solid var(--accent, #7aa2ff)' : '2px solid transparent',
            color: tab === 'logs' ? 'var(--accent, #7aa2ff)' : 'var(--text-secondary)',
            fontWeight: tab === 'logs' ? 700 : 500, fontSize: '0.92rem',
          }}
        >📋 로그</button>
        <button
          type="button" onClick={() => switchTab('reports')}
          style={{
            padding: '8px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
            borderBottom: tab === 'reports' ? '2px solid var(--accent, #7aa2ff)' : '2px solid transparent',
            color: tab === 'reports' ? 'var(--accent, #7aa2ff)' : 'var(--text-secondary)',
            fontWeight: tab === 'reports' ? 700 : 500, fontSize: '0.92rem',
          }}
        >🚩 제보</button>
        <button
          type="button" onClick={() => switchTab('crawl')}
          style={{
            padding: '8px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
            borderBottom: tab === 'crawl' ? '2px solid var(--accent, #7aa2ff)' : '2px solid transparent',
            color: tab === 'crawl' ? 'var(--accent, #7aa2ff)' : 'var(--text-secondary)',
            fontWeight: tab === 'crawl' ? 700 : 500, fontSize: '0.92rem',
          }}
        >📦 크롤</button>
        <div style={{ flex: 1 }} />
        <button
          type="button" onClick={presetLastHour}
          style={{
            padding: '4px 12px', borderRadius: 6, background: 'transparent',
            border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: '0.78rem',
            color: 'var(--text-secondary)', alignSelf: 'center',
          }}
          title="ts_from/to 를 직전 1시간으로 설정"
        >최근 1시간</button>
      </div>

      {tab !== 'crawl' && (
        <FilterBar
          filter={draftFilter} onChange={setDraftFilter}
          onApply={apply} onReset={reset} loading={false} tab={tab}
        />
      )}

      {tab === 'crawl' ? (
        <CrawlTab refreshTick={refreshTick} onAuthError={handleAuthError} />
      ) : (
        <KlaudTabContent
          tab={tab}
          filter={appliedFilter}
          refreshTick={refreshTick}
          onAuthError={handleAuthError}
        />
      )}
    </div>
  )
}

function KlaudTabContent({
  tab, filter, refreshTick, onAuthError,
}: {
  tab: 'logs' | 'reports'; filter: FilterState; refreshTick: number; onAuthError: (e: KlaudAuthError) => void
}) {
  // 인증 에러 catch 도 여기서
  const filterMemo = useMemo(() => filter, [filter])
  if (tab === 'logs') {
    return <LogsBoundary filter={filterMemo} refreshTick={refreshTick} onAuthError={onAuthError} />
  }
  return <ReportsTab filter={filterMemo} refreshTick={refreshTick} onAuthError={onAuthError} />
}

// ── Crawl Tab ──

function CrawlTab({ refreshTick, onAuthError }: {
  refreshTick: number; onAuthError: (e: KlaudAuthError) => void
}) {
  const [resources, setResources] = useState<KlaudCrawlResource[]>([])
  const [stats, setStats] = useState<KlaudCrawlStats | null>(null)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // filter (입력 즉시 적용 — crawl 은 가볍게)
  const [filterSource, setFilterSource] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterQ, setFilterQ] = useState('')

  const load = useCallback(async (append = false, cursor?: number | null) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetchKlaudCrawlResources({
        source: filterSource || undefined,
        status: filterStatus || undefined,
        q: filterQ || undefined,
        cursor: cursor ?? undefined,
        limit: 100,
      })
      setResources(prev => append ? [...prev, ...r.resources] : r.resources)
      setNextCursor(r.next_cursor)
      if (!append) setSelected(new Set())
    } catch (e) {
      if (e instanceof KlaudAuthError) onAuthError(e)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filterSource, filterStatus, filterQ, onAuthError])

  const loadStats = useCallback(async () => {
    try {
      const s = await fetchKlaudCrawlStats()
      setStats(s)
    } catch (e) {
      if (e instanceof KlaudAuthError) onAuthError(e)
    }
  }, [onAuthError])

  useEffect(() => { load(false) }, [load, refreshTick])
  useEffect(() => { loadStats() }, [loadStats, refreshTick])

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedRows = resources.filter(r => selected.has(r.id))

  // 선택된 행이 모두 같은 source 일 때만 액션 가능
  const selectedSource = useMemo(() => {
    if (selectedRows.length === 0) return null
    const s0 = selectedRows[0].source
    return selectedRows.every(r => r.source === s0) ? s0 : null
  }, [selectedRows])

  const doPurge = async () => {
    if (!selectedSource || selectedRows.length === 0) return
    if (!confirm(`${selectedRows.length}개 리소스 purge? ChromaDB chunk 제거는 Phase B 에서.`)) return
    try {
      await purgeKlaudCrawl(selectedSource, selectedRows.map(r => r.resource_path))
      load(false)
      loadStats()
    } catch (e) {
      if (e instanceof KlaudAuthError) onAuthError(e)
      else setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const doReindex = async () => {
    if (!selectedSource || selectedRows.length === 0) return
    try {
      await reindexKlaudCrawl(selectedSource, selectedRows.map(r => r.resource_path), false)
      load(false)
      loadStats()
    } catch (e) {
      if (e instanceof KlaudAuthError) onAuthError(e)
      else setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.85rem',
  }

  return (
    <div>
      {/* Stats 헤더 */}
      {stats && (
        <div className="glass" style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 12, display: 'flex', gap: 18, fontSize: '0.85rem', flexWrap: 'wrap' }}>
          <span>📊 총 <strong>{stats.total}</strong></span>
          <span style={{ color: '#34d399' }}>fresh: {stats.fresh}</span>
          <span style={{ color: '#f59e0b' }}>stale: {stats.stale}</span>
          <span style={{ color: '#ef4444' }}>failed: {stats.failed}</span>
          <span style={{ color: '#6b7280' }}>purged: {stats.purged}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            last cron-tick: {stats.last_cron_tick_at ? fmtTime(stats.last_cron_tick_at) : '—'}
          </span>
        </div>
      )}

      {/* Filter bar */}
      <div className="glass" style={{ padding: 12, borderRadius: 10, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select value={filterSource} onChange={e => setFilterSource(e.target.value)} style={inputStyle}>
          <option value="">source: all</option>
          <option value="p4-xlsx">P4 / XLSX</option>
          <option value="confluence-projk">Confluence / Project K</option>
          <option value="confluence-art">Confluence / Art</option>
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={inputStyle}>
          <option value="">status: all</option>
          <option value="fresh">fresh</option>
          <option value="stale">stale</option>
          <option value="failed">failed</option>
          <option value="purged">purged</option>
        </select>
        <input
          type="text" placeholder="path 검색 (LIKE)"
          value={filterQ} onChange={e => setFilterQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') load(false) }}
          style={{ ...inputStyle, minWidth: 240 }}
        />
        <div style={{ flex: 1 }} />
        {selectedRows.length > 0 && (
          <>
            <span style={{ alignSelf: 'center', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              {selectedRows.length}개 선택 {selectedSource ? `(${selectedSource})` : '(서로 다른 source — 액션 불가)'}
            </span>
            <button
              type="button" onClick={doReindex} disabled={!selectedSource}
              style={{
                padding: '6px 12px', borderRadius: 6, background: selectedSource ? 'var(--accent, #7aa2ff)' : 'transparent',
                color: selectedSource ? '#fff' : 'var(--text-secondary)',
                border: 'none', cursor: selectedSource ? 'pointer' : 'not-allowed', fontSize: '0.82rem',
              }}
            >🔄 Reindex (stale)</button>
            <button
              type="button" onClick={doPurge} disabled={!selectedSource}
              style={{
                padding: '6px 12px', borderRadius: 6, background: selectedSource ? '#ef4444' : 'transparent',
                color: selectedSource ? '#fff' : 'var(--text-secondary)',
                border: 'none', cursor: selectedSource ? 'pointer' : 'not-allowed', fontSize: '0.82rem',
              }}
            >🗑 Purge</button>
          </>
        )}
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: 8 }}>오류: {err}</div>}

      {/* Resources table */}
      <div className="glass" style={{ borderRadius: 10, overflow: 'auto', maxHeight: '60vh' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 1 }}>
            <tr>
              <th style={{ padding: '8px 10px', width: 28 }}>
                <input
                  type="checkbox"
                  checked={resources.length > 0 && selected.size === resources.length}
                  onChange={e => setSelected(e.target.checked ? new Set(resources.map(r => r.id)) : new Set())}
                />
              </th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>source</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>path</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>status</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>last indexed</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>chunks</th>
            </tr>
          </thead>
          <tbody>
            {resources.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '6px 10px' }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} />
                </td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
                  {CRAWL_SOURCE_LABEL[r.source] ?? r.source}
                </td>
                <td style={{ padding: '6px 10px', wordBreak: 'break-all', fontSize: '0.82rem' }}>
                  {r.resource_path}
                  {r.error_msg && (
                    <div style={{ marginTop: 2, fontSize: '0.72rem', color: '#ef4444' }}>⚠ {r.error_msg}</div>
                  )}
                </td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
                  <span style={{ color: CRAWL_STATUS_COLOR[r.status], fontWeight: 600 }}>{r.status}</span>
                </td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {r.last_indexed_at ? fmtTime(r.last_indexed_at) : '—'}
                </td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {r.chunk_count}
                </td>
              </tr>
            ))}
            {resources.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ padding: 30, textAlign: 'center', color: 'var(--text-secondary)' }}>
                  {filterSource || filterStatus || filterQ ? '조건에 맞는 리소스가 없습니다.' : '아직 크롤된 리소스가 없습니다. cron-tick 또는 klaud-crawl CLI 실행 후 표시됩니다.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor !== null && (
        <div style={{ marginTop: 10, textAlign: 'center' }}>
          <button
            type="button" onClick={() => load(true, nextCursor)} disabled={loading}
            style={{
              padding: '8px 18px', borderRadius: 6, background: 'transparent',
              color: 'var(--text-primary)', border: '1px solid var(--border-color)',
              cursor: loading ? 'wait' : 'pointer', fontSize: '0.85rem',
            }}
          >{loading ? '로딩…' : '더 보기 (Next)'}</button>
        </div>
      )}
    </div>
  )
}

function LogsBoundary({
  filter, refreshTick, onAuthError,
}: {
  filter: FilterState; refreshTick: number; onAuthError: (e: KlaudAuthError) => void
}) {
  // LogsTab 의 load() 내부에서 throw 한 KlaudAuthError 를 잡아 상위로 알림
  const [errKey, setErrKey] = useState(0)
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof KlaudAuthError) {
        onAuthError(e.reason)
        e.preventDefault()
        setErrKey(k => k + 1)
      }
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [onAuthError])
  return <LogsTab key={errKey} filter={filter} refreshTick={refreshTick} />
}

export default KlaudAdminPage
