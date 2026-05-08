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
    // 0.1.52 — uploadDepotFileAndUrl 가 readFile 사용 (tmp → buf → writeViaTempCopy).
    readFile: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])),
    unlink: vi.fn().mockResolvedValue(undefined),
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
import { stat, writeFile, mkdir, copyFile, utimes, readFile, unlink } from 'node:fs/promises';
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
const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;
const unlinkMock = unlink as unknown as ReturnType<typeof vi.fn>;

// 0.1.53 — pollSharePointReady 가 HEAD 대신 Range GET (bytes=0-3) 단일 probe 로 통일됐다.
// 옛 동작 (HEAD → 조건부 Range GET) 의 결정적 결함: SP file URL HEAD 가 Doc.aspx (HTML viewer)
// 로 redirect → "sp-redirect = ready" 로 trust → cloud 가 6148-byte stub 만 있어도 ready 응답
// → 사용자 webview 빈 워크북. Range GET 은 Doc.aspx redirect 를 bypass 하고 status 206 +
// Content-Range: `bytes 0-3/<total>` 로 cloud 의 진짜 binary size 노출.
//
// `makeRangeResponse` 는 production 의 Range GET probe 가 받는 응답 형태를 정확히 재현.
//   - 정상 ready: status=206, Content-Range='bytes 0-3/<size>', body=ZIP magic (4 bytes)
//   - cloud stub: status=206, Content-Range='bytes 0-3/6148', body=ZIP magic (stub 도 valid xlsx)
//   - SP Range 무시: status=200, body=raw xlsx 또는 HTML
//   - 미존재 / auth: status=4xx 또는 redirected 후 final url 이 login 페이지
function makeRangeResponse(opts: {
  status: number;
  // Content-Range 헤더 — 'bytes 0-3/N' 형태. 206 일 때 production 이 파싱.
  contentRange?: string;
  // 응답 body 의 first 4 bytes. ZIP magic = [0x50,0x4b,0x03,0x04]. HTML start = [0x3c,...].
  // 미지정 시 ZIP magic.
  bodyBytes?: number[];
  finalUrl?: string;
  redirected?: boolean;
}): Response {
  const bytes = opts.bodyBytes ?? [0x50, 0x4b, 0x03, 0x04];
  const headers: Record<string, string> = {};
  if (opts.contentRange) headers['content-range'] = opts.contentRange;
  const res = new Response(new Uint8Array(bytes), { status: opts.status, headers });
  if (opts.finalUrl) {
    Object.defineProperty(res, 'url', { value: opts.finalUrl, configurable: true });
  }
  if (opts.redirected) {
    Object.defineProperty(res, 'redirected', { value: true, configurable: true });
  }
  return res;
}

