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
  };
});

import { execSync } from 'node:child_process';
import { stat, writeFile, mkdir } from 'node:fs/promises';
import {
  detectSyncAccount,
  ensureFreshSync,
  type SyncProgressEvent,
} from '../../src/main/onedrive-sync';

const execMock = execSync as unknown as ReturnType<typeof vi.fn>;
const statMock = stat as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeFile as unknown as ReturnType<typeof vi.fn>;
const mkdirMock = mkdir as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // process.platform = 'win32' 강제 (CI 가 linux 일 수도 있으므로).
  Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
  execMock.mockReset();
  statMock.mockReset();
  writeMock.mockReset().mockResolvedValue(undefined);
  mkdirMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
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

  it('alreadyFresh — dest mtime 가 src mtime 보다 새것이면 sync 건너뜀', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }),
    );
    statMock.mockResolvedValue({ mtimeMs: 2_000_000 } as never);

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

  it('stale — dest 가 없으면 백그라운드 sync 시작 + syncing:true', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // 첫 호출: xlsx_stat
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }))
      // 두번째: xlsx_raw (백그라운드 sync 가 호출).
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT')); // dest 없음.

    const events: SyncProgressEvent[] = [];
    vi.useFakeTimers();
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyFresh).toBe(false);
      expect(r.syncing).toBe(true);
      expect(r.url).toContain('Klaud-temp');
      expect(r.url).toContain('action=embedview');
    }
    // 백그라운드 sync 가 micro-task 안에서 fetch + write 진행 후 8초 sleep + completed.
    await vi.runOnlyPendingTimersAsync();  // micro-task drain
    await vi.advanceTimersByTimeAsync(8500);
    expect(writeMock).toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual(['started', 'completed']);

    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it('stale — src 가 dest 보다 새것이면 백그라운드 sync 시작', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 5_000_000, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockResolvedValue({ mtimeMs: 1_000_000 } as never);

    const events: SyncProgressEvent[] = [];
    vi.useFakeTimers();
    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', (e) => events.push(e));

    if (r.ok) expect(r.syncing).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(8500);
    expect(events.map((e) => e.state)).toContain('completed');

    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it('src mtime 을 못 가져오면 (sidecar 404) alreadyFresh:true 로 fallback (옛 cloud 본문 유지)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    statMock.mockResolvedValue({ mtimeMs: 1_000_000 } as never);

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
