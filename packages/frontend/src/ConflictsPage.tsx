import { useState, useEffect, useCallback } from 'react'
import './App.css'
import { fetchConflicts } from './api'
import type { ConflictScanResult, ConflictAnalysis, ConflictPair } from './api'

// ── Theme (공유) ──
type ThemeMode = 'system' | 'light' | 'dark';
function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

// ── 분류 기준 ──

/** 문서 쌍의 패턴을 자동 분류 */
function classifyPattern(a: ConflictAnalysis): string {
  const comp = a.comparison;
  if (a.error) return '분석 실패';
  if (!comp || !comp.conflicts) {
    // comparison 안에 error가 있는 경우 (JSON 파싱 실패 등)
    if (comp && ('error' in comp)) return '분석 실패';
    return '미분석';
  }

  const summary = (comp.summary || '').toLowerCase();
  const rel = (comp.version_relationship || '').toLowerCase();
  const types = (comp.conflicts || []).map(c => c.type);

  // Confluence 빈 페이지
  if (summary.includes('비어있') || summary.includes('빈 페이지') || summary.includes('비어 있'))
    return 'Confluence 미작성';
  // Excel OCR 깨짐
  if (summary.includes('ocr') || summary.includes('가독성') || summary.includes('판독'))
    return 'Excel 변환 오류';
  // 개편/폐기
  if (types.includes('폐기후보') || rel.includes('폐기') || rel.includes('개편') || rel.includes('아카이브'))
    return '개편 미반영';
  // 나머지 충돌
  if (comp.has_conflict) return '내용 불일치';
  return '정상';
}

const PATTERN_INFO: Record<string, { label: string; color: string; desc: string }> = {
  'Confluence 미작성': { label: 'Confluence 미작성', color: '#ef4444', desc: 'Excel에 상세 기획이 있으나 Confluence 페이지가 비어있음' },
  '개편 미반영': { label: '개편 미반영', color: '#f97316', desc: 'Confluence에서 시스템이 개편되었으나 Excel 원본이 갱신되지 않음' },
  '내용 불일치': { label: '내용 불일치', color: '#eab308', desc: '양쪽 문서 모두 내용이 있으나 공식, 수치, 구조 등이 서로 다름' },
  'Excel 변환 오류': { label: 'Excel 변환 오류', color: '#a855f7', desc: 'Excel 원본의 OCR/변환 품질이 낮아 내용 파악이 어려움' },
  '분석 실패': { label: '분석 실패', color: '#6b7280', desc: 'LLM 분석 중 오류 발생 (재시도 필요)' },
  '미분석': { label: '미분석', color: '#6b7280', desc: '아직 심층 분석이 실행되지 않은 쌍' },
  '정상': { label: '정상', color: '#22c55e', desc: '충돌 없음' },
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  major: '#f97316',
  minor: '#eab308',
  none: '#22c55e',
};

const CONFLICT_TYPE_LABELS: Record<string, string> = {
  '공식불일치': '공식 불일치',
  '수치불일치': '수치 불일치',
  '구조적차이': '구조적 차이',
  '정보누락': '정보 누락',
  '버전불일치': '버전 불일치',
  '폐기후보': '폐기 후보',
  '기타': '기타',
};

// ── 아이콘 ──
const ExcelIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#217346" />
    <path d="M4.5 4.5L8 9L4.5 13.5H6.5L9 10L11.5 13.5H13.5L10 9L13.5 4.5H11.5L9 8L6.5 4.5H4.5Z" fill="white" />
  </svg>
);
const ConfluenceIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
    <rect width="18" height="18" rx="3" fill="#1868DB" />
    <path d="M3.5 12.5C3.5 12.5 4 11.5 5 11.5C6.5 11.5 7 13 9 13C11 13 12 11 13.5 11C14.5 11 14.5 12 14.5 12L14.5 13.5C14.5 13.5 14 14.5 13 14.5C11.5 14.5 11 13 9 13C7 13 6 15 4.5 15C3.5 15 3.5 14 3.5 14V12.5Z" fill="white" />
    <path d="M14.5 5.5C14.5 5.5 14 6.5 13 6.5C11.5 6.5 11 5 9 5C7 5 6 7 4.5 7C3.5 7 3.5 6 3.5 6L3.5 4.5C3.5 4.5 4 3.5 5 3.5C6.5 3.5 7 5 9 5C11 5 12 3 13.5 3C14.5 3 14.5 4 14.5 4V5.5Z" fill="white" />
  </svg>
);

