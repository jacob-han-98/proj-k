/**
 * 공통 어시스턴트 답변 렌더링 유틸 — App / AdminPage / SharedPage 공용.
 *
 * 구성:
 * - ExcelIcon / ConfluenceIcon: 소스 타입 아이콘 (스트리밍 모드/뷰 공통)
 * - linkifyInlineSources: 본문 전처리 — (출처: …) 와 **<워크북>.xlsx / <시트>** bold 라벨을 projk-source: 링크로 치환
 * - parseInlineSourceBody: body → {kind, levels} — breadcrumb 렌더용
 * - renderAssistantMarkdown({content, sources, onOpenInline, theme}): ReactMarkdown 래핑본
 * - renderSourceCards({sources, onOpen}): 답변 하단 출처 카드 목록
 * - SourceViewPanel: 우측 스플릿 뷰 (xlsx 원본 스크린샷 / confluence 원본 링크 포함)
 * - ScreenshotModal: 엑셀 full overview.png 플로팅 모달
 * - FollowUpCards: 후속 질문 카드
 * - useEscClose: sourceView/screenshot 모달 ESC 닫기 훅
 *
 * 어떤 페이지든 `const sv = useSourceView(); const ss = useScreenshot();` 으로
 * 상태 훅을 준비하고 JSX 에 SourceViewPanel / ScreenshotModal 을 렌더한 뒤,
 * 각 메시지에 renderAssistantMarkdown + renderSourceCards + FollowUpCards 를 쓰면 된다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import { fetchSourceView, screenshotUrl } from './api'
import type { Source, SourceView } from './api'

// ── Icons ──
export const ExcelIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#217346" />
    <path d="M4.5 4.5L8 9L4.5 13.5H6.5L9 10L11.5 13.5H13.5L10 9L13.5 4.5H11.5L9 8L6.5 4.5H4.5Z" fill="white" />
  </svg>
)

export const ConfluenceIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#1868DB" />
    <path d="M3.5 12.5C3.5 12.5 4 11.5 5 11.5C6.5 11.5 7 13 9 13C11 13 12 11 13.5 11C14.5 11 14.5 12 14.5 12L14.5 13.5C14.5 13.5 14 14.5 13 14.5C11.5 14.5 11 13 9 13C7 13 6 15 4.5 15C3.5 15 3.5 14 3.5 14V12.5Z" fill="white" />
    <path d="M14.5 5.5C14.5 5.5 14 6.5 13 6.5C11.5 6.5 11 5 9 5C7 5 6 7 4.5 7C3.5 7 3.5 6 3.5 6L3.5 4.5C3.5 4.5 4 3.5 5 3.5C6.5 3.5 7 5 9 5C11 5 12 3 13.5 3C14.5 3 14.5 4 14.5 4V5.5Z" fill="white" />
  </svg>
)

export const MermaidBlock = ({ code, theme }: { code: string; theme: 'light' | 'dark' }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark' })
    if (ref.current) {
      const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`
      mermaid.render(id, code)
        .then((res) => { if (ref.current) ref.current.innerHTML = res.svg })
        .catch(() => { if (ref.current) ref.current.innerHTML = '<pre>Error rendering diagram</pre>' })
    }
  }, [code, theme])
  return <div ref={ref} className="mermaid-wrapper" />
}

// ── 본문 전처리: (출처: …) + **xlsx/Confluence 라벨** → projk-source: 링크 ──
export function linkifyInlineSources(text: string): string {
  if (!text) return text
  const re = /\(\s*출처\s*[:：]\s*/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const afterPrefix = m.index + m[0].length
    let depth = 1
    let i = afterPrefix
    while (i < text.length) {
      const ch = text[i]
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) break }
      i++
    }
    if (i >= text.length) break
    const body = text.slice(afterPrefix, i).trim()
    const displayBody = body.replace(/[\[\]]/g, (c) => '\\' + c)
    const enc = encodeURIComponent(body)
    out += text.slice(last, start) + `[(출처: ${displayBody})](projk-source:${enc})`
    last = i + 1
    re.lastIndex = last
  }
  out += text.slice(last)

  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (match, label) => {
    const trimmed = label.trim()
    if (trimmed.includes('[') || trimmed.includes('](')) return match
    const isXlsx = /\.xlsx\s*\/\s*\S.*/.test(trimmed)
    const isConfluence = /^Confluence\s*\/\s*\S.*/.test(trimmed)
    if (!isXlsx && !isConfluence) return match
    const enc = encodeURIComponent(trimmed)
    return `**[${label}](projk-source:${enc})**`
  })
  return out
}

