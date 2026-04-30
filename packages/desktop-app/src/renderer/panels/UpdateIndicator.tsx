import { useEffect, useState, useMemo } from 'react';
import type { UpdaterState } from '../../shared/types';

// 토바에 항상 떠있는 작은 업데이트 상태 indicator.
// - 토스트는 "ready 발생 시 알림" 용 (휘발성)
// - indicator 는 "현재 업데이트 시스템이 어떤 상태인지" 항상 표시 (지속성)
//
// 클릭 동작:
//   ready    → 즉시 quitAndInstall (silent + auto-relaunch)
//   그 외     → 수동 폴링 (manual check)

function relativeTime(ts: number | null): string {
  if (!ts) return '미실행';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '방금';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

export function UpdateIndicator() {
  const [state, setState] = useState<UpdaterState>({ state: 'idle' });
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void window.projk.getUpdaterState().then((r) => {
      if (r) {
        setState(r.state);
        setLastCheckedAt(r.lastCheckedAt);
      }
    });
    const off = window.projk.onUpdaterState(setState);
    return off;
  }, []);

  const view = useMemo<{ label: string; level: 'ok' | 'busy' | 'attention' | 'error' | 'mute' }>(() => {
    switch (state.state) {
      case 'idle':
        return { label: lastCheckedAt ? `최신 (${relativeTime(lastCheckedAt)})` : '업데이트 미확인', level: 'mute' };
      case 'checking':
        return { label: '확인 중…', level: 'busy' };
      case 'not-available':
        return { label: `최신 v${state.current} (${relativeTime(lastCheckedAt)})`, level: 'ok' };
      case 'available':
        return { label: `v${state.version} 발견`, level: 'busy' };
      case 'downloading':
        return { label: `다운로드 ${Math.round(state.percent)}%`, level: 'busy' };
      case 'ready':
        return { label: `v${state.version} 준비됨 → 클릭`, level: 'attention' };
      case 'error':
        return { label: `업데이트 오류`, level: 'error' };
    }
  }, [state, lastCheckedAt]);

  const onClick = async () => {
    if (state.state === 'ready') {
      void window.projk.quitAndInstall();
      return;
    }
    if (checking) return;
    setChecking(true);
    try {
      const r = await window.projk.checkForUpdate();
      if (r?.lastCheckedAt) setLastCheckedAt(r.lastCheckedAt);
    } finally {
      setChecking(false);
    }
  };

  const tooltip =
    state.state === 'error'
      ? `오류: ${state.message ?? ''}`
      : state.state === 'ready'
        ? '클릭하면 새 버전으로 즉시 재시작'
        : state.state === 'downloading'
          ? `${(state.bytesPerSecond / 1024).toFixed(0)} KB/s`
          : '클릭해서 지금 확인';

  return (
    <button
      className={`update-indicator ${view.level}`}
      data-testid="update-indicator"
      data-state={state.state}
      onClick={onClick}
      title={tooltip}
      type="button"
    >
      <span className="dot" aria-hidden="true" />
      <span className="label">{view.label}</span>
    </button>
  );
}
