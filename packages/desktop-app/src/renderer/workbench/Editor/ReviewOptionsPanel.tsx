import { useState } from 'react';
import {
  DEFAULT_REVIEW_OPTIONS,
  setCap,
  setPersona,
  toggleCategory,
  type ReviewCategory,
  type ReviewIssueCap,
  type ReviewOptions,
  type ReviewerPersona,
} from '../../panels/review-options-mapping';

// P2: 두 번째 스크린샷의 옵션 패널 재현. 사용자가 6개 컨트롤로 리뷰 범위와 톤을
// 좁혀서 "리뷰 시작" 누르면 ReviewSplitPane 으로 넘어감.
//
// 옵션은 패널 내부 state — 탭별 휘발 (영속 X). 사용자가 자주 같은 옵션 쓴다면 향후
// localStorage 영속 가능하지만 일단 단순.

interface CapOption {
  value: ReviewIssueCap;
  label: string;
}

const CAP_OPTIONS: CapOption[] = [
  { value: 0, label: '없음' },
  { value: 5, label: '5개' },
  { value: 10, label: '10개' },
  { value: 'all', label: '전체' },
];

interface CategoryOption {
  value: ReviewCategory;
  label: string;
  icon: string;
}

const CATEGORY_OPTIONS: CategoryOption[] = [
  { value: 'logic-flow', label: '로직 플로우', icon: '🔀' },
  { value: 'qa-checklist', label: 'QA 체크리스트', icon: '✅' },
  { value: 'readability', label: '문서 가독성', icon: '📖' },
];

interface PersonaOption {
  value: ReviewerPersona;
  label: string;
}

const PERSONA_OPTIONS: PersonaOption[] = [
  { value: 'planner-lead', label: '기획팀장' },
  { value: 'programmer', label: '프로그래머' },
];

interface Props {
  onStart: (options: ReviewOptions) => void;
  onBack: () => void;
}

export function ReviewOptionsPanel({ onStart, onBack }: Props) {
  const [options, setOptions] = useState<ReviewOptions>(DEFAULT_REVIEW_OPTIONS);

  const renderCapRow = (
    field: 'issueCap' | 'verificationCap' | 'suggestionCap',
    icon: string,
    label: string,
  ) => (
    <div className="review-options-row" data-testid={`review-options-${field}`}>
      <span className="review-options-row-label">
        <span aria-hidden="true">{icon}</span> {label}
      </span>
      <div className="review-options-chips">
        {CAP_OPTIONS.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            className={`review-options-chip${options[field] === opt.value ? ' on' : ''}`}
            onClick={() => setOptions((cur) => setCap(cur, field, opt.value))}
            data-testid={`review-options-${field}-${opt.value}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="review-options-panel" data-testid="review-options-panel">
      <header className="review-options-header">
        <button
          type="button"
          className="review-options-back"
          onClick={onBack}
          aria-label="모드 다시 선택"
          title="모드 다시 선택"
          data-testid="review-options-back"
        >
          ←
        </button>
        <span className="review-options-title">리뷰 옵션</span>
      </header>

      <div className="review-options-body">
        {renderCapRow('issueCap', '⚠️', '보강 필요')}
        {renderCapRow('verificationCap', '🔍', '검증 필요')}
        {renderCapRow('suggestionCap', '💡', '제안')}

        <div className="review-options-row" data-testid="review-options-categories">
          <span className="review-options-row-label">관점</span>
          <div className="review-options-chips">
            {CATEGORY_OPTIONS.map((opt) => {
              const on = options.categories.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`review-options-chip${on ? ' on' : ''}`}
                  onClick={() => setOptions((cur) => toggleCategory(cur, opt.value))}
                  data-testid={`review-options-cat-${opt.value}`}
                >
                  <span aria-hidden="true">{opt.icon}</span> {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="review-options-row" data-testid="review-options-persona">
          <span className="review-options-row-label">리뷰어</span>
          <div className="review-options-chips">
            {PERSONA_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`review-options-chip${options.reviewerPersona === opt.value ? ' on' : ''}`}
                onClick={() => setOptions((cur) => setPersona(cur, opt.value))}
                data-testid={`review-options-persona-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="review-options-start"
          onClick={() => onStart(options)}
          data-testid="review-options-start"
        >
          리뷰 시작
        </button>
      </div>
    </div>
  );
}
