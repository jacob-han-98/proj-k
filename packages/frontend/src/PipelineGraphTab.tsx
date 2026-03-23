import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchPipelineDag, runPipelineDag, type PipelineDagResponse } from './api'

// ── Status theme (uses CSS vars at runtime) ───────

const ST: Record<string, { label: string; cssClass: string }> = {
  idle:      { label: 'IDLE',      cssClass: 'st-idle' },
  pending:   { label: 'PENDING',   cssClass: 'st-pending' },
  running:   { label: 'RUNNING',   cssClass: 'st-running' },
  completed: { label: 'COMPLETED', cssClass: 'st-completed' },
  failed:    { label: 'FAILED',    cssClass: 'st-failed' },
}

function stOf(status: string) { return ST[status] || ST.idle }

function timeAgo(iso: string | null | undefined) {
  if (!iso) return 'never'
  const raw = iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z'
  const diff = Date.now() - new Date(raw).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Read CSS variables at render time ─────────────

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function getThemeColors() {
  const bg = cssVar('--bg-primary') || '#0F172A'
  const bg2 = cssVar('--bg-secondary') || '#1E293B'
  const border = cssVar('--border-color') || '#334155'
  const text = cssVar('--text-primary') || '#F8FAFC'
  const text2 = cssVar('--text-secondary') || '#94A3B8'
  return { bg, bg2, border, text, text2 }
}

// Status colors (consistent across themes)
const STATUS_COLORS = {
  idle:      { fill: 'var(--bg-secondary)', stroke: 'var(--border-color)', text: 'var(--text-secondary)' },
  pending:   { fill: '#2d2200', stroke: '#ca8a04', text: '#fbbf24' },
  running:   { fill: '#0a2540', stroke: '#0ea5e9', text: '#0ea5e9' },
  completed: { fill: '#052e16', stroke: '#22c55e', text: '#22c55e' },
  failed:    { fill: '#450a0a', stroke: '#ef4444', text: '#ef4444' },
} as Record<string, { fill: string; stroke: string; text: string }>

// ── Build SVG ─────────────────────────────────────

interface NodePos { x: number; y: number; id: string; sourceId: number; stageId: string; shared?: boolean }

function buildSvg(dag: PipelineDagResponse, theme: ReturnType<typeof getThemeColors>): { svg: string; positions: NodePos[]; w: number; h: number } {
  const NODE_W = 160, NODE_H = 68, GAP_X = 60, GAP_Y = 24
  const LABEL_W = 180
  const positions: NodePos[] = []

  let maxCols = 0
  dag.sources.forEach(src => { if (src.stages.length > maxCols) maxCols = src.stages.length })

  const totalRows = dag.sources.length
  const rowH = NODE_H + GAP_Y
  const contentH = totalRows * rowH + GAP_Y
  const sharedX = LABEL_W + maxCols * (NODE_W + GAP_X) + GAP_X
  const svgW = sharedX + dag.shared_stages.length * (NODE_W + GAP_X) + GAP_X
  const svgH = Math.max(contentH, 200)

  let svg = ''

  const SOURCE_COLS: Record<string, { fill: string; stroke: string; text: string }> = {
    perforce:   { fill: '#1e3a5f', stroke: '#2563eb', text: '#93c5fd' },
    confluence: { fill: '#2d1b69', stroke: '#7c3aed', text: '#c4b5fd' },
  }

  // -- Edges --
  dag.sources.forEach((src, ri) => {
    const y = GAP_Y + ri * rowH + NODE_H / 2

    // label → first stage
    svg += bezier(LABEL_W - 10, y, LABEL_W + GAP_X / 2, y, theme.border, false)

    // between stages
    src.edges.forEach(e => {
      const fi = src.stages.findIndex(s => s.id === e.from)
      const ti = src.stages.findIndex(s => s.id === e.to)
      if (fi < 0 || ti < 0) return
      const fx = LABEL_W + GAP_X / 2 + fi * (NODE_W + GAP_X) + NODE_W
      const tx = LABEL_W + GAP_X / 2 + ti * (NODE_W + GAP_X)
      const fs = src.stage_status[e.from]?.status
      const color = fs === 'completed' ? '#22c55e' : fs === 'running' ? '#0ea5e9' : theme.border
      svg += bezier(fx, y, tx, y, color, false)
    })

    // last stage → shared index
    const lastIdx = src.stages.findIndex(s => s.id === src.last_stage)
    if (lastIdx >= 0) {
      const fx = LABEL_W + GAP_X / 2 + lastIdx * (NODE_W + GAP_X) + NODE_W
      const sharedCY = (contentH - GAP_Y) / 2 + GAP_Y / 2
      const ls = src.stage_status[src.last_stage]?.status
      svg += bezier(fx, y, sharedX, sharedCY, ls === 'completed' ? '#22c55e88' : '#ca8a04', true)
    }
  })

  // shared internal edges
  dag.shared_edges.forEach(e => {
    const sharedCY = (contentH - GAP_Y) / 2 + GAP_Y / 2
    const fs = dag.shared_status[e.from]?.status
    svg += bezier(sharedX + NODE_W, sharedCY, sharedX + NODE_W + GAP_X, sharedCY, fs === 'completed' ? '#22c55e' : theme.border, false)
  })

  // -- Source labels --
  dag.sources.forEach((src, ri) => {
    const x = 10, y = GAP_Y + ri * rowH
    const c = SOURCE_COLS[src.source_type] || SOURCE_COLS.perforce
    svg += `<g class="dag-node" data-id="src-${src.source_id}">
      <rect x="${x}" y="${y}" width="${LABEL_W - 30}" height="${NODE_H}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>
      <text x="${x + (LABEL_W - 30) / 2}" y="${y + NODE_H / 2 + 4}" text-anchor="middle" fill="${c.text}" font-size="12" font-weight="700">${esc(src.source_name)}</text>
    </g>`
  })

  // -- Stage nodes --
  dag.sources.forEach((src, ri) => {
    src.stages.forEach((stage, ci) => {
      const x = LABEL_W + GAP_X / 2 + ci * (NODE_W + GAP_X)
      const y = GAP_Y + ri * rowH
      const status = src.stage_status[stage.id] || { status: 'idle' }
      const sc = STATUS_COLORS[status.status] || STATUS_COLORS.idle
      const isRunning = status.status === 'running'

      positions.push({ x, y, id: `${src.source_id}-${stage.id}`, sourceId: src.source_id, stageId: stage.id })

      svg += `<g class="dag-node ${isRunning ? 'running' : ''}" data-id="${src.source_id}-${stage.id}">
        <rect class="node-bg" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${sc.fill}" stroke="${sc.stroke}" stroke-width="1.5"/>
        <text x="${x + NODE_W / 2}" y="${y + 20}" text-anchor="middle" fill="${theme.text}" font-size="12" font-weight="600">${esc(stage.label)}</text>
        <text x="${x + NODE_W / 2}" y="${y + 35}" text-anchor="middle" fill="${theme.text2}" font-size="9">${timeAgo(status.completed_at || status.created_at)}</text>
        <text x="${x + NODE_W / 2}" y="${y + 50}" text-anchor="middle" fill="${sc.text}" font-size="9" font-weight="600">${stOf(status.status).label}</text>
      </g>`
    })
  })

  // -- Shared nodes --
  const sharedCY = (contentH - GAP_Y) / 2 + GAP_Y / 2 - NODE_H / 2
  dag.shared_stages.forEach((stage, i) => {
    const x = sharedX + i * (NODE_W + GAP_X)
    const y = sharedCY
    const status = dag.shared_status[stage.id] || { status: 'idle' }
    const sc = STATUS_COLORS[status.status] || STATUS_COLORS.idle

    positions.push({ x, y, id: `shared-${stage.id}`, sourceId: 0, stageId: stage.id, shared: true })

    svg += `<g class="dag-node" data-id="shared-${stage.id}">
      <rect class="node-bg" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="12" fill="${sc.fill}" stroke="${sc.stroke}" stroke-width="2"/>
      <text x="${x + NODE_W / 2}" y="${y + 20}" text-anchor="middle" fill="${theme.text}" font-size="13" font-weight="700">${esc(stage.label)}</text>
      <text x="${x + NODE_W / 2}" y="${y + 35}" text-anchor="middle" fill="${theme.text2}" font-size="9">${timeAgo(status.completed_at || status.created_at)}</text>
      <text x="${x + NODE_W / 2}" y="${y + 50}" text-anchor="middle" fill="${sc.text}" font-size="10" font-weight="600">${stOf(status.status).label}</text>
    </g>`
  })

  return { svg, positions, w: svgW, h: svgH }
}

function bezier(x1: number, y1: number, x2: number, y2: number, color: string, dashed: boolean): string {
  const cx1 = x1 + (x2 - x1) * 0.4
  const cx2 = x2 - (x2 - x1) * 0.4
  return `<path d="M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="6 3"' : ''} marker-end="url(#arrowhead)"/>`
}

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// ── Main component ────────────────────────────────

export default function PipelineGraphTab() {
  const [dag, setDag] = useState<PipelineDagResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [popup, setPopup] = useState<{ x: number; y: number; nodeId: string; sourceId: number; stageId: string; shared: boolean } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const positionsRef = useRef<NodePos[]>([])

  const load = useCallback(async () => {
    try {
      setError(null)
      setDag(await fetchPipelineDag())
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!dag) return
    const active = dag.sources.some(src => Object.values(src.stage_status).some(x => x.status === 'running' || x.status === 'pending'))
      || Object.values(dag.shared_status).some(x => x.status === 'running' || x.status === 'pending')
    if (!active) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [dag, load])

  const onRun = useCallback(async (sourceId: number, stage: string, mode: 'single' | 'downstream' | 'all') => {
    try {
      const sid = sourceId || dag?.sources[0]?.source_id || 1
      const r = await runPipelineDag(sid, stage, mode)
      setToast(`${mode === 'single' ? '단일' : mode === 'downstream' ? '순차' : '전체'} 실행: ${r.jobs.length}개 작업`)
      setPopup(null)
      setTimeout(() => setToast(null), 3000)
      load()
    } catch (e) {
      setToast('실패: ' + (e instanceof Error ? e.message : String(e)))
      setTimeout(() => setToast(null), 5000)
    }
  }, [dag, load])

  const handleSvgClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.dag-node') as HTMLElement | null
    if (!target) { setPopup(null); return }
    const nodeId = target.dataset.id
    if (!nodeId || nodeId.startsWith('src-')) return  // source labels are not clickable
    const pos = positionsRef.current.find(p => p.id === nodeId)
    if (!pos) return
    const scrollLeft = containerRef.current?.scrollLeft || 0
    setPopup({ x: pos.x + 170 + scrollLeft, y: pos.y + 10, nodeId, sourceId: pos.sourceId, stageId: pos.stageId, shared: !!pos.shared })
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.node-popup') && !t.closest('.dag-node')) setPopup(null)
    }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopup(null) }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>로딩 중...</div>
  if (error) return <div style={{ padding: 40, color: '#ef4444' }}>실패: {error}</div>
  if (!dag) return null

  const theme = getThemeColors()
  const { svg, positions, w, h } = buildSvg(dag, theme)
  positionsRef.current = positions

  const fullSvg = `<svg class="dag-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${theme.border}"/></marker></defs>
    ${svg}
  </svg>`

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 1000,
          background: toast.includes('실패') ? '#450a0a' : '#052e16',
          border: `1px solid ${toast.includes('실패') ? '#ef4444' : '#22c55e'}`,
          color: toast.includes('실패') ? '#f87171' : '#4ade80',
          padding: '10px 20px', borderRadius: 8, fontSize: '0.85rem', fontWeight: 600,
        }}>{toast}</div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>노드 클릭 → 실행 메뉴</span>
        <div style={{ flex: 1 }} />
        {Object.entries(STATUS_COLORS).map(([k, v]) => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: v.stroke }} />{ST[k]?.label || k}
          </span>
        ))}
        <button onClick={load} style={{
          padding: '4px 12px', fontSize: '0.7rem', border: '1px solid var(--border-color)',
          borderRadius: 6, cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
        }}>새로고침</button>
      </div>

      {/* DAG */}
      <div
        ref={containerRef}
        style={{ position: 'relative', overflowX: 'auto', padding: '16px 0', background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}
      >
        <div onClick={handleSvgClick} dangerouslySetInnerHTML={{ __html: fullSvg }} />

        {/* Popup */}
        {popup && (
          <div style={{
            position: 'absolute', zIndex: 50, left: popup.x, top: popup.y,
            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderRadius: 12, padding: 12, minWidth: 180,
            boxShadow: `0 8px 32px rgba(0,0,0,var(--shadow-intensity, 0.3))`,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>{popup.stageId}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <PopupBtn label="▶ 이 단계만 실행" onClick={() => onRun(popup.sourceId, popup.stageId, 'single')} />
              {!popup.shared && (
                <>
                  <PopupBtn label="▶▶ 여기부터 끝까지" color="#ca8a04" onClick={() => onRun(popup.sourceId, popup.stageId, 'downstream')} />
                  <PopupBtn label="▶▶▶ 전체 파이프라인" color="#0ea5e9" onClick={() => onRun(popup.sourceId, popup.stageId, 'all')} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .dag-node { cursor: pointer; }
        .dag-node:hover rect { stroke-width: 2.5; }
        .dag-node.running rect.node-bg { animation: dagpulse 2s ease-in-out infinite; }
        @keyframes dagpulse { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:.4} }
      `}</style>
    </div>
  )
}

function PopupBtn({ label, color, onClick }: { label: string; color?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 14px', border: `1px solid ${color || 'var(--border-color)'}`, borderRadius: 8,
      background: 'transparent', cursor: 'pointer', color: color || 'var(--text-primary)',
      fontSize: '0.8rem', fontWeight: 500, textAlign: 'left', transition: 'background 0.1s',
    }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary, #334155)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >{label}</button>
  )
}
