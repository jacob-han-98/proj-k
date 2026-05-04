// electron-updater 래퍼.
//
// 책임:
//   - 앱 부팅 5초 후 자동 체크
//   - 새 버전 발견 시 백그라운드 다운로드
//   - 다운로드 완료 후 렌더러에 토스트 (사용자가 "재시작" 누르면 즉시 install + relaunch)
//   - 사용자가 무시해도 다음 정상 종료 시 자동 install
//
// 정책:
//   - 자동 다운로드 (autoDownload=true) — 데이터 비용 무시 가능 (사내망)
//   - 자동 설치는 사용자 동작 후 (autoInstallOnAppQuit=true)
//   - 채널 분리: dev (지금) → stable (Phase 5b)
//   - 코드사이닝 검증 비활성: forceCodeSigning=false
//
// dev URL 미설정 시: updater 자체를 비활성. 빌드 미반영/오프라인 환경 보호.

import { app, BrowserWindow } from 'electron';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { effectiveUpdateFeedUrl, getSettings } from './settings';

export type UpdaterState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'downloading'; percent: number; bytesPerSecond: number }
  | { state: 'ready'; version: string; releaseNotes?: string }
  | { state: 'not-available'; current: string }
  | { state: 'error'; message: string };

let current: UpdaterState = { state: 'idle' };
let lastCheckedAt: number | null = null;
const listeners: Array<(s: UpdaterState) => void> = [];

function setState(next: UpdaterState): void {
  current = next;
  listeners.forEach((l) => l(next));
}

export function getUpdaterState(): UpdaterState {
  return current;
}

export function getLastCheckedAt(): number | null {
  return lastCheckedAt;
}

export async function checkForUpdate(): Promise<void> {
  // 사용자가 indicator 클릭 시 즉시 폴링.
  // electron-updater 는 자체 throttle 이 있어 너무 자주 부르면 캐시된 결과 반환.
  if (!app.isPackaged) return;
  if (!process.env.PROJK_UPDATE_FEED_URL && !current.state) return;
  try {
    lastCheckedAt = Date.now();
    await autoUpdater.checkForUpdates();
  } catch (e) {
    console.warn('[updater] manual check failed', e);
  }
}

export function onUpdaterState(fn: (s: UpdaterState) => void): () => void {
  listeners.push(fn);
  fn(current);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

let initialized = false;

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  if (initialized) return;
  initialized = true;

  // VS Code 에서 직접 띄운 dev 인스턴스(app.isPackaged === false)는 updater 비활성.
  // 코드 핫리로드로 충분하고, 피드 서버가 안 떠있으면 ERR_CONNECTION_REFUSED 토스트가
  // 5초마다 떠서 시끄러움. 인스톨러로 설치된 사용자 빌드(packaged)에서만 동작.
  if (!app.isPackaged) {
    console.log('[updater] dev 인스턴스(app.isPackaged=false) — updater 비활성');
    return;
  }

  const feedUrl = effectiveUpdateFeedUrl();
  if (!feedUrl) {
    console.log('[updater] feed URL 미설정 — updater 비활성 (설정에서 입력 가능)');
    return;
  }
  console.log(`[updater] 피드 URL: ${feedUrl}`);

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // 빌드된 앱이 자기 publish 메타데이터에서 url을 읽지만, dev 환경에서는 환경변수 우선.
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl,
    channel: 'dev',
  });

  autoUpdater.on('checking-for-update', () => {
    lastCheckedAt = Date.now();
    setState({ state: 'checking' });
    console.log('[updater] checking…');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({ state: 'available', version: info.version, releaseNotes: stringifyReleaseNotes(info.releaseNotes) });
    console.log(`[updater] available: ${info.version}`);
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    setState({ state: 'not-available', current: info.version });
  });

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    setState({ state: 'downloading', percent: p.percent, bytesPerSecond: p.bytesPerSecond });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ state: 'ready', version: info.version, releaseNotes: stringifyReleaseNotes(info.releaseNotes) });
    console.log(`[updater] downloaded: ${info.version}`);
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:state', current);
    }
    // mcpBridgeEnabled 일 때는 dev 모드로 간주 — 사용자 토스트 클릭 없이 즉시 silent install + relaunch.
    // dev 사이클을 진짜 닫힘 루프로 — 코드 수정 → release → 5초 후 자동으로 새 빌드 적용.
    const s = getSettings();
    if (s.mcpBridgeEnabled !== false) {
      console.log('[updater] dev 모드 — 자동 silent install + relaunch');
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1000);
    }
  });

  autoUpdater.on('error', (err: Error) => {
    setState({ state: 'error', message: err?.message ?? String(err) });
    console.warn(`[updater] error: ${err?.message}`);
  });

  // 부팅 직후 즉시 체크하면 main window가 아직 안 그려질 수 있어 5초 지연.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.warn('[updater] check 실패', e);
    });
  }, 5_000);

  // 폴링 주기 — dev 모드(mcpBridgeEnabled)면 5초(닫힘 루프), 아니면 5분(일반 사용).
  // 부팅 시점에 결정. 사용자가 도중에 토글해도 다음 부팅까지는 기존 주기 유지.
  const pollInterval = getSettings().mcpBridgeEnabled !== false ? 5_000 : 5 * 60 * 1000;
  console.log(`[updater] polling interval = ${pollInterval}ms`);
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, pollInterval);
}

export function quitAndInstall(): void {
  // isSilent=true: NSIS 에 /S 플래그 전달 — 설치 마법사 안 띄움.
  // 사용자 체감: 앱이 잠깐 닫혔다가 새 버전이 곧바로 다시 뜸 (재설치 느낌 제거).
  // isForceRunAfter=true: 설치 직후 자동 재실행.
  autoUpdater.quitAndInstall(true, true);
}

function stringifyReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  return notes.map((n) => n.note ?? '').filter(Boolean).join('\n\n');
}
