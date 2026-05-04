import { useWorkbenchStore } from '../store';
import type { SplitMode } from '../store';
import type { ReviewOptions } from '../../panels/review-options-mapping';
import { ModePickerEmpty } from './ModePickerEmpty';
import { ReviewOptionsPanel } from './ReviewOptionsPanel';
import { ReviewSplitPane } from './ReviewSplitPane';

// P0: ReviewSplitPane 한 단계 위 wrapper. 사용자가 아직 모드를 안 골랐으면
// ModePickerEmpty (= 첫 스크린샷 빈 상태) 를 보여주고, 모드 선택 시 setSplitMode
// 호출 → 해당 모드 컴포넌트로 swap.
//
// 수동 시작 정책 — 패널은 mount 되어 있어도 mode='pick' 이면 백엔드 호출 X.
// 사용자가 "리뷰하기" 칩을 누르는 시점이 ReviewSplitPane 의 trigger effect 가
// 발동해 reviewStream 이 시작되는 시점.
//
// P1/P2/P3 가 들어오면서 mode='summary'/'agent' 분기에 SummaryCard / DocFocusedChat
// 컴포넌트를 추가한다. 지금은 review 만 활성, 그 외는 빈 placeholder.

interface Props {
  tabId: string;
  title: string;
  text: string;
  trigger: number;
  mode: SplitMode;
  // P2: 사용자가 리뷰 옵션 패널에서 "리뷰 시작" 누르기 전엔 undefined.
  // 채워지면 ReviewSplitPane 이 mount + reviewStream 호출 시 첨부.
  reviewOptions: ReviewOptions | undefined;
  confluencePageId: string | null;
  onClose: () => void;
}

export function DocAssistantPane({
  tabId,
  title,
  text,
  trigger,
  mode,
  reviewOptions,
  confluencePageId,
  onClose,
}: Props) {
  const setSplitMode = useWorkbenchStore((s) => s.setSplitMode);
  const setReviewOptions = useWorkbenchStore((s) => s.setReviewOptions);

  if (mode === 'pick') {
    return (
      <aside className="doc-assistant-pane" data-testid="doc-assistant-pane" data-mode="pick">
        <header className="doc-assistant-header">
          <span className="doc-assistant-title">
            <i className="codicon codicon-sparkle" aria-hidden="true" /> 어시스턴트 — {title}
          </span>
          <button
            type="button"
            className="doc-assistant-close"
            onClick={onClose}
            aria-label="어시스턴트 닫기"
            title="어시스턴트 닫기"
            data-testid="doc-assistant-close"
          >
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>
        <div className="doc-assistant-body">
          <ModePickerEmpty title={title} onPickMode={(m) => setSplitMode(tabId, m)} />
        </div>
      </aside>
    );
  }

  if (mode === 'review') {
    // P2: 옵션 미선택 → 옵션 폼. "리뷰 시작" 누르면 reviewOptions 채워지고 동시에
    // trigger 갱신 → 이 분기가 ReviewSplitPane 으로 swap.
    if (!reviewOptions) {
      return (
        <aside className="doc-assistant-pane" data-testid="doc-assistant-pane" data-mode="review-options">
          <header className="doc-assistant-header">
            <span className="doc-assistant-title">
              <i className="codicon codicon-checklist" aria-hidden="true" /> 리뷰 — {title}
            </span>
            <button
              type="button"
              className="doc-assistant-close"
              onClick={onClose}
              aria-label="어시스턴트 닫기"
              title="어시스턴트 닫기"
              data-testid="doc-assistant-close"
            >
              <i className="codicon codicon-close" aria-hidden="true" />
            </button>
          </header>
          <div className="doc-assistant-body">
            <ReviewOptionsPanel
              onStart={(opts) => setReviewOptions(tabId, opts)}
              onBack={() => setSplitMode(tabId, 'pick')}
            />
          </div>
        </aside>
      );
    }
    // 옵션 채워짐 → 기존 ReviewSplitPane 재사용. options 도 reviewStream 에 전달.
    return (
      <ReviewSplitPane
        tabId={tabId}
        title={title}
        text={text}
        trigger={trigger}
        reviewOptions={reviewOptions}
        confluencePageId={confluencePageId}
        onClose={onClose}
      />
    );
  }

  // P1 / P3 미구현 분기 — 사용자가 비활성 칩을 누를 일은 없지만 (ModePickerEmpty 가
  // disabled), 외부에서 setSplitMode 가 호출돼 도달할 수 있으므로 안전한 placeholder.
  return (
    <aside className="doc-assistant-pane" data-testid="doc-assistant-pane" data-mode={mode}>
      <header className="doc-assistant-header">
        <span className="doc-assistant-title">
          <i className="codicon codicon-sparkle" aria-hidden="true" /> 어시스턴트 — {title}
        </span>
        <button
          type="button"
          className="doc-assistant-close"
          onClick={onClose}
          aria-label="어시스턴트 닫기"
          title="어시스턴트 닫기"
          data-testid="doc-assistant-close"
        >
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      <div className="doc-assistant-body">
        <div className="doc-assistant-placeholder" data-testid="doc-assistant-placeholder">
          <p>이 모드는 준비 중입니다.</p>
          <button
            type="button"
            onClick={() => setSplitMode(tabId, 'pick')}
            data-testid="mode-back-to-picker"
          >
            ← 모드 다시 선택
          </button>
        </div>
      </div>
    </aside>
  );
}
