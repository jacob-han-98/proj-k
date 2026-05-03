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

  it('alreadyFresh — dest mtime 가 src mtime 보다 새것이고 size 같으면 sync 건너뜀', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }),
    );
    statMock.mockResolvedValue({ mtimeMs: 2_000_000, size: 100 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyFresh).toBe(true);
      expect(r.syncing).toBe(false);
    }
    expect(events).toEqual([]); // 백그라운드 sync 안 시작.
    expect(writeMock).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('stale by size — dest mtime 가 src 보다 새것이라도 size 다르면 sync 시작 (PK_단축키 6KB 회귀)', async () => {
    // 사용자 PC 실측 시나리오: PK_단축키 시스템.xlsx 가 OneDrive 에 6KB 짜리 partial 파일로
    // 들어감. 그 후 P4 sync 완료로 local 에 25MB 파일 있지만, OneDrive sync 가 dest mtime 을
    // *write 시각* 으로 박아둬서 dest > src 로 보임 → 옛 mtime-only 분기는 alreadyFresh 판정.
    // size 비교 추가로 회귀 차단.
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 25_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    // dest 는 mtime 더 새것 + size 6KB 인 가짜 partial 파일.
    statMock.mockResolvedValue({ mtimeMs: 2_000_000, size: 6_148 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_단축키 시스템', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyFresh).toBe(false); // size mismatch → stale → sync 시작
      expect(r.syncing).toBe(true);
    }
    await waitForCompleted(events);
    expect(writeMock).toHaveBeenCalled(); // 새 파일 write 됨
    expect(utimesMock).toHaveBeenCalled(); // mtime 동기화 호출됨
    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);
    fetchSpy.mockRestore();
  });

  it('writeFile 후 utimes 로 src mtime 동기화 (다음번 stale 판정 정확성 보장)', async () => {
    setupAccount();
    const SRC_MTIME = 1_700_000_000_000; // 임의의 src mtime ms
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: SRC_MTIME, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT')); // dest 없음 → stale

    const events: SyncProgressEvent[] = [];
    await ensureFreshSync('http://127.0.0.1:9999', '7_System/X', (e) => events.push(e));
    await waitForCompleted(events);

    expect(utimesMock).toHaveBeenCalled();
    const [destPath, atime, mtime] = utimesMock.mock.calls[0]!;
    expect(typeof destPath).toBe('string');
    // utimes 의 atime/mtime 인자는 Date 또는 number. 우리는 Date 사용.
    expect(mtime).toBeInstanceOf(Date);
    expect((mtime as Date).getTime()).toBe(SRC_MTIME);
    expect((atime as Date).getTime()).toBe(SRC_MTIME);
    fetchSpy.mockRestore();
  });

  // 백그라운드 sync 가 짧은 polling 후 'completed' 까지 끝나기를 기다리는 helper.
  // __setPollOptionsForTests 로 maxMs=100 잡아두니 최대 ~150ms 면 끝남.
  async function waitForCompleted(events: SyncProgressEvent[], timeoutMs = 500): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (events.some((e) => e.state === 'completed' || e.state === 'failed')) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('stale — dest 가 없으면 백그라운드 sync 시작 + syncing:true', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // 첫 호출: xlsx_stat
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }))
      // 두번째: xlsx_raw (백그라운드 sync 가 호출).
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT')); // dest 없음.

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyFresh).toBe(false);
      expect(r.syncing).toBe(true);
      expect(r.url).toContain('Klaud-temp');
      // 0.1.50 회귀 원복 — ?action=embedview 가 SharePoint download 응답 트리거 → ?web=1 로 복귀.
      expect(r.url).toContain('web=1');
    }
    await waitForCompleted(events);
    expect(writeMock).toHaveBeenCalled();
    expect(sessionFetchMock).toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);

    fetchSpy.mockRestore();
  });

  it('stale — src 가 dest 보다 새것이면 백그라운드 sync 시작', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 5_000_000, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockResolvedValue({ mtimeMs: 1_000_000, size: 100 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    if (r.ok) expect(r.syncing).toBe(true);
    await waitForCompleted(events);
    expect(events.map((e) => e.state)).toContain('completed');

    fetchSpy.mockRestore();
  });

  it('src mtime 을 못 가져오면 (sidecar 404) alreadyFresh:true 로 fallback (옛 cloud 본문 유지)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    statMock.mockResolvedValue({ mtimeMs: 1_000_000, size: 100 } as never);

    const events: SyncProgressEvent[] = [];
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/MISSING', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyFresh).toBe(true);
      expect(r.syncing).toBe(false);
    }
    expect(events).toEqual([]);
    expect(writeMock).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('account 미설정이면 ok:false', async () => {
    execMock.mockImplementation(() => regMissing());
    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', () => {});
    expect(r.ok).toBe(false);
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

  async function waitForCompleted(events: SyncProgressEvent[], timeoutMs = 500): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (events.some((e) => e.state === 'completed' || e.state === 'failed')) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('첫 폴링에 SharePoint redirect (302 → Doc.aspx) 받으면 즉시 ready → completed', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u_hybe_im/_layouts/15/Doc.aspx?sourcedoc=...'),
    );

    const events: SyncProgressEvent[] = [];
    await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));
    await waitForCompleted(events);

    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);
    // 첫 폴링에 ready → sessionFetch 1회만 호출.
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('404 → 404 → 302 시퀀스 — backoff 후 ready 도달', async () => {
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
    await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));
    await waitForCompleted(events);

    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);
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
      // 첫 시도: SSO 안 된 상태 — login 으로 redirect.
      .mockResolvedValueOnce(makeHeadResponse(302, 'https://login.microsoftonline.com/abc/oauth2/authorize?...'))
      // 두번째: 사용자 webview 가 SSO 끝내서 cookies 셋 → SharePoint redirect.
      .mockResolvedValueOnce(makeHeadResponse(302, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx'));

    const events: SyncProgressEvent[] = [];
    await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));
    await waitForCompleted(events);

    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);
    // login redirect 한 번 무시 + SharePoint redirect 한 번 = 총 2회.
    expect(sessionFetchMock).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('계속 404 받아도 maxMs 지나면 fallback 으로 completed (사용자 webview 가 어차피 SP 응답 받음)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset().mockResolvedValue(makeHeadResponse(404));

    const events: SyncProgressEvent[] = [];
    await ensureFreshSync('http://127.0.0.1:9999', 'x', (e) => events.push(e));
    await waitForCompleted(events, 1000);

    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);
    // maxMs=100ms 안에 1ms + 1ms + 1.5ms + 2ms ... 폴링 → 최소 몇 회 이상.
    expect(sessionFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    fetchSpy.mockRestore();
  });

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
      expect(r.url).toContain('web=1');
    }
    // 폴링이 첫 시도에 ready → 100ms 안. 옛 15s sleep 이면 15000ms 걸렸을 것.
    expect(elapsed).toBeLessThan(200);
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    expect(copyFileMock).toHaveBeenCalled();
    // mtime 동기화 검증 — copyFile 후 utimes 가 src mtime 으로 호출됨.
    expect(utimesMock).toHaveBeenCalled();
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
      expect(r.url).toContain('web=1');
    }
    expect(elapsed).toBeLessThan(200);
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    expect(utimesMock).toHaveBeenCalled();
  });
});
