import { useEffect, useRef, useState } from 'react';
import type { TreeNode } from '../../shared/types';
import { useWorkbenchStore } from '../workbench/store';
import { docKeyOfNode } from '../workbench/types';
import { flattenSheetContent, getSheetContent } from '../api';
import { attachDocToQnA } from '../qna/dispatch';

// Excel for the Web 임베드 URL 의 ?action= 값을 스왑.
// **0.1.50 회귀 보류**: ?action=embedview 시도 후 사용자 환경에서 SharePoint 가 file
// download 응답 주는 회귀 발생 (사용자 화면에 "저장 위치 물어봄" save dialog). 옛 ?web=1
// 으로 원복하면서 view/edit 토글 흐름은 일시 비활성. mode 무시하고 url 그대로 반환.
// 향후 SharePoint 응답 분석 (will-download blocked log) 후 안전한 임베드 형식 재도입 예정.
function applyAction(url: string, _mode: 'view' | 'edit'): string {
  return url;
}

// Excel for the Web 의 chrome (SuiteNav: 9-dot 와플 / 문서 제목 / 검색바 / 톱니 / 프로필) 을
// CSS 로 강제 숨김. ?action=embedview 만으로는 ODB 본인 사이트의 SharePoint redirect 흐름에서
// 일관되게 안 사라지기 때문에 안전망으로 webview 안에 style 태그를 주입한다.
//
// 주입 시점: dom-ready (초기 로드) + did-navigate-in-page (Excel 의 SPA 내부 네비) — 두 번 다
// inject() 호출 가능하므로 id 로 dedupe.
//
// 주의: Microsoft 가 셀렉터를 자주 바꾸지는 않지만(주요 ID 인 #SuiteNavWrapper, #O365_NavHeader
// 는 수년간 안정), 깨졌을 때를 위해 사용자가 ✏ 아이콘으로 편집 모드를 켜면 풀 chrome 으로
// reload 되므로 fallback 경로는 자연스럽게 확보된다.
function attachChromeStripper(wv: HTMLElement): () => void {
  const inject = () => {
    const code = `(function(){
      if (document.getElementById('klaud-chrome-hider')) return;
      var s = document.createElement('style');
      s.id = 'klaud-chrome-hider';
      s.textContent = [
        '#SuiteNavWrapper','#suiteNavWrapper','#O365_NavHeader',
        '[data-automation-id="suiteNavWrapper"]',
        '.o365cs-nav-header16','.o365cs-base.o365cs-topnav',
        '#sbsDom','.spo-suitenav',
        '#SearchBox','.ms-srch-sb',
        'header[role=banner]'
      ].map(function(sel){return sel+'{display:none !important;}'}).join('')
       + 'body{padding-top:0 !important;margin-top:0 !important;}';
      document.head.appendChild(s);
    })();`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wv as any).executeJavaScript?.(code).catch(() => {});
  };
  wv.addEventListener('dom-ready', inject);
  wv.addEventListener('did-navigate-in-page', inject);
  return () => {
    try {
      wv.removeEventListener('dom-ready', inject);
      wv.removeEventListener('did-navigate-in-page', inject);
    } catch {
      /* webview 이미 detached — 무시 */
    }
  };
}

// Confluence Cloud (Atlassian) 의 상단 글로벌 네비게이션 + 좌측 통합 사이드바를 강제 숨김.
// 우리 사이드바가 이미 페이지 트리를 들고 있어 webview 안 트리는 중복.
//
// 2024 redesign 이후 Atlassian 은 좌측에 [global app-switcher icons + space navigation]
// 을 통합한 새 shell 을 사용 — selector 가 자주 바뀌어 enum 만으론 부족. 두 가지 전략 병용:
//   (1) 알려진 selector 들 광범위하게 display:none + style 태그
//   (2) 본문(`[role=main]` / `#content` / `#main-content`) 을 anchor 로 잡고 그 조상 사슬을
//       타고 올라가며 형제 중 nav/aside/header 를 inline style 로 hide — selector 가 변해도
//       구조적으로 잡힘
//   (3) MutationObserver 로 SPA 가 새 노드 mount 할 때마다 재적용 (throttle 포함).
//
// 본문 영역( #main-content / [role=main] ) 은 review 본문 추출이 의존하므로 그대로 둠.
function attachConfluenceChromeStripper(wv: HTMLElement): () => void {
  const inject = () => {
    const code = `(function(){
      if (window.__klaudConfluenceStripper) return;
      window.__klaudConfluenceStripper = true;

      var SELECTORS = [
        // 상단 글로벌 네비게이션
        'header[role="banner"]',
        'nav[aria-label="Site"]',
        'nav[aria-label="App"]',
        '[data-testid="atlassian-navigation"]',
        '[data-vc="atlassian-navigation"]',
        '#AkTopNavigation',
        '.aui-header','#header',
        '#confluence-banner',
        // 좌측 통합 사이드바 (2024 redesign — global nav + space tree)
        'nav[aria-label*="Space"]','nav[aria-label*="space"]',
        'nav[aria-label*="앱"]','nav[aria-label*="navigation"]',
        '[data-testid="space-navigation"]','[data-test-id="space-navigation"]',
        '[data-testid="navigation"]','[data-testid="app-navigation"]',
        '[data-testid="app-navigation-stable"]',
        '[data-testid="ak-navigation"]','[data-testid="ak-side-navigation"]',
        '[data-testid="side-navigation"]','[data-testid="primary-side-navigation"]',
        '[data-testid="grid-side-nav"]','[data-testid="navigation-stable"]',
        '[data-vc="page-layout-sidebar"]','[data-vc="navigation-app"]',
        '[data-vc*="navigation"]','[data-vc*="side-nav"]',
        '#AkNavigationContent','#AkSideNavigation','#side-bar',
        'aside[aria-label]','aside[role="navigation"]',
        // grid 영역 기반 (새 Atlassian shell)
        '[data-grid-area="left-panel"]','[data-grid-area="banner"]',
        '[data-grid="left-panel"]','[data-grid="banner"]'
      ];

      var s = document.getElementById('klaud-confluence-hider');
      if (!s) {
        s = document.createElement('style');
        s.id = 'klaud-confluence-hider';
        s.textContent = SELECTORS.map(function(sel){return sel+'{display:none !important;visibility:hidden !important;}';}).join('')
          + 'body{padding-top:0 !important;margin-top:0 !important;padding-left:0 !important;margin-left:0 !important;}'
          + 'main,[role="main"],#main-content,#content,[data-vc="page-layout-main"],[data-testid="grid-main"]{'
          + 'width:100% !important;margin-left:0 !important;padding-left:0 !important;max-width:none !important;left:0 !important;}';
        document.head.appendChild(s);
      }

      // 구조적 fallback — main 의 조상 사슬에서 형제 nav/aside/header 를 inline 으로 숨김.
      // selector 가 바뀌어도 layout 구조는 안정적이라 잡힘.
      function structuralStrip() {
        var main = document.querySelector('[role="main"]')
          || document.querySelector('#main-content')
          || document.querySelector('#content')
          || document.querySelector('main');
        if (!main) return;
        var el = main;
        var depth = 0;
        while (el && el.parentElement && depth < 12) {
          var p = el.parentElement;
          if (p === document.body || p === document.documentElement) break;
          var sibs = p.children;
          for (var i = 0; i < sibs.length; i++) {
            var c = sibs[i];
            if (c === el) continue;
            if (c.contains(main)) continue;
            var tag = c.tagName;
            // role=navigation / banner / complementary 도 hide
            var role = c.getAttribute && c.getAttribute('role');
            if (tag === 'NAV' || tag === 'ASIDE' || tag === 'HEADER'
                || role === 'navigation' || role === 'banner' || role === 'complementary') {
              c.style.setProperty('display','none','important');
            }
          }
          el = p;
          depth++;
        }
      }
      structuralStrip();

      // MutationObserver — SPA 가 sidebar 를 늦게 mount 하거나 navigation 후 재구성하는 경우 대응.
      // throttle: 100ms 윈도우.
      var pending = false;
      var obs = new MutationObserver(function() {
        if (pending) return;
        pending = true;
        setTimeout(function() {
          pending = false;
          // selector 적용은 CSS 가 자동 처리. 구조적 strip 만 재실행.
          structuralStrip();
        }, 100);
      });
      obs.observe(document.documentElement, {childList:true, subtree:true});
    })();`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wv as any).executeJavaScript?.(code).catch(() => {});
  };
  wv.addEventListener('dom-ready', inject);
  wv.addEventListener('did-navigate-in-page', inject);
  return () => {
    try {
      wv.removeEventListener('dom-ready', inject);
      wv.removeEventListener('did-navigate-in-page', inject);
    } catch {
      /* webview 이미 detached — 무시 */
    }
  };
}

