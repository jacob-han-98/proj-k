import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { IPC, type ShortcutEvent } from '../shared/types';

// userData 폴더 이름 통일 — dev / packaged / _electron.launch (real Electron 테스트) 모두
// 동일 'projk-desktop' 사용. 미설정 시 Electron 이 entry script 옆 package.json 검색하는데
// out/main/index.js 직접 launch 시 경로 못 찾아 default 'Electron' 으로 떨어짐 →
// settings.json 미인식 회귀 (사용자 환경과 다른 폴더 보게 됨). app.whenReady 전에 호출 필수.
//
// setName 만으로는 부족 — Electron 이 첫 getPath('userData') 호출 결과를 캐시하므로
// setPath 도 명시. AppData/Roaming/projk-desktop 으로 강제.
app.setName('projk-desktop');
app.setPath('userData', join(app.getPath('appData'), 'projk-desktop'));

// 진단 환경에서 background spawn 한 BrowserWindow 가 GPU paint 안 일어나는 케이스 대비
// SW rendering 강제 옵션. 단, *명시 env 일 때만* 활성 — dev 자동 활성화 제거.
// 이전 시도에서 dev 자동 SW rendering 이 webview 의 SharePoint SSO chain JS 실행을 막아
// "퍼포스 sheet 클릭 시 화면 하얗게" 회귀 발생. 사용자 직접 트리거 시에만 활성.
if (process.env.PROJK_FORCE_SOFTWARE_RENDER === '1') {
  app.disableHardwareAcceleration();
}
import { registerIpc } from './ipc';
import { startSidecar, stopSidecar } from './sidecar';
import { getConfluenceCreds } from './auth';
import { initUpdater } from './updater';
import { startMcpBridgeIfEnabled, stopMcpBridge } from './mcp-bridge';
import { installLogPush } from './log-push';
import { installKlaudLogSink } from './klaud-log-sink';
import { loadDevEnvFromFiles } from './env-loader';
import { installDebugProbeServer } from './debug-probe';
import { startDevBundleWatcher } from './dev-bundle-watcher';
import { initThreadsDb, closeThreadsDb } from './db';
import { REPO_ROOT, XLSX_OUTPUT_DIR, CONFLUENCE_OUTPUT_DIR, CONFLUENCE_MANIFEST } from './paths';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    // VS Code 스타일 frameless — Windows 기본 title bar(min/max/close + "Project K" 표기)
    // 를 제거하고 renderer 의 .topbar 가 직접 그 역할을 한다. 36px 한 줄에 브랜드 / sidecar
    // 상태 / 설정 버튼 / 창 컨트롤을 모두 얹어서 화면 공간을 최대 활용.
    frame: false,
    // 'Klaud' 는 데스크톱 앱의 표기 브랜드. 'Project K' 는 프로젝트(레포/메모/사내 게이트웨이) 명.
    // electron-builder 의 productName / appId 는 'Project K' / 'im.hybe.projk.desktop' 그대로 유지 →
    // NSIS install dir 과 자동 업데이트 경로 끊김 없이 유지된다.
    title: `Klaud v${__APP_VERSION__}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // needed for <webview> Confluence embed
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // frameless 일 때 maximize 토글 → 우측 컨트롤 아이콘 swap (max ↔ restore).
  // renderer 가 IPC.WINDOW_MAXIMIZED 를 listen 해서 상태를 맞춘다.
  const broadcastMaximized = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', broadcastMaximized);
  mainWindow.on('unmaximize', broadcastMaximized);

  // electron-vite injects the dev server URL via env in dev, and bundles the
  // renderer into out/renderer/index.html in production.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// webview 가 사용할 모든 partition 을 main 의 app.whenReady 시점에 미리 등록.
// renderer 의 <webview partition="persist:..."> mount 시 race condition 회피
// (Electron 의 partition 등록과 React mount 흐름이 충돌하던 0.1.38 회귀 fix).
//
// 인증은 각 webview 안에서 사용자가 직접 (native 로그인 → cookie 영속).
// chrome-extension 처럼 "이미 로그인 되어있으면 그대로, 막히면 로그인 화면" 동선.
function installPartitions(): void {
  session.fromPartition('persist:confluence'); // Atlassian / Confluence
  session.fromPartition('persist:agent');      // agent-sdk-poc 웹 임베드 (회사 SSO 쿠키 영속)
  const onedriveSession = session.fromPartition('persist:onedrive'); // OneDrive / SharePoint / Office for the Web

  // PoC 0.1.53+ — OnlyOffice 임베드용 별도 파티션. 자체 호스팅 서버라 SSO 쿠키 불필요하지만
  // OneDrive 세션과 분리해 will-download 차단 정책만 동일하게 적용 (view-only 모드라도 OnlyOffice
  // 가 download 요청을 발생시키면 webview 가 OS save dialog 띄우는 것 방지).
  const onlyOfficeSession = session.fromPartition('persist:onlyoffice');
  onlyOfficeSession.on('will-download', (event, item) => {
    console.warn(
      `[onlyoffice-session] will-download blocked — url=${item.getURL().slice(0, 120)} ` +
      `file=${item.getFilename()} mime=${item.getMimeType()}`,
    );
    event.preventDefault();
    item.cancel();
  });

  // SharePoint 가 webview embed 거부 또는 redirect 끝에 file download 응답 (Content-Disposition:
  // attachment) 주는 케이스가 사용자 환경 시나리오. Electron default 가 OS native save dialog
  // 띄움 → 사용자가 "저장 위치 물어봄" 보고. 우리는 webview 안에서 .xlsx 본문이 *view* 되어야
  // 하므로 download 자체를 차단. 사용자가 정말 download 원하면 새 창 / 외부 브라우저로.
  onedriveSession.on('will-download', (event, item) => {
    const u = item.getURL();
    const fname = item.getFilename();
    const mime = item.getMimeType();
    console.warn(
      `[onedrive-session] will-download blocked — url=${u.slice(0, 120)} ` +
      `file=${fname} mime=${mime}. SharePoint 가 webview 안 view 대신 download 응답 줌 ` +
      `(인증 만료 / X-Frame deny / ?action= 매개변수 거부 등 의심).`,
    );
    event.preventDefault();
    item.cancel();
  });

  // 0.1.51 v4 — Excel-for-Web / SharePoint / WOPI 의 HTTP 실패를 main 콘솔에 직접 노출.
  // 옛 진단 한계: webview 안 Excel iframe 의 console-message 는 잡혀도, 실제 fetch 가 어떤
  // 응답 받았는지 (특히 WOPI 401/404/5xx) 는 안 잡힘. 사용자가 "빈 워크북" 보고할 때 진짜
  // 이유가 'WOPI 가 401 던졌다' 인지 'iframe 이 ABORTED 됐다' 인지 구분 불가.
  // → onCompleted 로 응답 status 로깅 + onErrorOccurred 로 network 실패 로깅. 시끄러움 회피
  // 위해 status >= 400 또는 office/sharepoint host 만 (host 매치는 substring).
  const interestingHosts = [
    'sharepoint.com',
    'officeapps.live.com',
    'office.com',
    'office.net',
    'live.com',
    'msftauth.net',
  ];
  const isInteresting = (url: string): boolean => interestingHosts.some((h) => url.includes(h));

  onedriveSession.webRequest.onCompleted((details) => {
    const u = details.url;
    if (!isInteresting(u)) return;
    if (details.statusCode < 400) return; // 4xx/5xx 만
    const ct = details.responseHeaders?.['content-type']?.[0] ?? details.responseHeaders?.['Content-Type']?.[0] ?? '';
    console.warn(
      `[onedrive-session] http-fail ${details.statusCode} ${details.method} ` +
      `url=${u.slice(0, 200)} type=${details.resourceType} content-type=${ct}`,
    );
  });

  onedriveSession.webRequest.onErrorOccurred((details) => {
    const u = details.url;
    if (!isInteresting(u)) return;
    // ERR_ABORTED 는 정상 redirect chain 에서도 발생 — 너무 시끄러움.
    // 단 우리가 진짜 잡고 싶은 ERR_FAILED, ERR_TIMED_OUT 등은 통과.
    if (details.error === 'net::ERR_ABORTED') return;
    console.warn(
      `[onedrive-session] net-error ${details.error} ${details.method} ` +
      `url=${u.slice(0, 200)} type=${details.resourceType}`,
    );
  });
}

// webview 안에서 우리 앱 단축키 (Ctrl+P / Ctrl+1~5) 가 가로채이는 회귀 차단.
// 사용자가 Confluence/SharePoint 페이지를 webview 로 보다가 Ctrl+P 누르면 webview
// 측 페이지의 키 핸들러가 먼저 받아 (Confluence 의 "Browse" 등) main renderer 의
// window keydown 까지 전달 안 됨. main 의 before-input-event 는 webContents 별로
// keyDown 을 가로챌 수 있어 — 매칭되는 단축키면 e.preventDefault + main window 로
// IPC dispatch. App.tsx / ActivityBar.tsx 의 기존 핸들러와 같은 동작을 보장.
function installShortcutInterceptor(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (!(input.control || input.meta)) return;
      if (input.shift || input.alt) return;
      const k = input.key.toLowerCase();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      let payload: ShortcutEvent | null = null;
      if (k === 'p') {
        payload = { name: 'command-palette' };
      } else if (k === '1' || k === '2' || k === '3' || k === '4' || k === '5') {
        payload = { name: 'activity-bar', digit: k };
      }
      if (!payload) return;
      event.preventDefault();
      mainWindow.webContents.send(IPC.SHORTCUT_TRIGGER, payload);
    });
  });
}

// 진단용 — 모든 webContents (main + webview + 자식 frame) 의 navigation/load/error
// 이벤트를 main 콘솔에 기록. webview 가 어떤 URL 로 redirect 되어 어디서 멈추는지
// (SSO chain / X-Frame deny / crashed 등) 추적. mcp 의 klaud_get_logs 로 받음.
function installWebContentsTracing(): void {
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType(); // 'window' | 'browserView' | 'webview' | 'remote' | 'backgroundPage' | 'offscreen'
    console.log(`[wc-created] type=${type} id=${contents.id} initial-url=${contents.getURL().slice(0, 80)}`);
    // 0.1.51 hotfix — 옛 코드는 webview 만 trace. main window 의 renderer console 은 DevTools
    // 에만 떴음 → log-push 로 가지 않아 디버깅 timeline 단절. window 도 console-message 만
    // forward (navigation 이벤트는 webview 만 — main window 는 SPA 내부 nav 라 noise).
    if (type === 'window') {
      const tag = `[wc ${contents.id}/window]`;
      contents.on('console-message', (_e, level, message, line, sourceId) => {
        const lvlTag = ['verbose', 'info', 'warn', 'error'][level] ?? 'log';
        console.log(`${tag} console.${lvlTag} ${message.slice(0, 500)} (${sourceId.slice(-40)}:${line})`);
      });
      return;
    }
    if (type !== 'webview') return; // sub-frame / offscreen 등은 noise.

    const tag = `[wv ${contents.id}]`;
    contents.on('did-start-loading', () => {
      console.log(`${tag} did-start-loading url=${contents.getURL().slice(0, 120)}`);
    });
    contents.on('did-navigate', (_e, url, httpResponseCode) => {
      console.log(`${tag} did-navigate http=${httpResponseCode} url=${url.slice(0, 120)}`);
    });
    contents.on('did-navigate-in-page', (_e, url) => {
      console.log(`${tag} did-navigate-in-page url=${url.slice(0, 120)}`);
    });
    contents.on('did-redirect-navigation', (_e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
      console.log(`${tag} did-redirect mainFrame=${isMainFrame} url=${url.slice(0, 120)}`);
    });
    contents.on('did-finish-load', () => {
      console.log(`${tag} did-finish-load url=${contents.getURL().slice(0, 120)}`);
    });
    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.warn(`${tag} did-fail-load mainFrame=${isMainFrame} code=${errorCode} desc=${errorDescription} url=${validatedURL.slice(0, 120)}`);
    });
    contents.on('did-stop-loading', () => {
      console.log(`${tag} did-stop-loading url=${contents.getURL().slice(0, 120)}`);
    });
    contents.on('render-process-gone', (_e, details) => {
      console.warn(`${tag} render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    });
    contents.on('unresponsive', () => {
      console.warn(`${tag} unresponsive — renderer event loop blocked`);
    });
    contents.on('responsive', () => {
      console.log(`${tag} responsive — renderer recovered`);
    });
    contents.on('console-message', (_e, level, message, line, sourceId) => {
      // level: 0=verbose, 1=info, 2=warn, 3=error
      const lvlTag = ['verbose', 'info', 'warn', 'error'][level] ?? 'log';
      console.log(`${tag} console.${lvlTag} ${message.slice(0, 200)} (${sourceId.slice(-40)}:${line})`);
    });
    contents.on('will-navigate', (_e, url) => {
      console.log(`${tag} will-navigate url=${url.slice(0, 160)}`);
    });
    // popup / new-window 추적 — SharePoint 가 webview 안 embedview 거부 시 새 창 띄우는 케이스.
    contents.setWindowOpenHandler(({ url, frameName, disposition }) => {
      console.log(`${tag} setWindowOpenHandler url=${url.slice(0, 160)} frame=${frameName} disp=${disposition}`);
      return { action: 'allow' };
    });
    contents.on('did-create-window', (_w, details) => {
      console.log(`${tag} did-create-window url=${details.url.slice(0, 160)}`);
    });
  });
}

