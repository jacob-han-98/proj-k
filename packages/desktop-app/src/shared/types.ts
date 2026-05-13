// Shared types between main, preload, and renderer.
// Keep this file dependency-free so it can be imported from any side of the IPC bridge.

export type DocType = 'xlsx' | 'confluence';

export interface TreeNode {
  id: string;
  type: 'category' | 'workbook' | 'sheet' | 'space' | 'page' | 'folder';
  title: string;
  children?: TreeNode[];
  // For 'sheet' nodes: relative path under xlsx-extractor/output/
  // For 'page' nodes: relative path under confluence-downloader/output/
  relPath?: string;
  // For 'page' nodes: Confluence page ID (used to construct live URLs)
  confluencePageId?: string;
  // Workbook source xlsx path under repo (for "Open in Excel")
  xlsxRepoPath?: string;
  // PR9c: depot 파일을 webview 로 열 때 직접 사용하는 OneDrive 임베드 URL.
  // 일반 sheet 노드는 비어있고 sheetMappings 룩업으로 처리. depot 임시 노드는 fetch 후 채워짐.
  oneDriveUrl?: string;
  // Quick Find 시트 클릭 흐름에서 사용 — 워크북 안의 특정 시트로 점프할 시트명.
  // 빌더가 SharePoint URL 에 `&activeCell='<sheetName>'!A1` 부착해서 Excel for the Web 이
  // 그 시트 탭으로 자동 활성화하게 함. 비어있으면 워크북 첫 시트 (default 동작).
  sheetName?: string;
}

export interface P4TreeResult {
  nodes: TreeNode[];
  rootDir: string;
  loadedAt: number;
  // 사이드카가 빈 결과를 돌려줄 때 어디서 막혔는지 진단용. 정상 결과에는 null/undefined.
  debug?: unknown;
}

// PR9: p4tickets.txt + p4 login -s + p4 clients 조합으로 main process 가 자동 발견한
// Perforce 좌표. 사용자가 SettingsModal 에서 "자동 발견" 누르면 이 값을 주는 form 으로 채움.
export interface P4DiscoveryInfo {
  ok: boolean;
  // 어디까지 발견됐는지 — UI 가 진단 메시지를 보여줄 수 있게.
  source: 'registry' | 'tickets' | 'manual' | 'none';
  host?: string; // P4PORT (예: 'perforce:1666')
  user?: string; // P4USER
  client?: string; // P4CLIENT — host 매칭하는 첫 client
  clientRoot?: string; // p4 info 의 Client root
  candidates?: string[]; // host 매칭 실패 시 사용자가 고를 수 있는 client 후보
  diagnostics?: string; // 실패 시 한 줄 안내 (사용자 읽기 좋게)
}

// PR9b: depot 트리의 한 노드. lazy fetch — 폴더(depot/dir)는 expand 시점에 자식 fetch.
// 보기 전용. 파일 클릭은 안내만 (편집은 별도 P4 checkout 흐름).
export interface P4DepotEntry {
  // 전체 depot path. 예: '//depot' (root) / '//depot/main/Design' / '//depot/main/Design/HUD.xlsx'
  path: string;
  // path 의 마지막 segment — 트리에 표시.
  name: string;
  kind: 'depot' | 'dir' | 'file';
}

export interface P4DepotResult {
  ok: boolean;
  entries: P4DepotEntry[];
  // 실패 시 사용자에게 한 줄 안내 (좌표 미설정, ticket 만료 등).
  diagnostics?: string;
}

// 0.1.52 — depot 파일 보기. p4 print → OneDrive 업로드 → cloud verify-poll → URL.
// 옛 revision/fromCache 필드는 manifest cache 와 함께 제거.
export interface P4DepotOpenResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export interface ConfluenceTreeResult {
  nodes: TreeNode[];
  rootDir: string;
  loadedAt: number;
  debug?: unknown;
}

export interface ConfluenceCreds {
  email: string;
  apiToken: string;
  baseUrl: string; // e.g. https://bighitcorp.atlassian.net
}

export interface SidecarStatus {
  state: 'starting' | 'ready' | 'error' | 'stopped';
  port: number | null;
  pid: number | null;
  message?: string;
}

