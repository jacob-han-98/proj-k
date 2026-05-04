import { describe, expect, it } from 'vitest';
import { pruneExpanded } from '../../src/renderer/workbench/Sidebar/tree-state-persist';

// 회귀 방지: 트리 상태 영속에서 사용자가 마지막에 펼쳐뒀던 폴더 ID 가 트리 데이터에서
// 사라진 경우, 무리하게 복원 시도하지 않고 silently 제거해야 한다는 정책 (사용자 요구).

describe('pruneExpanded — 영속된 expanded 의 valid 검증', () => {
  it('모두 valid 면 그대로 유지', () => {
    const stored = new Set(['a', 'b', 'c']);
    const valid = new Set(['a', 'b', 'c', 'd']);
    const pruned = pruneExpanded(stored, valid);
    expect(Array.from(pruned).sort()).toEqual(['a', 'b', 'c']);
  });

  it('일부 사라진 ID 는 silently 제거 (P4 stream/Confluence 페이지 삭제 시나리오)', () => {
    const stored = new Set(['a', 'orphaned', 'b']);
    const valid = new Set(['a', 'b']);
    const pruned = pruneExpanded(stored, valid);
    expect(Array.from(pruned).sort()).toEqual(['a', 'b']);
  });

  it('모두 사라졌으면 빈 set', () => {
    const stored = new Set(['x', 'y']);
    const valid = new Set(['a', 'b']);
    expect(pruneExpanded(stored, valid).size).toBe(0);
  });

  it('빈 stored 는 그대로 (트리 walk 비용 회피 + 같은 reference 반환)', () => {
    const stored = new Set<string>();
    const valid = new Set(['a']);
    const result = pruneExpanded(stored, valid);
    expect(result).toBe(stored); // same reference — re-render 회피
  });

  it('valid 가 비어있으면 모두 제거', () => {
    const stored = new Set(['a', 'b']);
    expect(pruneExpanded(stored, new Set()).size).toBe(0);
  });
});
