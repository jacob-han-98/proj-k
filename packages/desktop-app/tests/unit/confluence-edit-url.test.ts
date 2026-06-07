// 2026-05-13: Confluence 편집 URL 매처 — webview did-navigate 시 view ↔ edit 분기 정확성 확인.
//
// 회귀 방지: Atlassian 이 edit URL 형식을 새로 추가하면 이 테스트가 먼저 깨짐 → 패턴 보완.
// 의도적 false 도 함께 검증 — view URL 을 edit 으로 잘못 잡지 않게.

import { describe, expect, it } from 'vitest';
import { isConfluenceEditUrl } from '../../src/renderer/panels/confluence-url';

describe('isConfluenceEditUrl', () => {
  it('edit-v2 (현행 에디터) — true', () => {
    expect(
      isConfluenceEditUrl('https://bhunion.atlassian.net/wiki/spaces/K/pages/edit-v2/12345'),
    ).toBe(true);
    expect(
      isConfluenceEditUrl(
        'https://bhunion.atlassian.net/wiki/spaces/K/pages/edit-v2/12345/title-slug?draftShareId=x',
      ),
    ).toBe(true);
  });

  it('구 edit 경로 — true', () => {
    expect(
      isConfluenceEditUrl('https://bhunion.atlassian.net/wiki/spaces/K/pages/edit/12345'),
    ).toBe(true);
  });

  it('resumedraft.action — true', () => {
    expect(
      isConfluenceEditUrl(
        'https://bhunion.atlassian.net/wiki/pages/resumedraft.action?draftId=987&draftShareId=x',
      ),
    ).toBe(true);
  });

  it('createpage.action — true (신규 작성도 편집 흐름)', () => {
    expect(
      isConfluenceEditUrl(
        'https://bhunion.atlassian.net/wiki/pages/createpage.action?spaceKey=K&parentPageId=1',
      ),
    ).toBe(true);
  });

  it('viewpage.action — false', () => {
    expect(
      isConfluenceEditUrl('https://bhunion.atlassian.net/wiki/pages/viewpage.action?pageId=12345'),
    ).toBe(false);
  });

  it('정규 view URL — false', () => {
    expect(
      isConfluenceEditUrl(
        'https://bhunion.atlassian.net/wiki/spaces/K/pages/12345/title-slug',
      ),
    ).toBe(false);
  });

  it('빈 문자열 / 비URL — false (throw 없이 false)', () => {
    expect(isConfluenceEditUrl('')).toBe(false);
    expect(isConfluenceEditUrl('not-a-url')).toBe(false);
  });
});
