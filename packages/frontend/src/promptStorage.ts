/**
 * 사용자별 커스텀 프롬프트 — localStorage CRUD
 *
 * 각 파이프라인 단계(planning, answer, reflection 등)의 시스템 프롬프트를
 * 사용자가 브라우저 로컬에서 override할 수 있다.
 */

const STORAGE_KEY = 'qna-prompt-overrides';

export function getPromptOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function setPromptOverride(key: string, value: string): void {
  const overrides = getPromptOverrides();
  overrides[key] = value;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function removePromptOverride(key: string): void {
  const overrides = getPromptOverrides();
  delete overrides[key];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function resetAllOverrides(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasAnyOverrides(): boolean {
  return Object.keys(getPromptOverrides()).length > 0;
}
