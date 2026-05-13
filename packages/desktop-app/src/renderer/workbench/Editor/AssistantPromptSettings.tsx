import { useEffect, useState } from 'react';
import { fetchAssistantPreset, type AssistantPreset } from '../../api';
import {
  clearOverride,
  loadOverride,
  saveOverride,
  type AssistantPromptMode,
} from '../../panels/assistant-prompt-overrides';

// 2026-05-12: ⚙ 토글이 여는 prompt override 뷰.
// 2026-05-13: modal + 탭 (요약/리뷰) 으로 전면 리팩터. 사용자 피드백 — 어시스턴트
// 패널 안에 있어서 textarea 가 너무 좁음. modal backdrop + 큰 컨테이너 + 한 번에 한
// 모드만 노출 → textarea 가 화면 가용 영역 대부분 차지.
//
// 동작은 동일:
// 1. mount 시 summary/review preset 을 백엔드에서 병렬 fetch.
// 2. 저장된 override 가 있으면 textarea 의 default = override, 없으면 = preset.
// 3. 사용자가 수정 후 "저장" 누르면 localStorage 에 저장. textarea 가 preset 과
//    정확히 동일하면 override 삭제 (다음부터 preset 자동 추종).
// 4. "preset 으로 되돌리기" 버튼 — textarea 를 preset 으로 리셋 + 저장된 override 삭제.

interface ModeState {
  preset: AssistantPreset | null;
  // fetch 실패 시 preset === null, error 메시지 채워짐.
  error: string | null;
  loading: boolean;
  // 사용자가 textarea 에서 편집 중인 값. preset 도착 전엔 빈 문자열.
  draft: string;
  // 가장 마지막으로 저장된 override (있으면). 저장 직후 갱신.
  saved: string | null;
  savedAt: number | null;
}

interface Props {
  onBack: () => void;
  onClose: () => void;
}

const MODES: { key: AssistantPromptMode; label: string; icon: string }[] = [
  { key: 'summary', label: '요약', icon: '📄' },
  { key: 'review', label: '리뷰', icon: '📋' },
];

function emptyState(): ModeState {
  return { preset: null, error: null, loading: true, draft: '', saved: null, savedAt: null };
}

