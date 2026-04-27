export const API_BASE_URL = import.meta.env.MODE === 'production'
  ? `${window.location.origin}/proj-k/agentsdk/api`
  : window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:8090'
    : '/api';

export interface Source {
  workbook: string;
  sheet: string;
  section_path: string;
  score: number;
  source_url?: string;    // legacy (qna-poc 호환)
  path?: string;          // 내부 파일 경로 (디버그/스플릿 뷰)
  source?: 'xlsx' | 'confluence' | 'summary' | 'image' | 'external' | 'web' | 'datasheet' | 'other';
  origin_label?: string;  // 사용자 표시용 원본 라벨
  origin_url?: string;    // Confluence 원본 링크 등
}

export interface Proposal {
  type: 'modify' | 'create';
  workbook: string;
  sheet: string;
  section?: string;
  reason: string;
  before?: string;
  after?: string;
  content?: string;
  diff_summary: string;
}

export interface AskResponse {
  answer: string;
  confidence: string;
  sources: Source[];
  conversation_id: string;
  total_tokens: number;
  api_seconds: number;
  proposals?: Proposal[];
  qa_warnings?: string[];
  tool_calls?: number;
  tool_trace?: Array<{ tool: string; input?: any }>;
  follow_ups?: string[];
  compare_mode?: boolean;
}

