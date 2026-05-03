// C1: 사용자 환경 진단 — 설치 후 무엇이 안 되는지 한 화면에 모아 보여준다.
// 각 check 는 독립 promise — 병렬 실행 + 개별 실패가 다른 검사 막지 않음.

import type { SidecarStatus } from '../shared/types';

// sidecar /health 응답 — preload 가 unknown 으로만 노출하므로 진단 모듈 안에서 narrow.
export interface SidecarHealth {
  status?: string;
  version?: string;
  agent_url?: string | null;
  retriever_url?: string | null;
  repo_root_input?: string | null;
  repo_root_resolved?: string | null;
  repo_root_exists?: boolean;
  repo_root_listable?: boolean;
  repo_root_listdir_error?: string | null;
  repo_root_sample?: string[] | null;
  platform?: string;
}

export type DiagStatus = 'ok' | 'warn' | 'error' | 'pending';

export interface DiagResult {
  // UI 노출용 안정 키 — testid + key prop 양쪽에 사용.
  id: string;
  // 화면 라벨 (한글).
  label: string;
  status: DiagStatus;
  // 한 줄 요약. ok 면 ✅ 본문, warn/error 면 어떻게 고치면 되는지.
  message: string;
  // 사용자가 즉시 행동 가능한 단축키 (있으면 노출).
  action?: { label: string; kind: 'open-settings' | 'reload-trees' | 'detect-onedrive' | 'discover-p4' };
  // 추가 detail (debug — 펼치기). multiline 가능.
  detail?: string;
}

interface ProjkApi {
  getSettings: () => Promise<Record<string, unknown>>;
  getSidecarStatus: () => Promise<SidecarStatus>;
  getSidecarHealth: () => Promise<{ ok: boolean; body?: unknown; error?: string }>;
  getConfluenceCreds: () => Promise<{ email?: string; baseUrl?: string } | null>;
  oneDriveSync?: { detect: () => Promise<{ ok: boolean; account?: { email?: string } }> };
  p4?: { discover: () => Promise<{ ok: boolean; source?: string; user?: string; client?: string }> };
}

// 모든 check 를 병렬 수행. 어떤 check 도 throw 하지 않게 — 하나의 실패가 panel
// 전체를 깨지 않게.
export async function runAllDiagnostics(api: ProjkApi): Promise<DiagResult[]> {
  const settingsP = api.getSettings().catch(() => ({} as Record<string, unknown>));
  const sidecarStatusP = api.getSidecarStatus().catch(() => null);
  const sidecarHealthP = api.getSidecarHealth().catch(
    (): { ok: boolean; body?: unknown; error?: string } => ({ ok: false, error: 'fetch 실패' }),
  );
  const credsP = api.getConfluenceCreds().catch(() => null);
  const oneDriveP = api.oneDriveSync?.detect().catch(() => ({ ok: false })) ?? Promise.resolve({ ok: false });
  const p4DiscoverP = api.p4?.discover().catch(() => ({ ok: false })) ?? Promise.resolve({ ok: false });

  const [settings, sidecarStatus, sidecarHealthRaw, creds, oneDrive, p4d] = await Promise.all([
    settingsP, sidecarStatusP, sidecarHealthP, credsP, oneDriveP, p4DiscoverP,
  ]);
  const sidecarHealth: { ok: boolean; body?: SidecarHealth; error?: string } = {
    ok: sidecarHealthRaw.ok,
    body: (sidecarHealthRaw.body as SidecarHealth | undefined) ?? undefined,
    error: sidecarHealthRaw.error,
  };

  const out: DiagResult[] = [];

  // 1. Sidecar 부팅
  out.push(diagSidecar(sidecarStatus, sidecarHealth));

  // 2. Repo root (PROJK_REPO_ROOT)
  out.push(diagRepoRoot(settings, sidecarHealth));

  // 3. P4 root (PROJK_P4_ROOT)
  out.push(diagP4Root(settings));

  // 4. P4 CLI 발견
  out.push(diagP4Discover(p4d));

  // 5. xlsx-extractor output
  out.push(await diagXlsxExtractor(sidecarStatus));

  // 6. Confluence creds
  out.push(diagConfluenceCreds(creds));

  // 7. agent backend 응답
  out.push(diagAgentBackend(settings, sidecarStatus));

  // 8. Update feed URL
  out.push(diagUpdateFeed(settings));

  // 9. OneDrive Sync 클라이언트
  out.push(diagOneDriveSync(oneDrive));

  return out;
}