interface Props {
  selection: { kind: 'sheet' | 'confluence'; node: TreeNode } | null;
  confluenceConfigured: boolean;
  onPromptCreds: () => void;
  // PoC 2A — relPath 기반 매핑. App 이 settings 에서 load 후 prop 으로 내려줌.
  sheetMappings: Record<string, string>;
  onUpsertSheetMapping: (relPath: string, url: string) => void;
  // Phase 4-2: Confluence webview body 를 추출해 ChatPanel 의 review stream 으로 보낸다.
  // P0: 어시스턴트 패널 trigger. mode 미지정 = 'pick' (모드 선택 빈 상태) — Confluence
  // 어시스턴트 흐름. Excel 시트 리뷰 같이 단일 모드 작업은 mode='review' 로 즉시 시작.
  onRequestReview?: (title: string, text: string, mode?: 'pick' | 'review') => void;
}

const CONFLUENCE_BASE = 'https://bighitcorp.atlassian.net';

export function CenterPane({
  selection,
  confluenceConfigured,
  onPromptCreds,
  sheetMappings,
  onUpsertSheetMapping,
  onRequestReview,
}: Props) {

  if (!selection) {
    return (
      <main className="center" data-testid="center-pane">
        <div className="placeholder">
          좌측 트리에서 시트나 페이지를 선택하세요.
        </div>
      </main>
    );
  }

  if (selection.kind === 'sheet') {
    const relPath = selection.node.relPath ?? selection.node.id;
    // depot 파일은 node.oneDriveUrl 에 임베드 URL 이 직접 박혀있음 — 별도 처리.
    const directUrl = selection.node.oneDriveUrl;
    if (directUrl) {
      return <DepotSheetView key={selection.node.id} node={selection.node} directUrl={directUrl} />;
    }
    // 일반 P4 local 시트 — 0.1.50 (Step 1+2): ensureFresh 가 매번 mtime 비교 + 백그라운드 sync.
    // cachedUrl 있으면 즉시 webview 표시(이전 본문). 백그라운드에서 stale 감지 시 자동 reload.
    return (
      <LocalSheetView
        key={selection.node.id}
        node={selection.node}
        relPath={relPath}
        cachedUrl={sheetMappings[relPath] ?? null}
        onUpsertMapping={onUpsertSheetMapping}
        onRequestReview={onRequestReview}
      />
    );
  }

  // Confluence — webview 안에서 사용자가 직접 로그인.
  // viewpage.action 은 spaceKey 무관 — Confluence 가 pageId 만으로 canonical URL 로 redirect.
  // 이전엔 /spaces/PK/pages/<id> 로 hardcoded 였는데 PKTEST (테스트 사본) 등 다른 스페이스
  // 페이지에선 redirect 안 되거나 깨질 수 있어서 generic URL 로 통일 (B2-3b 후속).
  const url = `${CONFLUENCE_BASE}/wiki/pages/viewpage.action?pageId=${selection.node.confluencePageId}`;
  return (
    <ConfluencePane
      key={selection.node.id}
      url={url}
      node={selection.node}
      onRequestReview={onRequestReview}
    />
  );
}

