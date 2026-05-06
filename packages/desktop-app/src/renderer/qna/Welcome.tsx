// Phase G: 빈 thread 의 welcome 화면. agent-sdk-poc 웹 (사용자 스크린샷) 과 동등한
// 큰 타이틀 + 부제 + preset 카드 2컬럼 그리드. messages.length === 0 일 때만 노출.
//
// preset 카드 클릭 시:
//   - 입력란에 prompt 자동 채움 (사용자가 이어서 편집 가능)
//   - compare_mode 가 true 면 Deep Research 토글 자동 ON
//   - auto-send 안 함 — 사용자가 Ctrl+Enter 로 직접 send

import type { PresetPrompt } from '../api';

const CATEGORY_ICON: Record<string, string> = {
  // datasheet (게임 런타임 데이터 직접 조회) — 붉은 표 아이콘
  datasheet: '📊',
  // gdd_table (기획서 안 표) — 클립보드
  gdd_table: '📋',
  // compare/external/web — 푸른 점 (Deep Research 트리거)
  compare: '🔵',
  external: '🔵',
  web: '🔵',
  // 그 외 (system, spec, cross, content, overview, other) — 아이콘 없음
};

interface Props {
  presets: PresetPrompt[];
  onPick: (p: PresetPrompt) => void;
}

export function QnAWelcome({ presets, onPick }: Props) {
  return (
    <div className="qna-welcome" data-testid="qna-welcome">
      <div className="qna-welcome-hero">
        <div className="qna-welcome-icon" aria-hidden="true">🎮</div>
        <h1 className="qna-welcome-title">Project K 기획 QnA</h1>
        <p className="qna-welcome-sub">기획서에 대해 무엇이든 물어보세요.</p>
      </div>
      {presets.length > 0 && (
        <div className="qna-preset-grid" data-testid="qna-preset-grid">
          {presets.map((p, i) => {
            const icon = p.category ? CATEGORY_ICON[p.category] ?? '' : '';
            return (
              <button
                key={i}
                type="button"
                className="qna-preset-card"
                onClick={() => onPick(p)}
                title={p.prompt}
                data-testid={`qna-preset-card-${i}`}
              >
                {icon && <span className="qna-preset-card-icon" aria-hidden="true">{icon}</span>}
                <span className="qna-preset-card-label">{p.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