// ── 컴포넌트 ──

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className="severity-badge"
      style={{ background: SEVERITY_COLORS[severity] || '#6b7280', color: '#fff' }}
    >
      {severity}
    </span>
  );
}

function PatternBadge({ pattern }: { pattern: string }) {
  const info = PATTERN_INFO[pattern] || { color: '#6b7280', label: pattern };
  return (
    <span
      className="severity-badge"
      style={{ background: info.color, color: '#fff' }}
    >
      {info.label}
    </span>
  );
}

/** 분석 완료된 쌍의 상세 카드 */
function AnalysisCard({ analysis, pattern }: { analysis: ConflictAnalysis; pattern: string }) {
  const [expanded, setExpanded] = useState(false);
  const comp = analysis.comparison;
  const pair = analysis.pair;

  return (
    <div className={`conflict-card glass ${expanded ? 'expanded' : ''}`}>
      <div className="conflict-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="conflict-card-badges">
          {comp?.severity && <SeverityBadge severity={comp.severity} />}
          <PatternBadge pattern={pattern} />
          {comp?.conflicts && <span className="conflict-count-badge">{comp.conflicts.length}건</span>}
        </div>
        <div className="conflict-card-title">
          <span className="conflict-pair">
            <ExcelIcon /> <span className="pair-name">{pair.excel.replace('PK_', '')}</span>
            <span className="pair-arrow">↔</span>
            <ConfluenceIcon /> <span className="pair-name">{pair.confluence.split('\\').pop()}</span>
          </span>
          <span className="conflict-topic">{pair.overlap_topic}</span>
        </div>
        <span className={`expand-arrow ${expanded ? 'open' : ''}`}>&#9662;</span>
      </div>

      {expanded && comp && (
        <div className="conflict-card-body">
          {comp.summary && <p className="conflict-summary">{comp.summary}</p>}
          {comp.version_relationship && (
            <p className="conflict-relationship"><strong>관계:</strong> {comp.version_relationship}</p>
          )}
          {!comp.conflicts && ('error' in comp) && (
            <p className="conflict-error">LLM 응답 파싱 실패 — 재스캔 필요</p>
          )}
          <div className="conflict-details">
            {(comp.conflicts || []).map((c, i) => (
              <div key={i} className="conflict-detail-item">
                <div className="detail-header">
                  <SeverityBadge severity={c.severity} />
                  <span className="detail-type">{CONFLICT_TYPE_LABELS[c.type] || c.type}</span>
                  <span className="detail-topic">{c.topic}</span>
                </div>
                <div className="detail-comparison">
                  <div className="detail-side excel">
                    <ExcelIcon /> <span className="detail-label">Excel</span>
                    <p>{c.excel_says}</p>
                  </div>
                  <div className="detail-side confluence">
                    <ConfluenceIcon /> <span className="detail-label">Confluence</span>
                    <p>{c.confluence_says}</p>
                  </div>
                </div>
                <div className="detail-recommendation">
                  <strong>권고:</strong> {c.recommendation}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {expanded && analysis.error && (
        <div className="conflict-card-body">
          <p className="conflict-error">분석 오류: {analysis.error}</p>
        </div>
      )}
    </div>
  );
}

/** 미분석 쌍의 간단 카드 */
function UnanalyzedCard({ pair }: { pair: ConflictPair }) {
  return (
    <div className="conflict-card glass unanalyzed">
      <div className="conflict-card-header">
        <div className="conflict-card-badges">
          <span className="severity-badge" style={{ background: pair.confidence === 'high' ? '#ef4444' : pair.confidence === 'medium' ? '#eab308' : '#6b7280', color: '#fff' }}>
            {pair.confidence}
          </span>
          <PatternBadge pattern="미분석" />
        </div>
        <div className="conflict-card-title">
          <span className="conflict-pair">
            <ExcelIcon /> <span className="pair-name">{pair.excel.replace('PK_', '')}</span>
            <span className="pair-arrow">↔</span>
            <ConfluenceIcon /> <span className="pair-name">{pair.confluence.split('\\').pop()}</span>
          </span>
          <span className="conflict-topic">{pair.overlap_topic}</span>
        </div>
      </div>
    </div>
  );
}

// ── 메인 페이지 ──

function ConflictsPage() {
  const [data, setData] = useState<ConflictScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterSeverity, setFilterSeverity] = useState<string | null>(null);
  const [filterPattern, setFilterPattern] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [showUnanalyzed, setShowUnanalyzed] = useState(false);

  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    (localStorage.getItem('qna-theme') as ThemeMode) || 'system'
  );
  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    localStorage.setItem('qna-theme', mode);
    applyTheme(mode);
  }, []);
  useEffect(() => {
    applyTheme(themeMode);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => { if (themeMode === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  useEffect(() => {
    fetchConflicts()
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="layout"><div className="main-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="loading-spinner" /> Loading...</div></div>;
  if (error || !data) return <div className="layout"><div className="main-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444' }}>Error: {error || 'No data'}</div></div>;

  // 분석된 쌍에 패턴 분류 적용
  const analyzedWithPattern = data.analyses.map(a => ({
    analysis: a,
    pattern: classifyPattern(a),
  }));

  // 미분석 쌍 (analyses에 없는 pairs)
  const analyzedExcelSet = new Set(data.analyses.map(a => a.pair.excel));
  const unanalyzedPairs = data.pairs.filter(p => !analyzedExcelSet.has(p.excel));

  // 패턴별 카운트
  const patternCounts: Record<string, number> = {};
  analyzedWithPattern.forEach(({ pattern }) => {
    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
  });

  // 충돌 유형별 카운트
  const typeCounts: Record<string, number> = {};
  data.analyses.forEach(a => {
    (a.comparison?.conflicts || []).forEach(c => {
      typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    });
  });

  // 필터 적용
  let filtered = analyzedWithPattern;
  if (filterSeverity) {
    filtered = filtered.filter(({ analysis }) => analysis.comparison?.severity === filterSeverity);
  }
  if (filterPattern) {
    filtered = filtered.filter(({ pattern }) => pattern === filterPattern);
  }
  if (filterType) {
    filtered = filtered.filter(({ analysis }) =>
      (analysis.comparison?.conflicts || []).some(c => c.type === filterType)
    );
  }

  const clearFilters = () => {
    setFilterSeverity(null);
    setFilterPattern(null);
    setFilterType(null);
  };

  const hasFilter = filterSeverity || filterPattern || filterType;

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar glass">
        <div className="sidebar-header">
          <h2 className="logo">문서 정리 현황</h2>
        </div>

        {/* 요약 통계 */}
        <div className="conflicts-stats">
          <div className="stat-row"><span>매칭 쌍</span><strong>{data.pairs_found}쌍</strong></div>
          <div className="stat-row"><span>분석 완료</span><strong>{data.pairs_analyzed}쌍</strong></div>
          <div className="stat-row"><span>발견 충돌</span><strong>{data.total_conflicts}건</strong></div>
        </div>

        {/* 분류 기준 1: 패턴 */}
        <div className="sidebar-section">
          <p className="section-title">패턴별 분류</p>
          <div className="filter-chips">
            {Object.entries(patternCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([pattern, count]) => (
                <button
                  key={pattern}
                  className={`filter-chip ${filterPattern === pattern ? 'active' : ''}`}
                  style={{ '--chip-color': PATTERN_INFO[pattern]?.color || '#6b7280' } as React.CSSProperties}
                  onClick={() => setFilterPattern(filterPattern === pattern ? null : pattern)}
                >
                  <span className="chip-dot" style={{ background: PATTERN_INFO[pattern]?.color || '#6b7280' }} />
                  {PATTERN_INFO[pattern]?.label || pattern}
                  <span className="chip-count">{count}</span>
                </button>
              ))}
          </div>

          {/* 패턴 설명 */}
          {filterPattern && PATTERN_INFO[filterPattern] && (
            <p className="filter-desc">{PATTERN_INFO[filterPattern].desc}</p>
          )}
        </div>

        {/* 분류 기준 2: 심각도 */}
        <div className="sidebar-section" style={{ flex: 'none' }}>
          <p className="section-title">심각도</p>
          <div className="filter-chips">
            {['critical', 'major', 'minor'].map(sev => (
              <button
                key={sev}
                className={`filter-chip ${filterSeverity === sev ? 'active' : ''}`}
                onClick={() => setFilterSeverity(filterSeverity === sev ? null : sev)}
              >
                <span className="chip-dot" style={{ background: SEVERITY_COLORS[sev] }} />
                {sev}
                <span className="chip-count">{data.severity_counts[sev] || 0}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 분류 기준 3: 충돌 유형 */}
        <div className="sidebar-section" style={{ flex: 'none' }}>
          <p className="section-title">충돌 유형</p>
          <div className="filter-chips">
            {Object.entries(typeCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <button
                  key={type}
                  className={`filter-chip ${filterType === type ? 'active' : ''}`}
                  onClick={() => setFilterType(filterType === type ? null : type)}
                >
                  {CONFLICT_TYPE_LABELS[type] || type}
                  <span className="chip-count">{count}</span>
                </button>
              ))}
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="theme-selector">
            <button className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => handleThemeChange('system')}>System</button>
            <button className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>Light</button>
            <button className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>Dark</button>
          </div>
          <div className="status-text">
            스캔: {new Date(data.scan_time).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="chat-scroll-area" style={{ padding: '32px 40px' }}>
          {/* 헤더 */}
          <div className="conflicts-header animate-fade-in">
            <h1 className="main-title" style={{ fontSize: '1.5rem', marginBottom: 4 }}>정리가 필요한 문서</h1>
            <p className="sub-title" style={{ fontSize: '0.9rem' }}>
              Excel(Perforce)과 Confluence 간 동일 주제 문서의 충돌/outdated 현황
            </p>
          </div>

          {/* 요약 카드 */}
          <div className="conflicts-summary-cards">
            <div className="summary-card glass" style={{ borderLeft: '3px solid #ef4444' }}>
              <div className="summary-number">{data.severity_counts.critical || 0}</div>
              <div className="summary-label">Critical</div>
            </div>
            <div className="summary-card glass" style={{ borderLeft: '3px solid #f97316' }}>
              <div className="summary-number">{data.severity_counts.major || 0}</div>
              <div className="summary-label">Major</div>
            </div>
            <div className="summary-card glass" style={{ borderLeft: '3px solid #eab308' }}>
              <div className="summary-number">{data.severity_counts.minor || 0}</div>
              <div className="summary-label">Minor</div>
            </div>
            <div className="summary-card glass" style={{ borderLeft: '3px solid #6b7280' }}>
              <div className="summary-number">{unanalyzedPairs.length}</div>
              <div className="summary-label">미분석</div>
            </div>
          </div>

          {/* 필터 상태 */}
          {hasFilter && (
            <div className="active-filters">
              <span className="filter-label">필터:</span>
              {filterPattern && <span className="active-filter-tag">{filterPattern} <button onClick={() => setFilterPattern(null)}>x</button></span>}
              {filterSeverity && <span className="active-filter-tag">{filterSeverity} <button onClick={() => setFilterSeverity(null)}>x</button></span>}
              {filterType && <span className="active-filter-tag">{CONFLICT_TYPE_LABELS[filterType] || filterType} <button onClick={() => setFilterType(null)}>x</button></span>}
              <button className="clear-filters-btn" onClick={clearFilters}>전체 해제</button>
            </div>
          )}

          {/* 분석 완료 카드 목록 */}
          <div className="conflicts-list">
            {filtered.length === 0 && <p style={{ color: 'var(--text-secondary)', padding: 20 }}>필터 조건에 맞는 항목이 없습니다.</p>}
            {filtered.map(({ analysis, pattern }, i) => (
              <AnalysisCard key={i} analysis={analysis} pattern={pattern} />
            ))}
          </div>

          {/* 미분석 쌍 토글 */}
          {unanalyzedPairs.length > 0 && (
            <div className="unanalyzed-section">
              <button className="unanalyzed-toggle" onClick={() => setShowUnanalyzed(!showUnanalyzed)}>
                <span className={`expand-arrow ${showUnanalyzed ? 'open' : ''}`}>&#9662;</span>
                미분석 쌍 ({unanalyzedPairs.length}개)
              </button>
              {showUnanalyzed && (
                <div className="conflicts-list">
                  {unanalyzedPairs.map((p, i) => (
                    <UnanalyzedCard key={i} pair={p} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default ConflictsPage;
