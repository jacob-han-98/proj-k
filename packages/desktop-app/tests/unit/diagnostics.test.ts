import { describe, expect, it } from 'vitest';
import { runAllDiagnostics } from '../../src/renderer/diagnostics';

// runAllDiagnostics 가 받는 ProjkApi shape 의 minimal stub. 각 테스트마다 일부 필드만 채움.
// 어떤 메서드도 throw 해선 안 됨 — runAllDiagnostics 는 catch 로 graceful.

interface StubApiOpts {
  settings?: Record<string, unknown>;
  sidecarStatus?: { state: string; port?: number; pid?: number; message?: string } | null;
  sidecarHealth?: { ok: boolean; body?: unknown; error?: string };
  creds?: { email?: string; baseUrl?: string } | null;
  oneDrive?: { ok: boolean; account?: { email?: string } };
  p4?: { ok: boolean; source?: string; user?: string; client?: string };
  // /sheet_content probe — fetch 가 호출됨. status code 반환.
  sheetContentStatus?: number;
  sheetContentThrow?: boolean;
}

function stubApi(opts: StubApiOpts = {}) {
  return {
    getSettings: () => Promise.resolve(opts.settings ?? {}),
    getSidecarStatus: () => Promise.resolve(opts.sidecarStatus ?? { state: 'ready', port: 4530, pid: 1 }) as Promise<{ state: 'starting' | 'ready' | 'error'; port: number | null; pid: number | null; message?: string }>,
    getSidecarHealth: () => Promise.resolve(opts.sidecarHealth ?? { ok: true, body: { repo_root_exists: true, repo_root_listable: true, repo_root_resolved: '/mock/repo', repo_root_sample: ['a', 'b'], version: 'test' } }),
    getConfluenceCreds: () => Promise.resolve(opts.creds ?? null),
    oneDriveSync: { detect: () => Promise.resolve(opts.oneDrive ?? { ok: false }) },
    p4: { discover: () => Promise.resolve(opts.p4 ?? { ok: false }) },
  };
}

