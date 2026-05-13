// 2026-05-12: ModePickerEmpty ⚙ 설정 — 요약/리뷰 prompt override 영속 저장.
//
// 사용자 의도: 백엔드의 preset prompt 를 textarea 에 prefilled 로 본 뒤 자유롭게
// 수정 → 다음 요약/리뷰 호출 시 그 수정본이 그대로 백엔드의 prompt_override 로 전달.
// preset 일치 (사용자가 수정 안 함) 또는 빈 문자열은 저장 X — 그래야 백엔드 preset
// 이 갱신될 때 자동으로 따라감.
//
// key: `klaud:assistant-prompt-override:summary` / `:review`
// value: { prompt: string, presetVersion: string, savedAt: number, schemaVersion: 1 }

export type AssistantPromptMode = 'summary' | 'review';

const KEY_PREFIX = 'klaud:assistant-prompt-override:';
const SCHEMA_VERSION = 1;

export interface AssistantPromptOverride {
  prompt: string;
  // 백엔드 preset 의 version — preset 이 갱신되면 frontend 가 사용자에게 "preset 이
  // 바뀌었음, override 재검토" 알릴 수 있게. 빈 문자열이면 version 모르고 저장된 옛 값.
  presetVersion: string;
  savedAt: number;
  schemaVersion: number;
}

function keyOf(mode: AssistantPromptMode): string {
  return `${KEY_PREFIX}${mode}`;
}

export function loadOverride(mode: AssistantPromptMode): AssistantPromptOverride | null {
  try {
    const raw = localStorage.getItem(keyOf(mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AssistantPromptOverride>;
    if (typeof parsed?.prompt !== 'string' || parsed.schemaVersion !== SCHEMA_VERSION) {
      return null;
    }
    return {
      prompt: parsed.prompt,
      presetVersion: typeof parsed.presetVersion === 'string' ? parsed.presetVersion : '',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      schemaVersion: SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}

export function saveOverride(
  mode: AssistantPromptMode,
  prompt: string,
  presetVersion: string,
): void {
  const value: AssistantPromptOverride = {
    prompt,
    presetVersion,
    savedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  };
  try {
    localStorage.setItem(keyOf(mode), JSON.stringify(value));
  } catch {
    /* quota or disabled — 무시 */
  }
}

export function clearOverride(mode: AssistantPromptMode): void {
  try {
    localStorage.removeItem(keyOf(mode));
  } catch {
    /* ignore */
  }
}

// 호출 측 편의 — 백엔드에 보낼 prompt_override 값 결정.
// override 가 있고 preset 과 다르면 그 텍스트 반환, 같으면 undefined (preset 사용).
export function effectiveOverride(
  mode: AssistantPromptMode,
  presetPrompt: string,
): string | undefined {
  const o = loadOverride(mode);
  if (!o) return undefined;
  const trimmed = o.prompt.trim();
  if (!trimmed) return undefined;
  if (trimmed === presetPrompt.trim()) return undefined;
  return o.prompt;
}
