import { useState, useEffect, useCallback } from 'react'
import {
  fetchPipelineStatus, fetchPipelineSources, fetchPipelineDocuments,
  fetchPipelineJobs, fetchPipelineIssues, triggerPipelineJob, fetchCrawlLogs,
} from './api'
import type {
  PipelineStats, PipelineSource, PipelineDocument,
  PipelineJob, PipelineIssue, CrawlLog,
} from './api'

const STATUS_COLORS: Record<string, string> = {
  new: '#6b7280', crawled: '#3b82f6', captured: '#8b5cf6',
  downloaded: '#8b5cf6', converted: '#f59e0b', enriched: '#a855f7', indexed: '#22c55e', error: '#ef4444',
  pending: '#6b7280', assigned: '#3b82f6', running: '#f59e0b',
  completed: '#22c55e', failed: '#ef4444', cancelled: '#9ca3af',
  open: '#ef4444', in_progress: '#f59e0b', resolved: '#22c55e',
  wont_fix: '#9ca3af',
}

const StatusBadge = ({ status }: { status: string }) => (
  <span style={{
    display: 'inline-block', padding: '2px 8px', borderRadius: 12,
    fontSize: '0.75rem', fontWeight: 600,
    background: (STATUS_COLORS[status] || '#6b7280') + '22',
    color: STATUS_COLORS[status] || '#6b7280',
  }}>{status}</span>
)

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  // DB에 UTC로 저장됨 — 'Z' 붙여서 UTC 파싱 후 KST 변환
  const raw = iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z'
  const d = new Date(raw)
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type Tab = 'overview' | 'sources' | 'documents' | 'jobs' | 'issues' | 'crawl-logs'