export function AssistantPromptSettings({ onBack, onClose }: Props) {
  const [states, setStates] = useState<Record<AssistantPromptMode, ModeState>>({
    summary: emptyState(),
    review: emptyState(),
  });
  const [activeMode, setActiveMode] = useState<AssistantPromptMode>('summary');
  const [savingMode, setSavingMode] = useState<AssistantPromptMode | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(MODES.map((m) => fetchAssistantPreset(m.key))).then((presets) => {
      if (cancelled) return;
      setStates((cur) => {
        const next = { ...cur };
        MODES.forEach((m, i) => {
          const preset = presets[i];
          const override = loadOverride(m.key);
          if (preset) {
            next[m.key] = {
              preset,
              error: null,
              loading: false,
              draft: override?.prompt ?? preset.prompt,
              saved: override?.prompt ?? null,
              savedAt: override?.savedAt ?? null,
            };
          } else {
            // 백엔드 fetch 실패 — override 만이라도 보여줌, textarea 는 빈 상태로.
            next[m.key] = {
              preset: null,
              error: '백엔드에서 preset 을 가져오지 못했습니다 — agent-sdk-poc 가 켜져 있는지 확인하세요.',
              loading: false,
              draft: override?.prompt ?? '',
              saved: override?.prompt ?? null,
              savedAt: override?.savedAt ?? null,
            };
          }
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ESC 로 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateDraft = (mode: AssistantPromptMode, value: string) => {
    setStates((cur) => ({ ...cur, [mode]: { ...cur[mode], draft: value } }));
  };

  const handleSave = (mode: AssistantPromptMode) => {
    const s = states[mode];
    if (!s.preset) return; // preset 미도착 — 저장 비활성
    setSavingMode(mode);
    const trimmedDraft = s.draft.trim();
    const trimmedPreset = s.preset.prompt.trim();
    if (!trimmedDraft || trimmedDraft === trimmedPreset) {
      // override 가 preset 과 동일 or 비어있음 → 저장 삭제 (다음부터 preset 추종)
      clearOverride(mode);
      setStates((cur) => ({
        ...cur,
        [mode]: { ...cur[mode], saved: null, savedAt: null, draft: s.preset!.prompt },
      }));
      setFlash(`${labelOf(mode)} prompt — preset 으로 복원되었습니다.`);
    } else {
      saveOverride(mode, s.draft, s.preset.version);
      setStates((cur) => ({
        ...cur,
        [mode]: { ...cur[mode], saved: s.draft, savedAt: Date.now() },
      }));
      setFlash(`${labelOf(mode)} prompt 저장되었습니다.`);
    }
    setSavingMode(null);
    window.setTimeout(() => setFlash(null), 2500);
  };

  const handleReset = (mode: AssistantPromptMode) => {
    const s = states[mode];
    if (!s.preset) return;
    clearOverride(mode);
    setStates((cur) => ({
      ...cur,
      [mode]: { ...cur[mode], saved: null, savedAt: null, draft: s.preset!.prompt },
    }));
    setFlash(`${labelOf(mode)} prompt — preset 으로 되돌렸습니다.`);
    window.setTimeout(() => setFlash(null), 2500);
  };

  const cur = states[activeMode];
  const overridden = cur.saved !== null;
  const presetVersion = cur.preset?.version;
  const presetMatchesDraft =
    cur.preset != null && cur.draft.trim() === cur.preset.prompt.trim();

  return (
    <div
      className="assistant-prompt-settings-backdrop"
      data-testid="assistant-prompt-settings-backdrop"
      onClick={onClose}
    >
      <div
        className="assistant-prompt-settings"
        data-testid="assistant-prompt-settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="assistant-prompt-settings-header">
          <button
            type="button"
            className="doc-assistant-back"
            onClick={onBack}
            aria-label="모드 다시 선택"
            title="모드 다시 선택"
            data-testid="assistant-prompt-settings-back"
          >
            ←
          </button>
          <span className="assistant-prompt-settings-title">
            <i className="codicon codicon-settings-gear" aria-hidden="true" /> 어시스턴트 프롬프트 설정
          </span>
          <button
            type="button"
            className="doc-assistant-close"
            onClick={onClose}
            aria-label="설정 닫기"
            title="설정 닫기"
            data-testid="assistant-prompt-settings-close"
          >
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>

        <div className="assistant-prompt-settings-intro" data-testid="assistant-prompt-settings-intro">
          요약 / 리뷰에 사용되는 기본 prompt 가 textarea 에 채워져 있습니다. 자유롭게
          수정해서 저장하면 다음 호출부터 그 텍스트가 그대로 사용됩니다. 저장된 값은
          이 PC 에만 보관됩니다 (localStorage).
        </div>

        {/* 2026-05-13: 모드 탭 — 한 번에 한 모드만 노출해 textarea 공간 최대 확보. */}
        <div
          className="assistant-prompt-settings-tabs"
          data-testid="assistant-prompt-settings-tabs"
          role="tablist"
        >
          {MODES.map((m) => {
            const s = states[m.key];
            const isActive = activeMode === m.key;
            const hasOverride = s.saved !== null;
            return (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`assistant-prompt-settings-tab${isActive ? ' active' : ''}`}
                onClick={() => setActiveMode(m.key)}
                data-testid={`assistant-prompt-settings-tab-${m.key}`}
              >
                <span aria-hidden="true">{m.icon}</span> {m.label}
                {hasOverride && (
                  <span
                    className="assistant-prompt-settings-tab-dot"
                    aria-label="사용자 override 사용 중"
                    title="사용자 override 사용 중"
                  />
                )}
              </button>
            );
          })}
        </div>

        {flash && (
          <div className="assistant-prompt-settings-flash" data-testid="assistant-prompt-settings-flash">
            {flash}
          </div>
        )}

        <section
          className="assistant-prompt-mode"
          data-testid={`assistant-prompt-mode-${activeMode}`}
        >
          <div className="assistant-prompt-mode-head">
            <span
              className="assistant-prompt-mode-meta"
              data-testid={`assistant-prompt-mode-meta-${activeMode}`}
            >
              {cur.loading
                ? 'preset 불러오는 중…'
                : overridden
                  ? `사용자 override 사용 중${presetVersion ? ` · preset ${presetVersion}` : ''}`
                  : `preset 사용 중${presetVersion ? ` (${presetVersion})` : ''}`}
            </span>
          </div>
          {cur.error && (
            <div
              className="assistant-prompt-mode-error"
              data-testid={`assistant-prompt-mode-error-${activeMode}`}
            >
              ⚠️ {cur.error}
            </div>
          )}
          <textarea
            className="assistant-prompt-mode-textarea"
            value={cur.draft}
            onChange={(e) => updateDraft(activeMode, e.target.value)}
            spellCheck={false}
            placeholder={cur.loading ? '불러오는 중…' : 'prompt 가 비어있습니다 — preset 을 받아오지 못했습니다.'}
            data-testid={`assistant-prompt-mode-textarea-${activeMode}`}
            disabled={cur.loading}
          />
          <div className="assistant-prompt-mode-actions">
            <button
              type="button"
              className="assistant-prompt-mode-save"
              onClick={() => handleSave(activeMode)}
              disabled={cur.loading || !cur.preset || savingMode === activeMode}
              data-testid={`assistant-prompt-mode-save-${activeMode}`}
            >
              {presetMatchesDraft && overridden ? 'preset 으로 저장' : '저장'}
            </button>
            <button
              type="button"
              className="assistant-prompt-mode-reset"
              onClick={() => handleReset(activeMode)}
              disabled={cur.loading || !cur.preset || !overridden}
              data-testid={`assistant-prompt-mode-reset-${activeMode}`}
            >
              preset 으로 되돌리기
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function labelOf(mode: AssistantPromptMode): string {
  return mode === 'summary' ? '요약' : '리뷰';
}
