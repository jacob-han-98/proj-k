import { useEffect, useState } from 'react';

// agent-sdk-poc 웹 임베드 — Klaud 안에 풀화면 webview.
//
// 이유: agent-sdk-poc 의 frontend (대화 / admin / fork / shared / 출처 split / refactor 등)
// 가 4000+ 줄 규모로 이미 완성되어 있음. Klaud 안 reimplement 대신 webview 로 임베드해
// UI 일관성 자동 + 백엔드 update 시 즉시 반영.
//
// URL 도출: settings.agentUrl 이 API base (.../proj-k/agentsdk/api). web frontend 는 동일
// origin 의 /proj-k/agentsdk/. /api 접미사만 strip.
//   prod: https://cp.tech2.hybe.im/proj-k/agentsdk/api  →  https://cp.tech2.hybe.im/proj-k/agentsdk/
//   dev:  http://127.0.0.1:8090                          →  (dev 는 web 가 별도 포트, 사용자 override 필요)
//
// 현재는 agentUrl 만 보고 derive. 사용자가 dev frontend (Vite) 를 쓰려면 agentWebUrl
// 별도 설정 필요 — 후속 PR 에서 추가.
//
// 세션: persist:agent partition (main/index.ts 에서 등록). 회사 SSO 쿠키 영속.

export function deriveAgentWebUrl(agentUrl: string | undefined | null): string | null {
  if (!agentUrl || typeof agentUrl !== 'string') return null;
  const trimmed = agentUrl.trim().replace(/\/$/, '');
  if (!trimmed) return null;
  // /api 또는 /api/ 접미사 strip → web 루트.
  const stripped = trimmed.replace(/\/api$/, '');
  // web 루트는 trailing slash 가 자연스러움.
  return stripped + '/';
}

export function AgentWebView() {
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await window.projk.getSettings();
        if (cancelled) return;
        setAgentUrl(deriveAgentWebUrl(s.agentUrl));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!loaded) {
    return (
      <main className="center agent-web-pane" data-testid="agent-web-pane">
        <div className="placeholder">로딩 중…</div>
      </main>
    );
  }

  if (!agentUrl) {
    return (
      <main className="center agent-web-pane" data-testid="agent-web-pane">
        <div className="placeholder agent-web-empty" data-testid="agent-web-empty">
          <div style={{ fontSize: 28, marginBottom: 8 }}>🤖</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Agent 백엔드 URL 미설정</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', maxWidth: 480, lineHeight: 1.5 }}>
            설정에서 <code>agentUrl</code> 을 입력하면 그 백엔드의 웹 UI 가 여기 임베드됩니다.
            <br />예: <code>https://cp.tech2.hybe.im/proj-k/agentsdk/api</code>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="center agent-web-pane" data-testid="agent-web-pane">
      <div className="doc-header agent-web-header">
        <span>🤖 Agent</span>
        <span className="breadcrumb" title={agentUrl}>{agentUrl}</span>
        <span className="actions">
          <button
            type="button"
            onClick={() => window.open(agentUrl, '_blank')}
            data-testid="agent-web-open-external"
            title="외부 브라우저로 열기"
          >↗ 새 창</button>
        </span>
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <webview
        src={agentUrl}
        partition="persist:agent"
        data-testid="agent-webview"
        {...({ allowpopups: 'true' } as any)}
        style={{ width: '100%', height: 'calc(100% - 44px)' }}
      />
    </main>
  );
}