function PipelinePage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [sources, setSources] = useState<PipelineSource[]>([])
  const [documents, setDocuments] = useState<PipelineDocument[]>([])
  const [docTotal, setDocTotal] = useState(0)
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  const [jobStats, setJobStats] = useState<Record<string, number>>({})
  const [issues, setIssues] = useState<PipelineIssue[]>([])
  const [crawlLogs, setCrawlLogs] = useState<CrawlLog[]>([])
  const [crawlLogFilter, setCrawlLogFilter] = useState<number | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [docFilter, setDocFilter] = useState<{ sourceId?: number; status?: string }>({})
  const [jobFilter, setJobFilter] = useState<string | undefined>()

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [s, src] = await Promise.all([fetchPipelineStatus(), fetchPipelineSources()])
      setStats(s)
      setSources(src.sources)
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Tab-specific data loading
  useEffect(() => {
    if (tab === 'documents') {
      fetchPipelineDocuments(docFilter.sourceId, docFilter.status)
        .then(r => { setDocuments(r.documents); setDocTotal(r.total) })
        .catch(() => {})
    } else if (tab === 'jobs') {
      fetchPipelineJobs(jobFilter)
        .then(r => { setJobs(r.jobs); setJobStats(r.stats) })
        .catch(() => {})
    } else if (tab === 'issues') {
      fetchPipelineIssues()
        .then(r => setIssues(r.issues))
        .catch(() => {})
    } else if (tab === 'crawl-logs') {
      fetchCrawlLogs(crawlLogFilter)
        .then(r => setCrawlLogs(r.logs))
        .catch(() => {})
    }
  }, [tab, docFilter, jobFilter, crawlLogFilter])

  // running 작업이 있으면 3초마다 자동 새로고침 (작업큐 + 전체현황)
  useEffect(() => {
    const hasRunning = jobs.some(j => j.status === 'running')
    if (!hasRunning) return
    const timer = setInterval(() => {
      fetchPipelineJobs(jobFilter)
        .then(r => { setJobs(r.jobs); setJobStats(r.stats) })
        .catch(() => {})
      if (tab === 'overview') {
        loadData()
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [jobs, tab, jobFilter, loadData])

  const handleTrigger = async (jobType: string, sourceId?: number, documentId?: number) => {
    try {
      await triggerPipelineJob(jobType, sourceId, documentId)
      // Reload jobs
      const r = await fetchPipelineJobs()
      setJobs(r.jobs)
      setJobStats(r.stats)
      setTab('jobs')
    } catch (e) {
      alert('트리거 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (loading && !stats) return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>로딩 중...</div>
  if (error) return <div style={{ padding: 40, color: '#ef4444' }}>연결 실패: {error}</div>

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 8 }}>데이터 파이프라인</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
        기획서 크롤링 → 변환 → 인덱싱 현황
      </p>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 4 }}>
        {(['overview', 'sources', 'documents', 'jobs', 'issues', 'crawl-logs'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
            background: 'transparent',
            color: tab === t ? '#2563eb' : '#374151',
            fontWeight: tab === t ? 600 : 500, fontSize: '0.85rem',
            borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
          }}>
            {t === 'overview' ? '전체 현황' : t === 'sources' ? '소스' : t === 'documents' ? '문서' : t === 'jobs' ? '작업큐' : t === 'issues' ? '이슈' : '크롤 로그'}
            {t === 'issues' && stats?.issues?.open ? ` (${stats.issues.open})` : ''}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && stats && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
            <StatCard label="크롤링 소스" value={stats.sources} onClick={() => setTab('sources')} />
            <StatCard label="전체 문서" value={stats.documents.total} onClick={() => setTab('documents')} />
            <StatCard label="인덱싱 완료" value={stats.documents.by_status?.indexed || 0} color="#22c55e" onClick={() => { setDocFilter({ status: 'indexed' }); setTab('documents') }} />
            <StatCard label="오류" value={stats.documents.by_status?.error || 0} color="#ef4444" onClick={() => { setDocFilter({ status: 'error' }); setTab('documents') }} />
            <StatCard label="대기 작업" value={stats.jobs?.pending || 0} color="#f59e0b" onClick={() => { setJobFilter('pending'); setTab('jobs') }} />
            <StatCard label="미해결 이슈" value={stats.issues?.open || 0} color="#ef4444" onClick={() => setTab('issues')} />
          </div>

          {/* Document status bar */}
          {stats.documents.total > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ marginBottom: 8 }}>문서 상태 분포</h4>
              <div style={{ display: 'flex', height: 24, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-secondary)' }}>
                {Object.entries(stats.documents.by_status || {}).map(([status, count]) => (
                  <div key={status} title={`${status}: ${count}`} style={{
                    width: `${(count / stats.documents.total) * 100}%`,
                    background: STATUS_COLORS[status] || '#6b7280',
                    minWidth: count > 0 ? 2 : 0,
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
                {Object.entries(stats.documents.by_status || {}).map(([status, count]) => (
                  <span key={status} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[status], marginRight: 4 }} />
                    {status}: {count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Active snapshot */}
          {stats.active_snapshot && (
            <div className="glass" style={{ padding: 16, borderRadius: 12 }}>
              <h4>활성 인덱스</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {stats.active_snapshot.snapshot_name} · {stats.active_snapshot.chunk_count} 청크 · {formatTime(stats.active_snapshot.created_at)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Sources */}
      {tab === 'sources' && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px' }}>ID</th>
                <th style={{ padding: '8px 12px' }}>이름</th>
                <th style={{ padding: '8px 12px' }}>타입</th>
                <th style={{ padding: '8px 12px' }}>변환 전략</th>
                <th style={{ padding: '8px 12px' }}>스케줄</th>
                <th style={{ padding: '8px 12px' }}>마지막 크롤링</th>
                <th style={{ padding: '8px 12px' }}>액션</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '8px 12px' }}>{s.id}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{s.name}</td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={s.source_type} /></td>
                  <td style={{ padding: '8px 12px' }}>{s.convert_strategy}</td>
                  <td style={{ padding: '8px 12px' }}>{s.schedule}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                    {s.last_crawled_at ? <>{formatTime(s.last_crawled_at)}<br/><span style={{ fontSize: '0.7rem' }}>{s.last_crawl_summary}</span></> : '-'}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <button onClick={() => handleTrigger('crawl', s.id)} style={{
                      padding: '4px 10px', fontSize: '0.75rem', border: '1px solid var(--border-color)',
                      borderRadius: 6, cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                    }}>크롤링</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Documents */}
      {tab === 'documents' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <select value={docFilter.sourceId || ''} onChange={e => setDocFilter(f => ({ ...f, sourceId: e.target.value ? Number(e.target.value) : undefined }))}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}>
              <option value="">모든 소스</option>
              {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={docFilter.status || ''} onChange={e => setDocFilter(f => ({ ...f, status: e.target.value || undefined }))}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}>
              <option value="">모든 상태</option>
              {['new', 'crawled', 'captured', 'converted', 'indexed', 'error'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', alignSelf: 'center' }}>{docTotal}건</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px' }}>ID</th>
                <th style={{ padding: '6px 10px' }}>제목</th>
                <th style={{ padding: '6px 10px' }}>타입</th>
                <th style={{ padding: '6px 10px' }}>상태</th>
                <th style={{ padding: '6px 10px' }}>최근 크롤링</th>
                <th style={{ padding: '6px 10px' }}>액션</th>
              </tr>
            </thead>
            <tbody>
              {documents.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '6px 10px' }}>{d.id}</td>
                  <td style={{ padding: '6px 10px' }}>{d.title || d.file_path}</td>
                  <td style={{ padding: '6px 10px' }}>{d.file_type}</td>
                  <td style={{ padding: '6px 10px' }}><StatusBadge status={d.status} /></td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(d.last_crawled_at)}</td>
                  <td style={{ padding: '6px 10px' }}>
                    <button onClick={() => handleTrigger('convert', undefined, d.id)} style={{
                      padding: '3px 8px', fontSize: '0.7rem', border: '1px solid var(--border-color)',
                      borderRadius: 4, cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                    }}>재변환</button>
                  </td>
                </tr>
              ))}
              {documents.length === 0 && <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>문서 없음</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Jobs */}
      {tab === 'jobs' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {['', 'pending', 'running', 'completed', 'failed'].map(s => (
              <button key={s} onClick={() => setJobFilter(s || undefined)} style={{
                padding: '4px 12px', fontSize: '0.8rem', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--border-color)',
                background: (jobFilter || '') === s ? '#2563eb' : 'var(--bg-secondary)',
                color: (jobFilter || '') === s ? '#fff' : 'var(--text-primary)',
              }}>
                {s || '전체'}{jobStats[s] ? ` (${jobStats[s]})` : ''}
              </button>
            ))}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px' }}>ID</th>
                <th style={{ padding: '6px 10px' }}>타입</th>
                <th style={{ padding: '6px 10px' }}>문서</th>
                <th style={{ padding: '6px 10px' }}>상태</th>
                <th style={{ padding: '6px 10px' }}>워커</th>
                <th style={{ padding: '6px 10px' }}>생성</th>
                <th style={{ padding: '6px 10px' }}>완료</th>
                <th style={{ padding: '6px 10px' }}>에러</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr key={j.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '6px 10px' }}>#{j.id}</td>
                  <td style={{ padding: '6px 10px' }}>{j.job_type}</td>
                  <td style={{ padding: '6px 10px', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.doc_title || j.doc_path || '-'}
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <StatusBadge status={j.status} />
                    {j.progress && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: '#2563eb' }}>{j.progress}</span>}
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{j.worker_id || '-'}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(j.created_at)}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(j.completed_at)}</td>
                  <td style={{ padding: '6px 10px', color: '#ef4444', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.error_message || ''}
                  </td>
                </tr>
              ))}
              {jobs.length === 0 && <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>작업 없음</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Issues */}
      {tab === 'issues' && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px' }}>ID</th>
                <th style={{ padding: '6px 10px' }}>심각도</th>
                <th style={{ padding: '6px 10px' }}>타입</th>
                <th style={{ padding: '6px 10px' }}>제목</th>
                <th style={{ padding: '6px 10px' }}>문서</th>
                <th style={{ padding: '6px 10px' }}>상태</th>
                <th style={{ padding: '6px 10px' }}>리포터</th>
                <th style={{ padding: '6px 10px' }}>등록일</th>
              </tr>
            </thead>
            <tbody>
              {issues.map(i => (
                <tr key={i.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '6px 10px' }}>#{i.id}</td>
                  <td style={{ padding: '6px 10px' }}><StatusBadge status={i.severity} /></td>
                  <td style={{ padding: '6px 10px' }}>{i.issue_type}</td>
                  <td style={{ padding: '6px 10px' }}>{i.title}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{i.doc_title || '-'}</td>
                  <td style={{ padding: '6px 10px' }}><StatusBadge status={i.status} /></td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{i.reported_by || '-'}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(i.created_at)}</td>
                </tr>
              ))}
              {issues.length === 0 && <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>이슈 없음</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Crawl Logs */}
      {tab === 'crawl-logs' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <select value={crawlLogFilter || ''} onChange={e => setCrawlLogFilter(e.target.value ? Number(e.target.value) : undefined)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}>
              <option value="">모든 소스</option>
              {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', alignSelf: 'center' }}>{crawlLogs.length}건</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px' }}>시각</th>
                <th style={{ padding: '6px 10px' }}>소스</th>
                <th style={{ padding: '6px 10px' }}>타입</th>
                <th style={{ padding: '6px 10px' }}>전체</th>
                <th style={{ padding: '6px 10px' }}>신규</th>
                <th style={{ padding: '6px 10px' }}>변경</th>
                <th style={{ padding: '6px 10px' }}>불변</th>
                <th style={{ padding: '6px 10px' }}>삭제</th>
                <th style={{ padding: '6px 10px' }}>에러</th>
                <th style={{ padding: '6px 10px' }}>소요</th>
              </tr>
            </thead>
            <tbody>
              {crawlLogs.map(cl => {
                return (
                  <tr key={cl.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(cl.created_at)}</td>
                    <td style={{ padding: '6px 10px', fontSize: '0.75rem' }}>{sources.find(s => s.id === cl.source_id)?.name || cl.source_id}</td>
                    <td style={{ padding: '6px 10px' }}><StatusBadge status={cl.crawl_type} /></td>
                    <td style={{ padding: '6px 10px' }}>{cl.total_files}</td>
                    <td style={{ padding: '6px 10px', color: cl.new_files > 0 ? '#22c55e' : 'var(--text-secondary)', fontWeight: cl.new_files > 0 ? 600 : 400 }}>
                      {cl.new_files > 0 ? `+${cl.new_files}` : '0'}
                    </td>
                    <td style={{ padding: '6px 10px', color: cl.changed_files > 0 ? '#f59e0b' : 'var(--text-secondary)', fontWeight: cl.changed_files > 0 ? 600 : 400 }}>
                      {cl.changed_files > 0 ? cl.changed_files : '0'}
                    </td>
                    <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{cl.unchanged_files}</td>
                    <td style={{ padding: '6px 10px', color: cl.deleted_files > 0 ? '#ef4444' : 'var(--text-secondary)' }}>
                      {cl.deleted_files > 0 ? `-${cl.deleted_files}` : '0'}
                    </td>
                    <td style={{ padding: '6px 10px', color: cl.errors > 0 ? '#ef4444' : 'var(--text-secondary)' }}>{cl.errors}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>
                      {cl.duration_sec != null ? `${cl.duration_sec.toFixed(1)}s` : '-'}
                    </td>
                  </tr>
                )
              })}
              {crawlLogs.length === 0 && <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>크롤 로그 없음</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color, onClick }: { label: string; value: number; color?: string; onClick?: () => void }) {
  return (
    <div className="glass" onClick={onClick} style={{
      padding: 16, borderRadius: 12, textAlign: 'center',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'transform 0.1s',
    }}
      onMouseEnter={e => onClick && (e.currentTarget.style.transform = 'scale(1.03)')}
      onMouseLeave={e => onClick && (e.currentTarget.style.transform = 'scale(1)')}
    >
      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{label}</div>
    </div>
  )
}

export default PipelinePage
