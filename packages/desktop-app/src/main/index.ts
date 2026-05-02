import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

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
  session.fromPartition('persist:onedrive');   // OneDrive / SharePoint / Office for the Web
}

// 진단용 — 모든 webContents (main + webview + 자식 frame) 의 navigation/load/error
// 이벤트를 main 콘솔에 기록. webview 가 어떤 URL 로 redirect 되어 어디서 멈추는지
// (SSO chain / X-Frame deny / crashed 등) 추적. mcp 의 klaud_get_logs 로 받음.
function installWebContentsTracing(): void {
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType(); // 'window' | 'browserView' | 'webview' | 'remote' | 'backgroundPage' | 'offscreen'
    console.log(`[wc-created] type=${type} id=${contents.id} initial-url=${contents.getURL().slice(0, 80)}`);
    if (type !== 'webview') return; // main window / sub-frame 는 너무 noise — webview 만.

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
  // log-push 는 setting 을 읽으므로 settings 모듈이 살아있어야 한다 → 가장 먼저.
  installLogPush(__APP_VERSION__);
  // 스레드 DB 부팅 (sql.js wasm load + schema migrate). 실패해도 main 진행.
  await initThreadsDb().catch((e) => console.error('[main] initThreadsDb', e));
  logEnvironment();
  installPartitions();
  installWebContentsTracing();
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