// Backward-compat helper — 옛 HEAD 시그니처로 작성된 테스트 케이스를 Range GET 응답으로 매핑.
// `status === 200 && finalUrl includes Doc.aspx`  → 기본 ready (206 + ZIP magic + size match)
// `status === 404`                                 → not ready (406 또는 그대로 404)
// `status === 200 && login.microsoftonline.com`    → auth-redirect (206 + redirected=true + login final url)
function makeHeadResponse(
  status: number,
  finalUrl: string | null = null,
  redirected = false,
): Response {
  // 옛 HEAD 의 의미를 새 Range GET 응답 형태로 매핑:
  //   - 정상 ready (302/200 + Doc.aspx) → 206 + Content-Range='bytes 0-3/100' + ZIP magic
  //   - 404                              → 404 그대로
  //   - auth redirect                    → 206 + redirected=true + login.microsoftonline.com final url
  if (finalUrl && finalUrl.includes('login.microsoftonline.com')) {
    return makeRangeResponse({
      status: 200,
      finalUrl,
      redirected: true,
      bodyBytes: [0x3c, 0x68, 0x74, 0x6d], // '<htm' — HTML page from auth follow
    });
  }
  if (status >= 400) {
    return new Response(null, { status });
  }
  // ready 케이스 — Content-Range 헤더 omit 해서 production 의 size 비교 skip (각 테스트가
  // expectedSize 를 다르게 set 해도 매번 stub 감지로 false-fail 안 나게). 명시적 stub 회귀
  // 테스트는 makeRangeResponse() 직접 사용.
  return makeRangeResponse({
    status: 206,
    finalUrl: finalUrl ?? undefined,
    redirected,
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
  // 0.1.52 — depot 흐름 (uploadDepotFileAndUrl) 이 readFile 로 tmp 읽고 writeViaTempCopy 가
  // unlink 로 cleanup. afterEach 의 vi.restoreAllMocks 가 mockResolvedValue 를 날리므로 매 test
  // 마다 다시 set.
  readFileMock.mockReset().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
  unlinkMock.mockReset().mockResolvedValue(undefined);
  // 폴링 default — 첫 attempt 에 SharePoint redirect 로 즉시 ready (Doc.aspx). 개별 테스트가 override 가능.
  sessionFetchMock.mockReset().mockResolvedValue(
    makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=...', true),
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

  it('sheetName 옵션 — URL 에 &activeCell=\'<sheet>\'!A1 부착 (Excel for the Web 시트 점프)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1, size: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));

    const r = await ensureFreshSync(
      'http://127.0.0.1:9999',
      '7_System/PK_HUD',
      () => {},
      { sheetName: 'HUD_전투' },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('ready');
      // activeCell 파라미터 — encodeURIComponent("'HUD_전투'!A1")
      expect(r.url).toContain('activeCell=');
      // 한글 시트명은 percent-encoded — decode 해서 검증.
      const m = r.url.match(/activeCell=([^&]+)/);
      expect(m).toBeTruthy();
      if (m) {
        expect(decodeURIComponent(m[1])).toBe("'HUD_전투'!A1");
      }
    }
    fetchSpy.mockRestore();
  });

  it('sheetName 미지정 — activeCell 부착 안 함 (workbook default 동작)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1, size: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));

    const r = await ensureFreshSync('http://127.0.0.1:9999', '7_System/PK_HUD', () => {});

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).not.toContain('activeCell');
    }
    fetchSpy.mockRestore();
  });

  it("sheetName single-quote escape — `Bob's data` → `Bob''s data`", async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1, size: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));

    const r = await ensureFreshSync(
      'http://127.0.0.1:9999',
      '7_System/PK_HUD',
      () => {},
      { sheetName: "Bob's data" },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = r.url.match(/activeCell=([^&]+)/);
      expect(m).toBeTruthy();
      if (m) {
        expect(decodeURIComponent(m[1])).toBe("'Bob''s data'!A1");
      }
    }
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
      makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u_hybe_im/_layouts/15/Doc.aspx?sourcedoc=...', true),
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
      .mockResolvedValueOnce(makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=g', true));

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
      // redirect:'follow' 결과 — auth 페이지로 끝까지 따라간 케이스. status 는 200, final url 이 login.
      .mockResolvedValueOnce(makeHeadResponse(200, 'https://login.microsoftonline.com/abc/oauth2/authorize?...', true))
      .mockResolvedValueOnce(makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx', true));

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

  // 회귀 2026-05-08 — Electron 33 의 session.fetch 가 redirect:'manual' 일 때 302 응답 대신
  // "Redirect was cancelled" 로 throw 하던 회귀. 옛 production 코드는 catch 가 silent 해서 21회
  // timeout 후 사용자는 "왜 안 됐나" 못 봄. 사용자가 depot 파일 클릭 시에만 노출 (로컬 시트는
  // url 즉시 반환되어 webview 자체로 동작했기 때문). 회귀 방지 의무.
  it('fetch 가 매번 throw — pollLastFetchError 가 사용자에게 노출 (silent 회귀 방지)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    // 모든 attempt 가 throw — 옛 회귀 (Electron33 redirect:'manual') 시뮬.
    sessionFetchMock.mockReset().mockRejectedValue(new Error('Redirect was cancelled'));

    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', () => {});

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('cloud-not-ready');
      if (r.status === 'cloud-not-ready') {
        // 사용자에게 "왜 안 됐나" 정보 흘러감 — 다음 회귀 디버깅 시 즉시 좁힐 수 있음.
        expect(r.pollLastStatus).toBe(-1);
        expect(r.pollReason).toBe('fetch-error');
        expect(r.pollLastFetchError).toContain('Redirect was cancelled');
      }
    }
    fetchSpy.mockRestore();
  });

  it('redirect:\'follow\' 로 SP Doc.aspx 따라간 200 응답 → ready (sp-redirect 분기)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=z', true),
    );

    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', () => {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('ready');
    fetchSpy.mockRestore();
  });

  // 회귀 2026-05-08 #2 — "webview 떴는데 빈 워크북". cloud 가 6148-byte stub (Excel-for-Web
  // auto-save 손상 등 옛 corruption 의 잔존), local 진본은 25MB. 옛 동작은 SP HEAD 의 Doc.aspx
  // redirect 만 보고 sp-redirect=ready 로 trust → cloud stub 임을 모르고 webview 마운트 →
  // Excel-for-Web 이 stub WOPI fetch → 빈 워크북. 새 동작은 Range GET (bytes=0-3) 으로
  // Content-Range: 'bytes 0-3/<total>' 파싱 → cloud 의 진짜 size 가 expectedSize 와 mismatch
  // 시 stub 으로 판정 → cloud-not-ready 카드 노출.
  it('cloud 가 stub (6148 bytes) — local 진본 25MB 와 size mismatch → not ready (빈 워크북 회귀 방지)', async () => {
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 25_000_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(25), { status: 200 })); // 25 byte buf 라도 expectedSize 는 25_000_000 으로 전달됨
    statMock.mockRejectedValue(new Error('ENOENT'));
    // cloud Range GET 응답 — Content-Range: bytes 0-3/6148 (stub size!), body 는 valid ZIP magic.
    // ZIP magic 만 보면 통과해버리지만 size mismatch 감지로 stub 으로 판정.
    // mockImplementation 으로 매 attempt fresh Response (body 한 번만 consume 가능 회피).
    sessionFetchMock.mockReset().mockImplementation(() =>
      Promise.resolve(makeRangeResponse({
        status: 206,
        contentRange: 'bytes 0-3/6148',
        bodyBytes: [0x50, 0x4b, 0x03, 0x04],
      })),
    );

    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', () => {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('cloud-not-ready');
      if (r.status === 'cloud-not-ready') {
        // size-mismatch 가 사용자/Claude 에게 명확히 노출 — 다음 비슷한 보고에 즉시 진단.
        expect(r.pollReason).toBe('size-mismatch');
        // pollLastStatus 는 마지막 attempt 의 status (206)
        expect(r.pollLastStatus).toBe(206);
      }
    }
    fetchSpy.mockRestore();
  });

  it('Range GET status=200 + body=HTML (Doc.aspx fallback) → not ready', async () => {
    // SP 가 Range 요청을 무시하고 Doc.aspx HTML 로 fallback 한 경우. 옛 코드는 이걸 ready 로
    // 잘못 판정. 새 코드는 body head 가 ZIP magic 아니면 (HTML start `<`) not ready 처리.
    setupAccount();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ mtime_ms: 1_000_000, size: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(100), { status: 200 }));
    statMock.mockRejectedValue(new Error('ENOENT'));
    // mockImplementation — Response body 는 한 번만 consume 가능. 매 attempt 마다 fresh
    // Response 객체 만들어 polling 루프에서 arrayBuffer() 가 throw 안 나게.
    sessionFetchMock.mockReset().mockImplementation(() =>
      Promise.resolve(makeRangeResponse({
        status: 200,
        bodyBytes: [0x3c, 0x21, 0x44, 0x4f], // '<!DO' — HTML start
        finalUrl: 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx',
        redirected: true,
      })),
    );

    const r = await ensureFreshSync('http://127.0.0.1:9999', 'x', () => {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('cloud-not-ready');
      if (r.status === 'cloud-not-ready') {
        expect(r.pollReason).toBe('magic-mismatch');
      }
    }
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
      makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u_hybe_im/_layouts/15/Doc.aspx?sourcedoc=g', true),
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
      makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx?sourcedoc=z', true),
    );

    statMock.mockResolvedValue({ mtimeMs: 5_000_000, size: 1_000 } as never);
    const r = await uploadDepotFileAndUrl(
      '//main/ProjectK/Design/7_System/PK_HUD.xlsx',
      'C:/tmp/dep_xxx.xlsx',
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      // 0.1.52 — return shape: { ok:true, url, status:'ready' | 'cloud-not-ready', ... }.
      // depot URL 은 Klaud-depot 폴더 + // prefix 제거 + 확장자 떼고 다시 붙임 패턴.
      expect(r.status).toBe('ready');
      expect(r.url).toContain('Klaud-depot');
      expect(r.url).toContain('main/ProjectK/Design/7_System/PK_HUD.xlsx');
      expect(r.url).toContain('web=1'); // view 강제는 renderer 의 redirect intercept 에서
    }
    expect(sessionFetchMock).toHaveBeenCalled();
    expect(copyFileMock).toHaveBeenCalled(); // writeViaTempCopy 의 atomic copy
    // 0.1.51 — OneDrive Sync 친화로 mtime 건드리지 않음.
    expect(utimesMock).not.toHaveBeenCalled();
  });

  it('syncUploadAndUrl (legacy file picker) 도 폴링 사용 + mtime 동기화', async () => {
    setupAccount();
    sessionFetchMock.mockReset().mockResolvedValue(
      makeHeadResponse(200, 'https://t-my.sharepoint.com/personal/u/_layouts/15/Doc.aspx', true),
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
