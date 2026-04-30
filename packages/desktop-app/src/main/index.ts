import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
    autoHideMenuBar: true,
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
