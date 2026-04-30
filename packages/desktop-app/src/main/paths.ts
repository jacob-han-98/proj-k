import { resolve, join } from 'node:path';
import { app } from 'electron';
import { effectiveRepoRoot } from './settings';

// 우선순위:
//   1) PROJK_REPO_ROOT 환경변수  (가장 강함)
//   2) userData/settings.json 의 repoRoot  (앱 안 SettingsModal 에서 입력)
//   3) dev 모드일 때만 app.getAppPath() 기준 두 단계 위
// packaged 환경에서 (1)/(2) 모두 비면 빈 문자열을 돌려, 트리 빌더가 빈 결과를 반환하고
// 사용자에게 "데이터 경로 미설정" 신호로 노출된다.

function detectRepoRoot(): string {
  const fromUserOrEnv = effectiveRepoRoot();
  if (fromUserOrEnv) return resolve(fromUserOrEnv);
  if (app.isPackaged) return '';
  const appPath = app.getAppPath();
  return resolve(appPath, '..', '..');
}

export function getRepoRoot(): string {
  return detectRepoRoot();
}

export function getDesktopAppDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  const root = detectRepoRoot();
  return root ? resolve(root, 'packages/desktop-app') : '';
}

export function getSidecarDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'sidecar');
  const root = detectRepoRoot();
  return root ? resolve(root, 'packages/desktop-app/src/sidecar') : '';
}

export function getXlsxOutputDir(): string {
  const root = detectRepoRoot();
  return root ? resolve(root, 'packages/xlsx-extractor/output') : '';
}

export function getConfluenceOutputDir(): string {
  const root = detectRepoRoot();
  return root ? resolve(root, 'packages/confluence-downloader/output') : '';
}

export function getConfluenceManifest(): string {
  const dir = getConfluenceOutputDir();
  return dir ? resolve(dir, '_manifest.json') : '';
}

// 후방호환 — 일부 import 가 상수 형태를 기대.
// 이 값들은 모듈 로드 시점 한 번 평가되므로, 사용자가 settings 를 바꾼 직후엔
// "함수 호출" 형태(get*) 를 사용해야 새 값을 본다.
export const REPO_ROOT = detectRepoRoot();
export const IS_PACKAGED = app.isPackaged;
export const DESKTOP_APP_DIR = getDesktopAppDir();
export const SIDECAR_DIR = getSidecarDir();
export const XLSX_OUTPUT_DIR = getXlsxOutputDir();
export const CONFLUENCE_OUTPUT_DIR = getConfluenceOutputDir();
export const CONFLUENCE_MANIFEST = getConfluenceManifest();
