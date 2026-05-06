// onedrive-sync.ts 의 main process 단위 테스트.
//
// 이번 세션에서 사용자 PC 발견된 bug 들의 회귀 방지:
//   1) detectSyncAccount() 가 UserUrl 키만 보던 것 → ServiceEndpointUri / SPOResourceId fallback.
//   2) ensureFreshSync() 의 mtime 비교 4가지 분기 (dest 없음 / src 더 새것 / 같음 / src 모름).
//
// child_process.execSync (registry 읽기) 와 node:fs/promises (mtime/write) 를 vi.mock 으로
// 가로채서 OS 의존성 격리. account.userFolder 는 가짜 path 사용.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 모킹은 hoisting 되어야 import 보다 위에 처리. 각 테스트가 mockImplementation 으로 override.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    copyFile: vi.fn(),
    utimes: vi.fn(),
  };
});
// pollSharePointReady 가 session.fromPartition('persist:onedrive').fetch 호출 — main process
// 전용 API 라 unit 환경에선 모킹 필요. 각 테스트가 sessionFetchMock 으로 응답 시퀀스 셋업.
const sessionFetchMock = vi.fn();
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({ fetch: sessionFetchMock })),
  },
}));

// copyFile 도 모킹 — uploadDepotFileAndUrl + syncUploadAndUrl 가 호출 (실제 fs IO 회피).
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import { execSync } from 'node:child_process';
import { stat, writeFile, mkdir, copyFile, utimes } from 'node:fs/promises';
import {
  __setPollOptionsForTests,
  detectSyncAccount,
  ensureFreshSync,
  repollCloudReady,
  syncUploadAndUrl,
  uploadDepotFileAndUrl,
  type SyncProgressEvent,
} from '../../src/main/onedrive-sync';

const execMock = execSync as unknown as ReturnType<typeof vi.fn>;
const statMock = stat as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeFile as unknown as ReturnType<typeof vi.fn>;
const mkdirMock = mkdir as unknown as ReturnType<typeof vi.fn>;
const copyFileMock = copyFile as unknown as ReturnType<typeof vi.fn>;
const utimesMock = utimes as unknown as ReturnType<typeof vi.fn>;

function makeHeadResponse(status: number, location: string | null = null): Response {
  // node Response constructor — 200 / 3xx 만 직접 만들 수 있고 4xx/5xx 도 가능.
  // headers 는 Map-like — Location 만 셋.
  return new Response(null, {
    status,
    headers: location ? { Location: location } : {},
  });
}

beforeEach(() => {
  // process.platform = 'win32' 강제 (CI 가 linux 일 수도 있으므로).
  Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
  execMock.mockReset();
  statMock.mockReset();
  writeMock.mockReset().mockResolvedValue(undefined);
  mkdirMock.mockReset().mockResolvedValue(undefined);
  copyFileMock.mockReset().mockResolvedValue(undefined);
  utimesMock.mockReset().mockResolvedValue(undefined);
  // 폴링 default — 첫 attempt 에 SharePoint redirect 로 즉시 ready (Doc.aspx). 개별 테스트가 override 가능.
  sessionFetchMock.mockReset().mockResolvedValue(
    makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=...'),
  );
  // 폴링 timing — 테스트 환경은 1ms / 1ms / 2ms / 100ms 같은 짧은 interval 로 실제 시간 거의
  // 안 걸림. fake-timer + microtask 충돌 회피 위해 real timer 사용 (advanceTimersByTimeAsync 가
  // pollSharePointReady 의 await chain 을 매끄럽게 못 따라가는 vitest 한계).
  __setPollOptionsForTests({ initialDelayMs: 1, baseBackoffMs: 1, maxBackoffMs: 2, maxMs: 100 });
});

afterEach(() => {
  __setPollOptionsForTests(null);
  vi.restoreAllMocks();
});

// reg query 출력은 다음 포맷:
//   <empty line>
//   HKEY_CURRENT_USER\Software\Microsoft\OneDrive\Accounts\Business1
//       <ValueName>    REG_SZ    <value>
//   <empty line>
function regOutput(value: string, data: string): string {
  return `\n  HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1\n    ${value}    REG_SZ    ${data}\n\n`;
}

// reg query 실패 (값 없음) → execSync throw.
function regMissing(): never {
  throw new Error('ERROR: The system was unable to find the specified registry key or value.');
}

