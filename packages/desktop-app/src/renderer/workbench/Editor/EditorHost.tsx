import { useRef, useState } from 'react';
import type { SearchHit, TreeNode } from '../../../shared/types';
import { CenterPane } from '../../panels/CenterPane';
import { useWorkbenchStore } from '../store';
import type { SplitPayload } from '../store';
import { DEFAULT_REVIEW_OPTIONS } from '../../panels/review-options-mapping';
import { QnATab } from './QnATab';
import { DocAssistantPane } from './DocAssistantPane';
import { TabBar } from './TabBar';
import { AgentWebView } from './AgentWebView';

interface Props {
  // CenterPane 이 받던 prop 그대로 forward — App.tsx 에서 한 단계 깊어진 것 외에 동작 차이 0.
  confluenceConfigured: boolean;
  onPromptCreds: () => void;
  sheetMappings: Record<string, string>;
  onUpsertSheetMapping: (relPath: string, url: string) => void;
  // PR5: QnATab 콜백. ChatPanel 에서 옮겨온 흐름.
  onMessagesChanged: () => void;
  onOpenHit?: (hit: SearchHit) => void;
  onOpenDoc?: (doc: { doc_id: string; doc_type: 'xlsx' | 'confluence'; doc_title: string | null }) => void;
}

// VS Code editor 영역 — 탭바 + 탭 컨텐츠.
// 핵심: 모든 열린 탭을 *동시 mount* 하고 비활성 탭은 display:none 으로 숨긴다.
// 이유: webview 의 Confluence 로그인 세션 / OneDrive 스크롤 위치 / executeJavaScript ref 가
// unmount 되면 매번 사라짐. 탭 전환할 때마다 로그인을 다시 시키지 않으려면 mount 유지가 필수.
export function EditorHost(props: Props) {
  const openTabs = useWorkbenchStore((s) => s.openTabs);
  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const tabSplits = useWorkbenchStore((s) => s.tabSplits);

  return (
    <div className="editor-host" data-testid="editor-host">
      <TabBar />
      <div className="tab-content-area" data-testid="tab-content-area">
        {openTabs.length === 0 ? (
          <div className="placeholder" data-testid="editor-empty">
            좌측 트리에서 시트나 페이지를 선택하세요.
          </div>
        ) : (
          openTabs.map((tab) => {
            const visible = tab.id === activeTabId;
            const split = tab.kind === 'qna-thread' ? undefined : tabSplits[tab.id];
            const confluencePageId =
              tab.kind === 'confluence' ? tab.node.confluencePageId ?? null : null;
            return (
              <div
                key={tab.id}
                className={`tab-slot${visible ? '' : ' hidden'}`}
                data-testid={`tab-slot-${tab.id}`}
                aria-hidden={!visible}
              >
                {tab.kind === 'qna-thread' ? (
                  <QnATab
                    threadId={tab.threadId}
                    onMessagesChanged={props.onMessagesChanged}
                    onOpenHit={props.onOpenHit}
                    onOpenDoc={props.onOpenDoc}
                  />
                ) : tab.kind === 'agent-web' ? (
                  <AgentWebView />
                ) : (
                  <DocTabContent
                    tabId={tab.id}
                    tabKind={tab.kind}
                    node={tab.node}
                    split={split}
                    confluencePageId={confluencePageId}
                    confluenceConfigured={props.confluenceConfigured}
                    onPromptCreds={props.onPromptCreds}
                    sheetMappings={props.sheetMappings}
                    onUpsertSheetMapping={props.onUpsertSheetMapping}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// PR5 에서 placeholder 제거 — QnATab 이 진짜 채팅 UI 를 들고 있음.

// PR7: Confluence/Excel 탭의 컨텐츠 wrapper. split 가 켜졌을 때 좌:우 비율을 드래그로 조정.
// ratio 는 우측 패널의 비율 (0.2 ~ 0.7). 탭 lifetime 동안 useState 로 유지 — 탭이 항상
// mount 되어 있으므로 split 닫고 다시 열어도 보존된다. 영속(설정 저장) 은 도입하지 않음 —
// 사용자별 선호가 다르고 탭 종류별로도 다를 수 있어 일단 휘발 정책.

interface DocTabContentProps {
  tabId: string;
  tabKind: 'confluence' | 'excel';
  node: TreeNode;
  split: SplitPayload | undefined;
  confluencePageId: string | null;
  confluenceConfigured: boolean;
  onPromptCreds: () => void;
  sheetMappings: Record<string, string>;
  onUpsertSheetMapping: (relPath: string, url: string) => void;
}

function DocTabContent({
  tabId,
  tabKind,
  node,
  split,
  confluencePageId,
  confluenceConfigured,
  onPromptCreds,
  sheetMappings,
  onUpsertSheetMapping,
}: DocTabContentProps) {
  // 우측 패널 비율 — default 0.4 (즉 좌:우 = 60:40).
  const [rightRatio, setRightRatio] = useState(0.4);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const onHandleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      // 우측 영역 = 컨테이너 right - 마우스 x. 컨테이너 너비 대비 비율.
      const r = (rect.right - ev.clientX) / rect.width;
      // 너무 좁아 (좌측 / 우측) 의미를 잃지 않도록 0.2~0.7 clamp.
      setRightRatio(Math.max(0.2, Math.min(0.7, r)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    // drag 중 텍스트 selection 방지 — webview 안 본문이 선택되는 시각 noise 차단.
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="tab-content-row" ref={rowRef}>
      <div className="tab-split-left" data-testid={`tab-split-left-${tabId}`}>
        <CenterPane
          selection={{ kind: tabKind === 'confluence' ? 'confluence' : 'sheet', node }}
          confluenceConfigured={confluenceConfigured}
          onPromptCreds={onPromptCreds}
          sheetMappings={sheetMappings}
          onUpsertSheetMapping={onUpsertSheetMapping}
          onRequestReview={(title, text, mode) => {
            // P2: sheet review 처럼 mode='review' 직접 시작 흐름은 옵션 panel skip —
            // DEFAULT_REVIEW_OPTIONS 미리 채워서 즉시 ReviewSplitPane mount.
            // Confluence 어시스턴트 (mode 미지정 → 'pick') 는 reviewOptions 미지정.
            const reviewOptions = mode === 'review' ? DEFAULT_REVIEW_OPTIONS : undefined;
            useWorkbenchStore.getState().openSplit(tabId, title, text, mode, reviewOptions);
          }}
        />
      </div>
      {split && (
        <>
          <div
            className="tab-split-handle"
            data-testid={`tab-split-handle-${tabId}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="리뷰 패널 크기 조정"
            onMouseDown={onHandleMouseDown}
          />
          <div
            className="tab-split-right"
            data-testid={`tab-split-right-${tabId}`}
            style={{ flex: `0 0 ${(rightRatio * 100).toFixed(2)}%` }}
          >
            <DocAssistantPane
              tabId={tabId}
              title={split.title}
              text={split.text}
              trigger={split.trigger}
              mode={split.mode}
              reviewOptions={split.reviewOptions}
              confluencePageId={confluencePageId}
              onClose={() => useWorkbenchStore.getState().closeSplit(tabId)}
            />
          </div>
        </>
      )}
    </div>
  );
}