function diagSidecar(status: SidecarStatus | null, health: { ok: boolean; body?: SidecarHealth; error?: string }): DiagResult {
  if (!status) {
    return {
      id: 'sidecar',
      label: '사이드카',
      status: 'error',
      message: 'IPC 응답 없음 — main process 가 안 떴거나 preload 미로드.',
    };
  }
  if (status.state === 'error') {
    return {
      id: 'sidecar',
      label: '사이드카',
      status: 'error',
      message: `에러 상태 — ${status.message ?? '원인 미상'}`,
      detail: JSON.stringify(status, null, 2),
    };
  }
  if (status.state !== 'ready') {
    return {
      id: 'sidecar',
      label: '사이드카',
      status: 'warn',
      message: `${status.state} — 부팅 중 또는 재시도 중`,
    };
  }
  if (!health.ok) {
    return {
      id: 'sidecar',
      label: '사이드카',
      status: 'warn',
      message: `포트 :${status.port} 응답 — health 호출 실패: ${health.error ?? '?'}`,
    };
  }
  return {
    id: 'sidecar',
    label: '사이드카',
    status: 'ok',
    message: `:${status.port} ready (v${health.body?.version ?? '?'})`,
  };
}

function diagRepoRoot(settings: Record<string, unknown>, health: { ok: boolean; body?: SidecarHealth }): DiagResult {
  const repo = settings.repoRoot;
  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    return {
      id: 'repo-root',
      label: '데이터 경로 (repoRoot)',
      status: 'error',
      message: '미설정 — 설정에서 repoRoot 를 입력하세요. P4/xlsx/Confluence 트리 모두 의존.',
      action: { label: '설정 열기', kind: 'open-settings' },
    };
  }
  const body = health.body;
  if (!body) {
    return {
      id: 'repo-root',
      label: '데이터 경로 (repoRoot)',
      status: 'warn',
      message: `${repo} — 사이드카 health 응답 없어 검증 불가`,
    };
  }
  if (!body.repo_root_exists) {
    return {
      id: 'repo-root',
      label: '데이터 경로 (repoRoot)',
      status: 'error',
      message: `경로 존재하지 않음: ${body.repo_root_resolved ?? repo}`,
      detail: body.repo_root_listdir_error ?? undefined,
      action: { label: '설정 열기', kind: 'open-settings' },
    };
  }
  if (!body.repo_root_listable) {
    return {
      id: 'repo-root',
      label: '데이터 경로 (repoRoot)',
      status: 'warn',
      message: `목록 못 읽음 — ${body.repo_root_listdir_error ?? '권한/마운트 문제'}`,
      detail: body.repo_root_resolved ?? undefined,
    };
  }
  return {
    id: 'repo-root',
    label: '데이터 경로 (repoRoot)',
    status: 'ok',
    message: `${body.repo_root_resolved ?? repo} (${body.repo_root_sample?.length ?? 0}+ 항목)`,
  };
}

function diagP4Root(settings: Record<string, unknown>): DiagResult {
  const p4 = settings.p4WorkspaceRoot;
  if (!p4 || typeof p4 !== 'string' || !p4.trim()) {
    return {
      id: 'p4-root',
      label: 'P4 워크스페이스 (p4WorkspaceRoot)',
      status: 'warn',
      message: '미설정 — Excel 시트 webview 가 동작 안 함. 설정에서 P4 root 입력.',
      action: { label: '설정 열기', kind: 'open-settings' },
    };
  }
  return {
    id: 'p4-root',
    label: 'P4 워크스페이스 (p4WorkspaceRoot)',
    status: 'ok',
    message: p4,
  };
}

function diagP4Discover(d: { ok: boolean; source?: string; user?: string; client?: string }): DiagResult {
  if (!d.ok) {
    return {
      id: 'p4-cli',
      label: 'P4 CLI 발견',
      status: 'warn',
      message: 'p4 CLI 자동 발견 실패 — Perforce 가 설치되어있고 ticket 로그인되어있는지 확인',
      action: { label: '재시도', kind: 'discover-p4' },
    };
  }
  return {
    id: 'p4-cli',
    label: 'P4 CLI 발견',
    status: 'ok',
    message: `${d.source ?? '?'} · ${d.user ?? '?'} @ ${d.client ?? '?'}`,
  };
}