describe('detectSyncAccount — userUrl resolve 우선순위', () => {
  it('1순위: UserUrl 키가 있으면 그대로 사용 (`:443` 포트는 제거)', () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('Business1') && cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('Business1') && cmd.includes('UserEmail')) return regOutput('UserEmail', 'u@hybe.im');
      if (cmd.includes('Business1') && cmd.includes('UserUrl')) return regOutput('UserUrl', 'https://t-my.sharepoint.com:443/personal/u_hybe_im/');
      if (cmd.includes('Business1') && cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', 'https://t-my.sharepoint.com/');
      regMissing();
    });
    const acc = detectSyncAccount();
    expect(acc).not.toBeNull();
    // `:443` 제거 + 끝의 `/` 제거.
    expect(acc!.userUrl).toBe('https://t-my.sharepoint.com/personal/u_hybe_im');
  });

  it('2순위: UserUrl 없으면 ServiceEndpointUri 에서 `/_api` 떼고 사용', () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('UserEmail')) return regOutput('UserEmail', 'u@hybe.im');
      if (cmd.includes('UserUrl')) regMissing();
      if (cmd.includes('ServiceEndpointUri')) return regOutput('ServiceEndpointUri', 'https://t-my.sharepoint.com/personal/u_hybe_im/_api');
      if (cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', '');
      regMissing();
    });
    const acc = detectSyncAccount();
    expect(acc?.userUrl).toBe('https://t-my.sharepoint.com/personal/u_hybe_im');
  });

  it('3순위: UserUrl + ServiceEndpointUri 둘 다 없으면 SPOResourceId + UserEmail UPN 변환', () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('UserEmail')) return regOutput('UserEmail', 'jacob@hybecorp.com');
      if (cmd.includes('UserUrl')) regMissing();
      if (cmd.includes('ServiceEndpointUri')) regMissing();
      if (cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', 'https://bhunion-my.sharepoint.com/');
      regMissing();
    });
    const acc = detectSyncAccount();
    expect(acc?.userUrl).toBe('https://bhunion-my.sharepoint.com/personal/jacob_hybecorp_com');
  });

  it('userFolder/email 둘 중 하나라도 없으면 null', () => {
    execMock.mockImplementation(() => regMissing());
    expect(detectSyncAccount()).toBeNull();
  });
});

