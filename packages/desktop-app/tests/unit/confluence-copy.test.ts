// B2-1: copyPageToTestSpace 단위 테스트. fetch 와 settings/auth 를 mock 해서 흐름 검증.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/auth', () => ({
  getConfluenceCreds: vi.fn(),
}));
vi.mock('../../src/main/settings', () => ({
  getSettings: vi.fn(),
}));

import { copyPageToTestSpace } from '../../src/main/confluence-copy';
import { getConfluenceCreds } from '../../src/main/auth';
import { getSettings } from '../../src/main/settings';

const credsMock = getConfluenceCreds as unknown as ReturnType<typeof vi.fn>;
const settingsMock = getSettings as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  credsMock.mockReset();
  settingsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyPageToTestSpace', () => {
  it('자격 미설정 → ok:false', async () => {
    credsMock.mockResolvedValue(null);
    settingsMock.mockReturnValue({});
    const r = await copyPageToTestSpace('123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('자격');
  });

  it('테스트 스페이스 미설정 → ok:false', async () => {
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    settingsMock.mockReturnValue({});
    const r = await copyPageToTestSpace('123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('테스트 스페이스');
  });

  it('happy path — fetch 3 회 (page GET, space resolve, create POST) + 새 page id 반환', async () => {
    credsMock.mockResolvedValue({ email: 'jacob@hybecorp.com', apiToken: 't0k', baseUrl: 'https://bighitcorp.atlassian.net' });
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST', confluenceTestParentPageId: '5740399078' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // 1) source page GET
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: '축복의 리프 시스템 기획',
        body: { storage: { value: '<p>본문</p>' } },
      }), { status: 200 }))
      // 2) space resolve
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: '5740398233', key: 'PKTEST' }],
      }), { status: 200 }))
      // 3) page create POST
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: '999000111',
        _links: { webui: '/spaces/PKTEST/pages/999000111', base: 'https://bighitcorp.atlassian.net/wiki' },
      }), { status: 200 }));

    const r = await copyPageToTestSpace('5740399680');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newPageId).toBe('999000111');
      expect(r.spaceKey).toBe('PKTEST');
      expect(r.newTitle).toContain('축복의 리프 시스템 기획');
      expect(r.newTitle).toMatch(/테스트 사본 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      expect(r.newPageUrl).toContain('/spaces/PKTEST/pages/999000111');
    }

    // 3번째 fetch (POST) 의 body 안에 spaceId / parentId / 본문 들어있는지
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const lastCall = fetchSpy.mock.calls[2]!;
    const init = lastCall[1] as RequestInit;
    expect(init.method).toBe('POST');
    const bodyStr = init.body as string;
    const body = JSON.parse(bodyStr);
    expect(body.spaceId).toBe('5740398233');
    expect(body.parentId).toBe('5740399078');
    expect(body.body.representation).toBe('storage');
    expect(body.body.value).toBe('<p>본문</p>');
    expect(body.title).toMatch(/테스트 사본/);
    fetchSpy.mockRestore();
  });

  it('parentPageId 비우면 spaceId 만 — page tree root 에 사본', async () => {
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST' /* no parent */ });

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: 'X',
        body: { storage: { value: '<p>x</p>' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: 'space-id', key: 'PKTEST' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'new-1' }), { status: 200 }));

    await copyPageToTestSpace('1');
    const init = fetchSpy.mock.calls[2]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.parentId).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('source page GET 실패 → ok:false', async () => {
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    const r = await copyPageToTestSpace('999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('원본 페이지');
  });

  it('테스트 스페이스 key 못 찾으면 ok:false', async () => {
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'WRONG' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: 'X',
        body: { storage: { value: '<p>x</p>' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const r = await copyPageToTestSpace('1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'WRONG'");
  });

  it('create POST 실패 → ok:false 에 status 포함', async () => {
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: 'X',
        body: { storage: { value: '<p>x</p>' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: 'sid', key: 'PKTEST' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const r = await copyPageToTestSpace('1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('403');
  });
});