// ── 인라인 출처 body 파서 ──
export interface ParsedSourceBody {
  kind: 'xlsx' | 'confluence' | 'other'
  levels: string[]
}
export function parseInlineSourceBody(body: string): ParsedSourceBody {
  let label = body.trim()
  let section = ''
  const sep = body.indexOf('§')
  if (sep >= 0) {
    label = body.slice(0, sep).trim()
    section = body.slice(sep + 1).trim()
  }
  const sections = section ? section.split(/\s*>\s*/).map(s => s.trim()).filter(Boolean) : []
  const sectionLevels = sections.map(s => `"${s}"`)
  if (/^Confluence\s*\//.test(label)) {
    const rest = label.replace(/^Confluence\s*\/\s*/, '').trim()
    const parts = rest.split(/\s*\/\s*/).map(p => p.trim()).filter(Boolean)
    return { kind: 'confluence', levels: ['Confluence', ...parts.map(p => `"${p}"`), ...sectionLevels] }
  }
  const xm = label.match(/^(.+?\.xlsx)\s*\/\s*(.+?)(?:\s+시트)?\s*$/)
  if (xm) return { kind: 'xlsx', levels: [xm[1], `"${xm[2]}" 시트`, ...sectionLevels] }
  return { kind: 'other', levels: [label, ...sectionLevels] }
}

// ── 인라인 소스 클릭 → openSourceView(path, section) 호출용 ──
export function openInlineSourceFromBody(
  body: string,
  sources: Source[] | undefined,
  onOpen: (path: string, section: string) => void,
) {
  let label = body
  let section = ''
  const sep = body.indexOf('§')
  if (sep >= 0) {
    label = body.slice(0, sep).trim()
    let sec = body.slice(sep + 1).trim()
    const nextSec = sec.search(/[,;]\s*§/)
    if (nextSec >= 0) sec = sec.slice(0, nextSec).trim()
    section = sec
  }
  const match = sources?.find(s => ((s.origin_label || '').trim()) === label)
  if (match?.path) { onOpen(match.path, section); return }
  onOpen(label, section)
}

// ── 공통 Markdown 렌더러 ──
export interface RenderAssistantMarkdownProps {
  content: string
  sources?: Source[]
  onOpenSource: (path: string, section: string) => void
  theme: 'light' | 'dark'
}
export function RenderAssistantMarkdown({ content, sources, onOpenSource, theme }: RenderAssistantMarkdownProps) {
  const processed = useMemo(() => linkifyInlineSources(content), [content])
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '')
          if (!inline && match && match[1] === 'mermaid') {
            return <MermaidBlock code={String(children).replace(/\n$/, '')} theme={theme} />
          }
          return <code className={className} {...props}>{children}</code>
        },
        a({ href, children, ...props }: any) {
          const h = href || ''
          if (h.startsWith('projk-source:')) {
            const body = decodeURIComponent(h.slice('projk-source:'.length))
            const parsed = parseInlineSourceBody(body)
            const Icon = parsed.kind === 'confluence' ? ConfluenceIcon : ExcelIcon
            return (
              <a
                href="#"
                className={`inline-source-link inline-source-${parsed.kind}`}
                onClick={(e) => {
                  e.preventDefault(); e.stopPropagation()
                  openInlineSourceFromBody(body, sources, onOpenSource)
                }}
                title="우측 패널에서 열기"
              >
                <span className="inline-source-icon"><Icon /></span>
                {parsed.levels.map((lvl, i) => (
                  <span key={i} className="inline-source-part">
                    {i > 0 && <span className="inline-source-sep"> › </span>}
                    <span>{lvl}</span>
                  </span>
                ))}
              </a>
            )
          }
          return <a href={h} target="_blank" rel="noreferrer" {...props}>{children}</a>
        },
      }}
    >{processed}</ReactMarkdown>
  )
}

