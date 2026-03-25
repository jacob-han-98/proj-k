import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import {
  fetchPipelineSources, fetchPipelineDocuments, fetchDocumentContent, getDocumentDownloadUrl,
  API_BASE_URL,
} from './api'
import type { PipelineSource, PipelineDocument, DocumentContent } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

type Tab = 'graph' | 'documents'

function PipelinePage() {
  const [tab, setTab] = useState<Tab>('graph')
  const [sources, setSources] = useState<PipelineSource[]>([])
  const [documents, setDocuments] = useState<PipelineDocument[]>([])
  const [docTotal, setDocTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [docFilter, setDocFilter] = useState<{ sourceId?: number; status?: string }>({})
  const [selectedDoc, setSelectedDoc] = useState<DocumentContent | null>(null)
  const [docLoading, setDocLoading] = useState(false)

  const loadSources = useCallback(async () => {
    try {
      setLoading(true); setError(null)
      const src = await fetchPipelineSources()
      setSources(src.sources)
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setLoading(false)
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

  const openDoc = useCallback(async (docId: number) => {
    setDocLoading(true)
    try {
      const content = await fetchDocumentContent(docId)
      setSelectedDoc(content)
    } catch {
      setSelectedDoc(null)
    }
    setDocLoading(false)
  }, [])

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
          <button key={t} onClick={() => { setTab(t); setSelectedDoc(null) }} style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
            background: 'transparent',
            color: tab === t ? '#2563eb' : 'var(--text-secondary)',
            fontWeight: tab === t ? 600 : 500, fontSize: '0.85rem',
            borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
          }}>
            {t === 'graph' ? 'Graph' : '문서'}
          </button>
        ))}
      </div>

      {/* Graph */}
      {tab === 'graph' && (
        <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-secondary)' }}>Graph 로딩 중...</div>}>
          <PipelineGraphTab />
        </Suspense>
      )}

      {/* Documents */}
      {tab === 'documents' && (
        <div style={{ display: 'flex', gap: 24, minHeight: 'calc(100vh - 250px)' }}>
          {/* Left: Document list */}
          <div style={{ width: selectedDoc ? 360 : '100%', flexShrink: 0, transition: 'width 0.2s' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <select value={docFilter.sourceId || ''} onChange={e => { setDocFilter(f => ({ ...f, sourceId: e.target.value ? Number(e.target.value) : undefined })); setSelectedDoc(null) }}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}>
                <option value="">모든 소스</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={docFilter.status || ''} onChange={e => { setDocFilter(f => ({ ...f, status: e.target.value || undefined })); setSelectedDoc(null) }}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}>
                <option value="">모든 상태</option>
                {['enriched', 'downloaded', 'converted', 'indexed', 'error'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', alignSelf: 'center' }}>{docTotal}건</span>
            </div>

            <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
              {documents.map(d => (
                <div
                  key={d.id}
                  onClick={() => openDoc(d.id)}
                  style={{
                    padding: '10px 14px', borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer', transition: 'background 0.1s',
                    background: selectedDoc?.doc_id === d.id ? 'var(--bg-secondary)' : 'transparent',
                  }}
                  onMouseEnter={e => { if (selectedDoc?.doc_id !== d.id) e.currentTarget.style.background = 'var(--bg-secondary)' }}
                  onMouseLeave={e => { if (selectedDoc?.doc_id !== d.id) e.currentTarget.style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.title || d.file_path}
                    </span>
                    <StatusBadge status={d.status} />
                  </div>
                  {!selectedDoc && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                      {d.file_type} · ID {d.id}
                    </div>
                  )}
                </div>
              ))}
              {documents.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>문서 없음</div>
              )}
            </div>
          </div>

          {/* Right: Document detail panel */}
          {selectedDoc && (
            <div style={{ flex: 1, minWidth: 0 }}>
              {docLoading ? (
                <div style={{ padding: 40, color: 'var(--text-secondary)' }}>로딩 중...</div>
              ) : (
                <DocumentViewer doc={selectedDoc} onClose={() => setSelectedDoc(null)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DocumentViewer({ doc, onClose }: { doc: DocumentContent; onClose: () => void }) {
  const isConfluence = doc.source_type === 'confluence'
  const isExcel = doc.source_type === 'perforce'

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px', background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex', alignItems: 'flex-start', gap: 12,
      }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>{doc.title}</h3>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {doc.tree_path && (
              <span title="트리 경로">📁 {doc.tree_path}</span>
            )}
            {doc.storage_path && (
              <span title="저장 위치">💾 {doc.storage_path}</span>
            )}
            {doc.images_count > 0 && (
              <span>🖼 이미지 {doc.images_count}개</span>
            )}
            {doc.md_file && (
              <span>📄 {doc.md_file}</span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {/* Confluence link */}
          {isConfluence && doc.confluence_url && (
            <a href={doc.confluence_url} target="_blank" rel="noreferrer" style={{
              padding: '6px 12px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
              background: '#1868DB', color: '#fff', textDecoration: 'none',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              Confluence ↗
            </a>
          )}
          {/* Excel download */}
          {isExcel && (
            <a href={getDocumentDownloadUrl(doc.doc_id)} style={{
              padding: '6px 12px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
              background: '#217346', color: '#fff', textDecoration: 'none',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              Excel ↓
            </a>
          )}
          <button onClick={onClose} style={{
            padding: '6px 10px', border: '1px solid var(--border-color)', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem',
          }}>✕</button>
        </div>
      </div>

      {/* Markdown content */}
      <div style={{
        padding: '20px 24px', maxHeight: 'calc(100vh - 380px)', overflowY: 'auto',
        fontSize: '0.85rem', lineHeight: 1.7, color: 'var(--text-primary)',
      }}>
        {doc.md_content ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ src, alt, ...props }) => {
                  // images/xxx.png → API URL로 변환
                  const apiSrc = src?.startsWith('images/')
                    ? `${API_BASE_URL}/admin/pipeline/documents/${doc.doc_id}/images/${src.replace('images/', '')}`
                    : src
                  return <img src={apiSrc} alt={alt || ''} {...props} style={{
                    maxWidth: '100%', borderRadius: 8, margin: '8px 0',
                    border: '1px solid var(--border-color)',
                  }} />
                }
              }}
            >
              {doc.md_content}
            </ReactMarkdown>
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
            콘텐츠 없음
          </div>
        )}
      </div>
    </div>
  )
}

export default PipelinePage
