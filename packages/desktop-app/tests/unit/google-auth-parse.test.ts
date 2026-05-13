// 2026-05-13 릴리스-B: id_token (JWT) payload 디코딩 단위 테스트.
//
// parseIdToken 은 서명 검증 없이 payload 만 base64url 디코딩 — backend (Google public keys
// 로 RS256 verify) 가 위조 검사 책임. frontend 는 사용자 email/name 표시 + 만료 확인용.

import { describe, expect, it } from 'vitest';
import { parseIdToken } from '../../src/main/google-auth';

// 헬퍼 — JWT 모양 만들기 (header.payload.signature, 서명은 미사용).
function makeJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const b64 = (o: object): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64(header)}.${b64(payload)}.fakesignature`;
}

describe('parseIdToken', () => {
  it('정상 JWT — email/name/picture/hd/sub/exp 파싱', () => {
    const token = makeJwt({
      email: 'user@bighitcorp.com',
      email_verified: true,
      name: 'Jacob Han',
      picture: 'https://lh3.googleusercontent.com/abc',
      hd: 'bighitcorp.com',
      sub: '1234567890',
      exp: 1700000000,
      aud: 'client-id.apps.googleusercontent.com',
    });
    const out = parseIdToken(token);
    expect(out.email).toBe('user@bighitcorp.com');
    expect(out.email_verified).toBe(true);
    expect(out.name).toBe('Jacob Han');
    expect(out.picture).toBe('https://lh3.googleusercontent.com/abc');
    expect(out.hd).toBe('bighitcorp.com');
    expect(out.sub).toBe('1234567890');
    expect(out.exp).toBe(1700000000);
    expect(out.aud).toBe('client-id.apps.googleusercontent.com');
  });

  it('잘못된 형식 (parts 수 불일치) → 빈 객체', () => {
    expect(parseIdToken('not.jwt')).toEqual({});
    expect(parseIdToken('')).toEqual({});
    expect(parseIdToken('a.b.c.d')).toEqual({});
  });

  it('JSON 깨진 payload → 빈 객체', () => {
    expect(parseIdToken('aaa.bbb.ccc')).toEqual({});
  });

  it('hd 없는 token (일반 gmail.com 등) → hd undefined', () => {
    const token = makeJwt({ email: 'someone@gmail.com', sub: '1' });
    const out = parseIdToken(token);
    expect(out.email).toBe('someone@gmail.com');
    expect(out.hd).toBeUndefined();
  });

  it('base64url padding 누락된 payload 도 디코딩', () => {
    // payload 길이 16 — base64 padding 없이 encode 되는 케이스 모방.
    const token = makeJwt({ email: 'a@b.com' });
    const out = parseIdToken(token);
    expect(out.email).toBe('a@b.com');
  });
});
