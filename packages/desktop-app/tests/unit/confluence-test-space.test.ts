// 2026-05-12: fetchTestSpaceTreeNode 단위 테스트. fetch + creds/settings mock 으로
// 분기 검증.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/auth', () => ({
  getConfluenceCreds: vi.fn(),
}));
vi.mock('../../src/main/settings', () => ({
  getSettings: vi.fn(),
}));

import { fetchTestSpaceTreeNode } from '../../src/main/confluence-test-space';
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

describe('fetchTestSpaceTreeNode', () => {
  it('testSpaceKey 미설정 → null (fetch 없음)', async () => {
    settingsMock.mockReturnValue({});
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await fetchTestSpaceTreeNode();
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creds 미설정 → null (silent)', async () => {
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST' });
    credsMock.mockResolvedValue(null);
    const r = await fetchTestSpaceTreeNode();
    expect(r).toBeNull();
  });

  it('parent 설정됨 → pages/{parentId}/children 1회 호출 + 자식 페이지 노드 반환', async () => {
    settingsMock.mockReturnValue({
      confluenceTestSpaceKey: 'PKTEST',
      confluenceTestParentPageId: '5740399078',
    });
    credsMock.mockResolvedValue({ email: 'jacob@hybecorp.com', apiToken: 't0k', baseUrl: 'https://x' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        results: [
          { id: '999000111', title: '축복의 리프 시스템 기획 (테스트 사본 2026-05-12 14:30)' },
          { id: '999000112', title: '다른 사본' },
        ],
      }), { status: 200 }),
    );

    const node = await fetchTestSpaceTreeNode();
    expect(node).not.toBeNull();
    expect(node!.id).toBe('testspace:PKTEST');
    expect(node!.type).toBe('space');
    expect(node!.title).toBe('📋 테스트 스페이스 (PKTEST)');
    expect(node!.children).toHaveLength(2);
    expect(node!.children![0]).toMatchObject({
      id: 'confluence:999000111',
      type: 'page',
      confluencePageId: '999000111',
    });
    expect(node!.children![0].title).toContain('축복의 리프');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('/wiki/api/v2/pages/5740399078/children');
    expect(url).toContain('limit=250');
  });

  it('parent 미설정 → space resolve + root pages fetch (parentId null 인 것만 root 로)', async () => {
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST' });
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // 1) space resolve
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: 'space-id-123', key: 'PKTEST' }],
      }), { status: 200 }))
      // 2) pages fetch — 1개 root + 1개 자식 (parentId 채워짐) 섞여있음
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [
          { id: 'p1', title: 'root1', parentId: null },
          { id: 'p2', title: 'child1', parentId: 'p1' },
          { id: 'p3', title: 'root2', parentId: '' },
        ],
      }), { status: 200 }));

    const node = await fetchTestSpaceTreeNode();
    expect(node).not.toBeNull();
    // root only — 2개 (p1, p3) 만, p2 는 child 라 제외
    expect(node!.children).toHaveLength(2);
    expect(node!.children!.map((c) => c.confluencePageId)).toEqual(['p1', 'p3']);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const spaceUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(spaceUrl).toContain('/wiki/api/v2/spaces?keys=PKTEST');
    const pagesUrl = fetchSpy.mock.calls[1]![0] as string;
    expect(pagesUrl).toContain('/wiki/api/v2/spaces/space-id-123/pages');
  });

  it('space resolve 실패 → null (silent)', async () => {
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'WRONG' });
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const r = await fetchTestSpaceTreeNode();
    expect(r).toBeNull();
  });

  it('children fetch 실패 (404) → 빈 children 으로 노드 자체는 반환', async () => {
    settingsMock.mockReturnValue({
      confluenceTestSpaceKey: 'PKTEST',
      confluenceTestParentPageId: '999',
    });
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const r = await fetchTestSpaceTreeNode();
    // 404 는 silent — 트리 자체는 보여줘서 인디케이터와 일관성. 자식 0개로.
    expect(r).not.toBeNull();
    expect(r!.children).toHaveLength(0);
  });

  it('네트워크 예외 → null (silent + console.warn)', async () => {
    settingsMock.mockReturnValue({ confluenceTestSpaceKey: 'PKTEST' });
    credsMock.mockResolvedValue({ email: 'a@b', apiToken: 't', baseUrl: 'https://x' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await fetchTestSpaceTreeNode();
    expect(r).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('confluence-test-space'), expect.any(Error));
  });
});
