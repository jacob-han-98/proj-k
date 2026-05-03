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
    if (url.includes('/quick_find')) {
      // PR10: Quick Find sidecar proxy 가 NDJSON 으로 hits + result yield. mock 은 단순.
      // 주의: 이 함수는 template literal 안 — 브라우저 컨텍스트에서 JS 로 실행되니
      // TypeScript 캐스트 (\`as string\`) 사용 X. plain JS 만.
      const body = init && init.body ? JSON.parse(init.body) : {};
      const fast = !!body.fast;
      const lines = [
        { type: 'status', message: fast ? '⚡ L1 only' : '📚 auto v2.1' },
        { type: 'hit', data: {
          doc_id: 'xlsx::PK_HUD::HUD_기본',
          type: 'xlsx',
          title: 'HUD_기본',
          path: '7_System / PK_HUD / HUD_기본',
          workbook: 'PK_HUD',
          summary: 'HUD 기본 레이아웃',
          score: 0.92,
          matched_via: 'title_exact',
          rank: 1,
          content_md_path: '/mock/xlsx/PK_HUD/HUD_기본.md',
          source: 'l1',
        } },
        { type: 'hit', data: {
          doc_id: 'conf::Design/HUD-개편',
          type: 'confluence',
          title: 'HUD 개편안',
          path: 'Design / 시스템 디자인 / HUD',
          space: 'Design',
          summary: '신규 HUD 시안 검토',
          score: 0.74,
          matched_via: 'vector_cosine',
          rank: 2,
          content_md_path: '/mock/conf/HUD-개편.md',
          source: fast ? 'l1' : 'vector',
        } },
        { type: 'result', data: { total: 2, latency_ms: fast ? 48 : 312, strategy: fast ? 'l1' : 'auto_v2', expanded: false } },
      ];
      const ndjson = lines.map((l) => JSON.stringify(l) + '\\n').join('');
      return new Response(ndjson, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    if (url.includes('/sheet_content')) {
      // B3: 워크북 sheet content 들 — LocalSheetView 의 리뷰 버튼이 호출.
      // 실제 sidecar 는 relPath 의 basename = 워크북. mock 의 fakeP4Tree 는 옛 tree shape
      // (sheet 노드까지 relPath 에 포함) 라 PK_HUD 가 들어있는 어떤 path 든 워크북으로 매칭.
      const u = new URL(url);
      const relPath = u.searchParams.get('relPath') ?? '';
      if (relPath.includes('PK_HUD')) {
        return new Response(JSON.stringify({
          workbook: 'PK_HUD 시스템',
          source_dir: '/mock/xlsx-extractor/output/PK_HUD 시스템',
          sheets: [
            { name: 'HUD_기본', content: '# HUD_기본\\n\\n레이아웃 ...', char_count: 24, truncated: false },
            { name: 'HUD_전투', content: '# HUD_전투\\n\\n전투 HUD ...', char_count: 22, truncated: false },
          ],
          total_chars: 46,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }
    if (url.includes('/source_view')) {
      // A3-b: citation drill-down. mock 답변에 (출처: PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃)
      // 가 들어있으니 그 path 가 들어오면 fixture content 반환. 다른 path 는 404 같은 null.
      const u = new URL(url);
      const path = u.searchParams.get('path') ?? '';
      const section = u.searchParams.get('section') ?? '';
      if (path.includes('PK_HUD') || path.includes('HUD_기본')) {
        return new Response(JSON.stringify({
          path,
          section,
          content: '# HUD_기본\\n\\n## 레이아웃\\n\\n상단 정보바 + 좌측 미니맵. mock content 본문.',
          section_range: section ? [10, 50] : null,
          origin_label: 'P4 / 7_System / PK_HUD 시스템.xlsx',
          source: 'mock',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }
    if (url.includes('/preset_prompts')) {
      // A3-a: agent-sdk-poc 의 PRESETS 형식 동등. 카테고리 별 mock — chips UI 검증.
      return new Response(JSON.stringify({
        presets: [
          { label: '변신 시스템 정리', prompt: '변신 시스템의 목적을 정리해줘.', category: 'system' },
          { label: '스킬 시스템 설명', prompt: '스킬 시스템을 설명해줘.', category: 'system' },
          { label: 'HUD 경험치/골드 최대값', prompt: 'HUD 의 최대값은?', category: 'spec' },
          { label: '7_System 시스템 목록', prompt: '7_System 폴더에 어떤 기획서가 있나?', category: 'overview' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/ask_stream')) {
      // agent-sdk-poc (2026-05) 신규 schema: token={text}, result={data:{answer}}.
      // Klaud 의 readToken/readResultData 가 양쪽 받지만 mock 은 신규 schema 따라가
      // 실제 backend 와 동일한 contract 검증.
      const finalAnswer = 'HUD 의 기본 레이아웃은 ① 상단 정보바, ② 좌측 미니맵으로 구성됩니다 (출처: PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃).';
      const body = [
        { type: 'status', message: 'mock 시작' },
        { type: 'stage', stage: 'writing', label: '답변 작성' },
        { type: 'token', text: 'HUD 의 ' },
        { type: 'token', text: '기본 레이아웃은 ' },
        { type: 'token', text: '... ' },
        { type: 'result', data: { answer: finalAnswer } },
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

  // 0.1.50 (Step 1+2) — onedrive-sync 테스트 helper.
  // window.__setEnsureFreshResponse({ ok:true, url:'...', alreadyFresh:false, syncing:true }) 로
  // 다음 ensureFresh 호출 응답을 갈아끼움. window.__pushSyncProgress({relPath, state, error}) 로
  // main → renderer 의 progress 이벤트를 흉내냄 (LocalSheetView 가 webview reload 또는 indicator 갱신).
  window.__setEnsureFreshResponse = (r) => { window.__ensureFreshResponse = r; };
  window.__pushSyncProgress = (ev) => {
    (window.__syncProgressListeners ?? []).forEach((cb) => cb(ev));
  };
  window.__getLastEnsureFreshRelPath = () => window.__lastEnsureFreshRelPath ?? null;

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

    // Frameless window controls (TitleBar 가 호출). Playwright 환경에선 no-op.
    win: {
      minimize: () => Promise.resolve(),
      maximizeToggle: () => Promise.resolve(false),
      close: () => Promise.resolve(),
      isMaximized: () => Promise.resolve(false),
      onMaximizedChange: () => () => {},
    },

    // OneDrive PoC 2B stubs (0.1.45 PKCE) — admin consent 막혀 미사용. legacy stub 만 유지.
    oneDrive: {
      status: () => Promise.resolve({ authenticated: false, pollState: 'idle', pollError: null, challenge: null }),
      authStart: () => Promise.resolve({ ok: false, error: 'mock — Playwright 환경' }),
      authClear: () => Promise.resolve({ ok: true }),
      uploadLocal: () => Promise.resolve({ ok: false, canceled: true }),
    },

    // OneDrive Sync 우회 (PoC 2C — 0.1.46+) — Playwright 에서는 detect false (Linux 환경).
    // 0.1.49 — userUrl 추가 (URL 빌드용 personal site URL).
    // 0.1.50 — 테스트가 ensureFresh 응답과 progress 이벤트를 동적으로 제어할 수 있도록 hook 추가.
    oneDriveSync: {
      detect: () => Promise.resolve({ ok: false }),
      upload: () => Promise.resolve({ ok: false, canceled: true }),
      auto: () => Promise.resolve({ ok: false, error: 'mock — Playwright 환경' }),
      // 기본은 ok:false (fallback flow 검증). window.__setEnsureFreshResponse(r) 로 테스트별 override.
      ensureFresh: (relPath) => {
        const r = window.__ensureFreshResponse ?? { ok: false, error: 'mock — Playwright 환경' };
        window.__lastEnsureFreshRelPath = relPath;
        return Promise.resolve(r);
      },
      onProgress: (cb) => {
        window.__syncProgressListeners = window.__syncProgressListeners ?? [];
        window.__syncProgressListeners.push(cb);
        return () => {
          const arr = window.__syncProgressListeners ?? [];
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },

    // B2-3a: ChangesCard Apply 흐름 — 테스트에서 어떤 items 가 들어왔는지 검증할 수 있게
    // window.__lastApplyArgs 에 capture. 실제 PUT 안 하고 ok response.
    confluenceApplyEdits: (pageId, items) => {
      window.__lastApplyArgs = { pageId, items };
      return Promise.resolve({ ok: true, applied: items.length, skipped: 0, skippedIds: [], pageUrl: '' });
    },

    // B2-1: 사본 mock — 새 page id 즉시 반환.
    confluenceCopyToTest: (sourcePageId) =>
      Promise.resolve({ ok: true, newPageId: 'mock-copy-' + sourcePageId, newPageUrl: 'https://mock/copy', newTitle: 'mock copy', spaceKey: 'PKTEST' }),

    // B2-3b: 사전 매칭 체크 mock — 모두 matched (테스트가 unmatched 시나리오 원할 시 override).
    confluencePrecheckMatch: (_pageId, items) =>
      Promise.resolve({ ok: true, matched: items.map((i) => i.id), unmatched: [] }),

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
      // 트리 표시용 — mock 은 빈 캐시.
      cachedPaths: () => Promise.resolve([]),
      // PR9c: depot 파일 보기 (p4 print → OneDrive read-only). mock 은 즉시 fake URL.
      openDepotFile: (depotPath) =>
        Promise.resolve({
          ok: true,
          url:
            'https://example.sharepoint.com/personal/mock_user/Documents/Klaud-depot/' +
            encodeURIComponent(depotPath.replace(/^\\/\\//, '')) +
            '.xlsx?web=1&action=view',
          revision: 42,
          fromCache: false,
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