// Confluence webview + 리뷰 트리거. webview ref 를 잡으려면 별도 컴포넌트로
// 분리해야 selection 변경 시 ref 가 mount/unmount 흐름에 자연스럽게 따라간다.
function ConfluencePane({
  url,
  node,
  onRequestReview,
}: {
  url: string;
  node: TreeNode;
  // P0: 어시스턴트 패널 trigger. mode 미지정 = 'pick' (모드 선택 빈 상태) — Confluence
  // 어시스턴트 흐름. Excel 시트 리뷰 같이 단일 모드 작업은 mode='review' 로 즉시 시작.
  onRequestReview?: (title: string, text: string, mode?: 'pick' | 'review') => void;
}) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const [extracting, setExtracting] = useState(false);
  // B2-1: 테스트 스페이스 설정 여부 — 설정되어 있으면 "📋 테스트로 복사" 버튼 노출.
  const [testSpaceKey, setTestSpaceKey] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  // 사용자 토글 — 기본 false (Confluence 의 상단 네비 / 좌측 트리 숨김). true 면 원본 그대로.
  // 토글 시 webview 를 remount 해서 stripper 를 깨끗하게 부착/미부착으로 새 로드.
  const [showInternalMenu, setShowInternalMenu] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await window.projk.getSettings();
        if (!cancelled) setTestSpaceKey(s.confluenceTestSpaceKey?.trim() || null);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Confluence webview 안의 상단 글로벌 네비 + 좌측 space sidebar 숨김.
  // 우리 사이드바가 페이지 트리 들고 있어서 webview 안 트리는 중복.
  // 사용자가 "내부 메뉴 보기" 켜면 stripper 미부착 — webview key 변경으로 fresh remount.
  useEffect(() => {
    if (showInternalMenu) return;
    const wv = webviewRef.current;
    if (!wv) return;
    return attachConfluenceChromeStripper(wv);
  }, [showInternalMenu]);

  const copyToTestSpace = async () => {
    if (!node.confluencePageId) {
      alert('이 노드에 Confluence page ID 가 없어요.');
      return;
    }
    setCopying(true);
    try {
      const r = await window.projk.confluenceCopyToTest(node.confluencePageId);
      if (!r.ok) {
        alert(`테스트 사본 생성 실패: ${r.error}`);
        return;
      }
      // 새 페이지를 탭으로 open. 기존 흐름 유지: confluence kind + node.
      const newNode: TreeNode = {
        id: `confluence:${r.newPageId}`,
        type: 'page',
        title: r.newTitle,
        relPath: `[${r.spaceKey}] ${r.newTitle}`,
        confluencePageId: r.newPageId,
      };
      useWorkbenchStore.getState().openTab({ kind: 'confluence', node: newNode });
    } catch (e) {
      alert(`테스트 사본 호출 예외: ${(e as Error).message}`);
    } finally {
      setCopying(false);
    }
  };

  const requestReview = async () => {
    if (!onRequestReview) return;
    const wv = webviewRef.current;
    if (!wv) {
      alert('webview 가 아직 mount 되지 않았어요.');
      return;
    }
    setExtracting(true);
    try {
      // <webview>.executeJavaScript 는 페이지 컨텍스트에서 실행. Confluence 의
      // 본문 영역만 추려서 보내는 게 LLM 토큰 절약 + 노이즈 제거에 유리.
      // 우선순위: #main-content > [role=main] > body. innerText 는 hidden 영역
      // 자동 제외 + 보이는 텍스트만 → CDN 도구 노이즈 최소화.
      const code = `(() => {
        const el = document.querySelector('#main-content')
          || document.querySelector('[role="main"]')
          || document.body;
        return el ? (el.innerText || '').trim() : '';
      })()`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (await (wv as any).executeJavaScript(code)) as string;
      if (!text) {
        alert('webview 본문 추출 결과가 비어있습니다 — 페이지 로딩 끝났는지 확인하세요.');
        return;
      }
      onRequestReview(node.title, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`webview 본문 추출 실패: ${msg}`);
    } finally {
      setExtracting(false);
    }
  };

  // Phase A2: 진입점 2 — webview 본문 추출 후 qna 액티비티의 새 thread 에 doc 첨부.
  // requestReview 와 추출 로직은 동일, dispatch 만 다르게 (split 안 띄우고 ActivityBar swap).
  // 사용자 결정: split의 'agent' 모드는 폐지하고 4번째 액티비티로 통합.
  const requestAgentQuery = async () => {
    const wv = webviewRef.current;
    if (!wv) {
      alert('webview 가 아직 mount 되지 않았어요.');
      return;
    }
    setExtracting(true);
    try {
      const code = `(() => {
        const el = document.querySelector('#main-content')
          || document.querySelector('[role="main"]')
          || document.body;
        return el ? (el.innerText || '').trim() : '';
      })()`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (await (wv as any).executeJavaScript(code)) as string;
      if (!text) {
        alert('webview 본문 추출 결과가 비어있습니다 — 페이지 로딩 끝났는지 확인하세요.');
        return;
      }
      const r = await attachDocToQnA({ node, text, type: 'confluence' });
      if (!r.ok) alert(`Agent 질문 시작 실패: ${r.error}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`webview 본문 추출 실패: ${msg}`);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <main className="center" data-testid="center-pane">
      <div className="doc-header">
        <span>📘 {node.title}</span>
        <span className="breadcrumb">{node.relPath}</span>
        <span className="actions">
          {onRequestReview && (
            <button
              onClick={requestReview}
              disabled={extracting}
              data-testid="confluence-assistant"
              title="어시스턴트 열기 (요약 / 리뷰)"
            >
              {extracting ? '추출 중…' : '📎 어시스턴트'}
            </button>
          )}
          <button
            onClick={requestAgentQuery}
            disabled={extracting}
            data-testid="confluence-agent-query"
            title="이 문서를 첨부해 Agent 와 대화 (Ctrl+4 — qna 액티비티)"
          >
            {extracting ? '추출 중…' : '🤖 Agent에 질문'}
          </button>
          {testSpaceKey && node.confluencePageId && (
            <button
              onClick={copyToTestSpace}
              disabled={copying}
              data-testid="confluence-copy-test"
              title={`${testSpaceKey} 스페이스에 안전 사본 만들기 (timestamp 자동 추가)`}
            >
              {copying ? '복사 중…' : '📋 테스트로 복사'}
            </button>
          )}
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-dim)', marginLeft: 4, marginRight: 4, cursor: 'pointer' }}
            title="Confluence 의 상단 메뉴와 좌측 트리를 표시 (꺼짐 = 우리 트리만)"
          >
            <input
              type="checkbox"
              checked={showInternalMenu}
              onChange={(e) => setShowInternalMenu(e.target.checked)}
              data-testid="confluence-show-internal-menu"
            />
            내부 메뉴 보기
          </label>
          <button onClick={() => window.open(url, '_blank')} title="외부 브라우저">↗</button>
        </span>
      </div>
      {/* key 에 토글 상태 포함 → 사용자가 보기 모드 바꿀 때 webview 강제 remount.
          이미 적용된 CSS/inline 스타일을 일일이 되돌리지 않고 fresh load 로 처리. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <webview
        key={showInternalMenu ? 'with-chrome' : 'no-chrome'}
        ref={webviewRef as any}
        src={url}
        partition="persist:confluence"
        {...({ allowpopups: 'true' } as any)}
        style={{ width: '100%', height: 'calc(100% - 44px)' }}
      />
    </main>
  );
}

// depot 파일 표시 — read-only 기반. ✏ 아이콘 토글 시 ?action=embedview ↔ edit swap.
// directUrl 은 main 의 buildDepotEmbedUrl 이 ?action=embedview 로 빌드. 편집 모드면 edit 로
// 바꿔 webview reload — depot 은 P4 가 진실의 원천이라 OneDrive 카피만 변경되고 P4 영향 X.
function DepotSheetView({ node, directUrl }: { node: TreeNode; directUrl: string }) {
  const docKey = docKeyOfNode(node);
  const editing = useWorkbenchStore((s) => (docKey ? !!s.editingDocs[docKey] : false));
  const url = applyAction(directUrl, editing ? 'edit' : 'view');
  const wvRef = useRef<HTMLElement | null>(null);
  // 0.1.52 — local 흐름 (LocalSheetView v7) 과 평행. webview 자체 fail (mainFrame did-fail-load,
  // SP error.aspx) 시 카드. + Doc.aspx?action=default → action=view swap (auto-save 차단).
  const [webviewFailed, setWebviewFailed] = useState<{ code: number | null } | null>(null);

  // view 모드일 때만 chrome 숨김 — edit 모드는 사용자가 SuiteNav/리본 이 필요해서 켠 거니까 그대로.
  useEffect(() => {
    if (editing) return;
    const wv = wvRef.current;
    if (!wv) return;
    return attachChromeStripper(wv);
  }, [editing, url]);

  // webview navigation 감시 — local v7 과 동일 패턴.
  useEffect(() => {
    if (webviewFailed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wv = wvRef.current as any;
    if (!wv || typeof wv.addEventListener !== 'function') return;

    type NavEvent = {
      url?: string;
      validatedURL?: string;
      errorCode?: number;
      errorDescription?: string;
      httpResponseCode?: number;
      isMainFrame?: boolean;
    };

    const onFailLoad = (ev: NavEvent) => {
      if (ev.isMainFrame === false) return;
      console.warn('[depot-webview] did-fail-load (mainFrame) → fail card', ev);
      setWebviewFailed({ code: ev.errorCode ?? null });
    };
    const onDidNavigate = (ev: NavEvent) => {
      const u = ev?.url ?? '';
      if (!u) return;
      if (u.includes('/_layouts/15/error.aspx') || u.includes('/_layouts/15/AccessDenied.aspx')) {
        console.warn('[depot-webview] SP error page → fail card:', u);
        setWebviewFailed({ code: null });
        return;
      }
      // edit 모드가 아닌데 SP 가 Doc.aspx?action=default 로 redirect 했으면 view 로 swap.
      // local v7 과 동일 — bhunion tenant 의 download 회귀 회피 + auto-save 위험 제거.
      if (
        !editing
        && u.includes('/Doc.aspx')
        && /[?&]action=default(?:&|$)/.test(u)
        && !u.includes('action=view')
      ) {
        const viewUrl = u.replace(/([?&])action=default(&|$)/, '$1action=view$2');
        console.log('[depot-webview] action=default → action=view swap:', viewUrl);
        (wv as { loadURL?: (u: string) => void }).loadURL?.(viewUrl);
      }
    };

    wv.addEventListener('did-fail-load', onFailLoad);
    wv.addEventListener('did-navigate', onDidNavigate);
    wv.addEventListener('did-navigate-in-page', onDidNavigate);
    return () => {
      wv.removeEventListener('did-fail-load', onFailLoad);
      wv.removeEventListener('did-navigate', onDidNavigate);
      wv.removeEventListener('did-navigate-in-page', onDidNavigate);
    };
  }, [editing, url, webviewFailed]);

  if (webviewFailed) {
    return (
      <main className="center" data-testid="center-pane">
        <div className="doc-header">
          <span>🗄️ {node.title}</span>
          <span className="breadcrumb">{node.relPath ?? node.id}</span>
        </div>
        <div
          className="placeholder"
          data-testid="onedrive-cloud-not-ready"
          style={{ padding: 24, color: 'var(--text-dim)', lineHeight: 1.6 }}
        >
          ⚠ webview 로드 실패
          <br />
          <span style={{ fontSize: 11 }}>
            {webviewFailed.code != null ? `code=${webviewFailed.code}. ` : ''}
            depot 파일을 다시 클릭해주세요.
          </span>
        </div>
      </main>
    );
  }

  return (
    <main className="center" data-testid="center-pane">
      <div className="doc-header">
        <span>🗄️ {node.title}</span>
        <span className="breadcrumb">
          {node.relPath ?? node.id}
          <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>
            (depot · {editing ? '편집 중' : '읽기 전용'})
          </span>
        </span>
        <span className="actions">
          <button
            onClick={() => window.open(url, '_blank')}
            data-testid="sheet-open-onedrive"
            title="새 창으로 열기"
          >
            ↗ 새 창
          </button>
        </span>
      </div>
      {/* key 에 mode 포함 → 모드 전환 시 webview 강제 remount + Excel 재초기화 + chrome stripper 재부착. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <webview
        key={`${node.id}::${editing ? 'edit' : 'view'}`}
        ref={wvRef as any}
        src={url}
        partition="persist:onedrive"
        {...({ allowpopups: 'true' } as any)}
        style={{ width: '100%', height: 'calc(100% - 44px)' }}
      />
    </main>
  );
}

// 0.1.50 (Step 1+2) — local 시트 표시 컴포넌트.
//
// 동작:
//   1) cachedUrl(이전에 등록된 매핑) 있으면 webview 즉시 표시 (옛 cloud 본문이라도 보임).
//   2) mount 시 ensureFresh 호출 — main 이 P4 src vs OneDrive dest 의 mtime 비교.
//      - alreadyFresh: 추가 작업 없음, webview 그대로.
//      - stale: 백그라운드 sync 시작, syncing indicator 표시.
//   3) 백그라운드 sync 의 진행상황은 oneDriveSync.onProgress 로 push 받아 처리:
//      - completed: webview reload 로 새 본문 받기.
//      - failed: indicator 만 끄고 console warn (옛 본문은 그대로).
//   4) ensureFresh 가 fail (sync 클라이언트 미설정 / sidecar 못 찾음 등) → 옛 SheetMappingPrompt
//      로 fallback (수동 share URL 입력 + file picker 자동 매핑 옵션).
function LocalSheetView(props: {
  node: TreeNode;
  relPath: string;
  cachedUrl: string | null;
  onUpsertMapping: (relPath: string, url: string) => void;
  // B3: 워크북 sheet content 추출 → review_stream 입력. xlsx-extractor 미실행 / 출력 없으면
  // 버튼은 노출되지만 클릭 시 alert 후 원위치.
  // P0: 어시스턴트 패널 trigger. mode 미지정 = 'pick' (모드 선택 빈 상태) — Confluence
  // 어시스턴트 흐름. Excel 시트 리뷰 같이 단일 모드 작업은 mode='review' 로 즉시 시작.
  onRequestReview?: (title: string, text: string, mode?: 'pick' | 'review') => void;
}) {
  const { node, relPath, cachedUrl, onUpsertMapping, onRequestReview } = props;
  const [extractingReview, setExtractingReview] = useState(false);
  // 0.1.51 v6 — url state 초기값 null (옛: cachedUrl). 매 클릭마다 ensureFresh 의 cloud
  // verify-poll 통과 후에만 url 채움 → webview mount. cachedUrl 은 prop 으로 받지만 즉시
  // mount 트리거 안 됨 (race condition 차단). cachedUrl prop 자체는 sheetMappings 영구화
  // 호환을 위해 유지.
  const [url, setUrl] = useState<string | null>(null);
  // bgPhase: ensureFresh 진행 중 placeholder 텍스트 변경용. main 의 onProgress event 에 동기화.
  const [bgPhase, setBgPhase] = useState<'idle' | 'starting' | 'uploading' | 'verifying'>('idle');
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ensureFresh 가 cloud-not-ready 반환 시 set. webview 마운트 차단 + inline 에러 카드 + 재시도 버튼.
  const [cloudNotReady, setCloudNotReady] = useState<
    | { reason: 'poll-timeout' | 'webview-nav' | 'webview-fail'; pollAttempts?: number; pollLastStatus?: number | null }
    | null
  >(null);
  const [repolling, setRepolling] = useState(false);
  // Cache-bust nonce — repoll 성공 시 1↑. webview key 에 넣어 unmount/mount 강제.
  const [reloadNonce, setReloadNonce] = useState(0);
  // 옛 cachedUrl 무시 정책의 흔적 — sheetMappings prop 변경 무시 (logging 용).
  void cachedUrl;
  const webviewRef = useRef<HTMLElement | null>(null);
  // 편집 모드 — 트리뷰의 ✏ 아이콘이 store 에 토글. true 면 ?action=edit 로 swap.
  const docKey = docKeyOfNode(node);
  const editing = useWorkbenchStore((s) => (docKey ? !!s.editingDocs[docKey] : false));

  // onUpsertMapping 은 부모 (App.tsx) 에서 매 render 마다 새 reference 가 내려올 수 있어 dep 에
  // 넣으면 useEffect 가 무한 재실행되며 ensureFresh 가 매번 호출된다. ref 로 latest 만 잡고 dep
  // 에서는 빼서 mount/relPath 변경 시에만 1회 실행되게 한다.
  const onUpsertMappingRef = useRef(onUpsertMapping);
  useEffect(() => { onUpsertMappingRef.current = onUpsertMapping; }, [onUpsertMapping]);

  // B3: sheet content 추출 → review_stream 입력. xlsx-extractor 미실행 또는 워크북 디렉토리
  // 부재 시 sidecar 가 404 → null → 사용자에게 안내 alert.
  const requestSheetReview = async () => {
    if (!onRequestReview) return;
    setExtractingReview(true);
    try {
      const r = await getSheetContent(relPath);
      if (!r) {
        alert(
          '리뷰할 sheet content 를 찾을 수 없습니다.\n\n' +
            'xlsx-extractor 변환이 안 된 워크북일 수 있어요. ' +
            'WSL 측에서 packages/xlsx-extractor 를 한 번 돌리면 활성화됩니다.',
        );
        return;
      }
      // Excel 시트 리뷰는 단일 모드 작업 — 어시스턴트 picker 거치지 않고 즉시 review 시작.
      onRequestReview(r.workbook, flattenSheetContent(r), 'review');
    } finally {
      setExtractingReview(false);
    }
  };

  // Phase A2: 진입점 2 — sheet content 추출 후 qna 액티비티의 새 thread 에 doc 첨부.
  // requestSheetReview 와 추출 로직 동일, dispatch 만 다름.
  const requestSheetAgent = async () => {
    setExtractingReview(true);
    try {
      const r = await getSheetContent(relPath);
      if (!r) {
        alert(
          'Agent 에 첨부할 sheet content 를 찾을 수 없습니다.\n\n' +
            'xlsx-extractor 변환이 안 된 워크북일 수 있어요. ' +
            'WSL 측에서 packages/xlsx-extractor 를 한 번 돌리면 활성화됩니다.',
        );
        return;
      }
      const dispatch = await attachDocToQnA({
        node,
        text: flattenSheetContent(r),
        type: 'excel',
      });
      if (!dispatch.ok) alert(`Agent 질문 시작 실패: ${dispatch.error}`);
    } finally {
      setExtractingReview(false);
    }
  };

  // 0.1.51 v6 — mount + relPath 변경 시 ensureFresh await. main 이 모든 단계 (stat 비교 +
  // writeViaTempCopy + cloud HEAD polling) 를 직렬로 처리 후 ready / cloud-not-ready / 운영실패
  // 중 하나로 return. 결과에 따라 webview mount, 카드, 또는 fallback 분기.
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setCloudNotReady(null);
    setRepolling(false);
    setBgPhase('starting');
    console.log(`[LocalSheetView] mount/relPath relPath=${relPath}`);
    void (async () => {
      const t0 = performance.now();
      const r = await window.projk.oneDriveSync.ensureFresh(relPath);
      if (cancelled) return;
      const elapsed = (performance.now() - t0).toFixed(0);
      if (!r.ok) {
        console.log(`[LocalSheetView] ensureFresh ${relPath} (${elapsed}ms) fail: ${r.error}`);
        // sync 클라이언트 미설정 / sidecar 못 찾음 / sidecar fetch 실패 → manual fallback.
        setBgPhase('idle');
        setFallback(true);
        setError(r.error);
        return;
      }
      console.log(
        `[LocalSheetView] ensureFresh ${relPath} (${elapsed}ms) ${r.status} url=${r.url.slice(0, 80)}`,
      );
      setBgPhase('idle');
      if (r.status === 'ready') {
        setUrl(r.url);
        onUpsertMappingRef.current(relPath, r.url);
      } else {
        // status === 'cloud-not-ready' — webview 마운트 차단, 카드 + 재시도 노출.
        setCloudNotReady({
          reason: 'poll-timeout',
          pollAttempts: r.pollAttempts,
          pollLastStatus: r.pollLastStatus,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [relPath]);

  // operational progress 구독 — placeholder 텍스트 갱신 정도만. mount/unmount 결정 X.
  useEffect(() => {
    const off = window.projk.oneDriveSync.onProgress((ev) => {
      if (ev.relPath !== relPath) return;
      console.log(
        `[LocalSheetView] onProgress ${relPath}: state=${ev.state}` +
        (ev.bytes != null ? ` bytes=${ev.bytes}` : '') +
        (ev.error ? ` error=${ev.error}` : ''),
      );
      if (ev.state === 'uploading') setBgPhase('uploading');
      else if (ev.state === 'verifying') setBgPhase('verifying');
      else if (ev.state === 'failed') console.warn('[onedrive-sync] sync failed:', ev.error);
      // 'completed' 는 ensureFresh 의 await 가 곧 return 으로 안내 — 별도 처리 X.
    });
    return off;
  }, [relPath]);

  // 0.1.51 — webview navigation 감시. ensureFresh 가 alreadyFresh:true 로 webview 즉시
  // 마운트했지만 cloud 가 실제로 file 없는 경우 (옛 mtime/size 매치는 보장 아님) → SP 가
  // /_layouts/15/error.aspx 로 redirect → 사용자가 "이 파일은 없습니다" 페이지 봄. 이 path 에선
  // poll 도 진행 안 했으니 'cloud-not-ready' progress 도 못 받음. webview navigation 직접 감시
  // 로 cover.
  //
  // 추가로 모든 navigation/load event 를 console 로 dump — 사용자 환경에서 "왜 비어 보이는지"
  // 진단할 때 SharePoint 가 어떤 URL chain 으로 redirect 했고 어디서 멈췄는지 timeline 확보.
  useEffect(() => {
    if (!url || cloudNotReady) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wv = webviewRef.current as any;
    if (!wv || typeof wv.addEventListener !== 'function') return;

    type NavEvent = {
      url?: string;
      validatedURL?: string;
      errorCode?: number;
      errorDescription?: string;
      httpResponseCode?: number;
      isMainFrame?: boolean;
    };
    const traceEvents = [
      'did-start-loading',
      'did-start-navigation',
      'did-redirect-navigation',
      'will-navigate',
      'did-navigate',
      'did-navigate-in-page',
      'did-frame-navigate',
      'dom-ready',
      'did-stop-loading',
      'did-finish-load',
      'did-fail-load',
      'page-title-updated',
    ] as const;
    const handlers: Array<[string, (ev: NavEvent) => void]> = [];
    for (const eventName of traceEvents) {
      const handler = (ev: NavEvent) => {
        const u = ev?.url ?? ev?.validatedURL ?? '';
        const code = ev?.errorCode ?? ev?.httpResponseCode ?? '';
        const isMain = ev?.isMainFrame == null ? '-' : String(ev.isMainFrame);
        const desc = ev?.errorDescription ?? '';
        console.log(
          `[onedrive-webview] ${eventName} url=${u.slice(0, 200)} ` +
          `code=${code} mainFrame=${isMain}` +
          (desc ? ` desc="${desc}"` : ''),
        );
        // SP 에러 페이지로 navigate 시 cloud-not-ready 카드로 swap.
        if (eventName === 'did-fail-load' && ev.isMainFrame !== false) {
          console.warn('[onedrive-webview] did-fail-load (mainFrame) → cloudNotReady', ev);
          setCloudNotReady({ reason: 'webview-fail', pollLastStatus: ev.errorCode ?? null });
        }
        // 0.1.51 v6 — sub-frame fail 누적 카운트 / Excel content 로드 ref 같은 휴리스틱 모두
        // 제거. v6 에선 ensureFresh 가 cloud HEAD probe 로 ready 확정한 뒤에만 webview mount
        // 하므로, sub-frame ABORTED 가 누적되면 그건 우리가 책임 못 지는 영역 (Excel-for-Web /
        // WOPI 내부 race) — 사용자가 새 창으로 열거나 새로고침으로 회복 가능. cloudNotReady 는
        // mainFrame fail 또는 SP error.aspx 로 navigate 한 명확한 신호만 받음.
        if ((eventName === 'did-navigate' || eventName === 'did-navigate-in-page') && u) {
          if (
            u.includes('/_layouts/15/error.aspx')
            || u.includes('/_layouts/15/AccessDenied.aspx')
          ) {
            console.warn('[onedrive-webview] navigated to SP error page → cloudNotReady:', u);
            setCloudNotReady({ reason: 'webview-nav', pollLastStatus: null });
          }
          // 0.1.51 v3 — Excel-for-Web view-only 강제. SP 가 `?web=1` redirect 시 자동으로
          // `Doc.aspx?action=default` (edit mode) 로 보내는데, edit 모드는 auto-save 위험
          // (cloud incomplete content 받으면 빈 워크북 PUT → 6KB stub 영구 corruption).
          // 여기서 swap 해 view 모드로 재navigation. `?action=view` 직접 사용 시 bhunion tenant 가
          // download 응답 주는 회귀를 회피하면서 동시에 view 모드 강제.
          if (
            u.includes('/Doc.aspx')
            && /[?&]action=default(?:&|$)/.test(u)
            && !u.includes('action=view')
          ) {
            const viewUrl = u.replace(/([?&])action=default(&|$)/, '$1action=view$2');
            console.log('[onedrive-webview] action=default → action=view swap:', viewUrl);
            (wv as { loadURL?: (u: string) => void }).loadURL?.(viewUrl);
          }
        }
      };
      wv.addEventListener(eventName, handler);
      handlers.push([eventName, handler]);
    }
    return () => {
      for (const [name, h] of handlers) {
        wv.removeEventListener(name, h);
      }
    };
  }, [url, cloudNotReady, reloadNonce]);

  // 0.1.51 — 사용자가 inline 에러 카드의 "재시도" 누름. 재업로드 없이 SharePoint HEAD 폴링만
  // 한 번 더. ready 면 cloudNotReady reset + reloadNonce++ → webview 마운트.
  const handleRepoll = async () => {
    setRepolling(true);
    try {
      const r = await window.projk.oneDriveSync.repoll(relPath);
      if (r.ok && r.ready) {
        setCloudNotReady(null);
        setReloadNonce((n) => n + 1);
      } else if (r.ok && !r.ready) {
        // 여전히 cloud 가 file 못 찾음 — 카드 유지하면서 메타만 업데이트.
        setCloudNotReady({
          reason: 'poll-timeout',
          pollAttempts: r.pollAttempts,
          pollLastStatus: r.pollLastStatus,
        });
      } else if (!r.ok) {
        setCloudNotReady({ reason: 'poll-timeout', pollLastStatus: null });
        console.warn('[onedrive-sync] repoll fail:', r.error);
      }
    } finally {
      setRepolling(false);
    }
  };

  // view 모드에서만 chrome (SuiteNav/검색바/프로필) 강제 제거. edit 모드는 그대로.
  // 🔥 Hooks 규칙: useEffect 는 반드시 unconditional 위치 — 아래 conditional return 들이
  // mount 마다 다른 분기로 가면 hooks 개수 달라져 React crash. 분기 *위에* 둠.
  useEffect(() => {
    if (editing) return;
    if (!url) return;
    const wv = webviewRef.current;
    if (!wv) return;
    return attachChromeStripper(wv);
  }, [editing, url]);

  // ensureFresh fail → 옛 흐름 (file picker / 수동 share URL).
  if (fallback) {
    return (
      <SheetMappingPrompt
        node={node}
        relPath={relPath}
        onSubmit={onUpsertMapping}
        initialError={error}
      />
    );
  }

  // 0.1.51 — cloud-not-ready (poll timeout / webview SP 에러 페이지). webview 마운트 차단 +
  // 재시도 버튼. 옛 동작은 이 분기가 없어서 webview 가 SP 404 페이지 직접 노출 — "랜덤하게 안
  // 됨" 의 정체. 이제 명시적 에러 + 사용자 의지로 재시도.
  if (cloudNotReady) {
    const reasonText =
      cloudNotReady.reason === 'poll-timeout' ? 'SharePoint 가 파일을 인식하지 못함'
      : cloudNotReady.reason === 'webview-nav' ? 'SharePoint 가 에러 페이지를 반환'
      : 'webview navigation 실패';
    const meta: string[] = [];
    if (cloudNotReady.pollAttempts != null) meta.push(`${cloudNotReady.pollAttempts}회 폴링`);
    if (cloudNotReady.pollLastStatus != null) meta.push(`status=${cloudNotReady.pollLastStatus}`);
    return (
      <main className="center" data-testid="center-pane">
        <div className="doc-header">
          <span>📄 {node.title}</span>
          <span className="breadcrumb">{relPath}</span>
        </div>
        <div
          className="placeholder"
          data-testid="onedrive-cloud-not-ready"
          style={{ padding: 24, color: 'var(--text-dim)', lineHeight: 1.6 }}
        >
          ⚠ OneDrive 동기화 미완료
          <br />
          <span style={{ fontSize: 11 }}>
            {reasonText}
            {meta.length > 0 && ` (${meta.join(', ')})`}
            <br />
            큰 파일이거나 cloud-side 처리 지연일 수 있습니다. 잠시 후 재시도하면 보통 해결됩니다.
          </span>
          <br />
          <button
            onClick={handleRepoll}
            disabled={repolling}
            data-testid="onedrive-retry"
            style={{ marginTop: 12 }}
          >
            {repolling ? '재시도 중…' : '🔄 재시도'}
          </button>
        </div>
      </main>
    );
  }

  // 0.1.51 v6 — ensureFresh 진행 중 (또는 cloud-not-ready 도 fallback 도 아닌 초기 상태) →
  // placeholder. bgPhase 에 따라 텍스트 변경. webview 는 ready 도달 후에만 마운트.
  if (!url) {
    const phaseText =
      bgPhase === 'uploading' ? '📤 OneDrive 폴더에 업로드 중…'
      : bgPhase === 'verifying' ? '☁ 클라우드 도달 검증 중…'
      : '🔄 OneDrive 동기화 중…';
    return (
      <main className="center" data-testid="center-pane">
        <div className="doc-header">
          <span>📄 {node.title}</span>
          <span className="breadcrumb">{relPath}</span>
        </div>
        <div
          className="placeholder"
          data-testid="onedrive-syncing-placeholder"
          style={{ padding: 24, color: 'var(--text-dim)', lineHeight: 1.6 }}
        >
          {phaseText}
          <br />
          <span style={{ fontSize: 11 }}>
            클라우드 도달 후 Excel 본문이 자동으로 열립니다 (큰 파일은 수 초~수십 초).
          </span>
        </div>
      </main>
    );
  }

  // 편집 모드 토글마다 webview 강제 remount → Excel for the Web 가 깨끗하게 재초기화.
  // 같은 src 안에서 src 만 바꾸면 Excel 가 일부 chrome 만 갱신해서 어색하게 섞이는 경우 방지.
  const displayUrl = applyAction(url, editing ? 'edit' : 'view');

  return (
    <main className="center" data-testid="center-pane">
      <div className="doc-header">
        <span>📄 {node.title}</span>
        <span className="breadcrumb">
          {relPath}
          {editing && (
            <span style={{ marginLeft: 8, color: 'var(--accent)' }}>(편집 중)</span>
          )}
        </span>
        <span className="actions">
          {/* 0.1.51 v6 — bgSyncing indicator 제거. 모든 sync 는 ensureFresh await 안에서
            처리되고, webview 가 mount 된 시점엔 이미 cloud ready. 이후 BG 작업 없음. */}
          {onRequestReview && (
            <button
              onClick={requestSheetReview}
              disabled={extractingReview}
              data-testid="sheet-review"
              title="xlsx-extractor 가 변환한 sheet content 들을 LLM 으로 리뷰"
              style={{ marginRight: 6 }}
            >
              {extractingReview ? '추출 중…' : '📋 리뷰'}
            </button>
          )}
          <button
            onClick={requestSheetAgent}
            disabled={extractingReview}
            data-testid="sheet-agent-query"
            title="이 시트를 첨부해 Agent 와 대화 (Ctrl+4 — qna 액티비티)"
            style={{ marginRight: 6 }}
          >
            {extractingReview ? '추출 중…' : '🤖 Agent에 질문'}
          </button>
          <button
            onClick={() => window.open(displayUrl, '_blank')}
            data-testid="sheet-open-onedrive"
            title="새 창으로 열기"
          >
            ↗ 새 창
          </button>
        </span>
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <webview
        key={`${relPath}::${editing ? 'edit' : 'view'}::${reloadNonce}`}
        ref={webviewRef as any}
        src={displayUrl}
        partition="persist:onedrive"
        data-testid="onedrive-webview"
        {...({ allowpopups: 'true' } as any)}
        style={{ width: '100%', height: 'calc(100% - 44px)' }}
      />
    </main>
  );
}

// PoC 2B — sheet 매핑 미등록 + 자동 흐름 실패 시 fallback. 두 path:
//   (1) 자동 upload — Microsoft 인증 → file picker → OneDrive 에 upload + 매핑 자동
//   (2) 수동 — 사용자가 share URL 직접 등록
function SheetMappingPrompt(props: {
  node: TreeNode;
  relPath: string;
  onSubmit: (relPath: string, url: string) => void;
  // 0.1.50 — LocalSheetView 의 ensureFresh 가 fail 한 이유를 사용자에게 보여줌.
  initialError?: string | null;
}) {
  const [url, setUrl] = useState('');
  const [syncAccount, setSyncAccount] = useState<{
    userFolder: string;
    userUrl: string;
    userEmail: string;
  } | null>(null);
  const [syncDetected, setSyncDetected] = useState<boolean | null>(null); // null=확인 중, false=미설정
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(
    props.initialError ? `자동 매핑 진입 불가: ${props.initialError}` : null,
  );

  // 마운트 시 OneDrive Business sync 클라이언트 detect → 성공하면 자동 흐름 트리거.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await window.projk.oneDriveSync.detect();
      if (cancelled) return;
      if (!r.ok) {
        setSyncDetected(false);
        return;
      }
      setSyncAccount({
        userFolder: r.userFolder,
        userUrl: r.userUrl,
        userEmail: r.userEmail,
      });
      setSyncDetected(true);
      // 자동 흐름 — sidecar 에서 P4 원본 fetch + sync 폴더 복사 + 매핑 등록.
      // 사용자 클릭 0회. 실패 시 사용자가 수동 file picker 또는 manual share URL 선택 가능.
      setBusy(true);
      setInfo(`자동 매핑 진행 중 — sidecar 에서 fetch → OneDrive Sync 폴더 → 클라우드 upload 대기 (~15초)…`);
      const auto = await window.projk.oneDriveSync.auto(props.relPath);
      if (cancelled) return;
      setBusy(false);
      if (auto.ok) {
        setInfo(`✓ 자동 매핑 완료 — ${auto.localPath}`);
        props.onSubmit(props.relPath, auto.url);
      } else {
        // 첫 sheet 부터 P4 워크스페이스 root 가 settings 에 없어서 sidecar 가 file 못 찾는 경우
        // 사용자가 .xlsx 한 번만 선택하면 그 path 에서 root 가 자동 추정되어 다음부터 자동.
        const hint = auto.error?.includes('파일 없음') || auto.error?.includes('미설정')
          ? ' — 처음 한 번만 .xlsx 를 선택해주세요. 그 다음부터는 자동입니다.'
          : '';
        setInfo(`자동 매핑 실패: ${auto.error}${hint}`);
      }
    })();
    return () => { cancelled = true; };
  }, [props.relPath]);

  const submitManual = () => {
    const v = url.trim();
    if (v) props.onSubmit(props.relPath, v);
  };

  const syncUpload = async () => {
    setBusy(true);
    setInfo('.xlsx 선택 → OneDrive Sync 폴더에 복사 → 클라우드 upload 대기 (~15초)…');
    const r = await window.projk.oneDriveSync.upload(props.relPath);
    setBusy(false);
    if (r.ok) {
      setInfo(`✓ 매핑 완료 — ${r.localPath} (P4 워크스페이스 자동 등록됨, 다음 sheet 부터 자동)`);
      props.onSubmit(props.relPath, r.url);
    } else if (r.canceled) {
      setInfo('파일 선택 취소');
    } else {
      setInfo(`매핑 실패: ${r.error}`);
    }
  };

  return (
    <main className="center" data-testid="center-pane">
      <div className="doc-header">
        <span>📄 {props.node.title}</span>
        <span className="breadcrumb">{props.relPath}</span>
      </div>
      <div className="preview-body" data-testid="sheet-mapping-prompt" style={{ maxWidth: 720 }}>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          이 시트는 OneDrive 매핑이 등록되지 않았습니다.
        </p>

        {/* 자동 path — Sync 클라이언트 우회 (admin consent 불필요) */}
        {syncDetected !== false && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 12,
              marginTop: 12,
              background: 'var(--bg-elev)',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
              🚀 자동 매핑 (권장)
            </div>
            {syncDetected === null && (
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 0 }}>
                OneDrive Sync 클라이언트 확인 중…
              </p>
            )}
            {syncAccount && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 0 }}>
                  Sync 폴더 감지됨 ({syncAccount.userEmail}). .xlsx 선택하면 자동으로 OneDrive 에 올리고 webview 에 임베드합니다.
                </p>
                <button
                  onClick={syncUpload}
                  disabled={busy}
                  data-testid="onedrive-sync-upload"
                  className="primary"
                >
                  {busy ? '진행 중…' : '📂 .xlsx 선택해서 자동 매핑'}
                </button>
              </>
            )}
            {info && <p style={{ fontSize: 11, marginTop: 6 }}>{info}</p>}
          </div>
        )}
        {syncDetected === false && (
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 12 }}>
            ⚠ OneDrive Business Sync 클라이언트가 감지되지 않았습니다 — 수동 등록으로 진행하세요.
          </p>
        )}

        {/* 수동 path */}
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-dim)' }}>
            또는 share URL 직접 등록
          </summary>
          <ol style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.7, marginTop: 6 }}>
            <li>OneDrive 에서 같은 파일을 업로드 (P4 구조 그대로 권장).</li>
            <li>그 파일 <strong>공유</strong> → <strong>링크 복사</strong> (편집 가능).</li>
            <li>아래에 붙여넣기.</li>
          </ol>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://...sharepoint.com/:x:/g/personal/.../?e=..."
              data-testid="sheet-mapping-input"
              style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitManual(); }}
            />
            <button onClick={submitManual} data-testid="sheet-mapping-save">
              저장
            </button>
          </div>
        </details>

        <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
          relPath: <code>{props.relPath}</code>
        </p>
      </div>
    </main>
  );
}
