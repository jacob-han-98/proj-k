import { useState, useEffect } from 'react'
import { fetchDefaultPrompts } from './api'
import type { PromptDefault } from './api'
import { getPromptOverrides, setPromptOverride, removePromptOverride, resetAllOverrides } from './promptStorage'

interface Props {
  onClose: () => void
}

// 단계 순서 (UI 표시 순)
const PROMPT_ORDER = ['planning', 'answer', 'answer_basic', 'reflection', 'proposal', 'synthesis', 'synthesis_basic']

// 플레이스홀더 경고
const PLACEHOLDER_WARNINGS: Record<string, string> = {
  proposal: '⚠ {quality_criteria_section} 플레이스홀더를 반드시 포함해야 합니다.',
  synthesis: '⚠ {query} 플레이스홀더를 반드시 포함해야 합니다.',
  synthesis_basic: '⚠ {query} 플레이스홀더를 반드시 포함해야 합니다.',
}

export default function PromptSettings({ onClose }: Props) {
  const [defaults, setDefaults] = useState<Record<string, PromptDefault>>({})
  const [overrides, setOverrides] = useState<Record<string, string>>(getPromptOverrides())
  const [selectedKey, setSelectedKey] = useState('planning')
  const [editValue, setEditValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose])

  useEffect(() => {
    fetchDefaultPrompts()
      .then(data => {
        setDefaults(data)
        // 초기 편집 값 설정
        const key = 'planning'
        setEditValue(overrides[key] || data[key]?.content || '')
        setLoading(false)
      })
      .catch(err => {
        console.error('Failed to fetch default prompts:', err)
        setError('프롬프트를 불러올 수 없습니다. 서버에 최신 코드가 배포되었는지 확인해주세요.')
        setLoading(false)
      })
  }, [])

  const handleSelectKey = (key: string) => {
    // 현재 dirty면 자동 저장
    if (dirty) {
      handleSave()
    }
    setSelectedKey(key)
    setEditValue(overrides[key] || defaults[key]?.content || '')
    setDirty(false)
  }

  const handleSave = () => {
    const defaultContent = defaults[selectedKey]?.content || ''
    if (editValue === defaultContent) {
      // 기본값과 동일하면 override 제거
      removePromptOverride(selectedKey)
      const next = { ...overrides }
      delete next[selectedKey]
      setOverrides(next)
    } else {
      setPromptOverride(selectedKey, editValue)
      setOverrides({ ...overrides, [selectedKey]: editValue })
    }
    setDirty(false)
  }

  const handleResetOne = () => {
    const defaultContent = defaults[selectedKey]?.content || ''
    setEditValue(defaultContent)
    removePromptOverride(selectedKey)
    const next = { ...overrides }
    delete next[selectedKey]
    setOverrides(next)
    setDirty(false)
  }

  const handleResetAll = () => {
    if (!confirm('모든 커스텀 프롬프트를 기본값으로 초기화하시겠습니까?')) return
    resetAllOverrides()
    setOverrides({})
    setEditValue(defaults[selectedKey]?.content || '')
    setDirty(false)
  }

  const isOverridden = (key: string) => key in overrides

  const warning = PLACEHOLDER_WARNINGS[selectedKey]
  const hasPlaceholderIssue = warning && (
    (selectedKey === 'proposal' && !editValue.includes('{quality_criteria_section}')) ||
    ((selectedKey === 'synthesis' || selectedKey === 'synthesis_basic') && !editValue.includes('{query}'))
  )

  return (
    <div className="prompt-settings-overlay" onClick={onClose}>
      <div className="prompt-settings-modal" onClick={e => e.stopPropagation()}>
        <div className="prompt-settings-header">
          <h2>프롬프트 설정</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="prompt-reset-all-btn" onClick={handleResetAll}>전체 초기화</button>
            <button className="prompt-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="prompt-settings-body">
          {error ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary, #888)', width: '100%' }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>{error}</div>
              <button className="prompt-action-btn" onClick={() => { setError(null); setLoading(true); fetchDefaultPrompts().then(data => { setDefaults(data); setEditValue(overrides['planning'] || data['planning']?.content || ''); setLoading(false); }).catch(() => { setError('프롬프트를 불러올 수 없습니다.'); setLoading(false); }) }}>재시도</button>
            </div>
          ) : (<>
          {/* Left: category list */}
          <div className="prompt-category-list">
            {loading ? (
              <div style={{ padding: 12, opacity: 0.6 }}>로딩 중...</div>
            ) : (
              PROMPT_ORDER.filter(k => k in defaults).map(key => (
                <button
                  key={key}
                  className={`prompt-category-item ${selectedKey === key ? 'active' : ''}`}
                  onClick={() => handleSelectKey(key)}
                >
                  <span className={`prompt-indicator ${isOverridden(key) ? 'overridden' : ''}`} />
                  {defaults[key]?.label || key}
                </button>
              ))
            )}
          </div>

          {/* Right: editor */}
          <div className="prompt-editor-area">
            {!loading && defaults[selectedKey] && (
              <>
                <div className="prompt-editor-toolbar">
                  <span className="prompt-editor-label">
                    {defaults[selectedKey].label}
                    {isOverridden(selectedKey) && <span style={{ color: '#f5a623', marginLeft: 6, fontSize: 12 }}>커스텀</span>}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="prompt-action-btn" onClick={handleResetOne} disabled={!isOverridden(selectedKey)}>
                      기본값 복원
                    </button>
                    <button className="prompt-action-btn primary" onClick={handleSave} disabled={!dirty}>
                      저장
                    </button>
                  </div>
                </div>
                {warning && (
                  <div className={`prompt-placeholder-warning ${hasPlaceholderIssue ? 'error' : ''}`}>
                    {warning}
                  </div>
                )}
                <textarea
                  className="prompt-textarea"
                  value={editValue}
                  onChange={e => { setEditValue(e.target.value); setDirty(true) }}
                  spellCheck={false}
                />
                <div className="prompt-editor-footer">
                  {editValue.length.toLocaleString()}자
                </div>
              </>
            )}
          </div>
          </>)}
        </div>
      </div>
    </div>
  )
}
