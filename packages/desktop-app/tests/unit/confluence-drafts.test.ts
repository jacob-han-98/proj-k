// 액티비티 바 5번 ("내 작업 중 문서") — Confluence draft 폴링 함수 단위 테스트.
//
// fetch 를 mock 해서 URL 형식 + 응답 → ActiveConfluenceResult 변환을 검증.
// auth.ts 도 mock — 자격 미설정 시 ok:false + diagnostics 반환 보장.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/auth', () => ({
  getConfluenceCreds: vi.fn(),
}));

import { getConfluenceCreds } from '../../src/main/auth';
import {
  invalidateConfluenceDraftsCache,
  listMyConfluenceDrafts,
} from '../../src/main/confluence-drafts';

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  vi.mocked(getConfluenceCreds).mockReset();
  invalidateConfluenceDraftsCache(); // 모듈 레벨 캐시 격리.
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonRes(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe('listMyConfluenceDrafts', () => {
  it('자격 미설정 → ok:false + 한국어 diagnostics, fetch 호출 없음', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue(null);
    const r = await listMyConfluenceDrafts(['PK']);
    expect(r.ok).toBe(false);
    expect(r.drafts).toEqual([]);
    expect(r.diagnostics).toMatch(/자격|Confluence/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('정상 흐름 — current user → space lookup → drafts. URL/method/Auth header 검증', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue({
      email: 'jacob@example.com',
      apiToken: 'token-123',
      baseUrl: 'https://bighitcorp.atlassian.net',
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes({ accountId: 'aid-jacob' }))
      .mockResolvedValueOnce(jsonRes({
        results: [{ id: 'sid-pk', key: 'PK' }],
      }))
      .mockResolvedValueOnce(jsonRes({
        results: [
          {
            id: 'page-101',
            title: '신규 시스템 기획',
            version: { createdAt: '2026-05-04T10:00:00.000Z' },
          },
          {
            id: 'page-202',
            title: '편집중 페이지',
            version: { createdAt: '2026-05-03T08:00:00.000Z' },
          },
        ],
      }));

    const r = await listMyConfluenceDrafts(['PK']);

    expect(r.ok).toBe(true);
    expect(r.drafts).toHaveLength(2);
    // lastModified desc 정렬.
    expect(r.drafts[0]?.pageId).toBe('page-101');
    expect(r.drafts[0]?.spaceKey).toBe('PK');
    expect(r.drafts[1]?.pageId).toBe('page-202');

    // URL + auth 검증.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [userUrl, userInit] = fetchMock.mock.calls[0]!;
    expect(userUrl).toContain('/wiki/rest/api/user/current');
    expect((userInit as RequestInit).headers).toMatchObject({
      Authorization: expect.stringMatching(/^Basic /),
    });

    const [spaceUrl] = fetchMock.mock.calls[1]!;
    expect(spaceUrl).toContain('/wiki/api/v2/spaces?keys=PK');

    const [draftUrl] = fetchMock.mock.calls[2]!;
    expect(draftUrl).toContain('/wiki/api/v2/pages');
    expect(draftUrl).toContain('status=draft');
    expect(draftUrl).toContain('owner-id=aid-jacob');
    expect(draftUrl).toContain('space-id=sid-pk');
  });

  it('빈 spaceKeys → PK fallback', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue({
      email: 'a@b.com',
      apiToken: 't',
      baseUrl: 'https://bighitcorp.atlassian.net',
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes({ accountId: 'aid' }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 'sid', key: 'PK' }] }))
      .mockResolvedValueOnce(jsonRes({ results: [] }));
    const r = await listMyConfluenceDrafts(undefined);
    expect(r.ok).toBe(true);
    const [spaceUrl] = fetchMock.mock.calls[1]!;
    expect(spaceUrl).toContain('keys=PK');
  });

  it('user/current 4xx → ok:false + diagnostics', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue({
      email: 'a@b.com', apiToken: 't', baseUrl: '',
    });
    fetchMock.mockResolvedValueOnce(jsonRes({}, false, 401));
    const r = await listMyConfluenceDrafts(['PK']);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toMatch(/사용자|만료|token/);
  });

  it('space lookup 빈 결과 → ok:false + diagnostics 에 key 표시', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue({
      email: 'a@b.com', apiToken: 't', baseUrl: '',
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes({ accountId: 'aid' }))
      .mockResolvedValueOnce(jsonRes({ results: [] })); // 빈 space
    const r = await listMyConfluenceDrafts(['UNKNOWN']);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toContain('UNKNOWN');
  });

  it('여러 space — 각 space 별 병렬 fetch + flatten', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue({
      email: 'a@b.com', apiToken: 't', baseUrl: '',
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes({ accountId: 'aid' }))
      .mockResolvedValueOnce(jsonRes({
        results: [{ id: 's1', key: 'PK' }, { id: 's2', key: 'TEMP' }],
      }))
      .mockResolvedValueOnce(jsonRes({
        results: [{ id: 'p-pk-1', title: 'PK doc', version: { createdAt: '2026-05-04T10:00:00Z' } }],
      }))
      .mockResolvedValueOnce(jsonRes({
        results: [{ id: 'p-temp-1', title: 'Temp doc', version: { createdAt: '2026-05-04T11:00:00Z' } }],
      }));
    const r = await listMyConfluenceDrafts(['PK', 'TEMP']);
    expect(r.ok).toBe(true);
    expect(r.drafts).toHaveLength(2);
    // lastModified desc — TEMP doc 가 더 최신.
    expect(r.drafts[0]?.spaceKey).toBe('TEMP');
    expect(r.drafts[1]?.spaceKey).toBe('PK');
  });

  it('invalidateConfluenceDraftsCache — 다음 호출이 user/space 재조회', async () => {
    vi.mocked(getConfluenceCreds).mockResolvedValue({
      email: 'a@b.com', apiToken: 't', baseUrl: '',
    });
    // 1차: user, space, drafts
    fetchMock
      .mockResolvedValueOnce(jsonRes({ accountId: 'aid1' }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 's', key: 'PK' }] }))
      .mockResolvedValueOnce(jsonRes({ results: [] }));
    await listMyConfluenceDrafts(['PK']);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 2차 캐시 hit: user/space 재조회 X, drafts 만.
    fetchMock.mockResolvedValueOnce(jsonRes({ results: [] }));
    await listMyConfluenceDrafts(['PK']);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // invalidate 후 — 모두 다시.
    invalidateConfluenceDraftsCache();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ accountId: 'aid2' }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 's', key: 'PK' }] }))
      .mockResolvedValueOnce(jsonRes({ results: [] }));
    await listMyConfluenceDrafts(['PK']);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
