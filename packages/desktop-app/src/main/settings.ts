import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

// 비밀이 아닌 설정값(데이터 경로, 피드 URL 등) 보관소.
// app.getPath('userData') 아래 plain JSON 으로 저장 — 환경변수 없이도 앱 재시작 사이
// 사용자가 입력한 값이 유지되어, PowerShell setx 가 필요 없어진다.
//
// Confluence 자격증명처럼 민감한 값은 auth.ts (safeStorage 암호화) 에 따로 둔다.

export interface Settings {
  repoRoot?: string;
  updateFeedUrl?: string;
  retrieverUrl?: string;
  agentUrl?: string;
  mcpBridgeEnabled?: boolean;
  mcpBridgeUrl?: string;
  logCollectorUrl?: string;
  devBundleUrl?: string;
  lastThreadId?: string;
  sheetMappings?: Record<string, string>;
  // PoC 2C 0.1.48 — P4 워크스페이스 root (사용자 PC 의 .xlsx 원본이 sync 된 경로).
  // 첫 sheet 의 file picker 결과 path 에서 relPath 매칭으로 자동 추정 + 저장.
  // 한 번 저장된 후엔 모든 sheet 가 sidecar /xlsx_raw 로 자동 fetch.
  p4WorkspaceRoot?: string;
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

// 메인 프로세스 부팅 시점에 paths.ts 가 동기로 읽어야 하므로 sync API 도 제공.
export function getSettingsSync(): Settings {
  try {
    const raw = readFileSync(settingsFile(), 'utf-8');
    return JSON.parse(raw) as Settings;
  } catch {
    return {};
  }
}

export function getSettings(): Settings {
  return getSettingsSync();
}

export function setSettings(patch: Partial<Settings>): Settings {
  const current = getSettingsSync();
  const next: Settings = { ...current, ...patch };
  // undefined 키는 명시적으로 제거 — 사용자가 비웠을 때 디폴트 추정 로직이 동작하게.
  for (const k of Object.keys(patch) as Array<keyof Settings>) {
    if (patch[k] == null || patch[k] === '') delete (next as Record<string, unknown>)[k];
  }
  const userDir = app.getPath('userData');
  if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

// 우선순위: 환경변수 > settings.json > 기본 추정.
// 메인 프로세스 곳곳(paths/updater)에서 import 해서 사용.
export function effectiveRepoRoot(): string | undefined {
  return process.env.PROJK_REPO_ROOT || getSettingsSync().repoRoot || undefined;
}

export function effectiveUpdateFeedUrl(): string | undefined {
  return process.env.PROJK_UPDATE_FEED_URL || getSettingsSync().updateFeedUrl || undefined;
}

export function effectiveRetrieverUrl(): string | undefined {
  return process.env.PROJK_RETRIEVER_URL || getSettingsSync().retrieverUrl || undefined;
}

export function effectiveAgentUrl(): string | undefined {
  return process.env.PROJK_AGENT_URL || getSettingsSync().agentUrl || undefined;
}

export function effectiveP4WorkspaceRoot(): string | undefined {
  return process.env.PROJK_P4_ROOT || getSettingsSync().p4WorkspaceRoot || undefined;
}
