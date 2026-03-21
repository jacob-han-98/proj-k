import { useState } from 'react'
import type { Proposal } from './api'
import { API_BASE_URL, createConfluencePage } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Markdown 테이블 → TSV 변환 (Excel 붙여넣기용) */
function mdToTsv(md: string): string {
  const lines = md.split('\n')
  const tsvLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue // 구분자 행 스킵
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
    tsvLines.push(cells.join('\t'))
  }
  return tsvLines.join('\n')
}

/** 복사: 테이블이 있으면 TSV, 아니면 원본 */
function copyForExcel(content: string) {
  const tsv = mdToTsv(content)
  navigator.clipboard.writeText(tsv || content)
}

const ExcelIcon = () => (
  <svg width="14" height="14" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#217346" />
    <path d="M4.5 4.5L8 9L4.5 13.5H6.5L9 10L11.5 13.5H13.5L10 9L13.5 4.5H11.5L9 8L6.5 4.5H4.5Z" fill="white" />
  </svg>
)
const ConfluenceIcon = () => (
  <svg width="14" height="14" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#1868DB" />
    <path d="M3.5 12.5C3.5 12.5 4 11.5 5 11.5C6.5 11.5 7 13 9 13C11 13 12 11 13.5 11C14.5 11 14.5 12 14.5 12L14.5 13.5C14.5 13.5 14 14.5 13 14.5C11.5 14.5 11 13 9 13C7 13 6 15 4.5 15C3.5 15 3.5 14 3.5 14V12.5Z" fill="white" />
    <path d="M14.5 5.5C14.5 5.5 14 6.5 13 6.5C11.5 6.5 11 5 9 5C7 5 6 7 4.5 7C3.5 7 3.5 6 3.5 6L3.5 4.5C3.5 4.5 4 3.5 5 3.5C6.5 3.5 7 5 9 5C11 5 12 3 13.5 3C14.5 3 14.5 4 14.5 4V5.5Z" fill="white" />
  </svg>
)
const DocIcon = ({ workbook }: { workbook: string }) =>
  workbook.startsWith('Confluence') ? <ConfluenceIcon /> : <ExcelIcon />

function ModifyCard({ p }: { p: Proposal }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="proposal-card modify">
      <div className="proposal-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="proposal-type-badge modify">수정</span>
        <div className="proposal-card-info">
          <span className="proposal-doc-name">
            <DocIcon workbook={p.workbook} /> {p.workbook.replace('PK_', '')} / {p.sheet}
            {p.section && <span className="proposal-section"> &gt; {p.section}</span>}
          </span>
          <span className="proposal-diff-summary">{p.diff_summary}</span>
        </div>
        <span className={`expand-arrow ${expanded ? 'open' : ''}`}>&#9662;</span>
      </div>

      {expanded && (
        <div className="proposal-card-body">
          <div className="proposal-reason">{p.reason}</div>
          <div className="proposal-diff">
            <div className="diff-panel before">
              <div className="diff-panel-header">변경 전</div>
              <div className="diff-panel-content markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.before || '(내용 없음)'}</ReactMarkdown>
              </div>
            </div>
            <div className="diff-panel after">
              <div className="diff-panel-header">
                변경 후
                <button className="copy-panel-btn" onClick={(e) => { e.stopPropagation(); copyForExcel(p.after || ''); }}>복사</button>
              </div>
              <div className="diff-panel-content markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.after || '(내용 없음)'}</ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CreateCard({ p }: { p: Proposal }) {
  const [expanded, setExpanded] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<{ url: string } | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)

  const handlePublish = async () => {
    setPublishing(true)
    setPublishError(null)
    try {
      const result = await createConfluencePage(p.sheet, p.content || '', p.workbook)
      setPublished({ url: result.page_url })
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="proposal-card create">
      <div className="proposal-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="proposal-type-badge create">신규</span>
        <div className="proposal-card-info">
          <span className="proposal-doc-name">
            <DocIcon workbook={p.workbook} /> {p.workbook.replace('PK_', '')} / {p.sheet}
          </span>
          <span className="proposal-diff-summary">{p.diff_summary}</span>
        </div>
        <span className={`expand-arrow ${expanded ? 'open' : ''}`}>&#9662;</span>
      </div>

      {expanded && (
        <div className="proposal-card-body">
          <div className="proposal-reason">{p.reason}</div>
          <div className="proposal-new-content-wrapper">
            <div className="proposal-new-content-header">
              <span>미리보기</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="copy-panel-btn" onClick={() => navigator.clipboard.writeText(p.content || '')}>내용 복사</button>
                {!published ? (
                  <button
                    className="copy-panel-btn confluence-publish"
                    onClick={handlePublish}
                    disabled={publishing}
                  >
                    {publishing ? '게시 중...' : 'Confluence에 게시'}
                  </button>
                ) : (
                  <a href={published.url} target="_blank" rel="noreferrer" className="copy-panel-btn" style={{ textDecoration: 'none', color: '#22c55e' }}>
                    게시 완료 — 열기
                  </a>
                )}
              </div>
            </div>
            {publishError && <div style={{ padding: '6px 12px', fontSize: '0.75rem', color: '#ef4444' }}>{publishError}</div>}
            <div className="proposal-new-content markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.content || '(내용 없음)'}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ProposalView({ proposals, conversationId }: { proposals: Proposal[]; conversationId?: string }) {
  if (!proposals || proposals.length === 0) return null

  const modifyCount = proposals.filter(p => p.type === 'modify').length
  const createCount = proposals.filter(p => p.type === 'create').length

  const handleExportCowork = async () => {
    if (!conversationId) {
      alert('대화 ID가 없습니다. 답변이 완료된 후 다시 시도해주세요.')
      return
    }
    const url = `${API_BASE_URL}/conversations/${encodeURIComponent(conversationId)}/export`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        alert(`내보내기 실패 (${res.status}). 이 대화가 서버에 저장되었는지 확인해주세요.`)
        return
      }
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `proposal_${conversationId.slice(0, 8)}.md`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {
      alert('서버 연결에 실패했습니다.')
    }
  }

  return (
    <div className="proposal-container">
      <div className="proposal-header-bar">
        <span className="proposal-header-title">기획서 제안</span>
        <span className="proposal-header-counts">
          {modifyCount > 0 && <span className="proposal-type-badge modify">{modifyCount}건 수정</span>}
          {createCount > 0 && <span className="proposal-type-badge create">{createCount}건 신규</span>}
        </span>
        {conversationId && (
          <button className="proposal-export-btn" onClick={handleExportCowork} title="Claude Cowork에서 실제 파일을 수정할 수 있는 지시서 다운로드">
            Cowork 내보내기
          </button>
        )}
      </div>

      <div className="proposal-cards">
        {proposals.map((p, i) =>
          p.type === 'modify'
            ? <ModifyCard key={i} p={p} />
            : <CreateCard key={i} p={p} />
        )}
      </div>
    </div>
  )
}
