// B2-2: review fixture localStorage 캐시 — 같은 페이지 두 번째 클릭 시 백엔드 호출 우회 +
// "💾 캐시된 리뷰" badge + "🔁 새 리뷰" 버튼으로 강제 refresh.

import { test, expect, type Page } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

async function setup(page: Page, opts: { reviewBody: unknown; bodyText: string }): Promise<{ reviewCallCount: () => number; reset: () => void }> {
  await page.addInitScript({ content: mockProjkInitScript });

  let reviewCalls = 0;
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    reviewCalls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: 'mock 분석' },
        { type: 'result', data: { review: JSON.stringify(opts.reviewBody), model: 'sonnet' } },
      ]),
    });
  });

  await page.goto('/');
  await page.getByTestId('activity-confluence').click();
  const tree = page.getByTestId('confluence-tree');
  await tree.getByText('Design', { exact: true }).click();
  await tree.getByText('시스템 디자인', { exact: true }).click();
  await tree.getByText('전투', { exact: true }).click();

  await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();
  await page.evaluate((body) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wv = document.querySelector('webview') as any;
    if (wv) wv.executeJavaScript = async () => body;
  }, opts.bodyText);

  return { reviewCallCount: () => reviewCalls, reset: () => { reviewCalls = 0; } };
}

async function clickReview(page: Page) {
  await page.getByTestId('confluence-review').click();
}

async function closeReview(page: Page) {
  await page.getByTestId('review-split-close').click();
}

// React StrictMode (dev) 가 mount 시 effect 2회 발동 → 첫 클릭에 fetch 가 1 또는 2회.
// 테스트 패턴: 절대값 대신 *증분* 비교. cache hit 케이스는 후속 클릭에서 호출이 *안* 늘어남.

test('첫 리뷰 → result 도착 시 fixture 자동 저장', async ({ page }) => {
  const ctrl = await setup(page, {
    reviewBody: { score: 75, issues: [{ text: 'first call' }] },
    bodyText: '본문 v1',
  });
  await clickReview(page);
  await expect(page.getByTestId('review-card')).toContainText('first call');
  expect(ctrl.reviewCallCount()).toBeGreaterThanOrEqual(1);

  // localStorage 에 fixture 저장됐는지 직접 확인 — prefix klaud:review-fixture: 인 key 가 1+
  const cached = await page.evaluate(() => {
    let count = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('klaud:review-fixture:')) count++;
    }
    return count;
  });
  expect(cached).toBeGreaterThanOrEqual(1);
});

test('같은 페이지 + 같은 본문 두 번째 리뷰 → cache hit, /review_stream 재호출 X + badge 노출', async ({ page }) => {
  const ctrl = await setup(page, {
    reviewBody: { score: 80, issues: [{ text: 'cached body' }] },
    bodyText: '본문 v1 동일',
  });
  // 첫 클릭 → 저장
  await clickReview(page);
  await expect(page.getByTestId('review-card')).toContainText('cached body');
  const initialCount = ctrl.reviewCallCount();

  // 닫기 + 다시 클릭 → cache hit
  await closeReview(page);
  await clickReview(page);
  await expect(page.getByTestId('review-card')).toContainText('cached body');
  // 백엔드 호출 안 늘어남 (cache hit)
  expect(ctrl.reviewCallCount()).toBe(initialCount);
  // cache badge 노출
  await expect(page.getByTestId('review-cache-badge')).toBeVisible();
  await expect(page.getByTestId('review-cache-badge')).toContainText('캐시된 리뷰');
  await expect(page.getByTestId('review-cache-badge')).toContainText('sonnet');
});

test('"🔁 새 리뷰" 버튼 → cache invalidate + 백엔드 재호출', async ({ page }) => {
  const ctrl = await setup(page, {
    reviewBody: { score: 80, issues: [{ text: 'fresh result' }] },
    bodyText: '동일 본문',
  });
  await clickReview(page);
  await expect(page.getByTestId('review-card')).toContainText('fresh result');
  await closeReview(page);

  await clickReview(page);
  await expect(page.getByTestId('review-cache-badge')).toBeVisible();
  const beforeRerun = ctrl.reviewCallCount();

  // "🔁 새 리뷰" 클릭
  await page.getByTestId('review-cache-rerun').click();
  // 새 stream 호출됨 (정확히 1회 더 — refreshNonce trigger)
  await expect.poll(() => ctrl.reviewCallCount()).toBeGreaterThan(beforeRerun);
  // badge 사라짐 (fresh stream 결과로 채워졌으니)
  await expect(page.getByTestId('review-cache-badge')).toHaveCount(0);
});

test('본문이 바뀌면 자동 cache miss → 새로 호출', async ({ page }) => {
  const ctrl = await setup(page, {
    reviewBody: { score: 80, issues: [{ text: 'first' }] },
    bodyText: '본문 v1',
  });
  await clickReview(page);
  await expect(page.getByTestId('review-card')).toContainText('first');
  await closeReview(page);
  const beforeBodyChange = ctrl.reviewCallCount();

  // 본문을 다른 텍스트로 바꿈 (webview stub 재셋)
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wv = document.querySelector('webview') as any;
    if (wv) wv.executeJavaScript = async () => '본문 v2 — 다름';
  });

  await clickReview(page);
  // contentHash 가 다르니 cache miss → 새 호출
  await expect.poll(() => ctrl.reviewCallCount()).toBeGreaterThan(beforeBodyChange);
  // badge 안 보임 (fresh stream)
  await expect(page.getByTestId('review-cache-badge')).toHaveCount(0);
});
