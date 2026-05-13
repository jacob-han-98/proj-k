import { useEffect, useMemo, useRef, useState } from 'react';
import { KLAUD_BUILTIN_WORKSPACE_DOMAIN, type AppSettings } from '../../shared/types';
import { useWorkbenchStore } from '../workbench/store';

// 2026-05-13 사용자 피드백: VSCode 스타일 settings — 좌측 카테고리 nav + 우측 content +
// 상단 검색. 기존 한 column stack 에서 전면 리팩터.
//
// 구조:
//   - 좌측 사이드 (200px): 카테고리 리스트. active 카테고리 highlight.
//   - 상단: 검색 input. 모든 필드의 label/hint/keywords 매칭. 검색 중에는 모든 카테고리
//     의 매칭 필드만 펼쳐서 보여주고, 카테고리 nav 는 disable. 검색어 지우면 평상시.
//   - 우측 content: 활성 카테고리의 section. 각 필드는 label + input + hint.
//   - 하단: 저장 + 취소 버튼. 저장 시 setSettings IPC + Confluence creds 별도.

interface Props {
  initialEmail?: string;
  initialBaseUrl?: string;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_BASE_URL = 'https://bighitcorp.atlassian.net';
const DEFAULT_REPO_ROOT_HINT = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k';
const DEFAULT_FEED_URL_HINT = 'http://localhost:8766/';
const DEFAULT_RETRIEVER_URL_HINT = 'http://localhost:8088';
const DEFAULT_AGENT_URL_HINT = 'http://localhost:8090';
const DEFAULT_MCP_BRIDGE_URL_HINT = 'ws://localhost:8769';
const DEFAULT_LOG_COLLECTOR_URL_HINT = 'http://localhost:8772';
const DEFAULT_DEV_BUNDLE_URL_HINT = 'http://localhost:8773';
const DEFAULT_ONLYOFFICE_URL_HINT = 'http://172.20.105.147:8080';

// 카테고리 메타. nav 순서 = 배열 순서.
type CategoryId =
  | 'general'
  | 'data'
  | 'auth'
  | 'telemetry'
  | 'appearance'
  | 'backend'
  | 'dev';

interface CategoryMeta {
  id: CategoryId;
  label: string;
  icon: string;
  // 검색 매칭 keyword (label/hint 외 추가).
  keywords: string[];
}

const CATEGORIES: CategoryMeta[] = [
  { id: 'general', label: '일반', icon: '⚙️', keywords: ['repo', 'update', 'feed', '경로', '저장소'] },
  { id: 'data', label: '데이터', icon: '🗂️', keywords: ['p4', 'perforce', 'confluence', '테스트', 'space'] },
  { id: 'auth', label: '인증', icon: '🔑', keywords: ['google', 'sso', 'oauth', 'confluence', 'token', 'workspace'] },
  { id: 'telemetry', label: '운영 모니터링', icon: '📡', keywords: ['로그', '제보', 'log', 'sink', 'telemetry', 'klaud'] },
  { id: 'appearance', label: '외형', icon: '🎨', keywords: ['viewer', 'excel', 'onlyoffice', 'tab', '고정', 'pin', 'review'] },
  { id: 'backend', label: '백엔드', icon: '🔌', keywords: ['url', 'agent', 'retriever', 'api'] },
  { id: 'dev', label: '개발', icon: '🛠️', keywords: ['mcp', 'bridge', 'devbundle', 'collector', 'hot swap'] },
];

// 필드 메타 — 검색 + 카테고리 grouping 에 사용.
interface FieldMeta {
  category: CategoryId;
  testid: string; // 검색 결과 → scroll 시 사용
  label: string;
  hint?: string;
  keywords?: string[]; // label/hint 외 추가 검색 키워드
}

// 모든 필드의 메타 list — 검색 인덱스. UI 렌더는 category section 안에 직접.
const FIELD_META: FieldMeta[] = [
  { category: 'general', testid: 'settings-repo-root', label: 'Repo Root', hint: 'Klaud 가 읽는 proj-k repo 의 절대 경로', keywords: ['데이터 경로', 'repo'] },
  { category: 'general', testid: 'settings-feed-url', label: '자동 업데이트 피드 URL', hint: 'electron-updater 가 새 버전 확인', keywords: ['update', '배포'] },
  { category: 'backend', testid: 'settings-retriever-url', label: 'Retriever URL', hint: 'sidecar /search_docs 가 forward', keywords: ['검색'] },
  { category: 'backend', testid: 'settings-agent-url', label: 'Agent URL', hint: 'sidecar /ask_stream 가 SSE forward', keywords: ['LLM'] },
  { category: 'backend', testid: 'settings-agent-web-url', label: 'Agent Web URL', hint: '🤖 임베드 탭이 사용하는 web frontend', keywords: ['embed'] },
  { category: 'dev', testid: 'settings-mcp-bridge-enabled', label: 'MCP Bridge 활성', hint: 'Klaud ↔ Claude Code RPC 양방향', keywords: ['mcp'] },
  { category: 'dev', testid: 'settings-mcp-bridge-url', label: 'MCP Bridge URL', hint: 'WSL klaud-mcp-server WebSocket', keywords: ['mcp'] },
  { category: 'dev', testid: 'settings-log-collector-url', label: 'Log Collector URL (dev)', hint: 'main console fire-and-forget POST (WSL collector)', keywords: ['로그'] },
  { category: 'dev', testid: 'settings-dev-bundle-url', label: 'Dev Bundle URL (hot swap)', hint: '5초 폴링으로 out/ 변경 감지 + swap', keywords: ['hot reload'] },
  { category: 'telemetry', testid: 'settings-klaud-log-sink-url', label: 'Klaud log sink URL', hint: 'renderer/main console + 제보 POST 사내 backend', keywords: ['로그', '제보'] },
  { category: 'telemetry', testid: 'settings-klaud-telemetry-enabled', label: '로그/제보 전송 활성', hint: 'opt-out 토글', keywords: ['로그', '제보'] },
  { category: 'data', testid: 'settings-p4-host', label: 'P4 Host', hint: 'p4 서버 좌표 (예: perforce:1666)', keywords: ['p4'] },
  { category: 'data', testid: 'settings-p4-user', label: 'P4 User', keywords: ['p4'] },
  { category: 'data', testid: 'settings-p4-client', label: 'P4 Client', keywords: ['p4'] },
  { category: 'data', testid: 'settings-p4-root', label: 'P4 Workspace Root', hint: 'OneDrive 자동 매핑 기준', keywords: ['p4', 'onedrive'] },
  { category: 'data', testid: 'settings-confluence-test-space-key', label: 'Confluence 테스트 스페이스 키', hint: '리뷰/Apply 검증용 사본 스페이스', keywords: ['confluence', '테스트'] },
  { category: 'data', testid: 'settings-confluence-test-parent-page-id', label: 'Confluence 테스트 부모 페이지 ID', keywords: ['confluence'] },
  { category: 'auth', testid: 'settings-google-client-id', label: 'Google OAuth Client ID', hint: 'GCP Console (Desktop app) 발급', keywords: ['sso', 'oauth'] },
  { category: 'auth', testid: 'settings-google-hd', label: 'Google Workspace 도메인 (hd)', hint: '사내 정책으로 hybecorp.com 고정', keywords: ['sso', 'oauth', 'workspace'] },
  { category: 'auth', testid: 'settings-google-status', label: 'Google 로그인 상태', keywords: ['sso'] },
  { category: 'auth', testid: 'settings-conf-email', label: 'Confluence Email', hint: 'Atlassian API token 발급 계정', keywords: ['confluence'] },
  { category: 'auth', testid: 'settings-conf-token', label: 'Confluence API Token', hint: 'safeStorage 로 암호화 저장', keywords: ['confluence'] },
  { category: 'auth', testid: 'settings-conf-base-url', label: 'Confluence Base URL', keywords: ['confluence'] },
  { category: 'auth', testid: 'settings-atlassian-client-id', label: 'Atlassian OAuth Client ID', hint: 'developer.atlassian.com/console — OAuth 2.0 (3LO)', keywords: ['atlassian', 'oauth', '3lo', 'confluence'] },
  { category: 'auth', testid: 'settings-atlassian-status', label: 'Atlassian 로그인 상태', keywords: ['atlassian', 'sso'] },
  { category: 'appearance', testid: 'settings-viewer-mode', label: 'Excel Viewer 모드', hint: 'onlyoffice (default) / sp', keywords: ['excel'] },
  { category: 'appearance', testid: 'settings-onlyoffice-url', label: 'OnlyOffice Document Server URL', keywords: ['excel'] },
  { category: 'appearance', testid: 'settings-auto-pin-on-review', label: '리뷰 모드 진입 시 자동 탭 고정', hint: '좌측 정렬 + 하이라이트', keywords: ['tab', 'pin'] },
];

function matchesQuery(meta: FieldMeta, q: string): boolean {
  const haystack = [meta.label, meta.hint ?? '', ...(meta.keywords ?? [])].join(' ').toLowerCase();
  return haystack.includes(q);
}

function categoryMatchesQuery(cat: CategoryMeta, q: string, fieldsInCat: FieldMeta[]): boolean {
  if (cat.label.toLowerCase().includes(q)) return true;
  if (cat.keywords.some((k) => k.toLowerCase().includes(q))) return true;
  return fieldsInCat.some((f) => matchesQuery(f, q));
}

export function SettingsModal({ initialEmail, initialBaseUrl, onClose, onSaved }: Props) {
  // ---- 모든 필드 state (기존 패턴 유지) ----
  const [repoRoot, setRepoRoot] = useState('');
  const [updateFeedUrl, setUpdateFeedUrl] = useState('');
  const [retrieverUrl, setRetrieverUrl] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [agentWebUrl, setAgentWebUrl] = useState('');
  const [mcpBridgeEnabled, setMcpBridgeEnabled] = useState(true);
  const [mcpBridgeUrl, setMcpBridgeUrl] = useState('');
  const [logCollectorUrl, setLogCollectorUrl] = useState('');
  const [devBundleUrl, setDevBundleUrl] = useState('');
  const [klaudLogSinkUrl, setKlaudLogSinkUrl] = useState('');
  const [klaudTelemetryEnabled, setKlaudTelemetryEnabled] = useState(true);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [apiToken, setApiToken] = useState('');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? DEFAULT_BASE_URL);
  const [saving, setSaving] = useState(false);
  const [savedSettings, setSavedSettings] = useState<AppSettings>({});