// fetch mock — sheet_content probe 만 처리.
function withFetchMock(status: number, throwIt = false) {
  const original = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = ((_url: string) => {
    if (throwIt) return Promise.reject(new Error('fetch boom'));
    return Promise.resolve({ ok: status >= 200 && status < 300, status } as Response);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe('runAllDiagnostics — happy path', () => {
  it('모든 항목 ok 인 경우', async () => {
    const restore = withFetchMock(404); // sheet_content: dir 있고 워크북 없음 = ok
    try {
      const r = await runAllDiagnostics(stubApi({
        settings: {
          repoRoot: '/mock/repo',
          p4WorkspaceRoot: 'D:\\ProjectK',
          updateFeedUrl: 'http://localhost:8766/',
          agentUrl: 'http://localhost:8090',
        },
        creds: { email: 'jacob@hybe.com', baseUrl: 'https://hybe.atlassian.net' },
        oneDrive: { ok: true, account: { email: 'jacob@hybe.com' } },
        p4: { ok: true, source: 'tickets', user: 'jacobh', client: 'jacobh_PC' },
      }));
      const ids = r.map((d) => d.id);
      expect(ids).toEqual([
        'sidecar', 'repo-root', 'p4-root', 'p4-cli',
        'xlsx-extractor', 'confluence', 'agent', 'update-feed', 'onedrive',
      ]);
      // 모두 ok
      expect(r.filter((d) => d.status === 'ok')).toHaveLength(9);
    } finally {
      restore();
    }
  });
});

describe('runAllDiagnostics — error/warn 분기', () => {
  it('repoRoot 미설정 — error + open-settings action', async () => {
    const restore = withFetchMock(503);
    try {
      const r = await runAllDiagnostics(stubApi({ settings: {} }));
      const repo = r.find((d) => d.id === 'repo-root')!;
      expect(repo.status).toBe('error');
      expect(repo.action?.kind).toBe('open-settings');
    } finally { restore(); }
  });

  it('repoRoot 설정됐는데 dir 없음 — error', async () => {
    const restore = withFetchMock(503);
    try {
      const r = await runAllDiagnostics(stubApi({
        settings: { repoRoot: '/no/such/path' },
        sidecarHealth: { ok: true, body: { repo_root_exists: false, repo_root_resolved: '/no/such/path' } },
      }));
      const repo = r.find((d) => d.id === 'repo-root')!;
      expect(repo.status).toBe('error');
      expect(repo.message).toContain('존재하지 않음');
    } finally { restore(); }
  });

  it('p4WorkspaceRoot 미설정 — warn (필수 X 라 warn)', async () => {
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(stubApi({ settings: { repoRoot: '/r' } }));
      const p4 = r.find((d) => d.id === 'p4-root')!;
      expect(p4.status).toBe('warn');
    } finally { restore(); }
  });

  it('agentUrl 미설정 — warn', async () => {
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(stubApi({ settings: { repoRoot: '/r' } }));
      const a = r.find((d) => d.id === 'agent')!;
      expect(a.status).toBe('warn');
      expect(a.action?.kind).toBe('open-settings');
    } finally { restore(); }
  });

  it('Confluence creds 미등록 — warn', async () => {
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(stubApi({ creds: null }));
      const c = r.find((d) => d.id === 'confluence')!;
      expect(c.status).toBe('warn');
    } finally { restore(); }
  });

  it('xlsx-extractor 503 — warn (output dir 없음)', async () => {
    const restore = withFetchMock(503);
    try {
      const r = await runAllDiagnostics(stubApi());
      const x = r.find((d) => d.id === 'xlsx-extractor')!;
      expect(x.status).toBe('warn');
    } finally { restore(); }
  });

  it('xlsx-extractor 404 — ok (dir 있고 probe 워크북만 없음)', async () => {
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(stubApi());
      const x = r.find((d) => d.id === 'xlsx-extractor')!;
      expect(x.status).toBe('ok');
    } finally { restore(); }
  });

  it('xlsx-extractor fetch throw — warn', async () => {
    const restore = withFetchMock(0, true);
    try {
      const r = await runAllDiagnostics(stubApi());
      const x = r.find((d) => d.id === 'xlsx-extractor')!;
      expect(x.status).toBe('warn');
      expect(x.message).toContain('probe 실패');
    } finally { restore(); }
  });

  it('OneDrive 미감지 — warn + detect-onedrive action', async () => {
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(stubApi({ oneDrive: { ok: false } }));
      const o = r.find((d) => d.id === 'onedrive')!;
      expect(o.status).toBe('warn');
      expect(o.action?.kind).toBe('detect-onedrive');
    } finally { restore(); }
  });

  it('p4 discover 실패 — warn + discover-p4 action', async () => {
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(stubApi({ p4: { ok: false } }));
      const p = r.find((d) => d.id === 'p4-cli')!;
      expect(p.status).toBe('warn');
      expect(p.action?.kind).toBe('discover-p4');
    } finally { restore(); }
  });

  it('sidecar 미준비 (state=error) — error', async () => {
    const restore = withFetchMock(503);
    try {
      const r = await runAllDiagnostics(stubApi({
        sidecarStatus: { state: 'error', port: undefined, pid: undefined, message: 'spawn 실패' },
      }));
      const s = r.find((d) => d.id === 'sidecar')!;
      expect(s.status).toBe('error');
      expect(s.message).toContain('spawn 실패');
    } finally { restore(); }
  });
});

describe('runAllDiagnostics — robustness', () => {
  it('한 메서드가 throw 해도 다른 검사 정상 수행', async () => {
    const api = {
      getSettings: () => Promise.reject(new Error('settings boom')),
      getSidecarStatus: () => Promise.resolve({ state: 'ready' as const, port: 4530, pid: 1 }),
      getSidecarHealth: () => Promise.resolve({ ok: true, body: { repo_root_exists: true, repo_root_listable: true } }),
      getConfluenceCreds: () => Promise.resolve(null),
      oneDriveSync: { detect: () => Promise.resolve({ ok: false }) },
      p4: { discover: () => Promise.resolve({ ok: false }) },
    };
    const restore = withFetchMock(404);
    try {
      const r = await runAllDiagnostics(api);
      // settings throw 해도 9 항목 모두 결과 반환
      expect(r).toHaveLength(9);
      const repo = r.find((d) => d.id === 'repo-root')!;
      // settings 빈 object 로 처리 — repoRoot 미설정 = error
      expect(repo.status).toBe('error');
    } finally { restore(); }
  });
});
