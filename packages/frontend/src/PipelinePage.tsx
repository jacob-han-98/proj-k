import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import {
  fetchPipelineSources, fetchPipelineDocuments, triggerPipelineJob,
} from './api'
import type { PipelineSource, PipelineDocument } from './api'

const PipelineGraphTab = lazy(() => import('./PipelineGraphTab'))

const STATUS_COLORS: Record<string, string> = {
  new: '#6b7280', crawled: '#3b82f6', captured: '#8b5cf6',
  downloaded: '#8b5cf6', converted: '#f59e0b', enriched: '#a855f7', indexed: '#22c55e', error: '#ef4444',
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
  const raw = iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z'
  const d = new Date(raw)
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type Tab = 'graph' | 'documents'

function PipelinePage() {
  const [tab, setTab] = useState<Tab>('graph')
  const [sources, setSources] = useState<PipelineSource[]>([])
  const [documents, setDocuments] = useState<PipelineDocument[]>([])
  const [docTotal, setDocTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [docFilter, setDocFilter] = useState<{ sourceId?: number; status?: string }>({})

  const loadSources = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const src = await fetchPipelineSources()
      setSources(src.sources)
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSources() }, [loadSources])

  useEffect(() => {
    if (tab === 'documents') {
      fetchPipelineDocuments(docFilter.sourceId, docFilter.status)
        .then(r => { setDocuments(r.documents); setDocTotal(r.total) })
        .catch(() => {})
    }
  }, [tab, docFilter])

  const handleTrigger = async (jobType: string, _sourceId?: number, documentId?: number) => {
    try {
      await triggerPipelineJob(jobType, _sourceId, documentId)
      // 문서 목록 리로드
      if (tab === 'documents') {
        const r = await fetchPipelineDocuments(docFilter.sourceId, docFilter.status)
        setDocuments(r.documents)
        setDocTotal(r.total)
      }
    } catch (e) {
      alert('트리거 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (loading && !sources.length) return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>로딩 중...</div>
  if (error) return <div style={{ padding: 40, color: '#ef4444' }}>연결 실패: {error}</div>

  return (
    <div style={{ padding: '24px 32px' }}>
      <h2 style={{ marginBottom: 8 }}>데이터 파이프라인</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
        기획서 크롤링 → 변환 → 인덱싱 현황
      </p>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 4 }}>
        {(['graph', 'documents'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
            background: 'transparent',
            color: tab === t ? '#2563eb' : '#374151',
            fontWeight: tab === t ? 600 : 500, fontSize: '0.85rem',
            borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
          }}>
            {t === 'graph' ? 'Graph' : '문서'}
          </button>
        ))}
      </div>

      {/* Graph + Job Log */}
      {tab === 'graph' && (
        <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-secondary)' }}>Graph 로딩 중...</div>}>
          <PipelineGraphTab />
        </Suspense>
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
              {['new', 'crawled', 'captured', 'downloaded', 'converted', 'enriched', 'indexed', 'error'].map(s => <option key={s} value={s}>{s}</option>)}
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
                  <td style={{ padding: '6px 10px', display: 'flex', gap: 4 }}>
                    <button onClick={() => handleTrigger('download', d.source_id, d.id)} style={{
                      padding: '3px 8px', fontSize: '0.7rem', border: '1px solid var(--border-color)',
                      borderRadius: 4, cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                    }}>다운로드</button>
                    <button onClick={() => handleTrigger('convert', undefined, d.id)} style={{
                      padding: '3px 8px', fontSize: '0.7rem', border: '1px solid var(--border-color)',
                      borderRadius: 4, cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                    }}>변환</button>
                  </td>
                </tr>
              ))}
              {documents.length === 0 && <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>문서 없음</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default PipelinePage
