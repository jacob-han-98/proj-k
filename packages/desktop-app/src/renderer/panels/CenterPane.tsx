import { useEffect, useRef, useState } from 'react';
import type { TreeNode } from '../../shared/types';
import { useWorkbenchStore } from '../workbench/store';
import { docKeyOfNode } from '../workbench/types';

// Excel for the Web 임베드 URL 의 ?action= 값을 스왑.
// 기본 URL 은 main 의 onedrive-sync.ts 가 ?action=embedview 로 빌드. 다만 sheetMappings 에
// 캐시된 옛 매핑 (`?web=1`) 도 유효한 매핑이라 이 함수는:
//   1) URL API 로 안전 파싱
//   2) `web` 파라미터 강제 제거 — embedview 와 충돌해서 SuiteNav 를 다시 살려놓는 케이스 회피
//   3) `action` 을 mode 에 맞게 setSearchParam (덮어쓰기 또는 추가)
function applyAction(url: string, mode: 'view' | 'edit'): string {
  const target = mode === 'edit' ? 'edit' : 'embedview';
  try {
    const u = new URL(url);
    u.searchParams.delete('web');
    u.searchParams.set('action', target);
    return u.toString();
  } catch {
    // 파싱 실패는 거의 없지만 fallback — 옛 정규식 path.
    if (/[?&]action=/.test(url)) {
      return url.replace(/([?&])action=[^&]+/, `$1action=${target}`);
    }
    return url + (url.includes('?') ? '&' : '?') + `action=${target}`;
  }
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

interface Props {
  selection: { kind: 'sheet' | 'confluence'; node: TreeNode } | null;
  confluenceConfigured: boolean;
  onPromptCreds: () => void;
  // PoC 2A — relPath 기반 매핑. App 이 settings 에서 load 후 prop 으로 내려줌.
  sheetMappings: Record<string, string>;
  onUpsertSheetMapping: (relPath: string, url: string) => void;
  // Phase 4-2: Confluence webview body 를 추출해 ChatPanel 의 review stream 으로 보낸다.
  onRequestReview?: (title: string, text: string) => void;
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
      />
    );
  }

  // Confluence — webview 안에서 사용자가 직접 로그인.
  const url = `${CONFLUENCE_BASE}/wiki/spaces/PK/pages/${selection.node.confluencePageId}`;
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
  onRequestReview?: (title: string, text: string) => void;
}) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const [extracting, setExtracting] = useState(false);

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
              data-testid="confluence-review"
              title="현재 페이지 본문을 LLM 으로 리뷰"
            >
              {extracting ? '추출 중…' : '📋 리뷰'}
            </button>
          )}
          <button onClick={() => window.open(url, '_blank')} title="외부 브라우저">↗</button>
        </span>
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <webview
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

  // view 모드일 때만 chrome 숨김 — edit 모드는 사용자가 SuiteNav/리본 이 필요해서 켠 거니까 그대로.
  useEffect(() => {
    if (editing) return;
    const wv = wvRef.current;
    if (!wv) return;
    return attachChromeStripper(wv);
  }, [editing, url]);

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
}) {
  const { node, relPath, cachedUrl, onUpsertMapping } = props;
  const [url, setUrl] = useState<string | null>(cachedUrl);
  const [bgSyncing, setBgSyncing] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cache-bust nonce — completed event 마다 1↑. webview key 에 넣어 unmount/mount 강제,
  // 같은 src 라도 SharePoint 304 cache 우회. wv.reload() 가 cache hit 받는 케이스 회피.
  const [reloadNonce, setReloadNonce] = useState(0);
  const webviewRef = useRef<HTMLElement | null>(null);
  // 편집 모드 — 트리뷰의 ✏ 아이콘이 store 에 토글. true 면 ?action=edit 로 swap.
  const docKey = docKeyOfNode(node);
  const editing = useWorkbenchStore((s) => (docKey ? !!s.editingDocs[docKey] : false));

  // onUpsertMapping 은 부모 (App.tsx) 에서 매 render 마다 새 reference 가 내려올 수 있어 dep 에
  // 넣으면 useEffect 가 무한 재실행되며 ensureFresh 가 매번 호출된다. ref 로 latest 만 잡고 dep
  // 에서는 빼서 mount/relPath 변경 시에만 1회 실행되게 한다.
  const onUpsertMappingRef = useRef(onUpsertMapping);
  useEffect(() => { onUpsertMappingRef.current = onUpsertMapping; }, [onUpsertMapping]);

  // mount + relPath 변경 시 ensureFresh 호출.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await window.projk.oneDriveSync.ensureFresh(relPath);
      if (cancelled) return;
      if (!r.ok) {
        // sync 클라이언트 미설정 또는 sidecar 못 찾음 → manual fallback.
        setFallback(true);
        setError(r.error);
        return;
      }
      setUrl(r.url);
      onUpsertMappingRef.current(relPath, r.url);
      if (r.syncing) setBgSyncing(true);
    })();
    return () => { cancelled = true; };
  }, [relPath]);

  // 백그라운드 sync progress 구독.
  useEffect(() => {
    const off = window.projk.oneDriveSync.onProgress((ev) => {
      if (ev.relPath !== relPath) return;
      if (ev.state === 'completed') {
        setBgSyncing(false);
        // webview key 변경 → unmount/mount 로 강제 reload. wv.reload() 만으로는 SharePoint 가
        // 304 캐시 응답을 줘서 옛 본문 그대로인 케이스가 있어 nonce 로 cache-bust.
        setReloadNonce((n) => n + 1);
      } else if (ev.state === 'failed') {
        setBgSyncing(false);
        console.warn('[onedrive-sync] background sync failed:', ev.error);
      } else if (ev.state === 'started') {
        setBgSyncing(true);
      }
    });
    return off;
  }, [relPath]);

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

  // 매핑 정보 없고 첫 ensureFresh 응답 대기 중 → placeholder.
  if (!url) {
    return (
      <main className="center" data-testid="center-pane">
        <div className="doc-header">
          <span>📄 {node.title}</span>
          <span className="breadcrumb">{relPath}</span>
        </div>
        <div
          className="placeholder"
          data-testid="onedrive-prep-placeholder"
          style={{ padding: 24, color: 'var(--text-dim)' }}
        >
          🚀 OneDrive 자동 매핑 준비 중…
        </div>
      </main>
    );
  }

  // bgSyncing 진행 중 + cachedUrl 없는 경우 → webview mount 미루기. 사용자 화면 하얀
  // freeze 의 진짜 원인: webview 가 cloud 도달 전 SharePoint URL 로 navigate 시작하면
  // SharePoint 가 빈 페이지 / SSO redirect chain 으로 hang → main renderer 가 webview
  // navigation 으로 stuck. progress completed (= cloud 도달) 후만 mount 하면 안전.
  // cachedUrl 있으면 옛 본문이라도 즉시 표시 (이미 사용자가 본 sheet 라 cloud 에 있을 거).
  if (bgSyncing && !cachedUrl) {
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
          🔄 OneDrive 로 업로드 중… (~25초)
          <br />
          <span style={{ fontSize: 11 }}>
            클라우드 도달 후 Excel 본문이 자동으로 열립니다.
          </span>
        </div>
      </main>
    );
  }

  // 편집 모드 토글마다 webview 강제 remount → Excel for the Web 가 깨끗하게 재초기화.
  // 같은 src 안에서 src 만 바꾸면 Excel 가 일부 chrome 만 갱신해서 어색하게 섞이는 경우 방지.
  const displayUrl = applyAction(url, editing ? 'edit' : 'view');

  // view 모드에서만 chrome (SuiteNav/검색바/프로필) 강제 제거. edit 모드는 그대로.
  useEffect(() => {
    if (editing) return;
    const wv = webviewRef.current;
    if (!wv) return;
    return attachChromeStripper(wv);
  }, [editing, displayUrl]);
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
          {bgSyncing && (
            <span
              data-testid="onedrive-bg-syncing"
              style={{ fontSize: 10, color: 'var(--text-dim)', marginRight: 8 }}
              title="P4 원본이 더 새로워서 OneDrive 로 백그라운드 업로드 중. 끝나면 자동 새로고침."
            >
              🔄 OneDrive 동기화 중…
            </span>
          )}
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
