// B2-3b: confluence-apply.ts 의 tryFindAndReplace 단위 테스트 — 단계적 fallback 검증.

import { describe, expect, it } from 'vitest';
import { tryFindAndReplace } from '../../src/main/confluence-apply';

describe('tryFindAndReplace — strategy 단계 검증', () => {
  it('exact 매칭 — 가장 우선', () => {
    const r = tryFindAndReplace('hello world', 'world', 'there');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newBody).toBe('hello there');
      expect(r.strategy).toBe('exact');
    }
  });

  it('exact 실패 → whitespace normalize 단계 회복 (개행/공백 차이)', () => {
    // body 안 줄바꿈 + 다중 공백, before 는 단일 공백
    const body = 'preamble\n\n   <p>안녕   하세요   세상</p>\n\nepilogue';
    const r = tryFindAndReplace(body, '안녕 하세요 세상', '안녕!');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe('normalize');
      expect(r.newBody).toContain('안녕!');
      expect(r.newBody).not.toContain('안녕   하세요');
    }
  });

  it('exact / normalize 실패 → HTML strip + 단어 매칭 회복', () => {
    // storage 안에 inline 마크업이 끼어 있어 본문 텍스트로는 직접 매칭 X.
    const body = '<p>플레이어가 <custom data-type="emoji" data-id="id-0">:fire:</custom> 캐릭터를 조종한다</p>';
    const r = tryFindAndReplace(body, '플레이어가 캐릭터를 조종한다', '유저가 PC를 조작한다');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe('html-strip');
      expect(r.newBody).toContain('유저가 PC를 조작한다');
      expect(r.newBody).not.toContain('플레이어가');
    }
  });

  it('모두 실패 시 ok:false + reason', () => {
    const r = tryFindAndReplace('hello world', 'completely different text', 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('매칭 실패');
  });

  it('빈 before/after → ok:false', () => {
    expect(tryFindAndReplace('body', '', 'after').ok).toBe(false);
    expect(tryFindAndReplace('body', 'before', '').ok).toBe(false);
  });

  it('exact 단계 — 첫 번째 매칭만 교체 (중복 fragment 안전성)', () => {
    const r = tryFindAndReplace('a b a b a', 'a b', 'X');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newBody).toBe('X a b a');
  });

  it('exact 시 trim — 양끝 공백 무시', () => {
    const r = tryFindAndReplace('hello world stuff', '  world  ', 'there');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newBody).toBe('hello there stuff');
  });

  it('한글 normalize — 줄바꿈 + 다중 공백', () => {
    const body = 'A\n\n사용자가 게임을\n시작한다\n\nB';
    const r = tryFindAndReplace(body, '사용자가 게임을 시작한다', '플레이어가 시작');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe('normalize');
      expect(r.newBody).toContain('플레이어가 시작');
    }
  });
});
