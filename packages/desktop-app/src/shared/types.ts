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

// PR9c: depot 파일 한 개를 보기용으로 다운로드 + OneDrive 업로드 + 읽기 전용 URL 빌드.
// fromCache 가 true 면 manifest 의 같은 revision 캐시 hit (재업로드 skip).
export interface P4DepotOpenResult {
  ok: boolean;
  url?: string;
  revision?: number;
  fromCache?: boolean;
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
export interface QuickFindHit {
  doc_id: string; // "xlsx::<workbook>::<sheet>" or "conf::<path>"
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
  EXCEL_OPEN: 'excel:open',
  P4_SYNC: 'p4:sync',
  P4_DISCOVER: 'p4:discover',
  P4_DEPOT_LIST: 'p4:depot-list',
  P4_DEPOT_DIRS: 'p4:depot-dirs',
  P4_DEPOT_OPEN: 'p4:depot-open',
  P4_DEPOT_CACHE_LIST: 'p4:depot-cache-list',
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
  // main → renderer push. 백그라운드 sync 의 시작/완료/실패 통지. renderer 가 자기 webview
  // 의 relPath 와 매칭되면 reload 수행.
  ONEDRIVE_SYNC_PROGRESS: 'onedrive-sync:progress',
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
  // frameless window 컨트롤 — 우상단 min/max/close 버튼이 호출.
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximize-toggle',
  WINDOW_CLOSE: 'window:close',
  // main → renderer broadcast: 창이 maximize 됐는지. 아이콘 swap 용.
  WINDOW_MAXIMIZED: 'window:maximized',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
} as const;

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
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