export type UpdaterState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'downloading'; percent: number; bytesPerSecond: number }
  | { state: 'ready'; version: string; releaseNotes?: string }
  | { state: 'not-available'; current: string }
  | { state: 'error'; message: string };

// PR10: Quick Find — 사이드바의 "빠른 검색" 패널이 사용. agent-sdk-poc /quick_find 가
// NDJSON 스트림으로 yield 하는 hit 의 shape (backend 의 contract 메시지 20260501-163017
// 에 정의된 그대로). source 필드로 UI 배지 분기:
//   - "l1": ⚡ 키워드 매칭 (가장 정확)
//   - "vector": 🧬 의미 검색
//   - "expand": 🔮 동의어 확장 (Phase 3 발동 시)
// 백엔드 fold (2026-05-06, commit c3cbb23) 이후 xlsx 워크북 hit 안에 매칭된 시트들.
// score desc 정렬. 시트 doc_id 는 원형 "xlsx::<workbook>::<sheet>" 보존.
export interface MatchedSheet {
  sheet: string;
  doc_id: string;
  title?: string;
  summary?: string;
  score?: number;
  matched_via?: string;
  source?: 'l1' | 'vector' | 'expand';
  content_md_path?: string;
}

export interface QuickFindHit {
  // 백엔드 fold 이후 xlsx 는 "xlsx::<workbook>" (시트 부분 빠짐), confluence 는 "conf::<path>".
  // 시트 단위 doc_id 는 matched_sheets[] 안에서 보존됨.
  doc_id: string;
  type: 'xlsx' | 'confluence';
  title: string;
  path: string; // 표시용 경로
  workbook?: string | null;
  space?: string | null;
  summary: string; // 한 줄 설명
  score: number;
  matched_via: string;
  rank: number;
  content_md_path: string; // 본문 경로
  source: 'l1' | 'vector' | 'expand';
  // 백엔드가 워크북 단위로 fold 한 hit 에 한해 등장. 워크북 안에서 매칭된 시트들.
  matched_sheets?: MatchedSheet[];
  // backend (commit f991367) 가 confluence hit 에 numeric Confluence pageId 직접 부착.
  // ConfluencePage open URL (`viewpage.action?pageId=<numeric>`) 빌드용. xlsx hit 엔 없음.
  // 일부 manifest 매칭 실패 시 None — frontend 는 그 경우 sidecar tree lookup fallback.
  confluence_page_id?: string | null;
}

export interface QuickFindResult {
  total: number;
  latency_ms: number;
  // backend 디버그 정보 (UI 직접 의존 X — 단순 표시용).
  strategy?: string;
  expanded?: boolean;
  expanded_keywords?: string[];
}

export interface SearchHit {
  type: DocType;
  doc_id: string;
  title: string;
  path: string;
  url?: string;
  local_path?: string;
  snippet: string;
  matched_sheets?: string[];
  score: number;
  source: 'vector' | 'fulltext' | 'kg' | 'structural';
  // 렌더러 측 상태 — 답변 스트림 중 인용 출처와 매칭되면 true.
  // 백엔드는 절대 채우지 않는다.
  cited?: boolean;
}

export interface SearchResponse {
  results: SearchHit[];
  took_ms: number;
}