async function diagXlsxExtractor(status: SidecarStatus | null): Promise<DiagResult> {
  if (!status?.port) {
    return {
      id: 'xlsx-extractor',
      label: 'xlsx-extractor 변환 결과',
      status: 'pending',
      message: '사이드카 미준비',
    };
  }
  // sheet_content 는 relPath 가 비면 400, 워크북 누락 시 404, repo 미설정 시 503.
  // probe 용으로 일부러 빈 relPath 호출 시 400 = 디렉토리는 살아있다는 신호.
  // 실제 워크북 매칭은 사용 시점에 ad-hoc — 진단은 대분류만.
  try {
    const res = await fetch(`http://127.0.0.1:${status.port}/sheet_content?relPath=__probe__`);
    if (res.status === 503) {
      return {
        id: 'xlsx-extractor',
        label: 'xlsx-extractor 변환 결과',
        status: 'warn',
        message: 'output 디렉토리 미발견 — 시트 리뷰 (B3) 가 동작 안 함. WSL 측에서 한 번 변환 필요.',
      };
    }
    if (res.status === 404) {
      // dir 은 있는데 그 워크북이 없을 뿐 — output 자체는 정상.
      return {
        id: 'xlsx-extractor',
        label: 'xlsx-extractor 변환 결과',
        status: 'ok',
        message: 'output 디렉토리 발견 — 워크북별 매칭은 시트별로 확인',
      };
    }
    return {
      id: 'xlsx-extractor',
      label: 'xlsx-extractor 변환 결과',
      status: 'ok',
      message: '응답 정상',
    };
  } catch (e) {
    return {
      id: 'xlsx-extractor',
      label: 'xlsx-extractor 변환 결과',
      status: 'warn',
      message: `probe 실패: ${(e as Error).message}`,
    };
  }
}

function diagConfluenceCreds(creds: { email?: string; baseUrl?: string } | null): DiagResult {
  if (!creds || !creds.email) {
    return {
      id: 'confluence',
      label: 'Confluence 인증',
      status: 'warn',
      message: '미등록 — Confluence 페이지 webview 는 동작하지만 사본/리뷰 등 일부 기능 제약',
      action: { label: '설정 열기', kind: 'open-settings' },
    };
  }
  return {
    id: 'confluence',
    label: 'Confluence 인증',
    status: 'ok',
    message: `${creds.email} (${creds.baseUrl ?? 'baseUrl 미설정'})`,
  };
}

function diagAgentBackend(settings: Record<string, unknown>, status: SidecarStatus | null): DiagResult {
  const url = settings.agentUrl;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return {
      id: 'agent',
      label: 'Agent 백엔드 (agentUrl)',
      status: 'warn',
      message: '미설정 — QnA / 리뷰 / 변경 제안 모두 동작 안 함',
      action: { label: '설정 열기', kind: 'open-settings' },
    };
  }
  if (!status?.port) {
    return {
      id: 'agent',
      label: 'Agent 백엔드 (agentUrl)',
      status: 'pending',
      message: '사이드카 미준비',
      detail: url,
    };
  }
  return {
    id: 'agent',
    label: 'Agent 백엔드 (agentUrl)',
    status: 'ok',
    message: url,
  };
}

function diagUpdateFeed(settings: Record<string, unknown>): DiagResult {
  const url = settings.updateFeedUrl;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return {
      id: 'update-feed',
      label: '자동 업데이트 피드',
      status: 'warn',
      message: '미설정 — 새 버전 알림 안 옴',
      action: { label: '설정 열기', kind: 'open-settings' },
    };
  }
  return {
    id: 'update-feed',
    label: '자동 업데이트 피드',
    status: 'ok',
    message: url,
  };
}

function diagOneDriveSync(d: { ok: boolean; account?: { email?: string } }): DiagResult {
  if (!d.ok) {
    return {
      id: 'onedrive',
      label: 'OneDrive Business Sync 클라이언트',
      status: 'warn',
      message: '감지 실패 — Excel webview 가 동작 안 할 수 있음. OneDrive 설치 + 계정 로그인 필요.',
      action: { label: '재감지', kind: 'detect-onedrive' },
    };
  }
  return {
    id: 'onedrive',
    label: 'OneDrive Business Sync 클라이언트',
    status: 'ok',
    message: d.account?.email ?? '계정 발견',
  };
}
