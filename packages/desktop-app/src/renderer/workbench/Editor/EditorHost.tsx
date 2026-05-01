import type { SearchHit } from '../../../shared/types';
import { CenterPane } from '../../panels/CenterPane';
import { useWorkbenchStore } from '../store';
import { QnATab } from './QnATab';
import { ReviewSplitPane } from './ReviewSplitPane';
import { TabBar } from './TabBar';

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
                ) : (
                  <div className="tab-content-row">
                    <div className="tab-split-left" data-testid={`tab-split-left-${tab.id}`}>
                      <CenterPane
                        selection={{
                          kind: tab.kind === 'confluence' ? 'confluence' : 'sheet',
                          node: tab.node,
                        }}
                        confluenceConfigured={props.confluenceConfigured}
                        onPromptCreds={props.onPromptCreds}
                        sheetMappings={props.sheetMappings}
                        onUpsertSheetMapping={props.onUpsertSheetMapping}
                        onRequestReview={(title, text) =>
                          useWorkbenchStore.getState().openSplit(tab.id, title, text)
                        }
                      />
                    </div>
                    {split && (
                      <div className="tab-split-right" data-testid={`tab-split-right-${tab.id}`}>
                        <ReviewSplitPane
                          tabId={tab.id}
                          title={split.title}
                          text={split.text}
                          trigger={split.trigger}
                          confluencePageId={confluencePageId}
                          onClose={() => useWorkbenchStore.getState().closeSplit(tab.id)}
                        />
                      </div>
                    )}
                  </div>
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