  const [p4Host, setP4Host] = useState('');
  const [p4User, setP4User] = useState('');
  const [p4Client, setP4Client] = useState('');
  const [p4WorkspaceRoot, setP4WorkspaceRoot] = useState('');
  const [p4Discovering, setP4Discovering] = useState(false);
  const [p4DiscoveryMsg, setP4DiscoveryMsg] = useState<string | null>(null);

  const [confluenceTestSpaceKey, setConfluenceTestSpaceKey] = useState('');
  const [confluenceTestParentPageId, setConfluenceTestParentPageId] = useState('');

  const [viewerMode, setViewerMode] = useState<'sp' | 'onlyoffice'>('onlyoffice');
  const [onlyOfficeUrl, setOnlyOfficeUrl] = useState('');

  const [googleOAuthClientId, setGoogleOAuthClientId] = useState('');
  const [autoPinOnReview, setAutoPinOnReview] = useState(true);

  const [googleCreds, setGoogleCreds] = useState<{
    email: string;
    name?: string;
    picture?: string;
    hd?: string;
    hasToken: boolean;
    expiresInSeconds: number;
  } | null>(null);
  const [googleAuthing, setGoogleAuthing] = useState(false);
  const [googleAuthMsg, setGoogleAuthMsg] = useState<string | null>(null);

