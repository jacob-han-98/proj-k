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
  // agent-sdk-poc 의 web frontend URL — 🤖 임베드 탭이 사용. agentUrl (API base) 과
  // 분리되어 있어 prod web 을 띄워두고 dev API 를 쓰는 등 자유 조합 가능. 비어있으면
  // agentUrl 에서 /api 접미사 strip 해 도출. prod 예: https://cp.tech2.hybe.im/proj-k/agentsdk/
  agentWebUrl?: string;
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
  // PR9 — Perforce 서버 좌표. SettingsModal 의 "자동 발견" 으로 채워지거나 사용자 직접 입력.
  // 모두 비어있으면 P4Panel 의 depot 탭은 안내만 표시.
  p4Host?: string;
  p4User?: string;
  p4Client?: string;

  // B2-1 (2026-05-03): Confluence 리뷰/수정 검증용 별도 스페이스. 실 운영 페이지를
  // 직접 수정하지 않고 사본 만들어 안전하게 검증. 공통 패턴: 본인 personal space (~uid)
  // 또는 회사가 만든 sandbox 스페이스 (예: `PKTEST`).
  // 비워두면 "테스트로 복사" 버튼 비활성. 채워두면 노출.
  confluenceTestSpaceKey?: string;
  // 선택. 채우면 그 페이지의 자식으로 복사, 비우면 스페이스 root.
  confluenceTestParentPageId?: string;

  // 액티비티 바 5번 ("내 작업 중 문서") 의 Confluence draft polling 대상 space key 목록.
  // 비어있으면 ['PK'] 로 fallback. 임시/개발용 space 추가 시 여기에.
  confluenceDraftSpaceKeys?: string[];

  // PoC 0.1.53+: Excel viewer 분기. 미설정/`onlyoffice` (default) 또는 명시적 `sp`.
  // 기본을 OnlyOffice 자체 호스팅으로 — OneDrive 동기화 함정 우회.
  viewerMode?: 'sp' | 'onlyoffice';
  // OnlyOffice Document Server endpoint. 예: http://172.20.105.147:8080
  onlyOfficeUrl?: string;

  // 2026-05-13 릴리스-A2: 통합 로그 sink (운영 모니터링 + 제보).
  // - klaudLogSinkUrl: 사내 backend endpoint (예: http://cp.tech2.hybe.im/proj-k/admin
  //   또는 http://<host>:8090). 미설정 시 frontend 는 큐에 적재만 하고 송신 X — 사용자
  //   에게 영향 0. 설정되면 console + window.error + unhandledrejection + 제보 가
  //   모두 이 URL 로. /klaud/log/batch + /klaud/report 두 endpoint 를 직접 호출
  //   (agent-sdk-poc 가 호스팅 — 2026-05-13 backend 확정 b0157ad).
  // - klaudTelemetryEnabled: 사용자 opt-out. default true (안 켜져 있어도 url 미설정이면 무효).
  //   끄면 익명/사용자 로그 송신 자체 안 함. backend contract 와 이름 정렬.
  klaudLogSinkUrl?: string;
  klaudTelemetryEnabled?: boolean;
  // machine_id 는 backend 가 사용자 식별 (SSO 합류 전) 에 쓰는 익명 UUID. 첫 부팅 시
  // 자동 생성되어 settings 에 영구 보관. 사용자 변경 불가 (UI 미노출).
  klaudMachineId?: string;
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