// IPC channel names — single source of truth.
export const IPC = {
  TREE_P4: 'tree:p4',
  TREE_CONFLUENCE: 'tree:confluence',
  TREE_REFRESH: 'tree:refresh',
  SIDECAR_STATUS: 'sidecar:status',
  SIDECAR_PORT: 'sidecar:port',
  SIDECAR_HEALTH: 'sidecar:health',
  CONFLUENCE_CREDS_GET: 'confluence:creds:get',
  CONFLUENCE_CREDS_SET: 'confluence:creds:set',
  CONFLUENCE_APPLY_EDITS: 'confluence:apply-edits',
  CONFLUENCE_COPY_TO_TEST: 'confluence:copy-to-test',
  CONFLUENCE_PRECHECK_MATCH: 'confluence:precheck-match',
  EXCEL_OPEN: 'excel:open',
  P4_SYNC: 'p4:sync',
  P4_DISCOVER: 'p4:discover',
  P4_DEPOT_LIST: 'p4:depot-list',
  P4_DEPOT_DIRS: 'p4:depot-dirs',
  P4_DEPOT_OPEN: 'p4:depot-open',
  // 액티비티 바 5번 ("내 작업 중 문서") — 30s 폴링.
  ACTIVE_DOCS_P4: 'active-docs:p4',
  ACTIVE_DOCS_CONFLUENCE: 'active-docs:confluence',
  UPDATER_STATE: 'updater:state',
  UPDATER_CHECK: 'updater:check',
  UPDATER_QUIT_AND_INSTALL: 'updater:quit-and-install',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // OneDrive / Microsoft Graph (PoC 2B — 0.1.44~0.1.45, admin consent 막혀 미사용).
  ONEDRIVE_STATUS: 'onedrive:status',
  ONEDRIVE_AUTH_START: 'onedrive:auth-start',
  ONEDRIVE_AUTH_POLL: 'onedrive:auth-poll',
  ONEDRIVE_AUTH_CLEAR: 'onedrive:auth-clear',
  ONEDRIVE_UPLOAD_LOCAL: 'onedrive:upload-local',
  // OneDrive Sync 클라이언트 우회 (PoC 2C — 0.1.46+).
  // Microsoft first-party Sync 가 file 을 클라우드로 자동 upload + 본인용 SharePoint
  // URL (?web=1) 로 webview 임베드 (사내 SSO 자동). admin consent 불필요.
  ONEDRIVE_SYNC_DETECT: 'onedrive-sync:detect',
  ONEDRIVE_SYNC_UPLOAD: 'onedrive-sync:upload',
  // 0.1.47 — 사용자 클릭 0회. sidecar /xlsx_raw 에서 P4 원본 자동 fetch.
  ONEDRIVE_SYNC_AUTO: 'onedrive-sync:auto',
  // 0.1.50 (Step 1+2) — 매 sheet 클릭 시 호출. P4 src vs OneDrive dest 의 mtime 비교 →
  // stale 이면 백그라운드 sync 시작 + 즉시 URL 반환. fresh 면 그냥 URL 반환. 사용자 체감
  // "두 번째부터는 즉시 webview 열림 + 자동 최신화". 진행상황은 ONEDRIVE_SYNC_PROGRESS 로 push.
  ONEDRIVE_SYNC_ENSURE_FRESH: 'onedrive-sync:ensure-fresh',
  // main → renderer push. 백그라운드 sync 의 시작/완료/실패/cloud-not-ready 통지.
  // renderer 가 자기 webview 의 relPath 와 매칭되면 reload / 에러 카드 swap 수행.
  ONEDRIVE_SYNC_PROGRESS: 'onedrive-sync:progress',
  // 0.1.51 — 사용자가 cloud-not-ready 카드의 "재시도" 누르면 호출. 재업로드 없이 SharePoint
  // HEAD 폴링만 다시 한 번. cloud-side 처리가 끝났으면 ready:true → renderer 가 webview 마운트.
  ONEDRIVE_SYNC_REPOLL: 'onedrive-sync:repoll',
  // Threads workspace (Phase 3 — 0.1.30+).
  THREADS_LIST: 'threads:list',
  THREADS_CREATE: 'threads:create',
  THREADS_GET: 'threads:get',
  THREADS_RENAME: 'threads:rename',
  THREADS_ARCHIVE: 'threads:archive',
  THREADS_DELETE: 'threads:delete',
  THREADS_APPEND_MESSAGE: 'threads:append-message',
  THREADS_UPSERT_DOC: 'threads:upsert-doc',
  THREADS_PIN_DOC: 'threads:pin-doc',
  // main → renderer push: webview 가 focus 잡고 있어도 우리 앱 단축키 (Ctrl+P /
  // Ctrl+1~5) 가 우선해야. main 의 webContents.before-input-event 에서 가로채 이리로
  // forward → renderer 가 togglePalette / setActiveIcon 수행.
  SHORTCUT_TRIGGER: 'shortcut:trigger',
  // frameless window 컨트롤 — 우상단 min/max/close 버튼이 호출.
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximize-toggle',
  WINDOW_CLOSE: 'window:close',
  // main → renderer broadcast: 창이 maximize 됐는지. 아이콘 swap 용.
  WINDOW_MAXIMIZED: 'window:maximized',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  // PoC 0.1.53 — OnlyOffice 임베드 viewer 준비. main 이 WSL 의 serve.py 를 spawn/restart 후
  // 임베드 HTML URL 반환. 매 sheet 클릭 시 호출 (현재는 동시 1 sheet 만 지원 — serve.py 단일 인스턴스).
  ONLYOFFICE_PREPARE: 'onlyoffice:prepare',
  // 2026-05-13 릴리스-A2: Klaud 통합 로그 sink + 제보.
  // - KLAUD_LOG_PUSH: renderer 가 자신의 console / window.error / unhandledrejection 을 main 에 push.
  //   main 이 ring buffer + 파일 누적 + (설정되면) backend POST.
  // - KLAUD_REPORT_SUBMIT: 제보 버튼 클릭 시 사용자 노트 + 현재 컨텍스트 → main → backend.
  KLAUD_LOG_PUSH: 'klaud:log:push',
  KLAUD_REPORT_SUBMIT: 'klaud:report:submit',
  // 제보 모달에서 첨부 체크 시 main 이 mainWindow.webContents.capturePage() 로 PNG 캡처
  // → 1MB 이하면 base64 반환, 초과면 빈 문자열 반환 (frontend 가 silent skip).
  KLAUD_CAPTURE_SCREENSHOT: 'klaud:capture-screenshot',
  // 2026-05-13 릴리스-B: Google Workspace SSO.
  // GOOGLE_AUTH_START: SettingsModal 의 "Google 로그인" 버튼이 호출. main 이 PKCE flow
  //   진행 (loopback 서버 + BrowserWindow). 성공/실패 reason 반환.
  // GOOGLE_CREDS_GET: GoogleCredsInfo (email/name/picture/hasToken, 토큰 자체는 X).
  // GOOGLE_SIGN_OUT: 저장된 token 파일을 비움. renderer 가 confirm 후 호출.
  GOOGLE_AUTH_START: 'google:auth:start',
  GOOGLE_CREDS_GET: 'google:creds:get',
  GOOGLE_SIGN_OUT: 'google:sign-out',
} as const;

