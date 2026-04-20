/**
 * RefactorPanel — Admin 탭의 "기획서 정리" 섹션.
 *
 * 상위(AdminPage)는 타겟 선택 상태만 관리하고, 카드 로드/결정/피드백 액션은 이 패널이 담당한다.
 * 기존 Admin 스타일(.glass, .section-title, .admin-card, .source-link-card)을 재사용.
 */
import { useEffect, useState } from 'react';
import type {
  Grade,
  RefactorCard,
  RefactorTarget,
  RefactorOverview,
  DecisionRecord,
  FeedbackRecord,
} from './api';
import {
  fetchRefactorCards,
  applyRefactorDecision,
  recordRefactorFeedback,
  fetchRefactorDecisions,
  fetchRefactorFeedbackList,
} from './api';

const GRADE_COLORS: Record<Grade, string> = {
  S: '#ef4444',
  A: '#f59e0b',
  B: '#3b82f6',
  C: '#6b7280',
};

function GradeBadge({ grade }: { grade: Grade | string }) {
  const g = (grade || '?') as Grade;
  const color = GRADE_COLORS[g] || '#6b7280';
  return (
    <span style={{
      display: 'inline-block',
      minWidth: 24,
      textAlign: 'center',
      padding: '2px 8px',
      borderRadius: 6,
      background: color,
      color: 'white',
      fontWeight: 700,
      fontSize: '0.8rem',
    }}>{g}</span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const palette: Record<string, string> = {
    critical: '#dc2626',
    major: '#ea580c',
    minor: '#ca8a04',
  };
  const color = palette[severity] || '#6b7280';
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 4,
      background: color + '22',
      color,
      fontSize: '0.72rem',
      fontWeight: 600,
      letterSpacing: 0.3,
    }}>{severity}</span>
  );
}

function ConfidenceBadge({ c }: { c: string }) {
  const palette: Record<string, string> = { high: '#16a34a', medium: '#ca8a04', low: '#6b7280' };
  const color = palette[c] || '#6b7280';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 4,
      background: color + '22', color, fontSize: '0.72rem', fontWeight: 600,
    }}>{c}</span>
  );
}

// ── Overview (target 미선택 시) ───────────────────────────────

