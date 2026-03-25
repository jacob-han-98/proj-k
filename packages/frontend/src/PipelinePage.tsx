import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import {
  fetchPipelineSources, fetchPipelineDocuments, fetchDocumentContent, fetchSheetContent, getDocumentDownloadUrl,
  API_BASE_URL,
} from './api'
import type { PipelineSource, PipelineDocument, DocumentContent } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PipelineGraphTab = lazy(() => import('./PipelineGraphTab'))
const GameDataTab = lazy(() => import('./GameDataTab'))

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

type Tab = 'graph' | 'documents' | 'gamedata'

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
        {(['graph', 'documents', 'gamedata'] as Tab[]).map(t => (
          <button key={t} onClick={() => { setTab(t); setSelectedDoc(null) }} style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
            background: 'transparent',
            color: tab === t ? '#2563eb' : 'var(--text-secondary)',
            fontWeight: tab === t ? 600 : 500, fontSize: '0.85rem',
            borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
          }}>
            {t === 'graph' ? 'Graph' : t === 'documents' ? '문서' : 'DataSheet DB'}
          </button>
        ))}
      </div>

      {/* Graph */}
      {tab === 'graph' && (
        <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-secondary)' }}>Graph 로딩 중...</div>}>
          <PipelineGraphTab />
        </Suspense>
      )}

      {/* DataSheet DB */}
      {tab === 'gamedata' && (
        <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-secondary)' }}>DataSheet DB 로딩 중...</div>}>
          <GameDataTab />
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
  const sheets = doc.sheets || []

  const [activeSheet, setActiveSheet] = useState(sheets[0]?.name || '')
  const [sheetMd, setSheetMd] = useState(doc.md_content)
  const [sheetImgBase, setSheetImgBase] = useState('')  // Excel 시트별 이미지 경로 prefix

  // Excel 시트 전환
  const loadSheet = useCallback(async (sheetName: string) => {
    setActiveSheet(sheetName)
    try {
      const r = await fetchSheetContent(doc.doc_id, sheetName)
      setSheetMd(r.md_content)
      setSheetImgBase(`${sheetName}/_final/`)
    } catch {
      setSheetMd('시트 로딩 실패')
    }
  }, [doc.doc_id])

  // 초기 로드 시 Excel 첫 시트 이미지 경로 설정
  useEffect(() => {
    if (isExcel && sheets.length > 0) {
      setSheetImgBase(`${sheets[0].name}/_final/`)
      setActiveSheet(sheets[0].name)
    }
  }, [doc.doc_id])

  const mdContent = isExcel ? sheetMd : doc.md_content

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
            {doc.storage_path && (
              <span title="저장 위치">💾 {doc.storage_path}</span>
            )}
            {isExcel && sheets.length > 0 && (
              <span>📊 {sheets.length}개 시트</span>
            )}
            {!isExcel && doc.images_count > 0 && (
              <span>🖼 이미지 {doc.images_count}개</span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {isConfluence && doc.confluence_url && (
            <a href={doc.confluence_url} target="_blank" rel="noreferrer" style={{
              padding: '6px 12px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
              background: '#1868DB', color: '#fff', textDecoration: 'none',
            }}>Confluence ↗</a>
          )}
          {isExcel && (
            <a href={getDocumentDownloadUrl(doc.doc_id)} style={{
              padding: '6px 12px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 500,
              background: '#217346', color: '#fff', textDecoration: 'none',
            }}>Excel ↓</a>
          )}
          <button onClick={onClose} style={{
            padding: '6px 10px', border: '1px solid var(--border-color)', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem',
          }}>✕</button>
        </div>
      </div>

      {/* Excel: Sheet tabs */}
      {isExcel && sheets.length > 0 && (
        <div style={{
          display: 'flex', gap: 2, padding: '0 16px', background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)', overflowX: 'auto',
        }}>
          {sheets.map(s => (
            <button key={s.name} onClick={() => loadSheet(s.name)} style={{
              padding: '6px 14px', border: 'none', cursor: 'pointer',
              background: 'transparent', fontSize: '0.75rem',
              color: activeSheet === s.name ? '#2563eb' : 'var(--text-secondary)',
              fontWeight: activeSheet === s.name ? 600 : 400,
              borderBottom: activeSheet === s.name ? '2px solid #2563eb' : '2px solid transparent',
              whiteSpace: 'nowrap',
            }}>
              {s.name}
              {s.images_count > 0 && <span style={{ marginLeft: 4, fontSize: '0.6rem', color: 'var(--text-secondary)' }}>🖼{s.images_count}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Markdown content */}
      <div style={{
        padding: '20px 24px', maxHeight: 'calc(100vh - 420px)', overflowY: 'auto',
        fontSize: '0.85rem', lineHeight: 1.7, color: 'var(--text-primary)',
      }}>
        {mdContent ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ src, alt, ...props }) => {
                  let apiSrc = src
                  if (src?.startsWith('images/')) {
                    const imgFile = src.replace('images/', '')
                    if (isExcel && sheetImgBase) {
                      apiSrc = `${API_BASE_URL}/admin/pipeline/documents/${doc.doc_id}/images/${sheetImgBase}images/${imgFile}`
                    } else {
                      apiSrc = `${API_BASE_URL}/admin/pipeline/documents/${doc.doc_id}/images/${imgFile}`
                    }
                  }
                  return <img src={apiSrc} alt={alt || ''} {...props} style={{
                    maxWidth: '100%', borderRadius: 8, margin: '8px 0',
                    border: '1px solid var(--border-color)',
                  }} />
                }
              }}
            >
              {mdContent}
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
