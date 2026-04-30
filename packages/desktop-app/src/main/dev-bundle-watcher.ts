// dev-bundle-watcher: Klaud 의 hot-swap 클라이언트 (0.1.28+, 0.1.29 보강).
//
// settings.devBundleUrl (예: http://localhost:8773) 가 설정 + mcpBridgeEnabled (dev 모드)
// 일 때만 동작. 5초마다 GET /manifest.json 폴링 → 디스크의 sha 와 비교 → 다른 file 만
// fetch → process.resourcesPath/app.asar.unpacked/out/<rel> 에 write.
//
// 0.1.29 부터: app.relaunch + app.exit 제거 (packaged Windows 에서 새 인스턴스 spawn fail).
// 대신:
//   - renderer / preload 만 변경 → webContents.reloadIgnoringCache(). preload 는 reload
//     시 자동 re-evaluate. main 안 죽음, 사용자 부담 0.
//   - main 변경 → log 만. 다음 사용자 manual 재시작 시 자연 적용 (0.1.30+ 에 toast 검토).

import type { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getSettings } from './settings';

interface ManifestEntry {
  path: string;     // posix-style relative path under out/
  sha256: string;
  size: number;
}

interface Manifest {
  files: ManifestEntry[];
  generatedAt: number;
}

const POLL_INTERVAL_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;

let installed = false;
let lastSwapAt = 0;

function unpackedOutDir(): string {
  // packaged: <resourcesPath>/app.asar.unpacked/out/
  // dev (electron-vite): <projectRoot>/out — process.resourcesPath 안 가리킴
  return join(process.resourcesPath, 'app.asar.unpacked', 'out');
}

function localSha(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

async function fetchManifest(baseUrl: string): Promise<Manifest | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/manifest.json`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

async function fetchFile(baseUrl: string, rel: string): Promise<Buffer | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/${encodeURI(rel)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

function isMainOrPreload(relPath: string): boolean {
  // main/* 또는 preload/* 변경은 재시작 필요. renderer/* 는 webContents.reload 로 충분.
  return relPath.startsWith('main/') || relPath.startsWith('preload/');
}

async function checkOnce(baseUrl: string, getWindow: () => BrowserWindow | null): Promise<void> {
  const outDir = unpackedOutDir();
  if (!existsSync(outDir)) {
    // dev 모드 (electron-vite dev) 에서는 packaged path 자체가 없음 — skip.
    return;
  }
  const manifest = await fetchManifest(baseUrl);
  if (!manifest) return;

  // 차이 식별.
  const changed: ManifestEntry[] = [];
  for (const entry of manifest.files) {
    const abs = join(outDir, entry.path.split('/').join(sep));
    const cur = localSha(abs);
    if (cur !== entry.sha256) changed.push(entry);
  }
  if (changed.length === 0) return;

  // swap 이 짧은 시간에 여러 번 나는 거 방지 (10초 cooldown).
  if (Date.now() - lastSwapAt < 10_000) return;

  console.log(`[dev-bundle] ${changed.length} file 변경 감지 — fetch 시작`);
  let okCount = 0;
  let mainOrPreloadChanged = false;
  for (const entry of changed) {
    const buf = await fetchFile(baseUrl, entry.path);
    if (!buf) {
      console.warn(`[dev-bundle] fetch 실패: ${entry.path}`);
      continue;
    }
    const abs = join(outDir, entry.path.split('/').join(sep));
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(abs, buf);
      okCount++;
      if (isMainOrPreload(entry.path)) mainOrPreloadChanged = true;
    } catch (e) {
      console.warn(`[dev-bundle] write 실패 ${abs}: ${(e as Error).message}`);
    }
  }

  if (okCount === 0) return;
  lastSwapAt = Date.now();

  // renderer-only 변경 → webContents.reload (Klaud 안 죽음, ~1초 안에 새 화면).
  // main/preload 변경 → 다음 사용자 manual 재시작 시 자연 적용. log 만 남기고 reload 안 함.
  // (이전 0.1.28 의 app.relaunch + app.exit 가 packaged Windows 에서 silent fail —
  //  새 인스턴스 spawn 안 됨. 안전한 path 로 변경.)
  if (mainOrPreloadChanged) {
    console.log(
      `[dev-bundle] ${okCount}/${changed.length} swap (main/preload 포함) — 다음 manual 재시작 시 적용`,
    );
    return;
  }

  console.log(`[dev-bundle] ${okCount}/${changed.length} swap (renderer only) — webContents.reload`);
  setTimeout(() => {
    const win = getWindow();
    if (!win || win.isDestroyed()) {
      console.warn('[dev-bundle] reload skip — main window 없음');
      return;
    }
    try {
      win.webContents.reloadIgnoringCache();
    } catch (e) {
      console.warn(`[dev-bundle] reload 실패: ${(e as Error).message}`);
    }
  }, 200);
}

export function startDevBundleWatcher(getWindow: () => BrowserWindow | null): void {
  if (installed) return;
  const s = getSettings();
  const dev = s.mcpBridgeEnabled !== false; // dev 모드 게이팅 — mcpBridge 와 동일 신호.
  if (!dev) {
    console.log('[dev-bundle] mcpBridgeEnabled OFF — watcher 비활성');
    return;
  }
  const url = (s.devBundleUrl ?? 'http://localhost:8773').replace(/\/+$/, '');
  if (!url) {
    console.log('[dev-bundle] devBundleUrl 미설정 — watcher 비활성');
    return;
  }
  installed = true;
  console.log(`[dev-bundle] watcher 시작 → ${url}, every ${POLL_INTERVAL_MS}ms`);

  // 즉시 1회 + 주기.
  void checkOnce(url, getWindow);
  setInterval(() => {
    void checkOnce(url, getWindow);
  }, POLL_INTERVAL_MS).unref();
}
