import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchPipelineDag, fetchPipelineJobs, runPipelineDag, savePipelineSettings, retryJob, type PipelineDagResponse, type PipelineJob } from './api'

// ── Status theme (uses CSS vars at runtime) ───────

const ST: Record<string, { label: string; cssClass: string }> = {
  idle:      { label: 'IDLE',      cssClass: 'st-idle' },
  queued:    { label: 'QUEUED',    cssClass: 'st-queued' },
  running:   { label: 'RUNNING',   cssClass: 'st-running' },
  auto:      { label: 'AUTO',      cssClass: 'st-auto' },
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

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  const raw = iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z'
  const d = new Date(raw)
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
  queued:    { fill: '#2d2200', stroke: '#ca8a04', text: '#fbbf24' },
  auto:      { fill: '#052e16', stroke: '#22c55e', text: '#4ade80' },
  completed: { fill: '#052e16', stroke: '#22c55e', text: '#22c55e' },
  failed:    { fill: '#450a0a', stroke: '#ef4444', text: '#ef4444' },
} as Record<string, { fill: string; stroke: string; text: string }>

const JOB_STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280', running: '#f59e0b', completed: '#22c55e', failed: '#ef4444', cancelled: '#9ca3af',
}

// ── Build SVG ─────────────────────────────────────

interface NodePos { x: number; y: number; id: string; sourceId: number; stageId: string; shared?: boolean }

/** 노드 선택 정보 */
interface NodeSelection {
  sourceId: number   // 0 = shared
  stageId: string    // '' = source label selected (all jobs for that source)
  label: string
}