// 2026-05-13 릴리스-B: renderer 에 노출되는 Google 자격 메타. 토큰 자체는 main 전용.
export interface GoogleCredsInfoView {
  email: string;
  name?: string;
  picture?: string;
  hd?: string;
  hasToken: boolean;
  expiresInSeconds: number;
}

// main → renderer 단축키 forward payload. webview 안에서 발생한 키도 우리 앱 단축키면
// main 이 가로채 동일하게 동작시키기 위해. Ctrl+P / Ctrl+1~5 만 (현재 사용 중인 글로벌
// 단축키와 동일 — 새 단축키 추가 시 이 union 도 같이 확장).
export type ShortcutEvent =
  | { name: 'command-palette' }
  | { name: 'activity-bar'; digit: '1' | '2' | '3' | '4' | '5' };

// 2026-05-13 릴리스-A2: Klaud 통합 로그 sink 의 엔트리 shape.
// renderer 의 console / window.error / unhandledrejection / 명시 호출이 모두 이 형태로 push.
// main 의 console 도 동일 shape 로 ring buffer 적재 (source 만 'main').
// backend (server.py → agent-sdk-poc proxy) 로 batch POST 될 때도 같은 shape.
export interface KlaudLogEntry {
  ts: number; // epoch ms
  source: 'renderer' | 'main' | 'sidecar';
  level: 'log' | 'info' | 'warn' | 'error';
  // 메시지가 [foo] 로 시작하면 그걸 tag 로 분리. 아니면 빈 문자열.
  tag: string;
  message: string;
  // optional. 현재 활성 탭/모드/페이지 id 등 context. renderer 가 채움.
  extra?: Record<string, unknown>;
}

// 제보 페이로드. 사용자 노트 + 현재 컨텍스트. backend 가 (machine_id, session_id, ts) 로
// 직전 N분 로그를 묶어 관리자 페이지에서 조회 가능하게.
export interface KlaudReportPayload {
  note: string;
  context: {
    activeTab?: { id: string; kind: string; title: string };
    splitMode?: string;
    url?: string;
    [k: string]: unknown;
  };
  // optional. base64 PNG. 사용자가 첨부 토글 시.
  screenshotB64?: string;
}

