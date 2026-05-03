// B2-3a: word-level LCS diff (chrome-extension/lib/diff-engine.js TS 포팅) 단위 테스트.

import { describe, expect, it } from 'vitest';
import { computeWordDiff, diffOpsForDisplay, stripHtml, type DiffOp } from '../../src/renderer/panels/diff-engine';

function joinAll(ops: DiffOp[]): string {
  return ops.map((o) => o.text).join('');
}

describe('computeWordDiff', () => {
  it('동일 텍스트 → all same, 원문 복원', () => {
    const ops = computeWordDiff('hello world', 'hello world');
    expect(ops.every((o) => o.type === 'same')).toBe(true);
    expect(joinAll(ops)).toBe('hello world');
  });

  it('단어 추가 → added 포함', () => {
    const ops = computeWordDiff('hello', 'hello world');
    expect(ops.some((o) => o.type === 'added')).toBe(true);
    // ops 순서가 same → added → ... 형태로 after 의 단어 모두 포함
    const added = ops.filter((o) => o.type === 'added').map((o) => o.text).join('');
    expect(added).toContain('world');
  });

  it('단어 삭제 → removed 포함', () => {
    const ops = computeWordDiff('hello world', 'hello');
    const removed = ops.filter((o) => o.type === 'removed').map((o) => o.text).join('');
    expect(removed).toContain('world');
  });

  it('단어 교체 → removed + added', () => {
    const ops = computeWordDiff('hello world', 'hello there');
    const types = new Set(ops.map((o) => o.type));
    expect(types.has('removed')).toBe(true);
    expect(types.has('added')).toBe(true);
  });

  it('인접 same-type op 가 merge 됨 (한 span 으로)', () => {
    // 'aa bb' → 'aa bb cc' — added 토큰이 ' ' 와 'cc' 두 개 연속 → merge 후 1 span.
    const ops = computeWordDiff('aa bb', 'aa bb cc');
    const addedSpans = ops.filter((o) => o.type === 'added');
    expect(addedSpans.length).toBe(1);
    expect(addedSpans[0]!.text).toContain('cc');
  });

  it('한글 텍스트 — 동일 부분 + 추가', () => {
    const ops = computeWordDiff('보강 사항: 흐름 누락', '보강 사항: 흐름 누락 — 추가 설명');
    // 추가 부분에 "추가 설명" 들어있어야
    const added = ops.filter((o) => o.type === 'added').map((o) => o.text).join('');
    expect(added).toContain('추가');
    expect(added).toContain('설명');
  });

  it('빈 문자열 → 빈 ops', () => {
    expect(computeWordDiff('', '').filter((o) => o.text.length > 0)).toEqual([]);
  });

  it('before 만 비면 모두 added', () => {
    const ops = computeWordDiff('', 'new content');
    expect(ops.every((o) => o.type === 'added' || o.text === '')).toBe(true);
  });

  it('after 만 비면 모두 removed', () => {
    const ops = computeWordDiff('old content', '');
    expect(ops.every((o) => o.type === 'removed' || o.text === '')).toBe(true);
  });
});

describe('stripHtml', () => {
  it('태그 제거', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toContain('hello');
    expect(stripHtml('<p>hello <b>world</b></p>')).toContain('world');
    expect(stripHtml('<p>hello <b>world</b></p>')).not.toContain('<p>');
  });
  it('entity 일부 디코드 (fallback path)', () => {
    // jsdom 없이도 fallback 으로 처리 — entity 변환 검증.
    // 실제 jsdom 환경에서도 결과는 동일.
    const out = stripHtml('a&amp;b&lt;c&gt;d&nbsp;e');
    expect(out).toContain('a&b');
    expect(out).toContain('<c>');
    expect(out).toContain(' e');
  });
});

describe('diffOpsForDisplay', () => {
  it('HTML 안 텍스트 단어 diff', () => {
    const ops = diffOpsForDisplay('<p>hello world</p>', '<p>hello there</p>');
    const text = ops.map((o) => o.text).join('');
    expect(text).toContain('hello');
    // tag 자체는 제거됨
    expect(text).not.toContain('<p>');
  });
});
