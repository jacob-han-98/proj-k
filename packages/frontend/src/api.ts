export const API_BASE_URL = import.meta.env.MODE === 'production'
  ? `${window.location.origin}/proj-k/api`
  : window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:8088'
    : '/api';

export interface Source {
  workbook: string;
  sheet: string;
  section_path: string;
  score: number;
  source_url?: string;
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
}

export const askQuestion = async (
  question: string,
  model: string = 'claude-opus-4-5',
  prompt_style: string = '검증세트 최적화',
  conversation_id?: string
): Promise<AskResponse> => {
  const response = await fetch(`${API_BASE_URL}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      question,
      conversation_id,
      model,
      prompt_style,
    }),
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
}

export interface ConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: ConversationTurn[];
}

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

export const fetchPipelineJobs = async (status?: string): Promise<{ jobs: PipelineJob[]; stats: Record<string, number> }> => {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
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

/** NDJSON 스트리밍 이벤트 타입 */
export type StreamEvent =
  | { type: 'status'; message: string }
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
): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/ask_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, conversation_id, model, prompt_style }),
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