// Phase 3 thread workspace IPC payloads.
export interface ThreadSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: number;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
  meta_json: string | null;
}

export interface ThreadCitation {
  id?: number;
  message_id: string;
  doc_type: 'xlsx' | 'confluence';
  doc_id: string;
  doc_title: string | null;
  snippet: string | null;
  score: number | null;
  rank: number;
  url: string | null;
}

export interface ThreadDocRef {
  thread_id: string;
  doc_id: string;
  doc_type: 'xlsx' | 'confluence';
  doc_title: string | null;
  added_at: number;
  pinned: number;
}

export interface ThreadBundle {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  citations: Record<string, ThreadCitation[]>; // message_id → list
  docs: ThreadDocRef[];
}

// 데이터 경로 / 자동 업데이트 피드 / 백엔드 URL 등 비밀이 아닌 설정값.
// 사용자가 SettingsModal 에서 입력한 값이 main 의 settings.ts 로 저장되고,
// 이후 paths.ts/updater.ts/sidecar.ts 의 effective* 함수가 이를 읽는다.
export interface AppSettings {
  repoRoot?: string;
  updateFeedUrl?: string;
  // qna-poc 백엔드 URL — sidecar /search_docs 가 이리로 HTTP proxy.
  // 미설정 시 sidecar 는 빈 결과 반환 (Phase 1 stub).
  retrieverUrl?: string;
  // agent-sdk-poc 백엔드 URL — sidecar /ask_stream 이 이리로 SSE forward.
  // 미설정 시 echo stub.
  agentUrl?: string;
  // agent-sdk-poc 의 web frontend URL — 🤖 임베드 탭이 사용. agentUrl 과 분리.
  // 비어있으면 agentUrl 에서 /api 접미사 strip 해 도출.
  agentWebUrl?: string;
  // MCP bridge 활성화 (default true in dev). selfTestEnabled 와 분리됨 (0.1.22).
  // ON 이면 부팅 시 mcpBridgeUrl 로 WS connect → klaud-mcp-server (WSL) 와 RPC.
  // Claude Code 가 tool 로 직접 조작 (klaud_health, klaud_state, ...).
  mcpBridgeEnabled?: boolean;
  mcpBridgeUrl?: string;
  // Klaud main process console.log/warn/error 를 fire-and-forget POST 로 전송할 collector URL.
  // WSL 측에서 `npm run serve:log-collector` 가 받음 (default port 8772).
  // 미설정 시 push 비활성 (로컬 ring buffer 만 유지).
  logCollectorUrl?: string;
  // dev hot-swap (0.1.28+). WSL 의 dev-bundle-server (default 8773) 가 out/ 폴더를
  // host 하면, Klaud 가 5초마다 manifest.json 를 폴링해 변경된 file 만 fetch +
  // app.asar.unpacked/out 에 swap + 재시작. 빌드 cycle ~5초.
  // mcpBridgeEnabled 와 동일하게 dev 모드일 때만 활성.
  devBundleUrl?: string;
  // Phase 3.5: 사용자가 마지막으로 선택했던 thread id. 부팅 시 자동 select.
  lastThreadId?: string;
  // PoC 2A: P4 의 .xlsx relPath → OneDrive Office for the Web embed URL 매핑.
  // 사용자가 OneDrive 에 manual upload 한 file 의 share link 를 등록.
  // 다음 PoC 2B 에서 Microsoft Graph 자동 upload 가 같은 형식 채움.
  sheetMappings?: Record<string, string>;
  // OneDrive Sync 우회 흐름에서 picker path 로부터 자동 추정 후 저장 (0.1.48+).
  // sidecar 의 /xlsx_raw 가 P4 워크스페이스 root 로 fallback 사용.
  p4WorkspaceRoot?: string;
  // PR9: P4 자동 발견 또는 SettingsModal 수동 입력으로 채워지는 좌표.
  // 모두 비어있으면 PR9b 의 depot 트리 빌드는 skip 되고 P4Panel depot 탭은 disabled 유지.
  p4Host?: string; // P4PORT (예: 'perforce:1666')
  p4User?: string; // P4USER
  p4Client?: string; // P4CLIENT