// ── 답변 하단 출처 카드 ──
export function RenderSourceCards({
  sources, onOpen,
}: {
  sources: Source[]
  onOpen: (path: string, section: string) => void
}) {
  if (!sources || sources.length === 0) return null
  const groups = new Map<string, { src: Source; sections: string[] }>()
  sources.forEach(s => {
    const key = s.path || ((s.workbook || '') + '|' + (s.sheet || ''))
    const g = groups.get(key)
    const sec = (s.section_path || '').trim()
    if (g) { if (sec && !g.sections.includes(sec)) g.sections.push(sec) }
    else { groups.set(key, { src: s, sections: sec ? [sec] : [] }) }
  })
  return (
    <div className="message-sources">
      <p className="sources-title">출처</p>
      <div className="source-cards-container">
        {Array.from(groups.values()).map(({ src, sections }, i) => {
          const isConfluence = src.source === 'confluence' || src.workbook.startsWith('Confluence')
          const displayLabel =
            src.origin_label ||
            [src.workbook, src.sheet].filter(Boolean).join(' / ') ||
            src.path || '(unknown)'
          const extLink = src.origin_url || src.source_url || ''
          const firstSection = sections[0] || ''
          const canOpen = !!src.path
          return (
            <div key={i} className="source-link-card glass" title={src.path || displayLabel}>
              <button
                className="source-card-main"
                onClick={() => canOpen && onOpen(src.path!, firstSection)}
                disabled={!canOpen}
                type="button"
              >
                <span className="source-icon">{isConfluence ? <ConfluenceIcon /> : <ExcelIcon />}</span>
                <div className="source-body">
                  <span className="source-text">{displayLabel}</span>
                  {sections.length > 0 && (
                    <span className="source-sections">
                      {sections.slice(0, 4).join(' · ')}{sections.length > 4 ? ` …+${sections.length - 4}` : ''}
                    </span>
                  )}
                </div>
              </button>
              {extLink && (
                <a className="source-card-ext" href={extLink} target="_blank" rel="noreferrer" title="원본 링크 새 창에서 열기">↗</a>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 후속 질문 카드 ──
export function FollowUpCards({
  followUps, disabled, onPick,
}: {
  followUps?: string[]
  disabled?: boolean
  onPick: (q: string) => void
}) {
  if (!followUps || followUps.length === 0) return null
  return (
    <div className="followups">
      <p className="followups-title">이어서 물어볼 만한 질문</p>
      <div className="followups-cards">
        {followUps.map((q, i) => (
          <button
            key={i}
            className="followup-card"
            type="button"
            disabled={!!disabled}
            title="이 질문으로 이어서 물어보기"
            onClick={() => onPick(q)}
          >
            <span className="followup-arrow">›</span>
            <span className="followup-text">{q}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Source View + Screenshot 상태 훅 + 컴포넌트 ──
export function useSourceAndScreenshot() {
  const [sourceView, setSourceView] = useState<SourceView | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<{ url: string; label: string } | null>(null)

  const openSource = useCallback(async (path: string, section: string) => {
    setLoading(true); setErr(null)
    try {
      const v = await fetchSourceView(path, section)
      setSourceView(v)
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  const closeSource = useCallback(() => { setSourceView(null); setErr(null) }, [])
  const openScreenshot = useCallback((path: string, label: string) => {
    setScreenshot({ url: screenshotUrl(path), label })
  }, [])
  const closeScreenshot = useCallback(() => setScreenshot(null), [])

  // ESC 닫기 (모달 우선)
  useEffect(() => {
    if (!sourceView && !loading && !err && !screenshot) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (screenshot) { closeScreenshot(); return }
      closeSource()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sourceView, loading, err, screenshot, closeScreenshot, closeSource])

  return { sourceView, loading, err, screenshot, openSource, closeSource, openScreenshot, closeScreenshot }
}

export function SourceViewPanel({
  sourceView, loading, err, onClose, onScreenshot,
}: {
  sourceView: SourceView | null
  loading: boolean
  err: string | null
  onClose: () => void
  onScreenshot: (path: string, label: string) => void
}) {
  if (!sourceView && !loading && !err) return null
  const lines = sourceView?.content.split('\n') ?? []
  const sr = sourceView?.section_range
  return (
    <aside className="source-view-panel glass">
      <header className="source-view-header">
        <div className="source-view-title">
          {sourceView?.source === 'summary' && (
            <span className="source-view-summary-badge" title="Haiku 로 생성한 요약본입니다. 원본이 아닙니다.">📝 요약본</span>
          )}
          {sourceView?.origin_label || (loading ? '로딩 중...' : '출처 뷰')}
        </div>
        {sourceView?.origin_url && (
          <a href={sourceView.origin_url} target="_blank" rel="noreferrer" className="source-view-ext" title="원본 링크">↗ 원본</a>
        )}
        {sourceView?.source === 'xlsx' && sourceView?.path && (
          <button
            className="source-view-ext"
            type="button"
            title="엑셀 원본 스크린샷 보기"
            onClick={() => onScreenshot(sourceView.path, sourceView.origin_label || sourceView.path)}
          >📸 원본 스크린샷</button>
        )}
        <button className="source-view-close" onClick={onClose} title="닫기 (Esc)">✕</button>
      </header>
      {sourceView?.source === 'summary' && (
        <div className="source-view-summary-notice">
          ⚠ 이 문서는 <strong>원본 기획서가 아니라 검색용 요약본</strong>입니다. 세부 내용은 원본 문서를 확인해 주세요.
        </div>
      )}
      {loading && <div className="source-view-loading"><span className="loading-spinner" /> 로딩 중...</div>}
      {err && <div className="source-view-error">오류: {err}</div>}
      {sourceView && (
        <>
          {sr && (
            <div className="source-view-section-badge">
              하이라이트: {sourceView.section} &middot; 라인 {sr.start_line}–{sr.end_line}
            </div>
          )}
          <div className="source-view-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {sr ? lines.slice(0, sr.start_line - 1).join('\n') : sourceView.content}
            </ReactMarkdown>
            {sr && (
              <div className="source-view-highlight">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {lines.slice(sr.start_line - 1, sr.end_line).join('\n')}
                </ReactMarkdown>
              </div>
            )}
            {sr && (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {lines.slice(sr.end_line).join('\n')}
              </ReactMarkdown>
            )}
          </div>
        </>
      )}
    </aside>
  )
}

export function ScreenshotModal({
  state, onClose,
}: {
  state: { url: string; label: string } | null
  onClose: () => void
}) {
  if (!state) return null
  return (
    <div className="screenshot-modal-backdrop" onClick={onClose}>
      <div className="screenshot-modal glass" onClick={(e) => e.stopPropagation()}>
        <header className="screenshot-modal-header">
          <span className="screenshot-modal-title" title={state.label}>📸 {state.label}</span>
          <button className="screenshot-modal-close" onClick={onClose} title="닫기 (Esc)" type="button">✕</button>
        </header>
        <div className="screenshot-modal-body">
          <img src={state.url} alt={state.label} loading="lazy" />
        </div>
      </div>
    </div>
  )
}