function logEnvironment(): void {
  console.log('[main] platform:', process.platform);
  console.log('[main] REPO_ROOT:', REPO_ROOT);
  const checks = [
    ['xlsx-extractor/output', XLSX_OUTPUT_DIR],
    ['confluence-downloader/output', CONFLUENCE_OUTPUT_DIR],
    ['confluence _manifest.json', CONFLUENCE_MANIFEST],
  ];
  for (const [name, p] of checks) {
    console.log(`[main] ${name}: ${existsSync(p) ? 'OK' : 'MISSING'} — ${p}`);
  }
}

app.whenReady().then(async () => {
  // 2026-05-13 릴리스-B: dev 환경의 GCP OAuth credentials JSON 자동 인식 — env/ 안에
  // client_secret_*.googleusercontent.com.json 있으면 PROJK_GOOGLE_CLIENT_ID 로 inject.
  // production 빌드에는 env/ 없으니 자동 noop. SettingsModal 의 OAuth Client ID 비워두면
  // env 가 fallback 으로 작동.
  loadDevEnvFromFiles();
  // log-push 는 setting 을 읽으므로 settings 모듈이 살아있어야 한다 → 가장 먼저.
  // 2026-05-13 릴리스-A2: 통합 sink (운영 로그 + 제보) 도 같은 타이밍에 install.
  // 둘은 독립 — log-push 는 dev WSL collector 로 console 만, klaud-log-sink 는 production
  // 사내 backend 로 console + renderer + 제보 모두. main 의 console 은 log-push 가 wrap 한 뒤
  // klaud-log-sink.mirrorToSink 도 같이 호출하도록 log-push 가 처리.
  installLogPush(__APP_VERSION__);
  installKlaudLogSink({ version: __APP_VERSION__ });
  // 스레드 DB 부팅 (sql.js wasm load + schema migrate). 실패해도 main 진행.
  await initThreadsDb().catch((e) => console.error('[main] initThreadsDb', e));
  logEnvironment();
  installPartitions();
  installShortcutInterceptor();
  installWebContentsTracing();
  installDebugProbeServer(); // dev only — bash 에서 curl 로 인증된 HEAD probe trigger.
  registerIpc(() => mainWindow);
  createWindow();
  startSidecar().catch((e) => console.error('[main] startSidecar failed', e));
  initUpdater(() => mainWindow);
  startMcpBridgeIfEnabled(() => mainWindow);
  startDevBundleWatcher(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopSidecar();
  stopMcpBridge();
  closeThreadsDb();
  if (process.platform !== 'darwin') app.quit();
});
