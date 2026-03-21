import { useState, useEffect } from 'react'
import { fetchQualityCriteria, updateQualityCriteria } from './api'
import type { QualityCriteria, QualityCriterion } from './api'

export default function QualityCriteriaPanel() {
  const [data, setData] = useState<QualityCriteria | null>(null)
  const [editing, setEditing] = useState<QualityCriterion[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchQualityCriteria()
      .then(setData)
      .catch(e => setError(e.message))
  }, [])

  const handleEdit = () => {
    if (data) setEditing(JSON.parse(JSON.stringify(data.criteria)))
  }

  const handleCancel = () => setEditing(null)

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    try {
      await updateQualityCriteria(editing)
      const fresh = await fetchQualityCriteria()
      setData(fresh)
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const updateField = (idx: number, field: keyof QualityCriterion, value: string | number) => {
    if (!editing) return
    const updated = [...editing]
    updated[idx] = { ...updated[idx], [field]: value }
    setEditing(updated)
  }

  if (error) return <div style={{ padding: 20, color: '#ef4444' }}>Error: {error}</div>
  if (!data) return <div style={{ padding: 20, color: 'var(--text-secondary)' }}>Loading...</div>

  const criteria = editing || data.criteria
  const categories = [...new Set(criteria.map(c => c.category))]

  return (
    <div className="quality-panel">
      <div className="quality-header">
        <div>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>기획서 품질 기준</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            최종 수정: {data.updated_at} · {data.criteria.length}개 기준
          </p>
        </div>
        {!editing ? (
          <button className="share-btn" onClick={handleEdit}>편집</button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="share-btn" onClick={handleCancel}>취소</button>
            <button className="share-btn" onClick={handleSave} disabled={saving}
              style={{ background: '#22c55e', color: '#fff', borderColor: '#22c55e' }}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        )}
      </div>

      {/* 참고 문서 */}
      <div className="quality-section">
        <h3 className="quality-section-title">참고 기획서</h3>
        <div className="quality-refs">
          {data.reference_docs.map((doc, i) => (
            <a key={i} href={doc.url} target="_blank" rel="noreferrer" className="quality-ref-card glass">
              <span className="quality-ref-title">{doc.title}</span>
              <span className="quality-ref-note">{doc.note}</span>
            </a>
          ))}
        </div>
      </div>

      {/* 기준 목록 */}
      {categories.map(cat => (
        <div key={cat} className="quality-section">
          <h3 className="quality-section-title">{cat}</h3>
          <div className="quality-criteria-list">
            {criteria.filter(c => c.category === cat).map((c) => {
              const globalIdx = criteria.indexOf(c)
              return (
                <div key={c.id} className="quality-criterion glass">
                  <div className="criterion-header">
                    <span className="criterion-weight">{c.weight}</span>
                    {editing ? (
                      <input
                        className="criterion-title-input"
                        value={c.title}
                        onChange={e => updateField(globalIdx, 'title', e.target.value)}
                      />
                    ) : (
                      <span className="criterion-title">{c.title}</span>
                    )}
                    <span className="criterion-source">{c.source}</span>
                  </div>
                  {editing ? (
                    <textarea
                      className="criterion-desc-input"
                      value={c.description}
                      onChange={e => updateField(globalIdx, 'description', e.target.value)}
                      rows={2}
                    />
                  ) : (
                    <p className="criterion-desc">{c.description}</p>
                  )}
                  {editing && (
                    <div className="criterion-edit-row">
                      <label>가중치:</label>
                      <input type="number" value={c.weight} min={1} max={10}
                        onChange={e => updateField(globalIdx, 'weight', parseInt(e.target.value) || 1)}
                        style={{ width: 50 }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
