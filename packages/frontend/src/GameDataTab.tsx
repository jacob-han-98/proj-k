import { useState, useEffect, useCallback } from 'react'
import { fetchGameDataSummary, fetchGameDataTable, fetchGameDataDescribe, fetchGameDataEnum, searchGameData, type GameDataSummary, type GameDataQueryResult } from './api'

const cs = (styles: Record<string, any>) => styles as React.CSSProperties

// ── Styles ─────────────────────────────────────

const card = cs({ background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 14px', border: '1px solid var(--border-color)' })
const statNum = cs({ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 })
const statLabel = cs({ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: 2 })
const inputStyle = cs({
  padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color)',
  background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.78rem', width: '100%',
  outline: 'none',
})
const btnStyle = cs({
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-color)',
  background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.75rem',
  cursor: 'pointer', fontWeight: 500,
})
const btnActive = cs({
  ...btnStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb',
})
const thStyle = cs({
  padding: '5px 8px', textAlign: 'left' as const, fontSize: '0.7rem', fontWeight: 600,
  color: 'var(--text-secondary)', borderBottom: '2px solid var(--border-color)',
  whiteSpace: 'nowrap' as const, position: 'sticky' as const, top: 0,
  background: 'var(--bg-primary)', zIndex: 1,
})
const tdStyle = cs({
  padding: '4px 8px', fontSize: '0.73rem', color: 'var(--text-primary)',
  borderBottom: '1px solid var(--border-color)', maxWidth: 200,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
})

function Badge({ text, color = '#6b7280' }: { text: string; color?: string }) {
  return <span style={{
    display: 'inline-block', padding: '1px 6px', borderRadius: 8,
    fontSize: '0.6rem', fontWeight: 600, background: color + '22', color,
  }}>{text}</span>
}

const CS_COLORS: Record<string, string> = { cs: '#22c55e', c: '#3b82f6', s: '#f59e0b', sc: '#22c55e' }

// ── Main Component ─────────────────────────────

