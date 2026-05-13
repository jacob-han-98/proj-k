import { useEffect, useState } from 'react';
import { fetchAssistantPreset, type AssistantPreset } from '../../api';
import {
  clearOverride,
  loadOverride,
  saveOverride,
  type AssistantPromptMode,
} from '../../panels/assistant-prompt-overrides';

// 2026-05-12: ModePickerEmpty ⚙ 토글이 열어주는 설정 뷰. 어시스턴트 패널 안에서
// 같은 자리에 swap (mode='settings').
//
// 동작:
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

  return (
    <div
      className="assistant-prompt-settings"
      data-testid="assistant-prompt-settings"
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

      {flash && (
        <div className="assistant-prompt-settings-flash" data-testid="assistant-prompt-settings-flash">
          {flash}
        </div>
      )}

      <div className="assistant-prompt-settings-body">
        {MODES.map((m) => {
          const s = states[m.key];
          const overridden = s.saved !== null;
          const presetVersion = s.preset?.version;
          const presetMatchesDraft =
            s.preset != null && s.draft.trim() === s.preset.prompt.trim();
          return (
            <section
              key={m.key}
              className="assistant-prompt-mode"
              data-testid={`assistant-prompt-mode-${m.key}`}
            >
              <div className="assistant-prompt-mode-head">
                <span className="assistant-prompt-mode-label">
                  <span aria-hidden="true">{m.icon}</span> {m.label}
                </span>
                <span className="assistant-prompt-mode-meta" data-testid={`assistant-prompt-mode-meta-${m.key}`}>
                  {s.loading
                    ? 'preset 불러오는 중…'
                    : overridden
                      ? `사용자 override 사용 중${presetVersion ? ` · preset ${presetVersion}` : ''}`
                      : `preset 사용 중${presetVersion ? ` (${presetVersion})` : ''}`}
                </span>
              </div>
              {s.error && (
                <div className="assistant-prompt-mode-error" data-testid={`assistant-prompt-mode-error-${m.key}`}>
                  ⚠️ {s.error}
                </div>
              )}
              <textarea
                className="assistant-prompt-mode-textarea"
                value={s.draft}
                onChange={(e) => updateDraft(m.key, e.target.value)}
                spellCheck={false}
                rows={14}
                placeholder={s.loading ? '불러오는 중…' : 'prompt 가 비어있습니다 — preset 을 받아오지 못했습니다.'}
                data-testid={`assistant-prompt-mode-textarea-${m.key}`}
                disabled={s.loading}
              />
              <div className="assistant-prompt-mode-actions">
                <button
                  type="button"
                  className="assistant-prompt-mode-save"
                  onClick={() => handleSave(m.key)}
                  disabled={s.loading || !s.preset || savingMode === m.key}
                  data-testid={`assistant-prompt-mode-save-${m.key}`}
                >
                  {presetMatchesDraft && overridden ? 'preset 으로 저장' : '저장'}
                </button>
                <button
                  type="button"
                  className="assistant-prompt-mode-reset"
                  onClick={() => handleReset(m.key)}
                  disabled={s.loading || !s.preset || !overridden}
                  data-testid={`assistant-prompt-mode-reset-${m.key}`}
                >
                  preset 으로 되돌리기
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function labelOf(mode: AssistantPromptMode): string {
  return mode === 'summary' ? '요약' : '리뷰';
}
