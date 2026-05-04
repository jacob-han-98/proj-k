import type { SplitMode } from '../store';

// P0: DocAssistantPane 의 mode='pick' 빈 상태. 첫 스크린샷 (크롬 익스텐션 기존 UI) 의
// "무엇을 도와드릴까요?" + 4개 칩 → Klaud 는 3개 모드로 정리 (요약/리뷰/일반 Agent).
//
// 수동 시작 정책 — 칩 클릭해야 비로소 백엔드 호출. 캐시 hit 시는 DocAssistantPane 이
// 별도 분기로 자동 표시 (이 컴포넌트는 그 경우 mount 자체가 안 됨).
//
// P0 시점에는 review 만 활성, summary/agent 는 P1/P3 done 후 활성화 — 비활성 칩에
// "준비 중" 라벨로 향후 메뉴 자체는 미리 보여줌.

interface Mode {
  key: Exclude<SplitMode, 'pick'>;
  label: string;
  description: string;
  icon: string;
  enabled: boolean;
}

const MODES: Mode[] = [
  {
    key: 'summary',
    label: '요약하기',
    description: '문서 본문을 짧게 정리',
    icon: '📄',
    enabled: false,
  },
  {
    key: 'review',
    label: '리뷰하기',
    description: '보강·검증·제안 항목 도출',
    icon: '📋',
    enabled: true,
  },
  {
    key: 'agent',
    label: '일반 Agent 모드',
    description: '이 문서에 포커스한 자유 대화',
    icon: '💬',
    enabled: false,
  },
];

interface Props {
  title: string;
  onPickMode: (mode: Exclude<SplitMode, 'pick'>) => void;
}

export function ModePickerEmpty({ title, onPickMode }: Props) {
  return (
    <div className="mode-picker-empty" data-testid="mode-picker-empty">
      <div className="mode-picker-headline">무엇을 도와드릴까요?</div>
      <div className="mode-picker-subtitle" data-testid="mode-picker-subtitle">
        "{title}" 페이지에 대해 질문하거나 리뷰를 요청하세요.
      </div>
      <div className="mode-picker-list">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`mode-picker-chip${m.enabled ? '' : ' disabled'}`}
            disabled={!m.enabled}
            onClick={() => m.enabled && onPickMode(m.key)}
            data-testid={`mode-pick-${m.key}`}
            title={m.enabled ? m.description : '준비 중 — 곧 활성화됩니다'}
          >
            <span className="mode-picker-icon" aria-hidden="true">{m.icon}</span>
            <span className="mode-picker-body">
              <span className="mode-picker-label">{m.label}</span>
              <span className="mode-picker-desc">
                {m.enabled ? m.description : '준비 중'}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