  // 2026-05-13 Final-3: Atlassian OAuth 3LO.
  const [atlassianOAuthClientId, setAtlassianOAuthClientId] = useState('');
  const [atlassianCreds, setAtlassianCreds] = useState<{
    site_url: string;
    site_name: string;
    display_name?: string;
    email?: string;
    hasToken: boolean;
    expiresInSeconds: number;
  } | null>(null);
  const [atlassianAuthing, setAtlassianAuthing] = useState(false);
  const [atlassianAuthMsg, setAtlassianAuthMsg] = useState<string | null>(null);

  // ---- VSCode 스타일 nav state ----
  const [activeCategory, setActiveCategory] = useState<CategoryId>('general');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ESC 닫기 + Ctrl+F 검색 포커스.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refreshGoogleCreds = async () => {
    try {
      const c = await window.projk.google.getCreds();
      setGoogleCreds(c);
    } catch {
      setGoogleCreds(null);
    }
  };
  const refreshAtlassianCreds = async () => {
    try {
      const c = await window.projk.atlassian.getCreds();
      setAtlassianCreds(c);
    } catch {
      setAtlassianCreds(null);
    }
  };
  const runAtlassianAuth = async () => {
    setAtlassianAuthing(true);
    setAtlassianAuthMsg(null);
    try {
      const r = await window.projk.atlassian.authStart();
      if (r.ok) {
        setAtlassianAuthMsg(`✓ 로그인 완료 — ${r.site_url}`);
        await refreshAtlassianCreds();
      } else {
        setAtlassianAuthMsg(`✗ ${r.reason ?? '실패'}`);
      }
    } catch (e) {
      setAtlassianAuthMsg(`✗ ${(e as Error).message}`);
    } finally {
      setAtlassianAuthing(false);
    }
  };
  const runAtlassianSignOut = async () => {
    await window.projk.atlassian.signOut();
    setAtlassianAuthMsg('로그아웃 됨.');
    await refreshAtlassianCreds();
  };
  const runGoogleAuth = async () => {
    setGoogleAuthing(true);
    setGoogleAuthMsg(null);
    try {
      const r = await window.projk.google.authStart();
      if (r.ok) {
        setGoogleAuthMsg(`✓ 로그인 완료 — ${r.email}`);
        await refreshGoogleCreds();
      } else {
        setGoogleAuthMsg(`✗ ${r.reason ?? '실패'}`);
      }
    } catch (e) {
      setGoogleAuthMsg(`✗ ${(e as Error).message}`);
    } finally {
      setGoogleAuthing(false);
    }
  };
  const runGoogleSignOut = async () => {
    await window.projk.google.signOut();
    setGoogleAuthMsg('로그아웃 됨.');
    await refreshGoogleCreds();
  };

  useEffect(() => {
    window.projk.getSettings().then((s) => {
      setSavedSettings(s);
      setRepoRoot(s.repoRoot ?? DEFAULT_REPO_ROOT_HINT);
      setUpdateFeedUrl(s.updateFeedUrl ?? DEFAULT_FEED_URL_HINT);
      setRetrieverUrl(s.retrieverUrl ?? DEFAULT_RETRIEVER_URL_HINT);
      setAgentUrl(s.agentUrl ?? DEFAULT_AGENT_URL_HINT);
      setAgentWebUrl(s.agentWebUrl ?? '');
      setMcpBridgeEnabled(s.mcpBridgeEnabled !== false);
      setMcpBridgeUrl(s.mcpBridgeUrl ?? DEFAULT_MCP_BRIDGE_URL_HINT);
      setLogCollectorUrl(s.logCollectorUrl ?? DEFAULT_LOG_COLLECTOR_URL_HINT);
      setDevBundleUrl(s.devBundleUrl ?? DEFAULT_DEV_BUNDLE_URL_HINT);
      setKlaudLogSinkUrl(s.klaudLogSinkUrl ?? '');
      setKlaudTelemetryEnabled(s.klaudTelemetryEnabled !== false);
      setP4Host(s.p4Host ?? '');
      setP4User(s.p4User ?? '');
      setP4Client(s.p4Client ?? '');
      setP4WorkspaceRoot(s.p4WorkspaceRoot ?? '');
      setConfluenceTestSpaceKey(s.confluenceTestSpaceKey ?? '');
      setConfluenceTestParentPageId(s.confluenceTestParentPageId ?? '');
      setViewerMode(s.viewerMode ?? 'onlyoffice');
      setOnlyOfficeUrl(s.onlyOfficeUrl ?? DEFAULT_ONLYOFFICE_URL_HINT);
      setGoogleOAuthClientId(s.googleOAuthClientId ?? '');
      setAutoPinOnReview(s.autoPinOnReview !== false);
      setAtlassianOAuthClientId(s.atlassianOAuthClientId ?? '');
    });
    void refreshGoogleCreds();
    void refreshAtlassianCreds();
  }, []);

