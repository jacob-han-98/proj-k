import { useEffect, useState } from 'react';
import type { SidecarStatus } from '../../shared/types';
import { UpdateIndicator } from './UpdateIndicator';

// VS Code 스타일 frameless title bar.
// main process 에서 BrowserWindow({frame:false}) 로 OS 기본 title bar 가 사라졌고,
// 이 컴포넌트가 그 36px 높이를 그대로 차지하면서:
//   1) 좌측: Klaud + 버전 + 선택된 문서 breadcrumb
//   2) 우측: UpdateIndicator + sidecar 상태 pill + ⚙ 설정 + min/max/close
// CSS 의 -webkit-app-region: drag 로 이 영역을 잡고 끌면 창 이동.
// 모든 interactive 요소는 .no-drag 클래스로 drag 영역에서 제외.
//
// '데스크톱 앱 — 브랜드 + 사용자 제약 원칙' (CLAUDE.md): 사용자 표기는 'Klaud'.
// 'Project K' 식별자는 electron-builder 쪽 productName/appId 로만 살아있고 사용자 화면에서 사라짐.

interface Props {
  sidecar: SidecarStatus;
  breadcrumb: string;
  onOpenSettings: () => void;
}

export function TitleBar({ sidecar, breadcrumb, onOpenSettings }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.projk.win.isMaximized().then(setMaximized);
    const off = window.projk.win.onMaximizedChange(setMaximized);
    return off;
  }, []);

  const sidecarClass =
    sidecar.state === 'ready' ? 'ready' : sidecar.state === 'error' ? 'error' : '';

  return (
    <header className="topbar" data-testid="app-titlebar">
      <span className="title no-drag" data-testid="app-version">
        Klaud{' '}
        <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 11 }}>
          v{__APP_VERSION__}
        </span>
      </span>
      <span className="breadcrumb" style={{ color: 'var(--text-dim)' }}>
        {breadcrumb}
      </span>
      <div className="topbar-actions no-drag">
        <UpdateIndicator />
        <span
          className={`status-pill ${sidecarClass}`}
          title={sidecar.message ?? ''}
          data-testid="sidecar-pill"
        >
          sidecar {sidecar.state}
          {sidecar.port ? ` :${sidecar.port}` : ''}
          {sidecar.message && sidecar.state !== 'ready' ? ` — ${sidecar.message}` : ''}
        </span>
        <button
          type="button"
          className="topbar-settings"
          onClick={onOpenSettings}
          data-testid="topbar-settings"
        >
          ⚙ 설정
        </button>
      </div>
      <div className="window-controls no-drag" role="toolbar" aria-label="창 컨트롤">
        <button
          type="button"
          className="window-control"
          onClick={() => window.projk.win.minimize()}
          aria-label="최소화"
          data-testid="window-minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="window-control"
          onClick={() => window.projk.win.maximizeToggle()}
          aria-label={maximized ? '창 모드' : '최대화'}
          data-testid="window-maximize"
        >
          {maximized ? (
            // restore 아이콘 — 두 겹 사각형 (윈도우 표준).
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" />
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="window-control close"
          onClick={() => window.projk.win.close()}
          aria-label="닫기"
          data-testid="window-close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  );
}
