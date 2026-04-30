import { useEffect, useState } from 'react';
import type { TreeNode } from '../../shared/types';

interface Props {
  selection: { kind: 'sheet' | 'confluence'; node: TreeNode } | null;
  confluenceConfigured: boolean;
  onPromptCreds: () => void;
  // PoC 2A — relPath 기반 매핑. App 이 settings 에서 load 후 prop 으로 내려줌.
  sheetMappings: Record<string, string>;
  onUpsertSheetMapping: (relPath: string, url: string) => void;
}

const CONFLUENCE_BASE = 'https://bighitcorp.atlassian.net';

export function CenterPane({
  selection,
  confluenceConfigured,
  onPromptCreds,
  sheetMappings,
  onUpsertSheetMapping,
}: Props) {

  if (!selection) {
    return (
      <main className="center" data-testid="center-pane">
        <div className="placeholder">
          좌측 트리에서 시트나 페이지를 선택하세요.
        </div>
      </main>
    );
  }

  if (selection.kind === 'sheet') {
    const relPath = selection.node.relPath ?? selection.node.id;
    const mappedUrl = sheetMappings[relPath];
    if (mappedUrl) {
      return (
        <main className="center" data-testid="center-pane">
          <div className="doc-header">
            <span>📄 {selection.node.title}</span>
            <span className="breadcrumb">{selection.node.relPath}</span>
            <span className="actions">
              <button
                onClick={() => window.open(mappedUrl, '_blank')}
                data-testid="sheet-open-onedrive"
                title="새 창으로 열기"
              >
                ↗ 새 창
              </button>
            </span>
          </div>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <webview
            key={selection.node.id}
            src={mappedUrl}
            partition="persist:onedrive"
            {...({ allowpopups: 'true' } as any)}
            style={{ width: '100%', height: 'calc(100% - 44px)' }}
          />
        </main>
      );
    }
    // 매핑 없음 — 사용자가 OneDrive 에 upload 후 share URL 등록.
    return (
      <SheetMappingPrompt
        node={selection.node}
        relPath={relPath}
        onSubmit={onUpsertSheetMapping}
      />
    );
  }

  // Confluence — webview 안에서 사용자가 직접 로그인.
  const url = `${CONFLUENCE_BASE}/wiki/spaces/PK/pages/${selection.node.confluencePageId}`;
  return (
    <main className="center" data-testid="center-pane">
      <div className="doc-header">
        <span>📘 {selection.node.title}</span>
        <span className="breadcrumb">{selection.node.relPath}</span>
        <span className="actions">
          <button onClick={() => window.open(url, '_blank')} title="외부 브라우저">↗</button>
        </span>
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <webview
        key={selection.node.id}
        src={url}
        partition="persist:confluence"
        {...({ allowpopups: 'true' } as any)}
        style={{ width: '100%', height: 'calc(100% - 44px)' }}
      />
    </main>
  );
}