  const runP4Discover = async () => {
    setP4Discovering(true);
    setP4DiscoveryMsg(null);
    try {
      const info = await window.projk.p4.discover();
      if (info.ok) {
        if (info.host) setP4Host(info.host);
        if (info.user) setP4User(info.user);
        if (info.client) setP4Client(info.client);
        if (info.clientRoot) setP4WorkspaceRoot(info.clientRoot);
        const candidates =
          info.candidates && info.candidates.length > 1
            ? ` (다른 client 후보: ${info.candidates.filter((c) => c !== info.client).join(', ')})`
            : '';
        const rootHint = info.clientRoot ? ` / root ${info.clientRoot}` : '';
        setP4DiscoveryMsg(
          `✓ ticket 으로부터 발견 — ${info.client ?? '(client 없음)'}${rootHint}${candidates}`,
        );
      } else {
        setP4DiscoveryMsg(`✗ ${info.diagnostics ?? '발견 실패'}`);
        if (info.host) setP4Host(info.host);
        if (info.user) setP4User(info.user);
      }
    } catch (e) {
      setP4DiscoveryMsg(`✗ 호출 실패: ${(e as Error).message}`);
    } finally {
      setP4Discovering(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await window.projk.setSettings({
        repoRoot: repoRoot.trim() || undefined,
        updateFeedUrl: updateFeedUrl.trim() || undefined,
        retrieverUrl: retrieverUrl.trim() || undefined,
        agentUrl: agentUrl.trim() || undefined,
        agentWebUrl: agentWebUrl.trim() || undefined,
        mcpBridgeEnabled,
        mcpBridgeUrl: mcpBridgeUrl.trim() || undefined,
        logCollectorUrl: logCollectorUrl.trim() || undefined,
        devBundleUrl: devBundleUrl.trim() || undefined,
        klaudLogSinkUrl: klaudLogSinkUrl.trim() || undefined,
        klaudTelemetryEnabled,
        p4Host: p4Host.trim() || undefined,
        p4User: p4User.trim() || undefined,
        p4Client: p4Client.trim() || undefined,
        p4WorkspaceRoot: p4WorkspaceRoot.trim() || undefined,
        confluenceTestSpaceKey: confluenceTestSpaceKey.trim() || undefined,
        confluenceTestParentPageId: confluenceTestParentPageId.trim() || undefined,
        viewerMode,
        onlyOfficeUrl: onlyOfficeUrl.trim() || undefined,
        googleOAuthClientId: googleOAuthClientId.trim() || undefined,
        googleWorkspaceDomain: undefined,
        autoPinOnReview: autoPinOnReview ? undefined : false,
        atlassianOAuthClientId: atlassianOAuthClientId.trim() || undefined,
      });
      // store 동기화 (autoPinOnReview)
      useWorkbenchStore.getState().setAutoPinOnReview(autoPinOnReview);

      if (email && apiToken) {
        await window.projk.setConfluenceCreds({ email: email.trim(), apiToken, baseUrl: baseUrl.trim() });
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  // ---- 검색 필터 ----
  const q = query.trim().toLowerCase();
  const isSearching = q.length > 0;
  // 검색 시: 매칭 필드의 카테고리들 (중복 제거, 기존 순서) 모두 한 페이지에 보임.
  const matchingFields = useMemo(() => {
    if (!isSearching) return [];
    return FIELD_META.filter((f) => matchesQuery(f, q));
  }, [isSearching, q]);
  const matchingFieldIds = useMemo(() => new Set(matchingFields.map((f) => f.testid)), [matchingFields]);
  const matchingCategories = useMemo(() => {
    if (!isSearching) return [];
    return CATEGORIES.filter((c) => {
      const fields = FIELD_META.filter((f) => f.category === c.id);
      return categoryMatchesQuery(c, q, fields);
    });
  }, [isSearching, q]);

  // 검색 결과 자동 카테고리 점프 — 활성 카테고리가 매칭에 없으면 첫 매칭 카테고리로.
  useEffect(() => {
    if (!isSearching) return;
    if (matchingCategories.length === 0) return;
    if (!matchingCategories.some((c) => c.id === activeCategory)) {
      setActiveCategory(matchingCategories[0]!.id);
    }
  }, [isSearching, matchingCategories, activeCategory]);

  // 필드가 현재 카테고리/검색 컨텍스트에서 보여야 하는지.
  const shouldShowField = (testid: string): boolean => {
    if (!isSearching) return true;
    return matchingFieldIds.has(testid);
  };

  // 필드가 검색 매칭이면 강조.
  const fieldClass = (testid: string): string => {
    return isSearching && matchingFieldIds.has(testid) ? 'settings-field settings-field-match' : 'settings-field';
  };

  // ---- 각 카테고리 section 렌더 ----

  function renderGeneral() {
    return (
      <>
        {shouldShowField('settings-repo-root') && (
          <div className={fieldClass('settings-repo-root')}>
            <label htmlFor="settings-repo-root">Repo Root</label>
            <input
              id="settings-repo-root"
              data-testid="settings-repo-root"
              value={repoRoot}
              onChange={(e) => setRepoRoot(e.target.value)}
              placeholder={DEFAULT_REPO_ROOT_HINT}
              spellCheck={false}
            />
            <div className="settings-hint">
              Klaud 가 읽는 proj-k 저장소 절대 경로. WSL 경로 예: <code>{DEFAULT_REPO_ROOT_HINT}</code>
            </div>
          </div>
        )}
        {shouldShowField('settings-feed-url') && (
          <div className={fieldClass('settings-feed-url')}>
            <label htmlFor="settings-feed-url">자동 업데이트 피드 URL</label>
            <input
              id="settings-feed-url"
              data-testid="settings-feed-url"
              value={updateFeedUrl}
              onChange={(e) => setUpdateFeedUrl(e.target.value)}
              placeholder={DEFAULT_FEED_URL_HINT}
              spellCheck={false}
            />
            <div className="settings-hint">
              electron-updater 가 latest.yml 폴링. 예: <code>{DEFAULT_FEED_URL_HINT}</code>
            </div>
          </div>
        )}
      </>
    );
  }

  function renderBackend() {
    return (
      <>
        {shouldShowField('settings-retriever-url') && (
          <div className={fieldClass('settings-retriever-url')}>
            <label htmlFor="settings-retriever-url">Retriever URL</label>
            <input
              id="settings-retriever-url"
              data-testid="settings-retriever-url"
              value={retrieverUrl}
              onChange={(e) => setRetrieverUrl(e.target.value)}
              placeholder={DEFAULT_RETRIEVER_URL_HINT}
              spellCheck={false}
            />
            <div className="settings-hint">sidecar <code>/search_docs</code> 가 forward.</div>
          </div>
        )}
        {shouldShowField('settings-agent-url') && (
          <div className={fieldClass('settings-agent-url')}>
            <label htmlFor="settings-agent-url">Agent URL</label>
            <input
              id="settings-agent-url"
              data-testid="settings-agent-url"
              value={agentUrl}
              onChange={(e) => setAgentUrl(e.target.value)}
              placeholder={DEFAULT_AGENT_URL_HINT}
              spellCheck={false}
            />
            <div className="settings-hint">sidecar <code>/ask_stream</code> 가 SSE forward.</div>
          </div>
        )}
        {shouldShowField('settings-agent-web-url') && (
          <div className={fieldClass('settings-agent-web-url')}>
            <label htmlFor="settings-agent-web-url">Agent Web URL</label>
            <input
              id="settings-agent-web-url"
              data-testid="settings-agent-web-url"
              value={agentWebUrl}
              onChange={(e) => setAgentWebUrl(e.target.value)}
              placeholder="(비우면 agentUrl 에서 도출)"
              spellCheck={false}
            />
            <div className="settings-hint">🤖 임베드 탭이 사용. prod 예: <code>https://cp.tech2.hybe.im/proj-k/agentsdk/</code></div>
          </div>
        )}
      </>
    );
  }

  function renderData() {
    return (
      <>
        <div className="settings-subsection">Perforce</div>
        <div className="settings-row-inline">
          <button
            type="button"
            onClick={runP4Discover}
            disabled={p4Discovering}
            data-testid="settings-p4-discover"
            className="settings-btn-secondary"
          >
            {p4Discovering ? '발견 중…' : '자동 발견'}
          </button>
          {p4DiscoveryMsg && <span className="settings-hint">{p4DiscoveryMsg}</span>}
        </div>
        {shouldShowField('settings-p4-host') && (
          <div className={fieldClass('settings-p4-host')}>
            <label htmlFor="settings-p4-host">P4 Host (P4PORT)</label>
            <input id="settings-p4-host" data-testid="settings-p4-host" value={p4Host} onChange={(e) => setP4Host(e.target.value)} placeholder="perforce:1666" spellCheck={false} />
          </div>
        )}
        {shouldShowField('settings-p4-user') && (
          <div className={fieldClass('settings-p4-user')}>
            <label htmlFor="settings-p4-user">P4 User</label>
            <input id="settings-p4-user" data-testid="settings-p4-user" value={p4User} onChange={(e) => setP4User(e.target.value)} spellCheck={false} />
          </div>
        )}
        {shouldShowField('settings-p4-client') && (
          <div className={fieldClass('settings-p4-client')}>
            <label htmlFor="settings-p4-client">P4 Client</label>
            <input id="settings-p4-client" data-testid="settings-p4-client" value={p4Client} onChange={(e) => setP4Client(e.target.value)} spellCheck={false} />
          </div>
        )}
        {shouldShowField('settings-p4-root') && (
          <div className={fieldClass('settings-p4-root')}>
            <label htmlFor="settings-p4-root">P4 Workspace Root</label>
            <input id="settings-p4-root" data-testid="settings-p4-root" value={p4WorkspaceRoot} onChange={(e) => setP4WorkspaceRoot(e.target.value)} placeholder="C:\Users\... 또는 \\wsl.localhost\..." spellCheck={false} />
            <div className="settings-hint">OneDrive 자동 매핑 기준. sidecar 의 <code>/xlsx_raw</code> fallback.</div>
          </div>
        )}
        <div className="settings-subsection" style={{ marginTop: 16 }}>Confluence 테스트 스페이스</div>
        {shouldShowField('settings-confluence-test-space-key') && (
          <div className={fieldClass('settings-confluence-test-space-key')}>
            <label htmlFor="settings-confluence-test-space-key">테스트 스페이스 키</label>
            <input id="settings-confluence-test-space-key" data-testid="settings-confluence-test-space-key" value={confluenceTestSpaceKey} onChange={(e) => setConfluenceTestSpaceKey(e.target.value)} placeholder="PKTEST 또는 ~personal" spellCheck={false} />
            <div className="settings-hint">리뷰/Apply 검증을 운영 페이지가 아닌 사본에서 안전하게.</div>
          </div>
        )}
        {shouldShowField('settings-confluence-test-parent-page-id') && (
          <div className={fieldClass('settings-confluence-test-parent-page-id')}>
            <label htmlFor="settings-confluence-test-parent-page-id">부모 페이지 ID (선택)</label>
            <input id="settings-confluence-test-parent-page-id" data-testid="settings-confluence-test-parent-page-id" value={confluenceTestParentPageId} onChange={(e) => setConfluenceTestParentPageId(e.target.value)} spellCheck={false} />
            <div className="settings-hint">채우면 그 페이지의 자식, 비우면 스페이스 root.</div>
          </div>
        )}
      </>
    );
  }

  function renderAuth() {
    return (
      <>
        <div className="settings-subsection">Google Workspace SSO</div>
        {shouldShowField('settings-google-client-id') && (
          <div className={fieldClass('settings-google-client-id')}>
            <label htmlFor="settings-google-client-id">OAuth Client ID</label>
            <input
              id="settings-google-client-id"
              data-testid="settings-google-client-id"
              value={googleOAuthClientId}
              onChange={(e) => setGoogleOAuthClientId(e.target.value)}
              placeholder="<gcp-project>.apps.googleusercontent.com"
              spellCheck={false}
            />
            <div className="settings-hint">
              GCP Console (Desktop app 타입). 비우면 <code>PROJK_GOOGLE_CLIENT_ID</code> env 사용. 둘 다 미설정 시 SSO 비활성.
            </div>
          </div>
        )}
        {shouldShowField('settings-google-hd') && (
          <div className={fieldClass('settings-google-hd')}>
            <label htmlFor="settings-google-hd">Workspace 도메인 제한 (hd)</label>
            <input
              id="settings-google-hd"
              data-testid="settings-google-hd"
              value={KLAUD_BUILTIN_WORKSPACE_DOMAIN}
              readOnly
              disabled
              spellCheck={false}
              style={{ opacity: 0.7, cursor: 'not-allowed' }}
            />
            <div className="settings-hint">
              🔒 사내 정책으로 <code>{KLAUD_BUILTIN_WORKSPACE_DOMAIN}</code> 로 고정. dev/staging override 는 <code>PROJK_GOOGLE_WORKSPACE_DOMAIN</code> env.
            </div>
          </div>
        )}
        {shouldShowField('settings-google-status') && (
          <div className={fieldClass('settings-google-status')}>
            <div className="settings-row-inline" data-testid="settings-google-auth-row">
              {googleCreds && googleCreds.hasToken ? (
                <>
                  <span className="settings-hint" data-testid="settings-google-status" style={{ fontSize: 12 }}>
                    ✓ <strong>{googleCreds.email}</strong>
                    {googleCreds.name ? ` (${googleCreds.name})` : ''}
                    {googleCreds.expiresInSeconds < 0 ? ' — 토큰 만료됨, 다시 로그인' : ''}
                  </span>
                  <button type="button" onClick={() => void runGoogleSignOut()} data-testid="settings-google-signout" className="settings-btn-secondary">
                    로그아웃
                  </button>
                </>
              ) : (
                <>
                  <span className="settings-hint" data-testid="settings-google-status" style={{ fontSize: 12 }}>
                    로그인 안 됨 — 로그/제보 의 user_email 이 익명 (machine_id)
                  </span>
                  <button type="button" onClick={() => void runGoogleAuth()} disabled={googleAuthing} data-testid="settings-google-signin" className="settings-btn-secondary">
                    {googleAuthing ? '로그인 중…' : 'Google 로그인'}
                  </button>
                </>
              )}
            </div>
            {googleAuthMsg && (
              <div className="settings-hint" data-testid="settings-google-auth-msg">{googleAuthMsg}</div>
            )}
          </div>
        )}
        <div className="settings-subsection" style={{ marginTop: 16 }}>Confluence (API token)</div>
        {shouldShowField('settings-conf-email') && (
          <div className={fieldClass('settings-conf-email')}>
            <label htmlFor="settings-conf-email">Email</label>
            <input id="settings-conf-email" data-testid="settings-conf-email" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
          </div>
        )}
        {shouldShowField('settings-conf-token') && (
          <div className={fieldClass('settings-conf-token')}>
            <label htmlFor="settings-conf-token">API Token</label>
            <input id="settings-conf-token" data-testid="settings-conf-token" type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder={savedSettings.repoRoot ? '(저장된 token 유지)' : ''} spellCheck={false} />
            <div className="settings-hint">safeStorage (DPAPI) 로 암호화 저장. 비워두고 저장하면 기존 token 유지.</div>
          </div>
        )}
        {shouldShowField('settings-conf-base-url') && (
          <div className={fieldClass('settings-conf-base-url')}>
            <label htmlFor="settings-conf-base-url">Base URL</label>
            <input id="settings-conf-base-url" data-testid="settings-conf-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_BASE_URL} spellCheck={false} />
          </div>
        )}

        {/* 2026-05-13 Final-3: Atlassian OAuth 3LO — apiToken 대체 (Confluence 자동 인증). */}
        <div className="settings-subsection" style={{ marginTop: 16 }}>Atlassian OAuth (Confluence 자동 인증, apiToken 대체)</div>
        {shouldShowField('settings-atlassian-client-id') && (
          <div className={fieldClass('settings-atlassian-client-id')}>
            <label htmlFor="settings-atlassian-client-id">OAuth Client ID</label>
            <input
              id="settings-atlassian-client-id"
              data-testid="settings-atlassian-client-id"
              value={atlassianOAuthClientId}
              onChange={(e) => setAtlassianOAuthClientId(e.target.value)}
              placeholder="developer.atlassian.com/console — OAuth 2.0 (3LO) integration"
              spellCheck={false}
            />
            <div className="settings-hint">
              비우면 <code>PROJK_ATLASSIAN_CLIENT_ID</code> env (예: <code>env/atlassian.env</code>). Client Secret 은 env 만 (보안). 미설정 시 Atlassian SSO 비활성 — 기존 email + apiToken 흐름 fallback.
            </div>
          </div>
        )}
        {shouldShowField('settings-atlassian-status') && (
          <div className={fieldClass('settings-atlassian-status')}>
            <div className="settings-row-inline" data-testid="settings-atlassian-auth-row">
              {atlassianCreds && atlassianCreds.hasToken ? (
                <>
                  <span className="settings-hint" data-testid="settings-atlassian-status" style={{ fontSize: 12 }}>
                    ✓ <strong>{atlassianCreds.display_name ?? atlassianCreds.email ?? atlassianCreds.site_name}</strong>
                    <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>({atlassianCreds.site_url})</span>
                    {atlassianCreds.expiresInSeconds < 0 ? ' — 토큰 만료됨, 다시 로그인' : ''}
                  </span>
                  <button type="button" onClick={() => void runAtlassianSignOut()} data-testid="settings-atlassian-signout" className="settings-btn-secondary">
                    로그아웃
                  </button>
                </>
              ) : (
                <>
                  <span className="settings-hint" data-testid="settings-atlassian-status" style={{ fontSize: 12 }}>
                    로그인 안 됨 — Confluence 접근은 위 email + apiToken 사용
                  </span>
                  <button type="button" onClick={() => void runAtlassianAuth()} disabled={atlassianAuthing} data-testid="settings-atlassian-signin" className="settings-btn-secondary">
                    {atlassianAuthing ? '로그인 중…' : 'Atlassian 로그인'}
                  </button>
                </>
              )}
            </div>
            {atlassianAuthMsg && (
              <div className="settings-hint" data-testid="settings-atlassian-auth-msg">{atlassianAuthMsg}</div>
            )}
          </div>
        )}
      </>
    );
  }

  function renderTelemetry() {
    return (
      <>
        {shouldShowField('settings-klaud-log-sink-url') && (
          <div className={fieldClass('settings-klaud-log-sink-url')}>
            <label htmlFor="settings-klaud-log-sink-url">Klaud log sink URL</label>
            <input
              id="settings-klaud-log-sink-url"
              data-testid="settings-klaud-log-sink-url"
              value={klaudLogSinkUrl}
              onChange={(e) => setKlaudLogSinkUrl(e.target.value)}
              placeholder="https://cp.tech2.hybe.im/proj-k/admin"
              spellCheck={false}
            />
            <div className="settings-hint">
              renderer/main console + 제보 가 <code>{'<URL>/klaud/log/batch'}</code> + <code>{'<URL>/klaud/report'}</code> 로 POST. 관리자 페이지에서 사용자별 조회.
            </div>
          </div>
        )}
        {shouldShowField('settings-klaud-telemetry-enabled') && (
          <div className={fieldClass('settings-klaud-telemetry-enabled')}>
            <label htmlFor="settings-klaud-telemetry-enabled" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                id="settings-klaud-telemetry-enabled"
                type="checkbox"
                data-testid="settings-klaud-telemetry-enabled"
                checked={klaudTelemetryEnabled}
                onChange={(e) => setKlaudTelemetryEnabled(e.target.checked)}
              />
              <span>로그/제보 전송 활성</span>
            </label>
            <div className="settings-hint">체크 해제 시 URL 설정과 무관하게 일체 송신 안 함 (opt-out).</div>
          </div>
        )}
      </>
    );
  }

  function renderAppearance() {
    return (
      <>
        <div className="settings-subsection">Excel Viewer</div>
        {shouldShowField('settings-viewer-mode') && (
          <div className={fieldClass('settings-viewer-mode')}>
            <label htmlFor="settings-viewer-mode">Viewer 모드</label>
            <select id="settings-viewer-mode" data-testid="settings-viewer-mode" value={viewerMode} onChange={(e) => setViewerMode(e.target.value as 'sp' | 'onlyoffice')}>
              <option value="onlyoffice">OnlyOffice (default — sync 함정 0)</option>
              <option value="sp">SharePoint Excel for the Web</option>
            </select>
            <div className="settings-hint">onlyoffice 권장 (자체 호스팅 viewer).</div>
          </div>
        )}
        {shouldShowField('settings-onlyoffice-url') && (
          <div className={fieldClass('settings-onlyoffice-url')}>
            <label htmlFor="settings-onlyoffice-url">OnlyOffice URL</label>
            <input id="settings-onlyoffice-url" data-testid="settings-onlyoffice-url" value={onlyOfficeUrl} onChange={(e) => setOnlyOfficeUrl(e.target.value)} placeholder={DEFAULT_ONLYOFFICE_URL_HINT} spellCheck={false} />
            <div className="settings-hint">OnlyOffice Document Server endpoint. WSL2 IP 재부팅 시 갱신.</div>
          </div>
        )}
        <div className="settings-subsection" style={{ marginTop: 16 }}>탭 동작</div>
        {shouldShowField('settings-auto-pin-on-review') && (
          <div className={fieldClass('settings-auto-pin-on-review')}>
            <label htmlFor="settings-auto-pin-on-review" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                id="settings-auto-pin-on-review"
                type="checkbox"
                data-testid="settings-auto-pin-on-review"
                checked={autoPinOnReview}
                onChange={(e) => setAutoPinOnReview(e.target.checked)}
              />
              <span>리뷰 모드 진입 시 그 탭을 자동으로 고정</span>
            </label>
            <div className="settings-hint">"리뷰하기" 칩 클릭 시 좌측에 자동 고정. 컨텍스트 스위칭해도 그 탭이 항상 보임.</div>
          </div>
        )}
      </>
    );
  }

  function renderDev() {
    return (
      <>
        {shouldShowField('settings-mcp-bridge-enabled') && (
          <div className={fieldClass('settings-mcp-bridge-enabled')}>
            <label htmlFor="settings-mcp-bridge-enabled" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input id="settings-mcp-bridge-enabled" type="checkbox" data-testid="settings-mcp-bridge-enabled" checked={mcpBridgeEnabled} onChange={(e) => setMcpBridgeEnabled(e.target.checked)} />
              <span>MCP Bridge 활성</span>
            </label>
            <div className="settings-hint">Klaud ↔ Claude Code 양방향 RPC. dev 모드에서만 권장.</div>
          </div>
        )}
        {shouldShowField('settings-mcp-bridge-url') && (
          <div className={fieldClass('settings-mcp-bridge-url')}>
            <label htmlFor="settings-mcp-bridge-url">MCP Bridge URL</label>
            <input id="settings-mcp-bridge-url" data-testid="settings-mcp-bridge-url" value={mcpBridgeUrl} onChange={(e) => setMcpBridgeUrl(e.target.value)} placeholder={DEFAULT_MCP_BRIDGE_URL_HINT} spellCheck={false} disabled={!mcpBridgeEnabled} />
          </div>
        )}
        {shouldShowField('settings-log-collector-url') && (
          <div className={fieldClass('settings-log-collector-url')}>
            <label htmlFor="settings-log-collector-url">Log Collector URL (dev)</label>
            <input id="settings-log-collector-url" data-testid="settings-log-collector-url" value={logCollectorUrl} onChange={(e) => setLogCollectorUrl(e.target.value)} placeholder={DEFAULT_LOG_COLLECTOR_URL_HINT} spellCheck={false} />
            <div className="settings-hint">main console 을 WSL collector(8772) 로 fire-and-forget. 운영 모니터링과는 별개.</div>
          </div>
        )}
        {shouldShowField('settings-dev-bundle-url') && (
          <div className={fieldClass('settings-dev-bundle-url')}>
            <label htmlFor="settings-dev-bundle-url">Dev Bundle URL (hot swap)</label>
            <input id="settings-dev-bundle-url" data-testid="settings-dev-bundle-url" value={devBundleUrl} onChange={(e) => setDevBundleUrl(e.target.value)} placeholder={DEFAULT_DEV_BUNDLE_URL_HINT} spellCheck={false} />
            <div className="settings-hint">5초 폴링으로 out/ 변경 감지 + swap + relaunch.</div>
          </div>
        )}
      </>
    );
  }

  function renderActive() {
    switch (activeCategory) {
      case 'general':
        return renderGeneral();
      case 'data':
        return renderData();
      case 'auth':
        return renderAuth();
      case 'telemetry':
        return renderTelemetry();
      case 'appearance':
        return renderAppearance();
      case 'backend':
        return renderBackend();
      case 'dev':
        return renderDev();
    }
    return null;
  }

  const visibleCategories = isSearching ? matchingCategories : CATEGORIES;

  return (
    <div className="settings-modal-backdrop" data-testid="settings-modal-backdrop" onClick={onClose}>
      <div className="settings-modal" data-testid="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-modal-header">
          <span className="settings-modal-title">
            <i className="codicon codicon-settings-gear" aria-hidden="true" /> 설정
          </span>
          <input
            ref={searchRef}
            type="search"
            className="settings-modal-search"
            data-testid="settings-modal-search"
            placeholder="설정 검색 — 예: google, p4, 로그, 고정, viewer  (Ctrl+F)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button type="button" className="settings-modal-close" data-testid="settings-modal-close" onClick={onClose} aria-label="닫기">
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-modal-body">
          <nav className="settings-modal-nav" data-testid="settings-modal-nav" aria-label="설정 카테고리">
            {visibleCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`settings-modal-nav-item${activeCategory === c.id ? ' active' : ''}`}
                data-testid={`settings-modal-nav-${c.id}`}
                onClick={() => setActiveCategory(c.id)}
              >
                <span aria-hidden="true" style={{ marginRight: 6 }}>{c.icon}</span>
                {c.label}
              </button>
            ))}
            {isSearching && matchingCategories.length === 0 && (
              <div className="settings-hint" style={{ padding: 12 }} data-testid="settings-modal-no-results">
                검색 결과 없음
              </div>
            )}
          </nav>
          <section className="settings-modal-content" data-testid={`settings-modal-content-${activeCategory}`}>
            {renderActive()}
          </section>
        </div>

        <footer className="settings-modal-footer">
          <button type="button" className="settings-btn-secondary" onClick={onClose}>취소</button>
          <button type="button" className="settings-btn-primary" onClick={save} disabled={saving} data-testid="settings-save">
            {saving ? '저장 중…' : '저장하고 적용'}
          </button>
        </footer>
      </div>
    </div>
  );
}
