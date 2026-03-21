import { useState, useEffect, useCallback } from 'react'
import {
  fetchPipelineStatus, fetchPipelineSources, fetchPipelineDocuments,
  fetchPipelineJobs, fetchPipelineIssues, triggerPipelineJob,
} from './api'
import type {
  PipelineStats, PipelineSource, PipelineDocument,
  PipelineJob, PipelineIssue,
} from './api'

const STATUS_COLORS: Record<string, string> = {
  new: '#6b7280', crawled: '#3b82f6', captured: '#8b5cf6',
  converted: '#f59e0b', indexed: '#22c55e', error: '#ef4444',
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
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type Tab = 'overview' | 'sources' | 'documents' | 'jobs' | 'issues'

function PipelinePage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [sources, setSources] = useState<PipelineSource[]>([])
  const [documents, setDocuments] = useState<PipelineDocument[]>([])
  const [docTotal, setDocTotal] = useState(0)
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  const [jobStats, setJobStats] = useState<Record<string, number>>({})
  const [issues, setIssues] = useState<PipelineIssue[]>([])
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
    }
  }, [tab, docFilter, jobFilter])

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
        {(['overview', 'sources', 'documents', 'jobs', 'issues'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
            background: tab === t ? 'var(--accent-color)' : 'transparent',
            color: tab === t ? '#fff' : 'var(--text-secondary)',
            fontWeight: tab === t ? 600 : 400, fontSize: '0.85rem',
          }}>
            {t === 'overview' ? '전체 현황' : t === 'sources' ? '소스' : t === 'documents' ? '문서' : t === 'jobs' ? '작업큐' : '이슈'}
            {t === 'issues' && stats?.issues?.open ? ` (${stats.issues.open})` : ''}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && stats && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
            <StatCard label="크롤링 소스" value={stats.sources} />
            <StatCard label="전체 문서" value={stats.documents.total} />
            <StatCard label="인덱싱 완료" value={stats.documents.by_status?.indexed || 0} color="#22c55e" />
            <StatCard label="오류" value={stats.documents.by_status?.error || 0} color="#ef4444" />
            <StatCard label="대기 작업" value={stats.jobs?.pending || 0} color="#f59e0b" />
            <StatCard label="미해결 이슈" value={stats.issues?.open || 0} color="#ef4444" />
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
                background: (jobFilter || '') === s ? 'var(--accent-color)' : 'var(--bg-secondary)',
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
                  <td style={{ padding: '6px 10px' }}><StatusBadge status={j.status} /></td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{j.worker_id || '-'}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(j.created_at)}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{formatTime(j.completed_at)}</td>
                  <td style={{ padding: '6px 10px', color: '#ef4444', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.error_message || ''}
                  </td>
                </tr>
              ))}
              {jobs.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>작업 없음</td></tr>}
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
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="glass" style={{ padding: 16, borderRadius: 12, textAlign: 'center' }}>
      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{label}</div>
    </div>
  )
}

export default PipelinePage