describe('ensureFreshSync — mtime 비교 분기', () => {
  // 모든 케이스 공통: detectSyncAccount 가 success.
  function setupAccount() {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('UserEmail')) return regOutput('UserEmail', 'u@hybe.im');
      if (cmd.includes('UserUrl')) return regOutput('UserUrl', 'https://t-my.sharepoint.com/personal/u_hybe_im');
      if (cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', 'https://t-my.sharepoint.com/');
      regMissing();
    });
  }

  // 0.1.51 v6 — ensureFreshSync 가 모든 단계 직렬 await. backgroundSync fire-and-forget 제거.
  // 반환 shape: { ok:true, url, status:'ready' } | { ok:true, url, status:'cloud-not-ready', pollAttempts, pollLastStatus } | { ok:false, error }
  // 진행 events: 'uploading' (stale 시) → 'verifying' → 'completed' (ready) 또는 'verifying' (cloud-not-ready 면 completed 없음)

  it('alreadyFresh — dest mtime/size 매치도 cloud verify-poll 후 ready 반환', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }),
    );
    statMock.mockResolvedValue({ mtimeMs: 2_000_000, size: 100 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    // upload 안 함 (writeFile 호출 X) — verify-poll 만.
    expect(writeMock).not.toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual(['verifying', 'completed']);
    expect(sessionFetchMock).toHaveBeenCalled(); // verify-poll
    fetchSpy.mockRestore();
  });

  it('stale by size — size mismatch (PK_단축키 6KB 회귀) → upload + verify → ready', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 25_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    statMock.mockResolvedValue({ mtimeMs: 2_000_000, size: 6_148 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_단축키 시스템', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    expect(writeMock).toHaveBeenCalled();
    // 0.1.51 회귀 — utimes 절대 호출 X (OneDrive Sync 와 충돌 회피).
    expect(utimesMock).not.toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying', 'completed']);
    fetchSpy.mockRestore();
  });

  it('writeFile 후 mtime 건드리지 않음 (OneDrive Sync 충돌 회피 — 0.1.51 회귀)', async () => {
    setupAccount();
    const SRC_MTIME = 1_700_000_000_000;
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: SRC_MTIME, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));

    await ensureFreshSync('http://127.0.0.1:9999', '7_System/X', () => {});
    expect(writeMock).toHaveBeenCalled();
    expect(utimesMock).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('stale — dest 가 없으면 upload + verify 후 ready', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('ready');
      expect(r.url).toContain('Klaud-temp');
      expect(r.url).toContain('web=1'); // view 강제는 renderer 의 redirect intercept 에서
    }
    expect(writeMock).toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying', 'completed']);
    fetchSpy.mockRestore();
  });

  it('stale — src 가 dest 보다 새것이면 upload + verify 후 ready', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 5_000_000, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockResolvedValue({ mtimeMs: 1_000_000, size: 100 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying', 'completed']);
    fetchSpy.mockRestore();
  });

  it('src mtime 을 못 가져오면 (sidecar 404) verify-only path → cloud ready 면 status:ready', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    statMock.mockResolvedValue({ mtimeMs: 1_000_000, size: 100 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/MISSING', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    expect(writeMock).not.toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual(['verifying', 'completed']);
    fetchSpy.mockRestore();
  });

  it('account 미설정이면 ok:false', async () => {
    execMock.mockImplementation(() => regMissing());
    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', () => {});
    expect(r.ok).toBe(false);
  });

  it('동시 호출 (StrictMode dev double-fire / rapid double-click) — Promise 공유 → 둘 다 같은 결과', async () => {
    // 0.1.51 v7 회귀 방지. 옛 동작 (set+verify-only 5s budget) 은 두 번째 호출이 짧은 타임아웃에
    // 걸려서 false cloud-not-ready 반환 → renderer 가 정상 동작 중인데도 카드 노출. v7 은 두
    // 번째 호출이 첫 번째의 Promise 를 그대로 await — 같은 결과 받음.
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }));
    statMock.mockResolvedValue({ mtimeMs: 2_000_000, size: 100 } as never);

    // 두 호출이 같은 relPath 로 거의 동시에 진입.
    const events1: SyncProgressEvent[] = [];
    const events2: SyncProgressEvent[] = [];
    const [r1, r2] = await Promise.all([
      ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events1.push(e)),
      ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events2.push(e)),
    ]);

    // 둘 다 ok:true status:'ready' — 옛 verify-only 5s timeout false negative 안 발생.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.status).toBe('ready');
      expect(r2.status).toBe('ready');
      expect(r1.url).toBe(r2.url);
    }
    // 첫 호출의 onProgress 만 실제 작업 신호 받음 (Promise 공유 — 두 번째는 await 만).
    // 첫 호출자의 events 에는 'verifying','completed' 가 정확히 1회씩.
    expect(events1.map((e) => e.state)).toEqual(['verifying', 'completed']);
    fetchSpy.mockRestore();
  });
});

describe('SharePoint HEAD-poll — 25s sleep 대체', () => {
  function setupAccount(): void {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('UserEmail')) return regOutput('UserEmail', 'u@hybe.im');
      if (cmd.includes('UserUrl')) return regOutput('UserUrl', 'https://t-my.sharepoint.com/personal/u_hybe_im');
      if (cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', '');
      regMissing();
    });
  }

  it('첫 폴링에 302 redirect (Doc.aspx) → status:ready', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u_hybe_im/_layouts/15/Doc.aspx?sourcedoc=...'),
    );

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying', 'completed']);
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('404 → 404 → 302 시퀀스 — backoff 후 ready', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset()
      .mockResolvedValueOnce(makeHeadResponse(404))
      .mockResolvedValueOnce(makeHeadResponse(404))
      .mockResolvedValueOnce(makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=g'));

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying', 'completed']);
    expect(sessionFetchMock).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
  });

  it('login.microsoftonline.com redirect 는 ready 아님 — 폴링 계속', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset()
      .mockResolvedValueOnce(makeHeadResponse(302, 'https://login.microsoftonline.com/abc/oauth2/authorize?...'))
      .mockResolvedValueOnce(makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx'));

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying', 'completed']);
    expect(sessionFetchMock).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('계속 404 → maxMs timeout → status:cloud-not-ready (옛 v5 cloud-not-ready event 제거됨)', async () => {
    // v6: poll timeout 시 IPC return 으로 status:'cloud-not-ready' + pollAttempts/pollLastStatus 직접 전달.
    // 옛 'cloud-not-ready' progress event 는 emit 안 됨 (renderer 는 IPC await result 로만 카드 결정).
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset().mockResolvedValue(makeHeadResponse(404));

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('cloud-not-ready');
      if (r.status === 'cloud-not-ready') {
        expect(r.pollAttempts).toBeGreaterThanOrEqual(2);
        expect(r.pollLastStatus).toBe(404);
        expect(r.url).toContain('Klaud-temp');
      }
    }
    // 'completed' 안 떨어짐 (poll timeout 이라). 'cloud-not-ready' progress 도 없음 (제거됨).
    expect(events.map((e) => e.state)).toEqual(['uploading', 'verifying']);
    expect(sessionFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    fetchSpy.mockRestore();
  });
});

