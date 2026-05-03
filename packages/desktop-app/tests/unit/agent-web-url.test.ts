import { describe, expect, it } from 'vitest';
import { deriveAgentWebUrl, resolveAgentWebUrl } from '../../src/renderer/workbench/Editor/AgentWebView';

describe('deriveAgentWebUrl', () => {
  it('prod URL — /api 접미사 strip + trailing /', () => {
    expect(deriveAgentWebUrl('https://cp.tech2.hybe.im/proj-k/agentsdk/api'))
      .toBe('https://cp.tech2.hybe.im/proj-k/agentsdk/');
  });

  it('trailing / 가 있는 prod URL', () => {
    expect(deriveAgentWebUrl('https://cp.tech2.hybe.im/proj-k/agentsdk/api/'))
      .toBe('https://cp.tech2.hybe.im/proj-k/agentsdk/');
  });

  it('/api 가 없는 URL — 그대로 + trailing /', () => {
    expect(deriveAgentWebUrl('http://localhost:8090'))
      .toBe('http://localhost:8090/');
  });

  it('null / undefined / 빈 문자열 — null', () => {
    expect(deriveAgentWebUrl(null)).toBeNull();
    expect(deriveAgentWebUrl(undefined)).toBeNull();
    expect(deriveAgentWebUrl('')).toBeNull();
    expect(deriveAgentWebUrl('   ')).toBeNull();
  });

  it('whitespace 정리', () => {
    expect(deriveAgentWebUrl('  http://x.com/api  ')).toBe('http://x.com/');
  });

  it('"api" 가 path 중간에 있어도 끝에 있는 것만 strip', () => {
    expect(deriveAgentWebUrl('http://x.com/api/v2'))
      .toBe('http://x.com/api/v2/');
    expect(deriveAgentWebUrl('http://api.example.com/api'))
      .toBe('http://api.example.com/');
  });
});

describe('resolveAgentWebUrl', () => {
  it('agentWebUrl 명시 — 그대로 사용 (agentUrl 무시)', () => {
    expect(resolveAgentWebUrl('https://cp.tech2.hybe.im/proj-k/agentsdk/', 'http://localhost:8090'))
      .toBe('https://cp.tech2.hybe.im/proj-k/agentsdk/');
  });

  it('agentWebUrl 명시 + trailing / 없음 → 추가', () => {
    expect(resolveAgentWebUrl('https://cp.tech2.hybe.im/proj-k/agentsdk', 'http://x'))
      .toBe('https://cp.tech2.hybe.im/proj-k/agentsdk/');
  });

  it('agentWebUrl 비어있음 — agentUrl 에서 도출', () => {
    expect(resolveAgentWebUrl('', 'https://cp.tech2.hybe.im/proj-k/agentsdk/api'))
      .toBe('https://cp.tech2.hybe.im/proj-k/agentsdk/');
  });

  it('agentWebUrl 공백만 — agentUrl 에서 도출 (공백은 명시 아님)', () => {
    expect(resolveAgentWebUrl('   ', 'http://x.com/api')).toBe('http://x.com/');
  });

  it('둘 다 비어있으면 null', () => {
    expect(resolveAgentWebUrl(null, null)).toBeNull();
    expect(resolveAgentWebUrl(undefined, undefined)).toBeNull();
    expect(resolveAgentWebUrl('', '')).toBeNull();
  });

  it('실용: localhost API + prod web override', () => {
    // 사용자 케이스 — agentUrl 은 dev 서버, 임베드만 prod 보고 싶음.
    expect(resolveAgentWebUrl('https://cp.tech2.hybe.im/proj-k/agentsdk/', 'http://127.0.0.1:8090'))
      .toBe('https://cp.tech2.hybe.im/proj-k/agentsdk/');
  });
});