export default function GameDataTab() {
  const [summary, setSummary] = useState<GameDataSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[] | null>(null)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [tableData, setTableData] = useState<GameDataQueryResult | null>(null)
  const [tableSchema, setTableSchema] = useState<GameDataQueryResult | null>(null)
  const [tableLoading, setTableLoading] = useState(false)
  const [filterInput, setFilterInput] = useState('')
  const [activeFilter, setActiveFilter] = useState('')
  const [viewMode, setViewMode] = useState<'data' | 'schema'>('data')
  const [enumData, setEnumData] = useState<GameDataQueryResult | null>(null)
  const [selectedEnum, setSelectedEnum] = useState<string | null>(null)
  const [tableFilter, setTableFilter] = useState('')

  useEffect(() => {
    fetchGameDataSummary().then(s => { setSummary(s); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults(null); return }
    const r = await searchGameData(q)
    setSearchResults(r.results)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => doSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search, doSearch])

  const openTable = useCallback(async (name: string) => {
    setSelectedTable(name)
    setTableLoading(true)
    setViewMode('data')
    setFilterInput('')
    setActiveFilter('')
    setSelectedEnum(null)
    try {
      const [data, schema] = await Promise.all([
        fetchGameDataTable(name, 100),
        fetchGameDataDescribe(name),
      ])
      setTableData(data)
      setTableSchema(schema)
    } catch { }
    setTableLoading(false)
  }, [])

  const applyFilter = useCallback(async () => {
    if (!selectedTable) return
    setTableLoading(true)
    setActiveFilter(filterInput)
    try {
      const data = await fetchGameDataTable(selectedTable, 200, filterInput || undefined)
      setTableData(data)
    } catch { }
    setTableLoading(false)
  }, [selectedTable, filterInput])

  const openEnum = useCallback(async (enumType: string) => {
    setSelectedEnum(enumType)
    try {
      const data = await fetchGameDataEnum(enumType)
      setEnumData(data)
    } catch { }
  }, [])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>DataSheet DB 로딩 중...</div>
  if (!summary?.ready) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: '2rem', marginBottom: 12 }}>No DB</div>
      <p style={{ color: 'var(--text-secondary)' }}>
        게임 데이터 DB가 없습니다. DataSheet 파이프라인의 "Table Parser → SQLite"를 실행하세요.
      </p>
    </div>
  )

  const filteredTables = summary.tables?.filter(t =>
    !tableFilter || t.name.toLowerCase().includes(tableFilter.toLowerCase()) || t.file.toLowerCase().includes(tableFilter.toLowerCase())
  ) || []

  return (
    <div style={{ display: 'flex', gap: 20, minHeight: 'calc(100vh - 250px)' }}>
      {/* Left panel: DB Summary + Table list */}
      <div style={{ width: selectedTable ? 240 : 320, flexShrink: 0, transition: 'width 0.2s', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Stats cards — compact 2 rows */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          <div style={card}>
            <div style={statNum}>{summary.table_count}</div>
            <div style={statLabel}>Tables</div>
          </div>
          <div style={card}>
            <div style={statNum}>{(summary.total_rows || 0).toLocaleString()}</div>
            <div style={statLabel}>Rows</div>
          </div>
          <div style={card}>
            <div style={statNum}>{summary.db_size_mb}<span style={{ fontSize: '0.65rem', fontWeight: 400 }}>MB</span></div>
            <div style={statLabel}>DB Size</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          <div style={card}>
            <div style={statNum}>{summary.enum_types}</div>
            <div style={statLabel}>Enum Types</div>
          </div>
          <div style={card}>
            <div style={statNum}>{(summary.enum_values || 0).toLocaleString()}</div>
            <div style={statLabel}>Enum Values</div>
          </div>
          <div style={card}>
            <div style={statNum}>{summary.fk_count}</div>
            <div style={statLabel}>FK Relations</div>
          </div>
        </div>
        <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
          Ingested: {summary.ingested_at}
        </div>

        {/* Search */}
        <input
          style={inputStyle}
          placeholder="Search tables, enums..."
          value={search}
          onChange={e => { setSearch(e.target.value); setTableFilter('') }}
          onFocus={() => setTableFilter('')}
        />

        {/* Search results */}
        {searchResults && search && (
          <div style={{ ...card, maxHeight: 200, overflowY: 'auto', padding: '8px 0' }}>
            {searchResults.length === 0 && <div style={{ padding: '8px 16px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>결과 없음</div>}
            {searchResults.map((r, i) => (
              <div key={i}
                onClick={() => {
                  if (r.type === 'table') { openTable(r.name); setSearch(''); setSearchResults(null) }
                  else if (r.type === 'enum') { openEnum(r.enum_type); setSearch(''); setSearchResults(null) }
                }}
                style={{ padding: '4px 12px', cursor: 'pointer', fontSize: '0.73rem', display: 'flex', gap: 6, alignItems: 'center' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-primary)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Badge text={r.type} color={r.type === 'table' ? '#3b82f6' : '#a855f7'} />
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{r.name || r.enum_type}</span>
                {r.type === 'table' && <span style={{ color: 'var(--text-secondary)', fontSize: '0.6rem' }}>{r.rows}rows</span>}
                {r.type === 'enum' && <span style={{ color: 'var(--text-secondary)', fontSize: '0.6rem' }}>{r.comment}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Table list filter */}
        {!search && (
          <input style={{ ...inputStyle, fontSize: '0.7rem' }} placeholder="Filter tables..."
            value={tableFilter} onChange={e => setTableFilter(e.target.value)} />
        )}

        {/* Table list */}
        {!search && (
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 580px)' }}>
            {filteredTables.map(t => (
              <div key={t.name}
                onClick={() => openTable(t.name)}
                style={{
                  padding: '5px 8px', cursor: 'pointer', borderRadius: 4, marginBottom: 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: selectedTable === t.name ? 'var(--bg-secondary)' : 'transparent',
                  borderLeft: selectedTable === t.name ? '2px solid #2563eb' : '2px solid transparent',
                }}
                onMouseEnter={e => { if (selectedTable !== t.name) e.currentTarget.style.background = 'var(--bg-secondary)' }}
                onMouseLeave={e => { if (selectedTable !== t.name) e.currentTarget.style.background = 'transparent' }}
              >
                <Badge text={t.cs} color={CS_COLORS[t.cs] || '#6b7280'} />
                <span style={{ fontSize: '0.73rem', fontWeight: 500, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', flexShrink: 0 }}>{t.rows}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right panel: Table viewer / Enum viewer */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Enum popup */}
        {selectedEnum && enumData && (
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: '0.85rem' }}>{selectedEnum}</h3>
              <button style={btnStyle} onClick={() => { setSelectedEnum(null); setEnumData(null) }}>Close</button>
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{enumData.columns.map(c => <th key={c} style={thStyle}>{c}</th>)}</tr></thead>
                <tbody>
                  {enumData.rows.map((r, i) => (
                    <tr key={i}>{r.map((v: any, j: number) => <td key={j} style={tdStyle}>{v ?? ''}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Table viewer */}
        {selectedTable && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{selectedTable}</h3>
              <Badge text={`${tableData?.total ?? 0} rows`} color="#3b82f6" />
              {tableData?.ms != null && <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>{tableData.ms}ms</span>}
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button style={viewMode === 'data' ? btnActive : btnStyle} onClick={() => setViewMode('data')}>Data</button>
              <button style={viewMode === 'schema' ? btnActive : btnStyle} onClick={() => setViewMode('schema')}>Schema</button>
              <div style={{ width: 1, height: 20, background: 'var(--border-color)', margin: '0 2px' }} />
              <input
                style={{ ...inputStyle, width: 260, fontSize: '0.73rem' }}
                placeholder="Filter: Column=Value (e.g. Type=Boss)"
                value={filterInput}
                onChange={e => setFilterInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applyFilter() }}
              />
              <button style={btnStyle} onClick={applyFilter}>Apply</button>
              {activeFilter && (
                <button style={{ ...btnStyle, color: '#ef4444' }} onClick={() => { setFilterInput(''); setActiveFilter(''); openTable(selectedTable) }}>Clear</button>
              )}
            </div>

            {/* SQL preview */}
            {activeFilter && tableData?.sql && (
              <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', fontFamily: 'monospace', marginBottom: 6, padding: '3px 8px', background: 'var(--bg-secondary)', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tableData.sql}
              </div>
            )}

            {tableLoading && <div style={{ padding: 20, color: 'var(--text-secondary)' }}>Loading...</div>}

            {/* Schema view */}
            {!tableLoading && viewMode === 'schema' && tableSchema && (
              <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 380px)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{tableSchema.columns.map(c => <th key={c} style={thStyle}>{c}</th>)}</tr></thead>
                  <tbody>
                    {tableSchema.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((v: any, j: number) => (
                          <td key={j} style={tdStyle}>
                            {tableSchema.columns[j] === 'is_enum' && v ? (
                              <span
                                style={{ cursor: 'pointer', color: '#a855f7', textDecoration: 'underline' }}
                                onClick={() => openEnum(r[j + 1])}
                              >Yes</span>
                            ) : tableSchema.columns[j] === 'enum_name' && v ? (
                              <span
                                style={{ cursor: 'pointer', color: '#a855f7', textDecoration: 'underline' }}
                                onClick={() => openEnum(v)}
                              >{v}</span>
                            ) : String(v ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Data view */}
            {!tableLoading && viewMode === 'data' && tableData && (
              <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 380px)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                {tableData.error ? (
                  <div style={{ padding: 20, color: '#ef4444' }}>{tableData.error}</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: tableData.columns.length * 120 }}>
                    <thead>
                      <tr>{tableData.columns.map(c => <th key={c} style={thStyle}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {tableData.rows.map((r, i) => (
                        <tr key={i} style={{ background: i % 2 ? 'transparent' : 'var(--bg-secondary)' + '40' }}>
                          {r.map((v: any, j: number) => <td key={j} style={tdStyle} title={String(v ?? '')}>{v ?? ''}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}

        {!selectedTable && !selectedEnum && (
          <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 200px)', padding: '0 4px' }}>

            {/* How it works */}
            <div style={{ ...card, marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 10px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>How it works</h4>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', padding: '12px 0', flexWrap: 'wrap' }}>
                {[
                  { label: 'Perforce\nDataSheet xlsx', color: '#1a3a2a', border: '#059669' },
                  { label: 'Table Parser\nRow1 Header, Row2 Type\nRow3+ Data', color: '#1e293b', border: '#475569' },
                  { label: 'SQLite DB\n187 Tables\n28,126 Rows', color: '#172554', border: '#2563eb' },
                  { label: 'Agent Planning\nquery_game_data\ntool calling', color: '#3b1764', border: '#7c3aed' },
                  { label: 'Answer\n기획서 + 데이터\n교차 참조 답변', color: '#422006', border: '#d97706' },
                ].map((step, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ padding: '8px 14px', borderRadius: 8, background: step.color, border: `1.5px solid ${step.border}`, textAlign: 'center', minWidth: 110 }}>
                      {step.label.split('\n').map((line, li) => (
                        <div key={li} style={{ fontSize: li === 0 ? '0.7rem' : '0.6rem', fontWeight: li === 0 ? 600 : 400, color: li === 0 ? '#fff' : '#94a3b8', lineHeight: 1.4 }}>{line}</div>
                      ))}
                    </div>
                    {i < 4 && <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>&rarr;</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Two knowledge sources */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div style={{ ...card, borderLeft: '3px solid #2563eb' }}>
                <h4 style={{ margin: '0 0 6px', fontSize: '0.78rem', color: '#93c5fd' }}>
                  기획서 (Design Docs)
                </h4>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <div><strong style={{ color: 'var(--text-primary)' }}>"왜, 어떻게"</strong> — 설계 의도, 시스템 규칙, 플로우</div>
                  <div style={{ marginTop: 4 }}>Vision AI로 변환 → ChromaDB 벡터 검색</div>
                  <div style={{ marginTop: 2 }}>도구: <code style={{ fontSize: '0.6rem', background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3 }}>retrieve</code> <code style={{ fontSize: '0.6rem', background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3 }}>section_search</code> <code style={{ fontSize: '0.6rem', background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3 }}>kg_related</code></div>
                </div>
              </div>
              <div style={{ ...card, borderLeft: '3px solid #059669' }}>
                <h4 style={{ margin: '0 0 6px', fontSize: '0.78rem', color: '#6ee7b7' }}>
                  데이터시트 (Game Data)
                </h4>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <div><strong style={{ color: 'var(--text-primary)' }}>"무엇이, 얼마나"</strong> — 실제 수치, 아이템 목록, 스탯</div>
                  <div style={{ marginTop: 4 }}>Table Parser → SQLite 구조화 쿼리</div>
                  <div style={{ marginTop: 2 }}>도구: <code style={{ fontSize: '0.6rem', background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3 }}>query_game_data</code></div>
                </div>
              </div>
            </div>

            {/* Planning Prompt */}
            <div style={{ ...card, marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                Planning Prompt — Agent가 도구를 선택하는 기준
              </h4>
              <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '10px 12px', fontSize: '0.63rem', fontFamily: 'monospace', lineHeight: 1.7, color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'pre-wrap' as any, border: '1px solid var(--border-color)' }}>
{`## 사용 가능한 검색 도구
1. retrieve     — 기획서 하이브리드 검색 (구조적+벡터). 설계 의도, 규칙, 플로우
2. section_search — 특정 워크북 내 집중 검색
3. kg_related   — 지식 그래프에서 관련 시스템 조회
4. query_game_data — 게임 데이터 테이블 직접 조회 (NEW)
   - 기획서 = "왜/어떻게",  데이터 테이블 = "무엇이/얼마나"
   - args: {action, table, columns, filters, order_by, limit}
   - 예: "레전더리 무기 목록" → query_game_data(table=ItemEquipClass, filters=[Grade=Legendary])
   - 예: "보스 몬스터 HP"   → query_game_data(table=MonsterClass, filters=[Type=Boss])`}
              </div>
            </div>

            {/* Answer Prompt */}
            <div style={{ ...card, marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                Answer Prompt — 두 소스 교차 참조 지시
              </h4>
              <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '10px 12px', fontSize: '0.63rem', fontFamily: 'monospace', lineHeight: 1.7, color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'pre-wrap' as any, border: '1px solid var(--border-color)' }}>
{`5. 기획서 + 데이터 테이블 교차 참조:
   "게임 데이터 조회 결과"가 포함된 경우,
   - 실제 수치 → 데이터 테이블에서 직접 인용 [출처: GameData/테이블명]
   - 설계 의도 → 기획서에서 인용 [출처: 워크북/시트명]
   - 두 소스를 결합하여 "왜 이 수치인지"까지 설명하면 최고의 답변`}
              </div>
            </div>

            {/* Context Assembly */}
            <div style={{ ...card, marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                Context Assembly — LLM에 전달되는 구조
              </h4>
              <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '10px 12px', fontSize: '0.63rem', fontFamily: 'monospace', lineHeight: 1.7, color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>
{`## 게임 데이터 조회 결과 (실제 수치)
| Id  | Name           | Type | Level | MaxHp   |
| 501 | 코럽티드 보어  | Boss | 50    | 125,000 |
...

---

## 참조 기획서 (설계 의도/규칙)
[PK_몬스터 시스템 / 보스 몬스터]
보스 몬스터는 일반 몬스터 대비 10배의 HP를 가지며...

---

## 질문
보스 몬스터의 HP는 어떻게 되나요?`}
              </div>
            </div>

            {/* Example Q&A */}
            <div style={{ ...card, marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                Before → After 예시
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <div style={{ fontSize: '0.65rem', fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>Before (기획서만)</div>
                  <div style={{ fontSize: '0.63rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    Q: "레전더리 무기 몇 개야?"<br/>
                    A: "해당 정보를 찾을 수 없습니다"<br/><br/>
                    Q: "보스 몬스터 HP 비교해줘"<br/>
                    A: "기획서에 일부 수치만 언급..."<br/><br/>
                    Q: "궁사 스킬 쿨타임 목록"<br/>
                    A: "스킬 시스템 설계 규칙은..."
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', fontWeight: 600, color: '#22c55e', marginBottom: 4 }}>After (+ 데이터시트)</div>
                  <div style={{ fontSize: '0.63rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    Q: "레전더리 무기 몇 개야?"<br/>
                    A: "ItemEquipClass에서 Grade=Legendary 조회 결과 <strong style={{ color: 'var(--text-primary)' }}>23개</strong>"<br/><br/>
                    Q: "보스 몬스터 HP 비교해줘"<br/>
                    A: "MonsterClass 조회: Lv50 보스 125,000 / Lv55 보스 180,000..."<br/><br/>
                    Q: "궁사 스킬 쿨타임 목록"<br/>
                    A: "CharacterSkillClass 테이블 + 기획서 교차:<br/>&nbsp;&nbsp;Rapid Shot 1.2초 / Arrow Rain 8초..."
                  </div>
                </div>
              </div>
            </div>

            {/* Schema injection info */}
            <div style={{ ...card }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                Schema Summary — Planning LLM에 주입되는 메타데이터
              </h4>
              <div style={{ fontSize: '0.63rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
                Agent가 어떤 테이블에 어떤 컬럼이 있는지 알아야 적절한 쿼리를 생성할 수 있습니다.
                아래 형식의 스키마 요약(~3-4K tokens)이 매 질문마다 Planning 프롬프트에 자동 주입됩니다.
              </div>
              <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '8px 12px', fontSize: '0.6rem', fontFamily: 'monospace', lineHeight: 1.6, color: 'var(--text-secondary)', maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border-color)' }}>
                {(summary?.tables || []).slice(0, 15).map(t => (
                  <div key={t.name}>
                    <strong style={{ color: 'var(--text-primary)' }}>{t.name}</strong> ({t.rows}rows, {t.columns}cols) — {t.file}
                  </div>
                ))}
                {(summary?.tables?.length || 0) > 15 && <div style={{ opacity: 0.5 }}>... +{(summary?.tables?.length || 0) - 15} more tables</div>}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  )
}
