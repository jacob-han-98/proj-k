import { useEffect, useState } from 'react';
import type { UpdaterState } from '../../shared/types';

// 우측 하단 토스트. 상태 별 표시:
//   downloading → 진행률 바
//   ready       → "재시작하여 v1.2.3 설치" 버튼
//   error       → 에러 메시지 (사용자가 닫을 수 있음)
//   그 외        → 표시 안 함

export function UpdateToast() {
  const [state, setState] = useState<UpdaterState>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.projk.getUpdaterState().then((r) => {
      if (r) setState(r.state);
    });
    const off = window.projk.onUpdaterState((s) => {
      setState(s);
      if (s.state === 'ready' || s.state === 'error') setDismissed(false);
    });
    return off;
  }, []);

  if (dismissed) return null;
  if (state.state === 'idle' || state.state === 'checking' || state.state === 'not-available') {
    return null;
  }
  if (state.state === 'available') {
    return (
      <div className="update-toast" data-testid="update-toast">
        <div className="title">새 버전 발견 v{state.version}</div>
        <div className="meta">백그라운드 다운로드 중…</div>
      </div>
    );
  }
  if (state.state === 'downloading') {
    const pct = Math.round(state.percent);
    const kbps = (state.bytesPerSecond / 1024).toFixed(0);
    return (
      <div className="update-toast" data-testid="update-toast">
        <div className="title">업데이트 다운로드 중 ({pct}%)</div>
        <div className="meta">{kbps} KB/s</div>
        <div className="progress"><div className="bar" style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }
  if (state.state === 'ready') {
    return (
      <div className="update-toast" data-testid="update-toast">
        <div className="title">업데이트 v{state.version} 준비됨</div>
        <div className="meta">앱을 재시작하면 적용됩니다.</div>
        {state.releaseNotes && (
          <div className="meta" style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' }}>
            {state.releaseNotes}
          </div>
        )}
        <div className="row">
          <button onClick={() => setDismissed(true)}>나중에</button>
          <button
            className="primary"
            onClick={() => window.projk.quitAndInstall()}
            data-testid="update-restart"
          >
            지금 재시작
          </button>
        </div>
      </div>
    );
  }
  if (state.state === 'error') {
    return (
      <div className="update-toast" data-testid="update-toast">
        <div className="title" style={{ color: '#dc2626' }}>업데이트 오류</div>
        <div className="meta">{state.message}</div>
        <div className="row">
          <button onClick={() => setDismissed(true)}>닫기</button>
        </div>
      </div>
    );
  }
  return null;
}