// PoC 2B — sheet 매핑 미등록 시 두 path:
//   (1) 자동 upload — Microsoft 인증 → file picker → OneDrive 에 upload + 매핑 자동
//   (2) 수동 — 사용자가 share URL 직접 등록
function SheetMappingPrompt(props: {
  node: TreeNode;
  relPath: string;
  onSubmit: (relPath: string, url: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [syncAccount, setSyncAccount] = useState<{
    userFolder: string;
    userUrl: string;
    userEmail: string;
  } | null>(null);
  const [syncDetected, setSyncDetected] = useState<boolean | null>(null); // null=확인 중, false=미설정
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // 마운트 시 OneDrive Business sync 클라이언트 detect → 성공하면 자동 흐름 트리거.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await window.projk.oneDriveSync.detect();
      if (cancelled) return;
      if (!r.ok) {
        setSyncDetected(false);
        return;
      }
      setSyncAccount({
        userFolder: r.userFolder,
        userUrl: r.userUrl,
        userEmail: r.userEmail,
      });
      setSyncDetected(true);
      // 자동 흐름 — sidecar 에서 P4 원본 fetch + sync 폴더 복사 + 매핑 등록.
      // 사용자 클릭 0회. 실패 시 사용자가 수동 file picker 또는 manual share URL 선택 가능.
      setBusy(true);
      setInfo(`자동 매핑 진행 중 — sidecar 에서 fetch → OneDrive Sync 폴더 → 클라우드 upload 대기 (~15초)…`);
      const auto = await window.projk.oneDriveSync.auto(props.relPath);
      if (cancelled) return;
      setBusy(false);
      if (auto.ok) {
        setInfo(`✓ 자동 매핑 완료 — ${auto.localPath}`);
        props.onSubmit(props.relPath, auto.url);
      } else {
        // 첫 sheet 부터 P4 워크스페이스 root 가 settings 에 없어서 sidecar 가 file 못 찾는 경우
        // 사용자가 .xlsx 한 번만 선택하면 그 path 에서 root 가 자동 추정되어 다음부터 자동.
        const hint = auto.error?.includes('파일 없음') || auto.error?.includes('미설정')
          ? ' — 처음 한 번만 .xlsx 를 선택해주세요. 그 다음부터는 자동입니다.'
          : '';
        setInfo(`자동 매핑 실패: ${auto.error}${hint}`);
      }
    })();
    return () => { cancelled = true; };
  }, [props.relPath]);

  const submitManual = () => {
    const v = url.trim();
    if (v) props.onSubmit(props.relPath, v);
  };

  const syncUpload = async () => {
    setBusy(true);
    setInfo('.xlsx 선택 → OneDrive Sync 폴더에 복사 → 클라우드 upload 대기 (~15초)…');
    const r = await window.projk.oneDriveSync.upload(props.relPath);
    setBusy(false);
    if (r.ok) {
      setInfo(`✓ 매핑 완료 — ${r.localPath} (P4 워크스페이스 자동 등록됨, 다음 sheet 부터 자동)`);
      props.onSubmit(props.relPath, r.url);
    } else if (r.canceled) {
      setInfo('파일 선택 취소');
    } else {
      setInfo(`매핑 실패: ${r.error}`);
    }
  };

  return (
    <main className="center" data-testid="center-pane">
      <div className="doc-header">
        <span>📄 {props.node.title}</span>
        <span className="breadcrumb">{props.relPath}</span>
      </div>
      <div className="preview-body" style={{ maxWidth: 720 }}>
        <p style={{ fontSize: 13, marginTop: 4 }}>
          이 시트는 OneDrive 매핑이 등록되지 않았습니다.
        </p>

        {/* 자동 path — Sync 클라이언트 우회 (admin consent 불필요) */}
        {syncDetected !== false && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 12,
              marginTop: 12,
              background: 'var(--bg-elev)',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
              🚀 자동 매핑 (권장)
            </div>
            {syncDetected === null && (
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 0 }}>
                OneDrive Sync 클라이언트 확인 중…
              </p>
            )}
            {syncAccount && (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 0 }}>
                  Sync 폴더 감지됨 ({syncAccount.userEmail}). .xlsx 선택하면 자동으로 OneDrive 에 올리고 webview 에 임베드합니다.
                </p>
                <button
                  onClick={syncUpload}
                  disabled={busy}
                  data-testid="onedrive-sync-upload"
                  className="primary"
                >
                  {busy ? '진행 중…' : '📂 .xlsx 선택해서 자동 매핑'}
                </button>
              </>
            )}
            {info && <p style={{ fontSize: 11, marginTop: 6 }}>{info}</p>}
          </div>
        )}
        {syncDetected === false && (
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 12 }}>
            ⚠ OneDrive Business Sync 클라이언트가 감지되지 않았습니다 — 수동 등록으로 진행하세요.
          </p>
        )}

        {/* 수동 path */}
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-dim)' }}>
            또는 share URL 직접 등록
          </summary>
          <ol style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.7, marginTop: 6 }}>
            <li>OneDrive 에서 같은 파일을 업로드 (P4 구조 그대로 권장).</li>
            <li>그 파일 <strong>공유</strong> → <strong>링크 복사</strong> (편집 가능).</li>
            <li>아래에 붙여넣기.</li>
          </ol>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://...sharepoint.com/:x:/g/personal/.../?e=..."
              data-testid="sheet-mapping-input"
              style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitManual(); }}
            />
            <button onClick={submitManual} data-testid="sheet-mapping-save">
              저장
            </button>
          </div>
        </details>

        <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
          relPath: <code>{props.relPath}</code>
        </p>
      </div>
    </main>
  );
}
