import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Background spawn (Bash → npm → electron-vite → electron) 시 OS DWM compositor 가
// occlusion 으로 GPU paint skip → capturePage 가 빈 frame buffer 반환. software rendering
// 강제로 background 도 paint — 진단 / autotest 가 정상 frame 받음.
// dev/CI 환경 mark 로 PROJK_FORCE_SOFTWARE_RENDER 켜진 경우만 활성 (release 빌드 영향 X).
if (process.env.PROJK_FORCE_SOFTWARE_RENDER === '1' || !app.isPackaged) {
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
    // show:false 또는 background spawn 으로 OS-visible 하지 않은 상태에서도 renderer 가
    // paint 시작 — capturePage / autotest 가 정상 frame buffer 받게 한다.
    paintWhenInitiallyHidden: true,
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
      // Background spawn (Bash → npm → electron-vite → electron) 시 OS DWM 이 window 를
      // visible 처리 안 해 GPU paint skip → capturePage 빈 frame. backgroundThrottling 끄면
      // hidden 상태에서도 paint 계속.
      backgroundThrottling: false,
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
