import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_ICON_STORAGE_KEY,
  loadActiveIcon,
  saveActiveIcon,
} from '../../src/renderer/workbench/store';

// 회귀 방지: 0.1.49 까지 store.ts 의 activeIcon 이 매 부팅 시 'confluence' hardcode 였던
// 문제. 사용자가 P4 사이드바를 열고 작업하다 앱 재시작하면 매번 Confluence 로 돌아감.
// 0.1.50 부터 localStorage 영속.

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

describe('activeIcon persist (localStorage)', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('처음 부팅이면 기본값 confluence', () => {
    expect(loadActiveIcon()).toBe('confluence');
  });

  it('save 후 load 하면 같은 값', () => {
    saveActiveIcon('p4');
    expect(loadActiveIcon()).toBe('p4');
    saveActiveIcon('find');
    expect(loadActiveIcon()).toBe('find');
  });

  it('알 수 없는 값이 저장되어 있으면 기본값으로 fallback (사용자 PC 에 옛 키 남아있어도 안전)', () => {
    storage.setItem(ACTIVE_ICON_STORAGE_KEY, 'unknown-kind');
    expect(loadActiveIcon()).toBe('confluence');
  });

  it('localStorage 접근 자체가 실패해도 기본값 반환 (private mode 등)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(loadActiveIcon()).toBe('confluence');
    // setItem throw 해도 throw 가 사용자에게 새지 않아야 함.
    expect(() => saveActiveIcon('qna')).not.toThrow();
  });

  it('5 종 모든 SidebarKind round-trip', () => {
    const kinds = ['p4', 'confluence', 'find', 'qna', 'recent'] as const;
    for (const k of kinds) {
      saveActiveIcon(k);
      expect(loadActiveIcon()).toBe(k);
    }
  });
});
