import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/types';

// 단일 모달에서 데이터 경로 / 자동 업데이트 피드 / Confluence 자격증명 까지 모두 입력.
// 사용자가 PowerShell 의 setx 와 손으로 환경변수 만질 일이 없도록 흡수.

interface Props {
  initialEmail?: string;
  initialBaseUrl?: string;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_BASE_URL = 'https://bighitcorp.atlassian.net';
// dev 환경에서 자주 쓰는 디폴트 — 사용자가 그대로 둬도 되고 빈 칸으로 비활성도 OK.
const DEFAULT_REPO_ROOT_HINT = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k';
const DEFAULT_FEED_URL_HINT = 'http://localhost:8766/';
const DEFAULT_RETRIEVER_URL_HINT = 'http://localhost:8088';
const DEFAULT_AGENT_URL_HINT = 'http://localhost:8090';
const DEFAULT_MCP_BRIDGE_URL_HINT = 'ws://localhost:8769';
const DEFAULT_LOG_COLLECTOR_URL_HINT = 'http://localhost:8772';
const DEFAULT_DEV_BUNDLE_URL_HINT = 'http://localhost:8773';

export function SettingsModal({ initialEmail, initialBaseUrl, onClose, onSaved }: Props) {
  const [repoRoot, setRepoRoot] = useState('');
  const [updateFeedUrl, setUpdateFeedUrl] = useState('');
  const [retrieverUrl, setRetrieverUrl] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [mcpBridgeEnabled, setMcpBridgeEnabled] = useState(true);
  const [mcpBridgeUrl, setMcpBridgeUrl] = useState('');
  const [logCollectorUrl, setLogCollectorUrl] = useState('');
  const [devBundleUrl, setDevBundleUrl] = useState('');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [apiToken, setApiToken] = useState('');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? DEFAULT_BASE_URL);
  const [saving, setSaving] = useState(false);
  const [savedSettings, setSavedSettings] = useState<AppSettings>({});