function buildSvg(dag: PipelineDagResponse, theme: ReturnType<typeof getThemeColors>, selected: NodeSelection | null, workers: Record<string, number>): { svg: string; positions: NodePos[]; w: number; h: number } {
  const NODE_W = 160, NODE_H = 78, GAP_X = 60, GAP_Y = 24
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

  // helper: is this node selected?
  const isSelected = (sourceId: number, stageId: string, shared?: boolean) => {
    if (!selected) return false
    if (shared) return selected.sourceId === 0 && selected.stageId === stageId
    if (!stageId) return selected.sourceId === sourceId && selected.stageId === ''
    return selected.sourceId === sourceId && selected.stageId === stageId
  }

  // -- Edges --
  dag.sources.forEach((src, ri) => {
    const y = GAP_Y + ri * rowH + NODE_H / 2

    // 소스 라벨 → Crawl 엣지는 표시하지 않음 (pending 정보가 없고 시각적 노이즈)

    src.edges.forEach(e => {
      const fi = src.stages.findIndex(s => s.id === e.from)
      const ti = src.stages.findIndex(s => s.id === e.to)
      if (fi < 0 || ti < 0) return
      const fx = LABEL_W + GAP_X / 2 + fi * (NODE_W + GAP_X) + NODE_W
      const tx = LABEL_W + GAP_X / 2 + ti * (NODE_W + GAP_X)
      const toStatus = src.stage_status[e.to] || { status: 'idle' }
      const pending = (toStatus.pending_count || 0) + (toStatus.running_count || 0)
      const color = pending > 0 ? '#22c55e' : theme.border
      svg += bezier(fx, y, tx, y, color, false, pending)
    })

    // last stage → shared index
    const lastIdx = src.stages.findIndex(s => s.id === src.last_stage)
    if (lastIdx >= 0) {
      const fx = LABEL_W + GAP_X / 2 + lastIdx * (NODE_W + GAP_X) + NODE_W
      const sharedCY = (contentH - GAP_Y) / 2 + GAP_Y / 2
      const indexPending = (dag.shared_status['index']?.pending_count || 0) + (dag.shared_status['index']?.running_count || 0)
      const color = indexPending > 0 ? '#22c55e' : theme.border
      svg += bezier(fx, y, sharedX, sharedCY, color, true, indexPending)
    }
  })

  // shared internal edges
  dag.shared_edges.forEach(e => {
    const sharedCY = (contentH - GAP_Y) / 2 + GAP_Y / 2
    const toStatus = dag.shared_status[e.to] || { status: 'idle' }
    const pending = (toStatus.pending_count || 0) + (toStatus.running_count || 0)
    const color = pending > 0 ? '#22c55e' : theme.border
    svg += bezier(sharedX + NODE_W, sharedCY, sharedX + NODE_W + GAP_X, sharedCY, color, false, pending)
  })

  // -- Source labels --
  dag.sources.forEach((src, ri) => {
    const x = 10, y = GAP_Y + ri * rowH
    const c = SOURCE_COLS[src.source_type] || SOURCE_COLS.perforce
    const sel = isSelected(src.source_id, '')
    positions.push({ x, y, id: `src-${src.source_id}`, sourceId: src.source_id, stageId: '', shared: false })
    svg += `<g class="dag-node" data-id="src-${src.source_id}" data-source="${src.source_id}" data-stage="">
      <rect x="${x}" y="${y}" width="${LABEL_W - 30}" height="${NODE_H}" rx="10" fill="${c.fill}" stroke="${sel ? '#fff' : c.stroke}" stroke-width="${sel ? 2.5 : 1.5}"/>
      <text x="${x + (LABEL_W - 30) / 2}" y="${y + NODE_H / 2 + 4}" text-anchor="middle" fill="${c.text}" font-size="12" font-weight="700">${esc(src.source_name)}</text>
    </g>`
  })

  // -- Stage nodes --
  const AUTO_KEY_MAP: Record<string, string> = { crawl: 'auto_crawl_interval', download: 'auto_download', enrich: 'auto_enrich' }
  dag.sources.forEach((src, ri) => {
    src.stages.forEach((stage, ci) => {
      const x = LABEL_W + GAP_X / 2 + ci * (NODE_W + GAP_X)
      const y = GAP_Y + ri * rowH
      const status = src.stage_status[stage.id] || { status: 'idle' }
      const pendingCount = (status.pending_count || 0)
      const runningCount = (status.running_count || 0)

      let displayStatus = status.status
      if (runningCount > 0) displayStatus = 'running'
      else if (pendingCount > 0) displayStatus = 'queued'
      else if (displayStatus === 'completed') displayStatus = 'idle'

      const sc = STATUS_COLORS[displayStatus] || STATUS_COLORS.idle
      const nodeFill = theme.bg2
      const nodeStroke = theme.border
      const isRunning = displayStatus === 'running' || displayStatus === 'auto'
      const sel = isSelected(src.source_id, stage.id)

      positions.push({ x, y, id: `${src.source_id}-${stage.id}`, sourceId: src.source_id, stageId: stage.id })

      const autoKey = AUTO_KEY_MAP[stage.id]
      const settings = src.settings || {}
      const isAuto = autoKey ? (autoKey === 'auto_crawl_interval' ? (settings as any)[autoKey] > 0 : !!(settings as any)[autoKey]) : false
      const autoInterval = autoKey === 'auto_crawl_interval' ? (settings as any)[autoKey] || 0 : 0
      const autoTooltip = isAuto ? (autoInterval ? `자동: ${autoInterval}초마다` : '자동: ON') : '자동: OFF'

      const btnY = y + NODE_H - 16
      const isBusy = displayStatus === 'running'
      const disabledOpacity = 0.2

      const wCount = workers[stage.id] || 0

      const isWindowsOnly = stage.id === 'capture'
      const winStroke = isWindowsOnly ? '#f97316' : nodeStroke  // 오렌지 테두리
      const winTooltip = isWindowsOnly ? '\n⊞ Windows 전용 — PC에서 워커 실행 필요' : ''

      svg += `<g class="dag-node ${isRunning ? 'running' : ''}" data-id="${src.source_id}-${stage.id}" data-source="${src.source_id}" data-stage="${stage.id}">
        <title>${esc(stage.label)}: ${esc(stage.desc || '')}${winTooltip}${pendingCount ? `\n대기: ${pendingCount}건` : ''}${wCount ? `\n워커: ${wCount}대` : ''}</title>
        <rect class="node-bg" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${nodeFill}" stroke="${sel ? '#2563eb' : winStroke}" stroke-width="${sel ? 2.5 : isWindowsOnly ? 2 : 1.5}" ${isWindowsOnly ? 'stroke-dasharray="4 2"' : ''}/>
        ${wCount > 0 ? `<g><circle cx="${x + NODE_W - 8}" cy="${y + 8}" r="8" fill="#052e16" stroke="#22c55e" stroke-width="1"/>
          <text x="${x + NODE_W - 8}" y="${y + 12}" text-anchor="middle" fill="#4ade80" font-size="9" font-weight="700">${wCount}</text></g>`
        : `<circle cx="${x + NODE_W - 8}" cy="${y + 8}" r="5" fill="none" stroke="${theme.border}" stroke-width="0.8" stroke-dasharray="2 2"/>`}
        <text x="${x + NODE_W / 2}" y="${y + 18}" text-anchor="middle" fill="${theme.text}" font-size="12" font-weight="600">${esc(stage.label)}</text>
        <text x="${x + NODE_W / 2}" y="${y + 33}" text-anchor="middle" fill="${theme.text2}" font-size="9">${timeAgo(status.completed_at || status.created_at)}</text>
        <text x="${x + NODE_W / 2}" y="${y + 46}" text-anchor="middle" fill="${sc.text}" font-size="9" font-weight="600">${
          displayStatus === 'running' ? 'RUNNING' + (runningCount > 1 ? ` (${runningCount})` : '') :
          displayStatus === 'queued' ? `QUEUED ${pendingCount}` :
          displayStatus === 'auto' ? 'AUTO' :
          displayStatus === 'failed' ? 'FAILED' :
          displayStatus === 'pending' ? 'PENDING' :
          status.completed_at ? '' : ''
        }</text>
        <g class="node-action" ${!isBusy ? `data-run="${src.source_id}-${stage.id}"` : ''} style="opacity:${isBusy ? disabledOpacity : 1}${isBusy ? ';pointer-events:none' : ''}">
          <title>${isBusy ? '실행 중...' : '이 단계 실행'}</title>
          <circle cx="${x + NODE_W / 2 - 24}" cy="${btnY}" r="9" fill="rgba(59,130,246,0.15)" stroke="#3b82f6" stroke-width="0.8"/>
          <text x="${x + NODE_W / 2 - 24}" y="${btnY + 4}" text-anchor="middle" fill="#60a5fa" font-size="10">▶</text>
        </g>
        <g class="node-action" ${!isBusy ? `data-run-downstream="${src.source_id}-${stage.id}"` : ''} style="opacity:${isBusy ? disabledOpacity : 1}${isBusy ? ';pointer-events:none' : ''}">
          <title>${isBusy ? '실행 중...' : '여기부터 끝까지 실행'}</title>
          <circle cx="${x + NODE_W / 2}" cy="${btnY}" r="9" fill="rgba(234,179,8,0.15)" stroke="#ca8a04" stroke-width="0.8"/>
          <text x="${x + NODE_W / 2}" y="${btnY + 4}" text-anchor="middle" fill="#fbbf24" font-size="8">▶▶</text>
        </g>
        ${autoKey ? (() => {
          const acx = x + NODE_W / 2 + 24, acy = btnY
          return `<g class="node-action" data-auto="${src.source_id}-${stage.id}">
          <title>${autoTooltip}</title>
          <circle cx="${acx}" cy="${acy}" r="9" fill="${isAuto ? '#052e16' : 'rgba(255,255,255,0.08)'}" stroke="${isAuto ? '#22c55e' : theme.border}" stroke-width="${isAuto ? '1.5' : '0.5'}"/>
          <text x="${acx}" y="${acy + 4}" text-anchor="middle" fill="${isAuto ? '#4ade80' : theme.text2}" font-size="11">⟳${isAuto ? `<animateTransform attributeName="transform" type="rotate" from="0 ${acx} ${acy}" to="360 ${acx} ${acy}" dur="2s" repeatCount="indefinite"/>` : ''}</text>
        </g>`})() : ''}
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
    const sel = isSelected(0, stage.id, true)

    positions.push({ x, y, id: `shared-${stage.id}`, sourceId: 0, stageId: stage.id, shared: true })

    svg += `<g class="dag-node" data-id="shared-${stage.id}" data-source="0" data-stage="${stage.id}">
      <title>${esc(stage.label)}: ${esc(stage.desc || '')}</title>
      <rect class="node-bg" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="12" fill="${sc.fill}" stroke="${sel ? '#2563eb' : sc.stroke}" stroke-width="${sel ? 3 : 2}"/>
      <text x="${x + NODE_W / 2}" y="${y + 20}" text-anchor="middle" fill="${theme.text}" font-size="13" font-weight="700">${esc(stage.label)}</text>
      <text x="${x + NODE_W / 2}" y="${y + 35}" text-anchor="middle" fill="${theme.text2}" font-size="9">${timeAgo(status.completed_at || status.created_at)}</text>
      <text x="${x + NODE_W / 2}" y="${y + 50}" text-anchor="middle" fill="${sc.text}" font-size="10" font-weight="600">${stOf(status.status).label}</text>
    </g>`
  })

  return { svg, positions, w: svgW, h: svgH }
}

function bezier(x1: number, y1: number, x2: number, y2: number, color: string, dashed: boolean, pendingCount?: number): string {
  const cx1 = x1 + (x2 - x1) * 0.4
  const cx2 = x2 - (x2 - x1) * 0.4
  let svg = `<path d="M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="6 3"' : ''} marker-end="url(#arrowhead)"/>`
  if (pendingCount && pendingCount > 0) {
    // 엣지 중간점에 pending 배지 표시
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2 - 10
    svg += `<g>
      <rect x="${mx - 14}" y="${my - 8}" width="28" height="16" rx="8" fill="#ca8a04" opacity="0.9"/>
      <text x="${mx}" y="${my + 4}" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">${pendingCount}</text>
    </g>`
  }
  return svg
}

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// ── Job Log StatusBadge ────────────────────────────

const JobStatusBadge = ({ status }: { status: string }) => (
  <span style={{
    display: 'inline-block', padding: '1px 6px', borderRadius: 10,
    fontSize: '0.7rem', fontWeight: 600,
    background: (JOB_STATUS_COLORS[status] || '#6b7280') + '22',
    color: JOB_STATUS_COLORS[status] || '#6b7280',
  }}>{status}</span>
)

// ── Main component ────────────────────────────────

export default function PipelineGraphTab() {
  const [dag, setDag] = useState<PipelineDagResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const positionsRef = useRef<NodePos[]>([])

  // Node selection & job log
  const [selected, setSelected] = useState<NodeSelection | null>(null)
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  const [jobTotal, setJobTotal] = useState(0)
  const [jobPage, setJobPage] = useState(0)
  const [jobStatusFilter, setJobStatusFilter] = useState<Set<string>>(new Set())
  const [jobPageSize, setJobPageSize] = useState(50)

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

  // Auto-refresh when jobs are active — 2초 간격
  useEffect(() => {
    if (!dag) return
    const hasActiveJobs = dag.sources.some(src => Object.values(src.stage_status).some(x =>
      x.status === 'running' || (x.pending_count || 0) > 0 || (x.running_count || 0) > 0
    )) || Object.values(dag.shared_status).some(x => x.status === 'running' || (x.pending_count || 0) > 0)
    const hasWorkers = dag.workers && Object.values(dag.workers).some(v => v > 0)
    const hasAutoSettings = dag.sources.some(src => src.settings?.auto_crawl_interval)
    if (!hasActiveJobs && !hasWorkers && !hasAutoSettings) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [dag, load])

  // Load jobs when selection, page, or status filter changes
  useEffect(() => {
    const sourceId = selected?.sourceId
    const jobType = selected?.stageId || undefined
    fetchPipelineJobs(
      jobStatusFilter.size > 0 ? [...jobStatusFilter] : undefined,
      jobType ? [jobType] : undefined,
      jobPageSize,
      jobPage * jobPageSize,
      sourceId || undefined,
    )
      .then(r => { setJobs(r.jobs); setJobTotal(r.total) })
      .catch(() => {})
  }, [selected, jobPage, jobStatusFilter, jobPageSize])

  // Auto-refresh jobs when running jobs exist
  useEffect(() => {
    const hasRunning = jobs.some(j => j.status === 'running' || j.status === 'pending')
    if (!hasRunning) return
    const sourceId = selected?.sourceId
    const jobType = selected?.stageId || undefined
    const t = setInterval(() => {
      fetchPipelineJobs(jobStatusFilter.size > 0 ? [...jobStatusFilter] : undefined, jobType ? [jobType] : undefined, jobPageSize, jobPage * jobPageSize, sourceId || undefined)
        .then(r => { setJobs(r.jobs); setJobTotal(r.total) })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [jobs, selected, jobPage, jobStatusFilter, jobPageSize])

  const onRun = useCallback(async (sourceId: number, stage: string, mode: 'single' | 'downstream' | 'all') => {
    try {
      const sid = sourceId || dag?.sources[0]?.source_id || 1
      // 노드 자동 선택 + running 필터 자동 활성화
      setSelected({ sourceId: sid, stageId: stage, label: stage })
      setJobStatusFilter(new Set(['running']))
      setJobPage(0)
      const r = await runPipelineDag(sid, stage, mode) as any
      const launched = r.workers_launched || 0
      const pendingTotal = r.pending ? Object.values(r.pending as Record<string, number>).reduce((a: number, b: number) => a + b, 0) : 0
      if (r.windows_only) {
        setToast(`Windows 전용 작업 (대기 ${pendingTotal}건) — Windows PC에서 워커를 실행하세요`)
        setTimeout(() => setToast(null), 5000)
      } else {
        setToast(launched > 0 ? `워커 ${launched}개 실행 (대기 ${pendingTotal}건)` : '대기 작업 없음')
      }
      setTimeout(() => setToast(null), 3000)
      load()
    } catch (e) {
      setToast('실패: ' + (e instanceof Error ? e.message : String(e)))
      setTimeout(() => setToast(null), 5000)
    }
  }, [dag, load])

  const handleSvgClick = useCallback(async (e: React.MouseEvent) => {
    // ▶▶ 여기부터 끝까지
    const dsTarget = (e.target as Element).closest('[data-run-downstream]') as Element | null
    if (dsTarget) {
      const val = dsTarget.getAttribute('data-run-downstream') || ''
      const [sid, ...rest] = val.split('-')
      const stage = rest.join('-')
      if (sid && stage) onRun(Number(sid), stage, 'downstream')
      return
    }
    // ▶ 이 단계만 실행
    const runTarget = (e.target as Element).closest('[data-run]') as Element | null
    if (runTarget && !runTarget.hasAttribute('data-run-downstream')) {
      const val = runTarget.getAttribute('data-run') || ''
      const [sid, ...rest] = val.split('-')
      const stage = rest.join('-')
      if (sid && stage) onRun(Number(sid), stage, 'single')
      return
    }
    // ⟳ 자동 토글 클릭
    const autoTarget = (e.target as HTMLElement).closest('[data-auto]') as HTMLElement | null
    if (autoTarget) {
      const [sid, ...autoRest] = (autoTarget.getAttribute('data-auto') || '').split('-')
      const stage = autoRest.join('-')
      if (sid && stage && dag) {
        const src = dag.sources.find(s => s.source_id === Number(sid))
        const settings = src?.settings || {} as any
        const keyMap: Record<string, string> = { crawl: 'auto_crawl_interval', download: 'auto_download', enrich: 'auto_enrich' }
        const key = keyMap[stage]
        if (key) {
          const update: any = {}
          if (key === 'auto_crawl_interval') {
            update[key] = settings[key] > 0 ? 0 : 10
          } else {
            update[key] = !settings[key]
          }
          try {
            await savePipelineSettings(Number(sid), update)
            setToast(`${stage} 자동화: ${update[key] ? 'ON' : 'OFF'}`)
            setTimeout(() => setToast(null), 2000)
            load()
          } catch {
            setToast('설정 실패')
            setTimeout(() => setToast(null), 3000)
          }
        }
      }
      return
    }
    // 일반 노드 클릭 → 선택 (작업 로그 필터링)
    const target = (e.target as HTMLElement).closest('.dag-node') as HTMLElement | null
    if (!target) { setSelected(null); setJobPage(0); return }

    const sourceId = Number(target.getAttribute('data-source') || '0')
    const stageId = target.getAttribute('data-stage') || ''

    // 같은 노드 클릭 시 선택 해제
    if (selected && selected.sourceId === sourceId && selected.stageId === stageId) {
      setSelected(null)
      setJobPage(0)
      return
    }

    // 노드 라벨 결정
    let label = ''
    if (dag) {
      if (sourceId === 0) {
        label = dag.shared_stages.find(s => s.id === stageId)?.label || stageId
      } else if (!stageId) {
        label = dag.sources.find(s => s.source_id === sourceId)?.source_name || `Source #${sourceId}`
      } else {
        const src = dag.sources.find(s => s.source_id === sourceId)
        const stage = src?.stages.find(s => s.id === stageId)
        label = `${src?.source_name || ''} > ${stage?.label || stageId}`
      }
    }

    setSelected({ sourceId, stageId, label })
    setJobPage(0)
  }, [dag, load, onRun, selected])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>로딩 중...</div>
  if (error) return <div style={{ padding: 40, color: '#ef4444' }}>실패: {error}</div>
  if (!dag) return null

  const theme = getThemeColors()
  const { svg, positions, w, h } = buildSvg(dag, theme, selected, dag.workers || {})
  positionsRef.current = positions

  const fullSvg = `<svg class="dag-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${theme.border}"/></marker></defs>
    ${svg}
  </svg>`

  const totalPages = Math.ceil(jobTotal / jobPageSize)

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
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>노드 클릭 → 작업 로그 필터</span>
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
      </div>

      {/* Job Log */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>작업 로그</h3>
          {selected ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 10px', borderRadius: 16,
              background: '#2563eb22', color: '#2563eb', fontSize: '0.75rem', fontWeight: 600,
            }}>
              {selected.label}
              <span
                onClick={() => { setSelected(null); setJobPage(0) }}
                style={{ cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1 }}
              >×</span>
            </span>
          ) : (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>전체</span>
          )}
          <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
            {['pending', 'running', 'completed', 'failed'].map(s => {
              const active = jobStatusFilter.has(s)
              return (
                <button
                  key={s}
                  onClick={() => {
                    setJobStatusFilter(prev => {
                      const next = new Set(prev)
                      if (next.has(s)) next.delete(s); else next.add(s)
                      return next
                    })
                    setJobPage(0)
                  }}
                  style={{
                    padding: '2px 8px', fontSize: '0.7rem', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${active ? JOB_STATUS_COLORS[s] : 'var(--border-color)'}`,
                    background: active ? (JOB_STATUS_COLORS[s] || '#6b7280') + '22' : 'transparent',
                    color: active ? JOB_STATUS_COLORS[s] : 'var(--text-secondary)',
                    fontWeight: active ? 600 : 400,
                  }}
                >{s}</button>
              )
            })}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>{jobTotal}건</span>
          <select
            value={jobPageSize}
            onChange={e => { setJobPageSize(Number(e.target.value)); setJobPage(0) }}
            style={{ padding: '2px 6px', fontSize: '0.7rem', borderRadius: 4, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', marginLeft: 8 }}
          >
            {[50, 100, 200].map(n => <option key={n} value={n}>{n}개씩</option>)}
          </select>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
              <th style={{ padding: '5px 8px', width: 50 }}>ID</th>
              <th style={{ padding: '5px 8px', width: 70 }}>타입</th>
              <th style={{ padding: '5px 8px' }}>문서</th>
              <th style={{ padding: '5px 8px', width: 80 }}>상태</th>
              <th style={{ padding: '5px 8px', width: 110 }}>생성</th>
              <th style={{ padding: '5px 8px', width: 110 }}>완료</th>
              <th style={{ padding: '5px 8px' }}>에러</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>#{j.id}</td>
                <td style={{ padding: '4px 8px' }}>{j.job_type}</td>
                <td style={{ padding: '4px 8px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.doc_title || j.doc_path || (j.source_name ? `[${j.source_name}]` : '-')}
                  {j.doc_path && /^\d+$/.test(j.doc_path) && (
                    <a href={`https://bighitcorp.atlassian.net/wiki/pages/viewpage.action?pageId=${j.doc_path}`}
                       target="_blank" rel="noreferrer"
                       style={{ marginLeft: 6, fontSize: '0.65rem', color: '#2563eb', textDecoration: 'none' }}
                       title="Confluence에서 보기">↗</a>
                  )}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <JobStatusBadge status={j.status} />
                  {j.progress && <span style={{ marginLeft: 4, fontSize: '0.65rem', color: '#2563eb' }}>{j.progress}</span>}
                </td>
                <td style={{ padding: '4px 8px', color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{formatTime(j.created_at)}</td>
                <td style={{ padding: '4px 8px', color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{formatTime(j.completed_at)}</td>
                <td style={{ padding: '4px 8px', color: '#ef4444', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.72rem' }}>
                  {j.error_message || ''}
                  {j.status === 'failed' && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        try {
                          await retryJob(j.id)
                          setToast('재시도: pending으로 이동')
                          setTimeout(() => setToast(null), 2000)
                          // 작업 목록 새로고침
                          const sourceId = selected?.sourceId
                          const jobType = selected?.stageId || undefined
                          const r = await fetchPipelineJobs(
                            jobStatusFilter.size > 0 ? [...jobStatusFilter] : undefined,
                            jobType ? [jobType] : undefined, jobPageSize, jobPage * jobPageSize, sourceId || undefined
                          )
                          setJobs(r.jobs); setJobTotal(r.total)
                          load()
                        } catch (err) {
                          setToast('재시도 실패: ' + (err instanceof Error ? err.message : String(err)))
                          setTimeout(() => setToast(null), 3000)
                        }
                      }}
                      style={{
                        marginLeft: 6, padding: '1px 6px', fontSize: '0.65rem',
                        border: '1px solid #f97316', borderRadius: 4,
                        background: 'transparent', color: '#f97316',
                        cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                      title="pending으로 재시도"
                    >재시도</button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>작업 없음</td></tr>}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12, fontSize: '0.78rem' }}>
            <button
              disabled={jobPage === 0}
              onClick={() => setJobPage(p => p - 1)}
              style={{ padding: '3px 10px', border: '1px solid var(--border-color)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: jobPage === 0 ? 'not-allowed' : 'pointer', opacity: jobPage === 0 ? 0.4 : 1 }}
            >이전</button>
            <span style={{ color: 'var(--text-secondary)' }}>{jobPage + 1} / {totalPages}</span>
            <button
              disabled={jobPage >= totalPages - 1}
              onClick={() => setJobPage(p => p + 1)}
              style={{ padding: '3px 10px', border: '1px solid var(--border-color)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: jobPage >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: jobPage >= totalPages - 1 ? 0.4 : 1 }}
            >다음</button>
          </div>
        )}
      </div>

      <style>{`
        .dag-node { cursor: pointer; }
        .dag-node:hover rect.node-bg { stroke-width: 2.5; }
        .dag-node.running rect.node-bg { animation: dagpulse 2s ease-in-out infinite; }
        .node-action:hover circle { fill: rgba(255,255,255,0.2) !important; }
        @keyframes dagpulse { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:.4} }
      `}</style>
    </div>
  )
}
