import { describe, expect, it, beforeEach } from 'vitest';
import { useWorkbenchStore } from '../../src/renderer/workbench/store';

// P0: SplitPayload 의 mode 필드 분기 검증.
// - openSplit 기본 mode 는 'pick' (수동 시작 — 사용자가 모드 칩 누를 때까지 백엔드 호출 X).
// - 명시적 mode 인자도 동작.
// - setSplitMode 는 trigger 갱신해서 effect 가 재발동되도록.
// - 같은 mode 로 setSplitMode 재호출 시 state 변경 없음 (trigger 도 안 갱신).
//
// 회귀 방지: 향후 누군가 trigger 갱신 로직을 빼버리면 mode 칩 클릭해도 ReviewSplitPane 의
// trigger-deps useEffect 가 안 돌아 stream 이 안 시작되는 사고가 나는데, 이 테스트가 그걸 잡음.

describe('SplitPayload mode', () => {
  beforeEach(() => {
    // 각 테스트 시작 시 깨끗한 상태로.
    useWorkbenchStore.setState({ tabSplits: {} });
  });

  it('openSplit 기본 mode 는 pick (수동 시작)', () => {
    useWorkbenchStore.getState().openSplit('tab-1', '제목', '본문');
    const split = useWorkbenchStore.getState().tabSplits['tab-1'];
    expect(split).toBeDefined();
    expect(split?.mode).toBe('pick');
    expect(split?.title).toBe('제목');
    expect(split?.text).toBe('본문');
    expect(typeof split?.trigger).toBe('number');
  });

  it('openSplit 의 mode 인자가 명시적으로 들어오면 그 값 그대로 저장', () => {
    useWorkbenchStore.getState().openSplit('tab-1', '제목', '본문', 'review');
    const split = useWorkbenchStore.getState().tabSplits['tab-1'];
    expect(split?.mode).toBe('review');
  });

  it('setSplitMode 는 mode 갱신 + trigger 도 갱신해서 effect 재발동 보장', async () => {
    useWorkbenchStore.getState().openSplit('tab-1', '제목', '본문');
    const before = useWorkbenchStore.getState().tabSplits['tab-1'];
    expect(before?.mode).toBe('pick');
    const t0 = before!.trigger;

    // Date.now() 가 같은 ms 안에 떨어지면 trigger 가 같을 수 있어 한 번 sleep.
    await new Promise((r) => setTimeout(r, 5));

    useWorkbenchStore.getState().setSplitMode('tab-1', 'review');
    const after = useWorkbenchStore.getState().tabSplits['tab-1'];
    expect(after?.mode).toBe('review');
    expect(after!.trigger).toBeGreaterThan(t0);
  });

  it('setSplitMode 가 같은 mode 로 호출되면 state 안 바뀜 (no-op)', () => {
    useWorkbenchStore.getState().openSplit('tab-1', '제목', '본문', 'review');
    const before = useWorkbenchStore.getState().tabSplits['tab-1'];

    useWorkbenchStore.getState().setSplitMode('tab-1', 'review');
    const after = useWorkbenchStore.getState().tabSplits['tab-1'];
    // 같은 reference (set 함수가 early return) — trigger 도 안 갱신.
    expect(after).toBe(before);
  });

  it('setSplitMode 가 존재 안 하는 tabId 로 호출되면 silent no-op', () => {
    useWorkbenchStore.getState().setSplitMode('tab-없음', 'review');
    expect(useWorkbenchStore.getState().tabSplits['tab-없음']).toBeUndefined();
  });

  it('closeSplit 시 mode 와 함께 payload 정리', () => {
    useWorkbenchStore.getState().openSplit('tab-1', '제목', '본문', 'review');
    expect(useWorkbenchStore.getState().tabSplits['tab-1']).toBeDefined();
    useWorkbenchStore.getState().closeSplit('tab-1');
    expect(useWorkbenchStore.getState().tabSplits['tab-1']).toBeUndefined();
  });
});