  useEffect(() => {
    window.projk.getSettings().then((s) => {
      setSavedSettings(s);
      // 저장된 값이 있으면 그걸 채우고, 첫 부팅이면 권장 default 로 미리 채워서
      // 사용자가 그냥 "저장하고 적용" 누르기만 하면 동작하게 한다.
      setRepoRoot(s.repoRoot ?? DEFAULT_REPO_ROOT_HINT);
      setUpdateFeedUrl(s.updateFeedUrl ?? DEFAULT_FEED_URL_HINT);
      setRetrieverUrl(s.retrieverUrl ?? DEFAULT_RETRIEVER_URL_HINT);
      setAgentUrl(s.agentUrl ?? DEFAULT_AGENT_URL_HINT);
      setMcpBridgeEnabled(s.mcpBridgeEnabled !== false); // default true
      setMcpBridgeUrl(s.mcpBridgeUrl ?? DEFAULT_MCP_BRIDGE_URL_HINT);
      setLogCollectorUrl(s.logCollectorUrl ?? DEFAULT_LOG_COLLECTOR_URL_HINT);
      setDevBundleUrl(s.devBundleUrl ?? DEFAULT_DEV_BUNDLE_URL_HINT);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      // 1) 데이터 경로 / 피드 URL / 백엔드 URL / dev 디버그 옵션 저장 (비밀 아님)
      await window.projk.setSettings({
        repoRoot: repoRoot.trim() || undefined,
        updateFeedUrl: updateFeedUrl.trim() || undefined,
        retrieverUrl: retrieverUrl.trim() || undefined,
        agentUrl: agentUrl.trim() || undefined,
        mcpBridgeEnabled,
        mcpBridgeUrl: mcpBridgeUrl.trim() || undefined,
        logCollectorUrl: logCollectorUrl.trim() || undefined,
        devBundleUrl: devBundleUrl.trim() || undefined,
      });

      // 2) Confluence 자격증명 (비밀 — safeStorage 암호화)
      if (email && apiToken) {
        await window.projk.setConfluenceCreds({ email: email.trim(), apiToken, baseUrl: baseUrl.trim() });
      }

      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="creds-modal" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <h3>
          설정
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}>
            앱 v{__APP_VERSION__}
          </span>
        </h3>

        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -4, marginBottom: 4 }}>
          데이터 / 자동 업데이트
        </div>
        <label htmlFor="settings-repo-root">데이터 루트 (PROJK_REPO_ROOT)</label>
        <input
          id="settings-repo-root"
          aria-label="데이터 루트"
          data-testid="settings-repo-root"
          value={repoRoot}
          onChange={(e) => setRepoRoot(e.target.value)}
          placeholder={DEFAULT_REPO_ROOT_HINT}
          spellCheck={false}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          P4 미러 + Confluence 미러가 들어있는 폴더. 비워두면 트리 비활성.
        </div>

        <label htmlFor="settings-feed-url" style={{ marginTop: 6 }}>자동 업데이트 피드 URL</label>
        <input
          id="settings-feed-url"
          aria-label="자동 업데이트 피드 URL"
          data-testid="settings-feed-url"
          value={updateFeedUrl}
          onChange={(e) => setUpdateFeedUrl(e.target.value)}
          placeholder={DEFAULT_FEED_URL_HINT}
          spellCheck={false}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          예: <code>http://localhost:8766/</code>. 비워두면 자동 업데이트 OFF.
        </div>

        <label htmlFor="settings-retriever-url" style={{ marginTop: 8 }}>검색 백엔드 URL (qna-poc)</label>
        <input
          id="settings-retriever-url"
          aria-label="검색 백엔드 URL"
          data-testid="settings-retriever-url"
          value={retrieverUrl}
          onChange={(e) => setRetrieverUrl(e.target.value)}
          placeholder={DEFAULT_RETRIEVER_URL_HINT}
          spellCheck={false}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          관련 문서 검색에 사용. 미설정 시 검색 결과 0건.
        </div>

        <label htmlFor="settings-agent-url" style={{ marginTop: 6 }}>에이전트 백엔드 URL (agent-sdk-poc)</label>
        <input
          id="settings-agent-url"
          aria-label="에이전트 백엔드 URL"
          data-testid="settings-agent-url"
          value={agentUrl}
          onChange={(e) => setAgentUrl(e.target.value)}
          placeholder={DEFAULT_AGENT_URL_HINT}
          spellCheck={false}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          답변 스트리밍에 사용. 미설정 시 stub 응답.
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 12, marginBottom: 4 }}>
          개발용 디버그 (dev only)
        </div>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' }}
        >
          <input
            type="checkbox"
            checked={mcpBridgeEnabled}
            onChange={(e) => setMcpBridgeEnabled(e.target.checked)}
            data-testid="settings-mcp-bridge-enabled"
          />
          MCP bridge 활성화 (Claude Code 가 tool 로 직접 조작)
        </label>

        <label htmlFor="settings-mcp-bridge" style={{ marginTop: 8 }}>MCP Bridge URL</label>
        <input
          id="settings-mcp-bridge"
          aria-label="MCP Bridge URL"
          data-testid="settings-mcp-bridge-url"
          value={mcpBridgeUrl}
          onChange={(e) => setMcpBridgeUrl(e.target.value)}
          placeholder={DEFAULT_MCP_BRIDGE_URL_HINT}
          spellCheck={false}
          disabled={!mcpBridgeEnabled}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          예: <code>ws://localhost:8769</code>. WSL의 <code>npm run -w packages/desktop-app … klaud-mcp-server</code> 와 양방향 RPC.
        </div>

        <label htmlFor="settings-log-collector" style={{ marginTop: 8 }}>Log collector URL</label>
        <input
          id="settings-log-collector"
          aria-label="Log collector URL"
          data-testid="settings-log-collector-url"
          value={logCollectorUrl}
          onChange={(e) => setLogCollectorUrl(e.target.value)}
          placeholder={DEFAULT_LOG_COLLECTOR_URL_HINT}
          spellCheck={false}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          예: <code>http://localhost:8772</code>. Klaud main console 을 fire-and-forget POST. WSL의 <code>npm run serve:log-collector</code> 가 받아 file + stdout 미러. 미설정 시 push 비활성.
        </div>

        <label htmlFor="settings-dev-bundle-url" style={{ marginTop: 8 }}>Dev bundle URL (hot swap)</label>
        <input
          id="settings-dev-bundle-url"
          aria-label="Dev bundle URL"
          data-testid="settings-dev-bundle-url"
          value={devBundleUrl}
          onChange={(e) => setDevBundleUrl(e.target.value)}
          placeholder={DEFAULT_DEV_BUNDLE_URL_HINT}
          spellCheck={false}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -4 }}>
          예: <code>http://localhost:8773</code>. WSL <code>npm run serve:dev-bundle</code> 가 out/ 를 host. 5초 polling 으로 변경 감지 → swap → relaunch (빌드 cycle ~5초). 미설정 시 비활성.
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 12, marginBottom: 4 }}>
          Confluence 자격증명 (선택 — webview 인증)
        </div>
        <label htmlFor="settings-email">이메일</label>
        <input
          id="settings-email"
          aria-label="이메일"
          data-testid="settings-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@hybe.im"
        />
        <label htmlFor="settings-token">API Token</label>
        <input
          id="settings-token"
          aria-label="API Token"
          data-testid="settings-token"
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={initialEmail ? '(저장된 값 유지하려면 비워둠)' : 'Atlassian API token'}
        />
        <label htmlFor="settings-base-url">Base URL</label>
        <input
          id="settings-base-url"
          aria-label="Base URL"
          data-testid="settings-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <div className="row">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? '저장 중…' : '저장하고 적용'}
          </button>
        </div>

        {(savedSettings.repoRoot || savedSettings.updateFeedUrl) && (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            저장 위치: <code>{`{userData}/settings.json`}</code> (앱 재시작 사이 유지)
          </div>
        )}
      </div>
    </div>
  );
}