export function RefactorOverviewView({ overview }: { overview: RefactorOverview | null }) {
  if (!overview) return <div style={{ color: 'var(--text-secondary)' }}>Overview 로딩 중...</div>;
  const meta = overview.targets_meta;
  const grades = overview.grade_counts;
  return (
    <div className="welcome-area animate-fade-in">
      <h1 className="main-title">기획서 정리 Dashboard</h1>
      <p className="sub-title">
        왼쪽에서 리팩토링 대상을 선택하면 등급별 상세와 충돌 카드를 볼 수 있습니다.
      </p>
      <div className="admin-summary-cards">
        <div className="admin-card glass">
          <div className="admin-card-number">{meta.total_targets ?? 0}</div>
          <div className="admin-card-label">Ranker 타겟</div>
        </div>
        <div className="admin-card glass">
          <div className="admin-card-number">{overview.decisions.total}</div>
          <div className="admin-card-label">결정(Decisions)</div>
        </div>
        <div className="admin-card glass">
          <div className="admin-card-number">{overview.annotations.deprecated}</div>
          <div className="admin-card-label">Deprecated 주석</div>
        </div>
        <div className="admin-card glass">
          <div className="admin-card-number">{overview.feedback.total}</div>
          <div className="admin-card-label">피드백</div>
        </div>
      </div>

      <div className="glass" style={{ padding: '16px 20px', margin: '16px 0', borderRadius: 10 }}>
        <p className="section-title" style={{ marginBottom: 8 }}>등급 분포</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['S', 'A', 'B', 'C'] as Grade[]).map(g => (
            <span key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <GradeBadge grade={g} />
              <strong>{grades[g] ?? 0}</strong>
            </span>
          ))}
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginLeft: 'auto' }}>
            dims: {meta.dimensions_used?.join(', ') || '—'}
            {meta.generated_at && ` · 생성 ${new Date(meta.generated_at).toLocaleString('ko-KR')}`}
          </span>
        </div>
      </div>

      {overview.decisions.recent.length > 0 && (
        <div className="glass" style={{ padding: '16px 20px', margin: '16px 0', borderRadius: 10 }}>
          <p className="section-title" style={{ marginBottom: 8 }}>최근 결정</p>
          {overview.decisions.recent.slice().reverse().map(d => (
            <div key={d.id} style={{ padding: '6px 0', fontSize: '0.88rem', borderBottom: '1px dashed var(--border-color)' }}>
              <strong>{d.id}</strong> · {d.target_name} · 선택 <code>{d.selected_option}</code> · {d.date}
              <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{d.conflict_summary}</div>
            </div>
          ))}
        </div>
      )}

      {overview.feedback.recent.length > 0 && (
        <div className="glass" style={{ padding: '16px 20px', margin: '16px 0', borderRadius: 10 }}>
          <p className="section-title" style={{ marginBottom: 8 }}>최근 피드백</p>
          {overview.feedback.recent.slice().reverse().map(f => (
            <div key={f.id} style={{ padding: '6px 0', fontSize: '0.88rem', borderBottom: '1px dashed var(--border-color)' }}>
              <strong>{f.id}</strong> · <code>{f.action}</code>{f.regrade_to ? ` → ${f.regrade_to}` : ''} · {f.target_name}
              <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{f.comment}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Target 선택 시: 타겟 상세 + 카드 + 액션 ──────────────────

interface RefactorPanelProps {
  target: RefactorTarget;
  author: string;
  onSaved: () => void;  // 저장 후 overview 재로드 시그널
}

export function RefactorPanel({ target, author, onSaved }: RefactorPanelProps) {
  const [cards, setCards] = useState<RefactorCard[] | null>(null);
  const [cardsErr, setCardsErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [relatedDecisions, setRelatedDecisions] = useState<DecisionRecord[]>([]);
  const [relatedFeedback, setRelatedFeedback] = useState<FeedbackRecord[]>([]);

  useEffect(() => {
    let alive = true;
    setCards(null);
    setCardsErr(null);
    fetchRefactorCards(target.name)
      .then(r => { if (alive) setCards(r.cards); })
      .catch(e => { if (alive) setCardsErr(e.message); });
    // 이 타겟에 대한 과거 결정·피드백
    Promise.all([fetchRefactorDecisions(), fetchRefactorFeedbackList()])
      .then(([d, f]) => {
        if (!alive) return;
        setRelatedDecisions(d.decisions.filter(x => x.target_name === target.name));
        setRelatedFeedback(f.feedback.filter(x => x.target_name === target.name));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [target.name]);

  const flashToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2400);
  };

  const onApply = async (cardIndex1Based: number, option: string, custom?: string) => {
    const label = `apply-${cardIndex1Based}-${option}`;
    if (!window.confirm(
      `카드 #${cardIndex1Based} 에 옵션 "${option}" 을(를) 채택합니다. ` +
      `선택되지 않은 옵션의 원본 섹션은 overlay에 deprecated 로 기록됩니다.\n계속?`
    )) return;
    setSaving(label);
    try {
      const res = await applyRefactorDecision({
        target: target.name,
        card_index: cardIndex1Based,
        option,
        author,
        custom,
      });
      flashToast(`✅ ${res.decision.id} 기록 · annotations ${res.annotations.length}개`);
      // 리스트 새로고침
      const d = await fetchRefactorDecisions();
      setRelatedDecisions(d.decisions.filter(x => x.target_name === target.name));
      onSaved();
    } catch (e) {
      alert('결정 기록 실패: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(null);
    }
  };

  const onFeedback = async (
    action: 'defer' | 'dismiss' | 'comment' | 'regrade',
    cardIndex?: number,
    regradeTo?: Grade,
  ) => {
    const comment = window.prompt(
      `${action} 메모 (선택):` +
      (action === 'regrade' && regradeTo ? ` 제안 등급 ${regradeTo}` : ''),
      ''
    );
    if (comment === null) return;  // 취소
    const label = `fb-${action}-${cardIndex ?? '-'}-${regradeTo ?? '-'}`;
    setSaving(label);
    try {
      const res = await recordRefactorFeedback({
        target: target.name,
        action,
        author,
        comment: comment || '',
        card_index: cardIndex,
        regrade_to: regradeTo,
      });
      flashToast(`✅ ${res.feedback.id} (${action}) 기록`);
      const f = await fetchRefactorFeedbackList();
      setRelatedFeedback(f.feedback.filter(x => x.target_name === target.name));
      onSaved();
    } catch (e) {
      alert('피드백 기록 실패: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="chat-container" style={{ paddingBottom: 40 }}>
      {/* 헤더 */}
      <div className="admin-conv-header glass">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <GradeBadge grade={target.grade} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>#{target.rank} {target.name}</h3>
            <div className="admin-conv-meta-row" style={{ marginTop: 6 }}>
              <span>effort: {target.effort || '?'}</span>
              {Object.entries(target.dimension_scores).map(([dim, s]) => (
                <span key={dim}>{dim}: {s.value.toFixed(1)}</span>
              ))}
              {target.blast_radius_note && <span>blast: {target.blast_radius_note.slice(0, 80)}</span>}
              {target.confidence_flags && target.confidence_flags.length > 0 && (
                <span>⚠ {target.confidence_flags.join(', ')}</span>
              )}
            </div>
          </div>
        </div>
        <p style={{ marginTop: 10, marginBottom: 0, lineHeight: 1.55 }}>{target.rationale}</p>

        {/* 시스템 단위 액션 */}
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('dismiss')}>
            시스템 Dismiss
          </button>
          <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('regrade', undefined, 'S')}>등급 S 제안</button>
          <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('regrade', undefined, 'A')}>A 제안</button>
          <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('regrade', undefined, 'B')}>B 제안</button>
          <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('regrade', undefined, 'C')}>C 제안</button>
          <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('comment')}>의견만 기록</button>
        </div>
      </div>

      {/* Evidence snapshot */}
      {target.evidence && target.evidence.length > 0 && (
        <div className="glass" style={{ padding: '14px 18px', margin: '14px 0', borderRadius: 10 }}>
          <p className="section-title" style={{ marginBottom: 10 }}>
            Top Evidence (Ranker 출력 스냅샷 · 최대 6건)
          </p>
          {target.evidence.slice(0, 6).map((ev, i) => (
            <div key={i} style={{ padding: '6px 0', fontSize: '0.88rem', borderTop: i ? '1px dashed var(--border-color)' : 'none' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {ev.dimension}
                </span>
                <ConfidenceBadge c={ev.confidence} />
                {ev.verified_by_cov && <span style={{ fontSize: '0.72rem', color: '#16a34a' }}>verified</span>}
              </div>
              <div style={{ marginTop: 4, lineHeight: 1.5 }}>{ev.cited_text}</div>
              {ev.reason && (
                <div style={{ marginTop: 2, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  {ev.reason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 충돌 카드 */}
      <div style={{ margin: '14px 0' }}>
        <p className="section-title">충돌 카드 {cards ? `(${cards.length})` : ''}</p>
      </div>

      {cardsErr && (
        <div className="glass" style={{ padding: 16, color: '#ef4444' }}>
          카드 로드 실패: {cardsErr}
        </div>
      )}

      {cards && cards.length === 0 && (
        <div className="glass" style={{ padding: 16, color: 'var(--text-secondary)' }}>
          이 시스템은 기존 conflict-scan 결과에 포함된 쌍이 없거나, Stage 1에서 양측 evidence가
          매칭되지 않았습니다. Staleness / Confusion / TermDrift 차원을 추가하면 새로운 카드가
          생길 수 있습니다.
        </div>
      )}

      {cards && cards.map((c, i) => {
        const idx1 = i + 1;
        return (
          <div key={i} className="glass" style={{ padding: '14px 18px', margin: '8px 0', borderRadius: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <strong>#{idx1}</strong>
              <SeverityBadge severity={c.severity} />
              <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                {c.conflict_type}
              </span>
              <span style={{ fontWeight: 600 }}>{c.topic}</span>
            </div>

            {c.options.map(o => (
              <div key={o.key} className="source-link-card glass" style={{ margin: '6px 0', padding: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <strong>{o.key}</strong>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>({o.side})</span>
                  {o.source.workbook && <span style={{ fontSize: '0.78rem' }}>📄 {o.source.workbook}{o.source.sheet ? ` / ${o.source.sheet}` : ''}</span>}
                  {o.source.page_path && <span style={{ fontSize: '0.78rem' }}>🔗 {o.source.page_path}</span>}
                </div>
                <div style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>{o.summary}</div>
              </div>
            ))}

            {c.recommendation && (
              <div style={{
                marginTop: 8, padding: '8px 10px',
                background: 'var(--bg-secondary)', borderRadius: 6,
                fontSize: '0.82rem', color: 'var(--text-secondary)',
              }}>
                💡 {c.recommendation}
              </div>
            )}

            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {c.options.map(o => (
                <button
                  key={o.key}
                  className="share-btn"
                  disabled={!!saving}
                  onClick={() => onApply(idx1, o.key)}
                  title={`${o.key}안 채택 — 다른 옵션은 deprecated`}
                >
                  {saving === `apply-${idx1}-${o.key}` ? `저장중...` : `${o.key}안 채택`}
                </button>
              ))}
              <button className="share-btn" disabled={!!saving} onClick={() => {
                const v = window.prompt('커스텀 해결안 (자유 서술):');
                if (v) onApply(idx1, 'other', v);
              }}>
                Other...
              </button>
              <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('defer', idx1)}>
                보류
              </button>
              <button className="share-btn" disabled={!!saving} onClick={() => onFeedback('comment', idx1)}>
                의견 남기기
              </button>
            </div>
          </div>
        );
      })}

      {/* 이 타겟의 누적 결정/피드백 */}
      {(relatedDecisions.length > 0 || relatedFeedback.length > 0) && (
        <div className="glass" style={{ padding: '14px 18px', margin: '20px 0', borderRadius: 10 }}>
          <p className="section-title" style={{ marginBottom: 10 }}>이 시스템의 기록</p>
          {relatedDecisions.map(d => (
            <div key={d.id} style={{ padding: '6px 0', fontSize: '0.85rem', borderBottom: '1px dashed var(--border-color)' }}>
              <strong>{d.id}</strong> · <code>{d.selected_option}</code>안 · {d.date} · {d.status}
              <div style={{ color: 'var(--text-secondary)' }}>{d.conflict_summary}</div>
            </div>
          ))}
          {relatedFeedback.map(f => (
            <div key={f.id} style={{ padding: '6px 0', fontSize: '0.85rem', borderBottom: '1px dashed var(--border-color)' }}>
              <strong>{f.id}</strong> · <code>{f.action}</code>{f.regrade_to ? ` → ${f.regrade_to}` : ''} · {new Date(f.date).toLocaleString('ko-KR')}
              <div style={{ color: 'var(--text-secondary)' }}>{f.comment}</div>
            </div>
          ))}
        </div>
      )}

      {/* toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, padding: '10px 16px',
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          borderRadius: 8, zIndex: 100, fontSize: '0.9rem',
        }}>{toast}</div>
      )}
    </div>
  );
}
