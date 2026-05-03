import { describe, expect, it } from 'vitest';
import { deriveAgentWebUrl } from '../../src/renderer/workbench/Editor/AgentWebView';

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
