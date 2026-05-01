// Reusable mock for window.projk used by Playwright via addInitScript.
//
// Note: this script is serialized to a string by Playwright and executed inside
// the page before any other script — so it must be self-contained and refer
// only to the page's globals. No imports.

export const mockProjkInitScript = `
(function () {
  const fakeP4Tree = {
    nodes: [
      {
        id: 'cat:7_System',
        type: 'category',
        title: '7_System',
        children: [
          {
            id: 'workbook:7_System/PK_HUD 시스템',
            type: 'workbook',
            title: 'PK_HUD 시스템',
            relPath: '7_System/PK_HUD 시스템',
            children: [
              {
                id: 'sheet:7_System/PK_HUD 시스템/HUD_기본',
                type: 'sheet',
                title: 'HUD_기본',
                relPath: '7_System/PK_HUD 시스템/HUD_기본',
              },
              {
                id: 'sheet:7_System/PK_HUD 시스템/HUD_전투',
                type: 'sheet',
                title: 'HUD_전투',
                relPath: '7_System/PK_HUD 시스템/HUD_전투',
              },
            ],
          },
        ],
      },
    ],
    rootDir: '/mock/xlsx',
    loadedAt: Date.now(),
  };

  const fakeConfluenceTree = {
    nodes: [
      {
        id: 'confluence:1',
        type: 'page',
        title: 'Design',
        confluencePageId: '1',
        relPath: 'Design',
        children: [
          {
            id: 'confluence:2',
            type: 'folder',
            title: '시스템 디자인',
            confluencePageId: '2',
            relPath: 'Design/시스템 디자인',
            children: [
              {
                id: 'confluence:3',
                type: 'page',
                title: '전투',
                confluencePageId: '3',
                relPath: 'Design/시스템 디자인/전투',
              },
            ],
          },
        ],
      },
    ],
    rootDir: '/mock/confluence',
    loadedAt: Date.now(),
  };

  const sidecarStatus = { state: 'ready', port: 4530, pid: 9999 };
  const statusListeners = [];

  // Stub the search/ask endpoints by intercepting fetch to 127.0.0.1:<port>.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/search_docs')) {
      return new Response(JSON.stringify({
        results: [
          {
            type: 'xlsx',
            doc_id: 'PK_HUD 시스템',
            title: 'PK_HUD 시스템',
            path: '7_System / PK_HUD 시스템',
            snippet: 'HUD 기본 레이아웃 및 요소 배치',
            matched_sheets: ['HUD_기본'],
            score: 0.91,
            source: 'vector',
          },
          {
            type: 'confluence',
            doc_id: 'design/hud-改편',
            title: 'HUD 개편안',
            path: 'Design / 시스템 디자인 / HUD',
            url: 'https://example.atlassian.net/wiki/x/HUD',
            snippet: '신규 HUD 시안 검토',
            score: 0.78,
            source: 'fulltext',
          },
        ],
        took_ms: 42,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/ask_stream')) {
      // 답변 안에 (출처: ...) 패턴을 넣어 인용 매칭 동작을 검증할 수 있게 한다.
      const finalAnswer = 'HUD 의 기본 레이아웃은 ① 상단 정보바, ② 좌측 미니맵으로 구성됩니다 (출처: PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃).';
      const body = [
        { type: 'status', payload: 'mock 시작' },
        { type: 'token', payload: 'HUD 의 ' },
        { type: 'token', payload: '기본 레이아웃은 ' },
        { type: 'token', payload: '... ' },
        { type: 'result', payload: { answer: finalAnswer } },
      ].map((e) => JSON.stringify(e) + '\\n').join('');
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    return realFetch(input, init);
  };

  // Updater 상태 — 기본 idle. 테스트가 window.__pushUpdaterState 로 변경 가능.
  let updaterState = { state: 'idle' };
  const updaterListeners = [];
  window.__pushUpdaterState = (s) => {
    updaterState = s;
    updaterListeners.forEach((l) => l(s));
  };

  // App settings (in-memory). 기본은 "이미 한 번 설정 마쳐서 자동 모달이 안 뜨는 상태".
  // 첫 부팅 시나리오를 검증하려는 테스트는 window.__resetSettings() 호출 후 page.goto.
  let storedSettings = {
    repoRoot: '/mock/preset-root',
    updateFeedUrl: 'http://localhost:8766/',
    retrieverUrl: 'http://localhost:8088',
    agentUrl: 'http://localhost:8090',
  };
  window.__getStoredSettings = () => storedSettings;
  window.__resetSettings = () => { storedSettings = {}; };

  window.projk = {
    getP4Tree: () => Promise.resolve(fakeP4Tree),
    getConfluenceTree: () => Promise.resolve(fakeConfluenceTree),
    refreshTrees: () => Promise.resolve({ p4: fakeP4Tree, confluence: fakeConfluenceTree }),
    getSidecarStatus: () => Promise.resolve(sidecarStatus),
    getSidecarHealth: () => Promise.resolve({ ok: true, body: { status: 'ok', repo_root_listable: true } }),
    onSidecarStatus: (cb) => {
      statusListeners.push(cb);
      cb(sidecarStatus);
      return () => {
        const idx = statusListeners.indexOf(cb);
        if (idx >= 0) statusListeners.splice(idx, 1);
      };
    },
    getConfluenceCreds: () => Promise.resolve(null),
    setConfluenceCreds: () => Promise.resolve({ ok: true }),
    getUpdaterState: () => Promise.resolve({ state: updaterState, lastCheckedAt: null }),
    onUpdaterState: (cb) => {
      updaterListeners.push(cb);
      cb(updaterState);
      return () => {
        const idx = updaterListeners.indexOf(cb);
        if (idx >= 0) updaterListeners.splice(idx, 1);
      };
    },
    checkForUpdate: () => {
      window.__manualCheckCalled = (window.__manualCheckCalled ?? 0) + 1;
      return Promise.resolve({ ok: true, lastCheckedAt: Date.now() });
    },
    quitAndInstall: () => {
      window.__quitAndInstallCalled = true;
      return Promise.resolve({ ok: true });
    },
    getSettings: () => Promise.resolve(storedSettings),
    setSettings: (patch) => {
      storedSettings = { ...storedSettings, ...patch };
      // mock 동작: undefined/'' 키는 제거 (실제 main 동작과 동일)
      for (const k of Object.keys(patch)) {
        if (patch[k] == null || patch[k] === '') delete storedSettings[k];
      }
      return Promise.resolve(storedSettings);
    },

    // mcp-bridge IPC — Playwright 환경에서는 main 이 cmd 를 보내지 않으므로 no-op.
    // 단순히 hook 등록해도 깨지지 않도록 빈 구현 노출.
    onMcpCommand: () => () => {},
    mcpReply: () => {},

    // OneDrive PoC 2B stubs (0.1.45 PKCE) — admin consent 막혀 미사용. legacy stub 만 유지.
    oneDrive: {
      status: () => Promise.resolve({ authenticated: false, pollState: 'idle', pollError: null, challenge: null }),
      authStart: () => Promise.resolve({ ok: false, error: 'mock — Playwright 환경' }),
      authClear: () => Promise.resolve({ ok: true }),
      uploadLocal: () => Promise.resolve({ ok: false, canceled: true }),
    },

    // OneDrive Sync 우회 (PoC 2C — 0.1.46+) — Playwright 에서는 detect false (Linux 환경).
    // 0.1.49 — userUrl 추가 (URL 빌드용 personal site URL).
    oneDriveSync: {
      detect: () => Promise.resolve({ ok: false }),
      upload: () => Promise.resolve({ ok: false, canceled: true }),
      auto: () => Promise.resolve({ ok: false, error: 'mock — Playwright 환경' }),
    },

    // PR9: P4 자동 발견 + depot 트리 lazy fetch. Playwright mock 은 sample 데이터로 동작.
    p4: {
      discover: () => Promise.resolve({
        ok: true,
        source: 'tickets',
        host: 'mockperforce:1666',
        user: 'mockuser',
        client: 'mockuser_JACOB-D',
        clientRoot: 'D:\\\\ProjectK',
        candidates: ['mockuser_JACOB-D', 'mockuser_LAPTOP'],
      }),
      depotRoots: () => Promise.resolve({
        ok: true,
        entries: [
          { path: '//depot', name: 'depot', kind: 'depot' },
          { path: '//archive', name: 'archive', kind: 'depot' },
        ],
      }),
      depotDirs: (parentPath) => {
        // 단순 mock: //depot 의 자식은 폴더 1개 + .xlsx 1개. 그 외 path 는 빈 폴더.
        if (parentPath === '//depot') {
          return Promise.resolve({
            ok: true,
            entries: [
              { path: '//depot/Design', name: 'Design', kind: 'dir' },
              { path: '//depot/HUD.xlsx', name: 'HUD.xlsx', kind: 'file' },
            ],
          });
        }
        if (parentPath === '//depot/Design') {
          return Promise.resolve({
            ok: true,
            entries: [
              { path: '//depot/Design/Combat.xlsx', name: 'Combat.xlsx', kind: 'file' },
            ],
          });
        }
        return Promise.resolve({ ok: true, entries: [] });
      },
    },

    // Threads workspace stub — in-memory.
    threads: (() => {
      const mem = { threads: [], messages: [], citations: {}, docs: [] };
      return {
        list: () => Promise.resolve([]),
        create: (p) => Promise.resolve({ id: p.id, title: p.title, created_at: 0, updated_at: 0, archived: 0 }),
        get: () => Promise.resolve(null),
        rename: () => Promise.resolve({ ok: true }),
        archive: () => Promise.resolve({ ok: true }),
        delete: () => Promise.resolve({ ok: true }),
        appendMessage: (m) => Promise.resolve({ ...m, created_at: 0, meta_json: m.meta_json ?? null }),
        upsertDoc: (d) => Promise.resolve({ ...d, added_at: 0 }),
        pinDoc: () => Promise.resolve({ ok: true }),
        _mem: mem,
      };
    })(),
  };
})();
`;