export const askQuestion = async (
  question: string,
  model: string = 'claude-opus-4-5',
  prompt_style: string = '검증세트 최적화',
  conversation_id?: string,
  prompt_overrides?: Record<string, string>,
): Promise<AskResponse> => {
  const body: Record<string, unknown> = { question, conversation_id, model, prompt_style };
  if (prompt_overrides && Object.keys(prompt_overrides).length > 0) {
    body.prompt_overrides = prompt_overrides;
  }
  const response = await fetch(`${API_BASE_URL}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
};

// ── Admin 타입 ──

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  last_model: string;
}

export interface ConversationTurn {
  question: string;
  answer: string;
  sources: Source[];
  confidence: string;
  model: string;
  total_tokens: number;
  api_seconds: number;
  timestamp: string;
  prompt_overrides?: Record<string, string>;
}

export interface ConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: ConversationTurn[];
}

// ── 프롬프트 커스텀 ──

export interface PromptDefault {
  key: string;
  label: string;
  content: string;
}

export const fetchDefaultPrompts = async (): Promise<Record<string, PromptDefault>> => {
  const res = await fetch(`${API_BASE_URL}/prompts/defaults`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export interface PresetPrompt {
  label: string;
  prompt: string;
  category?: string;
  compare_mode?: boolean;   // 클릭 시 "📚 비교" 토글 자동 ON 여부
}

export const fetchPresetPrompts = async (): Promise<{ presets: PresetPrompt[] }> => {
  const res = await fetch(`${API_BASE_URL}/preset_prompts`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export interface SourceView {
  path: string;
  section: string;
  content: string;
  section_range: { start_line: number; end_line: number } | null;
  origin_label: string;
  origin_url: string;
  source: 'xlsx' | 'confluence' | 'summary' | 'image' | 'other';
}

export const screenshotUrl = (path: string): string => {
  const qs = new URLSearchParams({ path });
  return `${API_BASE_URL}/screenshot?${qs.toString()}`;
};

export const fetchSourceView = async (path: string, section = ''): Promise<SourceView> => {
  const qs = new URLSearchParams({ path });
  if (section) qs.set('section', section);
  const res = await fetch(`${API_BASE_URL}/source_view?${qs.toString()}`);
  if (!res.ok) throw new Error(`source_view ${res.status}`);
  return res.json();
};

export const fetchConversations = async (): Promise<{ conversations: ConversationSummary[]; total: number }> => {
  const res = await fetch(`${API_BASE_URL}/admin/conversations`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const forkConversation = async (id: string): Promise<{ conversation_id: string; title: string; turn_count: number }> => {
  const res = await fetch(`${API_BASE_URL}/conversations/${encodeURIComponent(id)}/fork`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchConversationDetail = async (id: string): Promise<ConversationDetail> => {
  const res = await fetch(`${API_BASE_URL}/admin/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

// ── Conflicts 타입 ──

export interface ConflictItem {
  type: string;
  topic: string;
  excel_says: string;
  confluence_says: string;
  severity: string;
  recommendation: string;
}

export interface ConflictComparison {
  has_conflict: boolean;
  severity: string;
  version_relationship: string;
  conflicts: ConflictItem[];
  summary: string;
  _meta?: { input_tokens: number; output_tokens: number; api_seconds: number };
}

export interface ConflictPair {
  excel: string;
  confluence: string;
  confidence: string;
  overlap_topic: string;
  risk_reason: string;
}

export interface ConflictAnalysis {
  pair: ConflictPair;
  comparison?: ConflictComparison;
  error?: string;
}

export interface ConflictScanResult {
  scan_time: string;
  elapsed_seconds: number;
  pairs_found: number;
  pairs_analyzed: number;
  total_conflicts: number;
  severity_counts: Record<string, number>;
  pairs: ConflictPair[];
  analyses: ConflictAnalysis[];
}

export const createConfluencePage = async (title: string, contentMd: string, parentPath?: string): Promise<{ success: boolean; page_id: string; page_url: string; title: string }> => {
  const res = await fetch(`${API_BASE_URL}/confluence/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content_md: contentMd, parent_path: parentPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(err.detail || `API error: ${res.status}`);
  }
  return res.json();
};

// ── 기획서 품질 기준 ──

export interface QualityCriterion {
  id: string;
  category: string;
  title: string;
  description: string;
  weight: number;
  source: string;
}

export interface QualityCriteria {
  version: string;
  updated_at: string;
  criteria: QualityCriterion[];
  reference_docs: { title: string; url: string; note: string }[];
}

export const fetchQualityCriteria = async (): Promise<QualityCriteria> => {
  const res = await fetch(`${API_BASE_URL}/quality-criteria`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const updateQualityCriteria = async (criteria: QualityCriterion[]): Promise<void> => {
  const res = await fetch(`${API_BASE_URL}/quality-criteria`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ criteria }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
};

export const fetchConflicts = async (): Promise<ConflictScanResult> => {
  const res = await fetch(`${API_BASE_URL}/conflicts`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

// ── 데이터 파이프라인 API ──

export interface PipelineStats {
  sources: number;
  documents: { total: number; by_status: Record<string, number> };
  jobs: Record<string, number>;
  issues: Record<string, number>;
  active_snapshot: { snapshot_name: string; chunk_count: number; created_at: string } | null;
}

export interface PipelineSource {
  id: number;
  name: string;
  source_type: string;
  path: string;
  convert_strategy: string;
  schedule: string;
  enabled: number;
  properties: string;
  created_at: string;
  last_crawled_at?: string | null;
  last_crawl_summary?: string | null;
}

export interface PipelineDocument {
  id: number;
  source_id: number;
  file_path: string;
  file_type: string;
  title: string | null;
  status: string;
  metadata: string;
  last_crawled_at: string | null;
  updated_at: string;
}

export interface PipelineJob {
  id: number;
  job_type: string;
  status: string;
  priority: number;
  worker_type: string;
  worker_id: string | null;
  params: string;
  result: string;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  completed_at: string | null;
  doc_title: string | null;
  doc_path: string | null;
  source_name: string | null;
  progress: string | null;
}

export interface PipelineIssue {
  id: number;
  document_id: number;
  issue_type: string;
  severity: string;
  title: string;
  description: string | null;
  reported_by: string | null;
  status: string;
  doc_title: string | null;
  file_path: string | null;
  created_at: string;
}

export const fetchPipelineStatus = async (): Promise<PipelineStats> => {
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/status`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchPipelineSources = async (): Promise<{ sources: PipelineSource[] }> => {
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/sources`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchPipelineDocuments = async (sourceId?: number, status?: string): Promise<{ documents: PipelineDocument[]; total: number }> => {
  const params = new URLSearchParams();
  if (sourceId) params.set('source_id', String(sourceId));
  if (status) params.set('status', status);
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/documents?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export interface SheetInfo {
  name: string;
  md_size: number;
  images_count: number;
}

export interface DocumentContent {
  doc_id: number;
  title: string;
  source_type: string;
  tree_path: string;
  storage_path: string | null;
  md_file: string | null;
  md_content: string;
  confluence_url: string | null;
  file_path: string;
  status: string;
  images_count: number;
  sheets?: SheetInfo[];  // Excel only
}

export const fetchDocumentContent = async (docId: number): Promise<DocumentContent> => {
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/documents/${docId}/content`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchSheetContent = async (docId: number, sheetName: string): Promise<{ sheet_name: string; md_content: string; images_count: number }> => {
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/documents/${docId}/sheet/${encodeURIComponent(sheetName)}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const retryJob = async (jobId: number): Promise<{ job_id: number; status: string }> => {
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/jobs/${jobId}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const getDocumentDownloadUrl = (docId: number): string =>
  `${API_BASE_URL}/admin/pipeline/documents/${docId}/download`;

export const fetchPipelineJobs = async (statuses?: string[], jobTypes?: string[], limit?: number, offset?: number, sourceId?: number): Promise<{ jobs: PipelineJob[]; stats: Record<string, number>; total: number }> => {
  const params = new URLSearchParams();
  if (statuses?.length) params.set('status', statuses.join(','));
  if (jobTypes?.length) params.set('job_type', jobTypes.join(','));
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (sourceId) params.set('source_id', String(sourceId));
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/jobs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchPipelineIssues = async (status?: string): Promise<{ issues: PipelineIssue[] }> => {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/issues?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const triggerPipelineJob = async (jobType: string, sourceId?: number, documentId?: number): Promise<{ job_id: number }> => {
  const params = new URLSearchParams({ job_type: jobType });
  if (sourceId) params.set('source_id', String(sourceId));
  if (documentId) params.set('document_id', String(documentId));
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/jobs/trigger?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export interface CrawlLog {
  id: number;
  source_id: number;
  job_id: number | null;
  crawl_type: string;
  total_files: number;
  new_files: number;
  changed_files: number;
  unchanged_files: number;
  deleted_files: number;
  errors: number;
  details: string;
  duration_sec: number | null;
  created_at: string;
}

export const fetchCrawlLogs = async (sourceId?: number): Promise<{ logs: CrawlLog[] }> => {
  const params = new URLSearchParams();
  if (sourceId) params.set('source_id', String(sourceId));
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/crawl-logs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

// ── Pipeline DAG ──────────────────────────────────

export interface DagStage {
  id: string;
  label: string;
  desc: string;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagStageStatus {
  status: string;   // idle | pending | running | completed | failed
  completed_at?: string | null;
  created_at?: string | null;
  error?: string | null;
  pending_count?: number;
  running_count?: number;
  assigned_count?: number;
}

export interface PipelineSettings {
  auto_crawl_interval: number;  // 0=수동, >0=초 단위
  auto_download: boolean;
  auto_enrich: boolean;
}

export interface PipelineDagSource {
  source_id: number;
  source_name: string;
  source_type: string;
  pipeline: string;
  stages: DagStage[];
  edges: DagEdge[];
  last_stage: string;
  stage_status: Record<string, DagStageStatus>;
  settings?: PipelineSettings;
}

export interface PipelineDagResponse {
  sources: PipelineDagSource[];
  shared_stages: DagStage[];
  shared_edges: DagEdge[];
  shared_status: Record<string, DagStageStatus>;
  workers?: Record<string, number>;
  managed_workers?: Record<string, number>;
  scalable_types?: string[];
}

export const fetchPipelineDag = async (): Promise<PipelineDagResponse> => {
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/dag`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const runPipelineDag = async (
  sourceId: number, stage: string, mode: 'single' | 'downstream' | 'all'
): Promise<{ source_id: number; mode: string; jobs: { job_id: number; stage: string }[] }> => {
  const params = new URLSearchParams({ source_id: String(sourceId), stage, mode });
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/dag/run?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const savePipelineSettings = async (
  sourceId: number, settings: Partial<PipelineSettings>
): Promise<{ ok: boolean; settings: PipelineSettings }> => {
  const params = new URLSearchParams({ source_id: String(sourceId) });
  if (settings.auto_crawl_interval !== undefined) params.set('auto_crawl_interval', String(settings.auto_crawl_interval));
  if (settings.auto_download !== undefined) params.set('auto_download', String(settings.auto_download));
  if (settings.auto_enrich !== undefined) params.set('auto_enrich', String(settings.auto_enrich));
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/settings?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const scaleWorkers = async (
  jobType: string, count: number
): Promise<{ job_type: string; current: number; launched: number; killed: number }> => {
  const params = new URLSearchParams({ job_type: jobType, count: String(count) });
  const res = await fetch(`${API_BASE_URL}/admin/pipeline/workers/scale?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

// ── Game Data (DataSheet DB) ─────────────────────

export interface GameDataSummary {
  ready: boolean;
  db_size_mb?: number;
  ingested_at?: string;
  table_count?: number;
  total_rows?: number;
  enum_types?: number;
  enum_values?: number;
  fk_count?: number;
  tables?: { name: string; file: string; rows: number; columns: number; cs: string }[];
}

export interface GameDataQueryResult {
  table?: string;
  columns: string[];
  rows: any[][];
  total: number;
  sql?: string;
  ms?: number;
  error?: string | null;
}

export const fetchGameDataSummary = async (): Promise<GameDataSummary> => {
  const res = await fetch(`${API_BASE_URL}/admin/game-data/summary`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchGameDataTable = async (tableName: string, limit = 100, filter?: string): Promise<GameDataQueryResult> => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filter) params.set('filter', filter);
  const res = await fetch(`${API_BASE_URL}/admin/game-data/table/${tableName}?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchGameDataDescribe = async (tableName: string): Promise<GameDataQueryResult> => {
  const res = await fetch(`${API_BASE_URL}/admin/game-data/describe/${tableName}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchGameDataEnum = async (enumType: string): Promise<GameDataQueryResult> => {
  const res = await fetch(`${API_BASE_URL}/admin/game-data/enum/${enumType}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const searchGameData = async (q: string): Promise<{ results: any[]; query: string }> => {
  const res = await fetch(`${API_BASE_URL}/admin/game-data/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

// ── Refactor Ranker / Decision Overlay ─────────────────────────

export type Grade = 'S' | 'A' | 'B' | 'C';

export interface RefactorSource {
  kind?: 'excel' | 'confluence' | 'graph_edge';
  workbook?: string;
  sheet?: string;
  space?: string;
  page_path?: string;
  section_path?: string;
  target?: string;
  title?: string;
}

export interface RefactorEvidence {
  dimension: string;
  cited_text: string;
  source: RefactorSource;
  reason?: string;
  confidence: 'high' | 'medium' | 'low';
  verified_by_cov?: boolean;
}

export interface RefactorDimensionScore {
  value: number;
  raw?: number;
  facts?: Record<string, any>;
  rationale?: string;
}

export interface RefactorTarget {
  rank: number;
  name: string;
  grade: Grade;
  rationale: string;
  dimension_scores: Record<string, RefactorDimensionScore>;
  evidence: RefactorEvidence[];
  blast_radius_note?: string;
  effort?: 'S' | 'M' | 'L';
  confidence_flags?: string[];
}

export interface RefactorTargetsReport {
  generated_at: string;
  ranker_version?: string;
  dimensions_used: string[];
  systems_scope?: { total: number; limited_to: number; selection_rule: string };
  targets: RefactorTarget[];
}

export interface RefactorCardOption {
  key: string;
  source: RefactorSource;
  summary: string;
  side: 'excel' | 'confluence';
}

export interface RefactorCard {
  target_name: string;
  topic: string;
  conflict_type: string;
  severity: string;
  recommendation: string | null;
  options: RefactorCardOption[];
}

export interface DecisionRecord {
  id: string;
  date: string;
  target_name: string;
  conflict_summary: string;
  selected_option: string;
  author: string;
  ttl_days?: number;
  status: 'active' | 'revoked';
  options: RefactorCardOption[];
  deprecated_refs?: RefactorSource[];
  selected_custom_text?: string;
}

export interface AnnotationRecord {
  decision_id: string;
  target: RefactorSource;
  status: 'active' | 'deprecated' | 'superseded' | 'revoked';
  label?: string;
  reason?: string;
  applied_at: string;
  expires_at?: string;
}

export interface FeedbackRecord {
  id: string;
  date: string;
  target_name: string;
  action: 'dismiss' | 'regrade' | 'defer' | 'comment';
  comment?: string;
  regrade_to?: Grade;
  author: string;
  expires_at?: string;
}

export interface RefactorOverview {
  targets_meta: {
    generated_at?: string;
    dimensions_used?: string[];
    systems_scope?: { total: number; limited_to: number; selection_rule: string };
    ranker_version?: string;
    total_targets?: number;
  };
  grade_counts: Record<string, number>;
  decisions: { total: number; recent: DecisionRecord[] };
  annotations: { total: number; deprecated: number; recent: AnnotationRecord[] };
  feedback: { total: number; recent: FeedbackRecord[] };
}

export const fetchRefactorOverview = async (): Promise<RefactorOverview> => {
  const res = await fetch(`${API_BASE_URL}/admin/refactor/overview`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchRefactorTargets = async (): Promise<RefactorTargetsReport> => {
  const res = await fetch(`${API_BASE_URL}/admin/refactor/targets`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchRefactorCards = async (target: string): Promise<{ target: string; count: number; cards: RefactorCard[] }> => {
  const res = await fetch(`${API_BASE_URL}/admin/refactor/cards/${encodeURIComponent(target)}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const applyRefactorDecision = async (req: {
  target: string;
  card_index: number;  // 1-based
  option: string;
  author: string;
  ttl_days?: number;
  custom?: string | null;
}): Promise<{ decision: DecisionRecord; annotations: AnnotationRecord[] }> => {
  const res = await fetch(`${API_BASE_URL}/admin/refactor/apply_decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(err.detail || `API error: ${res.status}`);
  }
  return res.json();
};

export const recordRefactorFeedback = async (req: {
  target: string;
  action: 'dismiss' | 'regrade' | 'defer' | 'comment';
  author: string;
  comment?: string;
  card_index?: number;  // 1-based
  regrade_to?: Grade;
  ttl_days?: number;
}): Promise<{ feedback: FeedbackRecord }> => {
  const res = await fetch(`${API_BASE_URL}/admin/refactor/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(err.detail || `API error: ${res.status}`);
  }
  return res.json();
};

export const fetchRefactorDecisions = async (limit?: number): Promise<{ decisions: DecisionRecord[] }> => {
  const qs = limit ? `?limit=${limit}` : '';
  const res = await fetch(`${API_BASE_URL}/admin/refactor/decisions${qs}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchRefactorAnnotations = async (limit?: number): Promise<{ annotations: AnnotationRecord[] }> => {
  const qs = limit ? `?limit=${limit}` : '';
  const res = await fetch(`${API_BASE_URL}/admin/refactor/annotations${qs}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export const fetchRefactorFeedbackList = async (limit?: number): Promise<{ feedback: FeedbackRecord[] }> => {
  const qs = limit ? `?limit=${limit}` : '';
  const res = await fetch(`${API_BASE_URL}/admin/refactor/feedback_list${qs}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

/** NDJSON 스트리밍 이벤트 타입 */
export type StreamEvent =
  | { type: 'status'; message: string }
  | { type: 'stage'; stage: string; label: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; tool: string; input: any; label: string }
  | { type: 'tool_end'; id: string; summary: string; label?: string; preview?: string }
  | { type: 'result'; data: AskResponse }
  | { type: 'error'; message: string };

/**
 * SSE 스트리밍으로 QnA 질문. NDJSON 라인을 파싱하여 콜백 호출.
 */
export const askQuestionStream = async (
  question: string,
  onEvent: (event: StreamEvent) => void,
  model: string = 'claude-opus-4-5',
  prompt_style: string = '검증세트 최적화',
  conversation_id?: string,
  signal?: AbortSignal,
  prompt_overrides?: Record<string, string>,
  compare_mode: boolean = false,
): Promise<void> => {
  const body: Record<string, unknown> = { question, conversation_id, model, prompt_style };
  if (prompt_overrides && Object.keys(prompt_overrides).length > 0) {
    body.prompt_overrides = prompt_overrides;
  }
  if (compare_mode) {
    body.compare_mode = true;
  }
  const response = await fetch(`${API_BASE_URL}/ask_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event: StreamEvent = JSON.parse(trimmed);
          onEvent(event);
        } catch {
          // 파싱 실패한 라인은 무시
        }
      }
    }

    if (buffer.trim()) {
      try {
        onEvent(JSON.parse(buffer.trim()));
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
};
