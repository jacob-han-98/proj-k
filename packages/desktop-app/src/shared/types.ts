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
}

export interface P4TreeResult {
  nodes: TreeNode[];
  rootDir: string;
  loadedAt: number;
  // 사이드카가 빈 결과를 돌려줄 때 어디서 막혔는지 진단용. 정상 결과에는 null/undefined.
  debug?: unknown;
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
  EXCEL_OPEN: 'excel:open',
  P4_SYNC: 'p4:sync',
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
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