  // B2-1 (2026-05-03): Confluence 리뷰/수정 검증용 별도 스페이스.
  // 채우면 doc-header 에 "📋 테스트로 복사" 버튼 노출. 운영 페이지를 안전하게 사본 만들어
  // 거기서 review/Apply 검증.
  confluenceTestSpaceKey?: string;
  // 선택. 채우면 그 페이지의 자식으로 복사, 비우면 스페이스 root.
  confluenceTestParentPageId?: string;

  // 액티비티 바 5번 ("내 작업 중 문서") 의 Confluence draft polling 대상 space key 목록.
  // 비어있으면 ['PK'] 로 fallback. 임시/개발용 space 추가 시 여기에.
  confluenceDraftSpaceKeys?: string[];

  // Excel viewer 분기 (PoC — 0.1.53+).
  //  'onlyoffice' : 자체 호스팅 OnlyOffice Document Server CE 임베드 — **default** (sync 함정 0).
  //  'sp'         : 기존 SharePoint webview (OneDrive Sync 흐름) — 사용자가 명시적 선택 시.
  // 미설정 (undefined) 은 onlyoffice 로 취급. onlyOfficeUrl 이 채워져 있어야 정상 동작 —
  // 비어있거나 서버 down 이면 prepare 가 actionable 에러 반환 (사용자가 Settings 에서 URL 확인 또는
  // SP 로 전환 가능).
  viewerMode?: 'sp' | 'onlyoffice';
  // OnlyOffice Document Server endpoint. 예: 'http://172.20.105.147:8080' (jacob WSL Docker)
  // 또는 사내 VM 에 띄운 서버 도메인. 주소 변경 시 사용자가 SettingsModal 에서 입력.
  onlyOfficeUrl?: string;

  // 2026-05-13 릴리스-A2: Klaud 통합 로그 sink + 제보 (운영 모니터링).
  // klaudLogSinkUrl 미설정 시 frontend 가 큐만 적재 (송신 X). klaudTelemetryEnabled
  // false 시 일체 송신 안 함 (opt-out). klaudMachineId 는 첫 부팅 시 자동 발급.
  klaudLogSinkUrl?: string;
  klaudTelemetryEnabled?: boolean;
  klaudMachineId?: string;

  // 2026-05-13 릴리스-B: Google Workspace SSO. 두 값 모두 비어 있으면 SSO 비활성.
  // PROJK_GOOGLE_CLIENT_ID env 가 fallback. hd 가 비어 있으면 워크스페이스 제한 없음.
  googleOAuthClientId?: string;
  googleWorkspaceDomain?: string;
}

// 액티비티 바 5번 ("내 작업 중 문서") — P4 체크아웃 한 항목.
// `p4 -ztag opened -u <user> -c <client>` 결과를 parse 한 것.
export interface ActiveP4File {
  depotPath: string;   // 예: '//main/ProjectK/Design/HUD.xlsx'
  clientPath?: string; // 예: '//jacob-D/Design/HUD.xlsx' — 클라이언트 path (참고용)
  action: string;      // 'edit' | 'add' | 'delete' | 'branch' | 'integrate' ...
  revision: number;    // open 된 시점의 revision (head 가 아닐 수 있음)
  type?: string;       // 'binary+l' | 'text' 등
}

export interface ActiveP4Result {
  ok: boolean;
  files: ActiveP4File[];
  // 좌표 미설정 / p4 호출 실패 시 한 줄 안내.
  diagnostics?: string;
}

// Confluence draft (status=draft) — 사용자가 편집 중이거나 새로 만들고 아직 publish 안 한 문서.
export interface ActiveConfluenceDraft {
  pageId: string;
  title: string;
  spaceKey: string;
  // ISO 8601 — version.createdAt. 사람-가독 상대 시간 표시용.
  lastModified?: string;
}

export interface ActiveConfluenceResult {
  ok: boolean;
  drafts: ActiveConfluenceDraft[];
  // 자격 미설정 / 4xx / 5xx 시 한 줄.
  diagnostics?: string;
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