describe('repollCloudReady — cloud-not-ready 재시도', () => {
  function setupAccount(): void {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('UserEmail')) return regOutput('UserEmail', 'u@hybe.im');
      if (cmd.includes('UserUrl')) return regOutput('UserUrl', 'https://t-my.sharepoint.com/personal/u_hybe_im');
      if (cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', '');
      regMissing();
    });
  }

  it('SharePoint 가 그 사이 ready 됐으면 ready:true 반환', async () => {
    setupAccount();
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u_hybe_im/_layouts/15/Doc.aspx?sourcedoc=g'),
    );

    const r = await repollCloudReady('7_System/PK_HUD');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(true);
      expect(r.pollAttempts).toBeGreaterThanOrEqual(1);
    }
  });

  it('여전히 cloud 못 찾으면 ready:false + 메타데이터 반환 (재시도 카드 유지)', async () => {
    setupAccount();
    sessionFetchMock.mockReset().mockResolvedValue(makeHeadResponse(404));

    const r = await repollCloudReady('7_System/PK_HUD');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(false);
      expect(r.pollLastStatus).toBe(404);
    }
  });

  it('account 미설정이면 ok:false', async () => {
    execMock.mockImplementation(() => regMissing());
    const r = await repollCloudReady('x');
    expect(r.ok).toBe(false);
  });
});

describe('depot/upload 폴링 흐름', () => {
  function setupAccount(): void {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes('UserFolder')) return regOutput('UserFolder', 'C:\\Users\\u\\OneDrive');
      if (cmd.includes('UserEmail')) return regOutput('UserEmail', 'u@hybe.im');
      if (cmd.includes('UserUrl')) return regOutput('UserUrl', 'https://t-my.sharepoint.com/personal/u_hybe_im');
      if (cmd.includes('SPOResourceId')) return regOutput('SPOResourceId', '');
      regMissing();
    });
  }

  it('uploadDepotFileAndUrl 도 폴링 사용 — Klaud-depot 폴더 URL 검증', async () => {
    setupAccount();
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=z'),
    );

    statMock.mockResolvedValue({ mtimeMs: 5_000_000, size: 1_000 } as never);
    const t0 = Date.now();
    const r = await uploadDepotFileAndUrl(
      '//main/ProjectK/Design/7_System/PK_HUD.xlsx',
      'C:/tmp/dep_xxx.xlsx',
    );
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(true);
    if (r.ok) {
      // depot URL 은 Klaud-depot 폴더 + // prefix 제거 + 확장자 떼고 다시 붙임 패턴.
      expect(r.url).toContain('Klaud-depot');
      expect(r.url).toContain('main/ProjectK/Design/7_System/PK_HUD.xlsx');
      expect(r.url).toContain('web=1'); // 0.1.51 v3 — view 강제는 renderer 의 redirect intercept 에서
    }
    // 폴링이 첫 시도에 ready → 100ms 안. 옛 15s sleep 이면 15000ms 걸렸을 것.
    expect(elapsed).toBeLessThan(200);
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    expect(copyFileMock).toHaveBeenCalled();
    // mtime 동기화 검증 — copyFile 후 utimes 가 src mtime 으로 호출됨.
    expect(utimesMock).not.toHaveBeenCalled(); // 0.1.51 — OneDrive Sync 친화로 mtime 건드리지 않음
  });

  it('syncUploadAndUrl (legacy file picker) 도 폴링 사용 + mtime 동기화', async () => {
    setupAccount();
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx'),
    );
    statMock.mockResolvedValue({ mtimeMs: 7_000_000, size: 5_000 } as never);

    const t0 = Date.now();
    const r = await syncUploadAndUrl('C:/local/PK_HUD.xlsx', '7_System/PK_HUD');
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toContain('Klaud-temp');
      expect(r.url).toContain('web=1'); // 0.1.51 v3 — view 강제는 renderer 의 redirect intercept 에서
    }
    expect(elapsed).toBeLessThan(200);
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    expect(utimesMock).not.toHaveBeenCalled(); // 0.1.51 — OneDrive Sync 친화로 mtime 건드리지 않음
  });
});
