import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOverride,
  effectiveOverride,
  loadOverride,
  saveOverride,
} from '../../src/renderer/panels/assistant-prompt-overrides';

// 2026-05-12: ModePickerEmpty ⚙ 설정 — 요약/리뷰 prompt override 영속 저장.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assistant-prompt-overrides', () => {
  it('save → load round-trip — summary', () => {
    saveOverride('summary', '한 문단으로 요약', 'v1');
    const got = loadOverride('summary');
    expect(got).not.toBeNull();
    expect(got!.prompt).toBe('한 문단으로 요약');
    expect(got!.presetVersion).toBe('v1');
    expect(got!.schemaVersion).toBe(1);
    expect(typeof got!.savedAt).toBe('number');
  });

  it('summary 와 review override 가 서로 분리된 key 사용', () => {
    saveOverride('summary', 'S-prompt', 'v1');
    saveOverride('review', 'R-prompt', 'v1');
    expect(loadOverride('summary')!.prompt).toBe('S-prompt');
    expect(loadOverride('review')!.prompt).toBe('R-prompt');
  });

  it('clearOverride 후 load 는 null', () => {
    saveOverride('review', 'x', 'v1');
    expect(loadOverride('review')).not.toBeNull();
    clearOverride('review');
    expect(loadOverride('review')).toBeNull();
  });

  it('schemaVersion 안 맞으면 load 가 null (자동 invalidate)', () => {
    storage.setItem(
      'klaud:assistant-prompt-override:summary',
      JSON.stringify({ prompt: 'old', presetVersion: 'v0', savedAt: 0, schemaVersion: 999 }),
    );
    expect(loadOverride('summary')).toBeNull();
  });

  it('prompt 가 string 아니면 null (방어)', () => {
    storage.setItem(
      'klaud:assistant-prompt-override:summary',
      JSON.stringify({ prompt: 123, presetVersion: 'v1', savedAt: 0, schemaVersion: 1 }),
    );
    expect(loadOverride('summary')).toBeNull();
  });

  describe('effectiveOverride', () => {
    it('저장된 override 가 preset 과 다르면 그 텍스트 반환', () => {
      saveOverride('summary', '커스텀 prompt', 'v1');
      expect(effectiveOverride('summary', '기본 preset')).toBe('커스텀 prompt');
    });

    it('override 가 preset 과 동일하면 undefined (preset 사용)', () => {
      saveOverride('summary', '기본 preset', 'v1');
      expect(effectiveOverride('summary', '기본 preset')).toBeUndefined();
    });

    it('override 가 trim 후 preset 과 동일해도 undefined', () => {
      saveOverride('summary', '  기본 preset  \n', 'v1');
      expect(effectiveOverride('summary', '기본 preset')).toBeUndefined();
    });

    it('override 가 비어있으면 undefined', () => {
      saveOverride('summary', '   \n   ', 'v1');
      expect(effectiveOverride('summary', '기본 preset')).toBeUndefined();
    });

    it('저장된 override 가 없으면 undefined', () => {
      expect(effectiveOverride('summary', '기본 preset')).toBeUndefined();
    });
  });
});
