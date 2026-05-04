// A5-a: ReviewCard 의 per-item feedback (👍 / 👎 / ✏) UI + Apply 흐름의 filter.
// chrome-extension 의 사용자 통제 패턴을 Klaud 로 마이그레이션.

import { test, expect, type Page } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

function ndjson(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

async function setupReviewWithItems(page: Page, items: { issues?: unknown[]; verifications?: unknown[]; suggestions?: unknown[] }): Promise<void> {
  await page.addInitScript({ content: mockProjkInitScript });
  const reviewJson = JSON.stringify({
    score: 70,
    issues: items.issues ?? [],
    verifications: items.verifications ?? [],
    suggestions: items.suggestions ?? [],
  });
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '분석 중' },
        { type: 'result', data: { review: reviewJson, model: 'haiku', usage: {} } },
      ]),
    });
  });
  await page.route('**/127.0.0.1:**/suggest_edits', async (route) => {
    // 사용자 instruction 을 echo 응답에 그대로 포함 → 테스트가 어떤 item 이 prompt 에 들어갔는지 검증.
    const reqBody = (route.request().postDataJSON() ?? {}) as { instruction?: string };
    const instr = reqBody.instruction ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: 'mock fix' },
        {
          type: 'result',
          data: {
            changes: [{ id: 'echo', section: '에코', description: instr.slice(0, 500), before: '', after: '' }],
            model: 'haiku',
            usage: {},
          },
        },
      ]),
    });
  });
  await page.goto('/');
}

async function selectConfluencePage(page: Page) {
  const tree = page.getByTestId('confluence-tree');
  await tree.getByText('Design', { exact: true }).click();
  await tree.getByText('시스템 디자인', { exact: true }).click();
  await tree.getByText('전투', { exact: true }).click();
  // webview body stub — review 가 webview 본문 추출 의존.
  await page.evaluate(() => {
    const wv = document.querySelector('webview');
    if (wv) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (wv as any).executeJavaScript = async () => '문서 본문 mock';
    }
  });
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();
  await page.getByTestId('review-options-start').click();
}

test('default — 모든 item liked, 👍 active', async ({ page }) => {
  await setupReviewWithItems(page, {
    issues: [
      { text: '플로우 누락', perspective: '프로그래머' },
      { text: '예시 부족', perspective: '리더' },
    ],
  });
  await selectConfluencePage(page);

  const card = page.getByTestId('review-card');
  await expect(card).toContainText('플로우 누락');
  // 모든 item 의 👍 가 active.
  const likeButtons = card.locator('[data-testid^="ri-like-"]');
  await expect(likeButtons).toHaveCount(2);
  for (const btn of await likeButtons.all()) {
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
  }
});

test('👎 dislike 클릭 → item 회색/취소선 + outer.disliked 클래스', async ({ page }) => {
  await setupReviewWithItems(page, {
    issues: [{ text: '플로우 누락', perspective: '프로그래머' }],
  });
  await selectConfluencePage(page);

  const dislikeBtn = page.locator('[data-testid^="ri-dislike-"]').first();
  await dislikeBtn.click();
  await expect(dislikeBtn).toHaveAttribute('aria-pressed', 'true');

  const itemOuter = page.locator('.review-item-outer').first();
  await expect(itemOuter).toHaveClass(/disliked/);
});

test('✏ edited 클릭 → textarea 노출', async ({ page }) => {
  await setupReviewWithItems(page, {
    issues: [{ text: '플로우 누락', perspective: '프로그래머' }],
  });
  await selectConfluencePage(page);

  const editBtn = page.locator('[data-testid^="ri-edit-"]').first();
  await editBtn.click();

  const textarea = page.locator('[data-testid^="ri-edit-area-"]').first();
  await expect(textarea).toBeVisible();
  await textarea.fill('데이터 흐름 다이어그램 추가 권장');
  await expect(textarea).toHaveValue('데이터 흐름 다이어그램 추가 권장');
});

test('Apply 시 disliked 항목 제외 + edited 의 사용자 instruction 추가', async ({ page }) => {
  await setupReviewWithItems(page, {
    issues: [
      { text: '플로우 누락', perspective: '프로그래머' },
      { text: '예시 부족', perspective: '리더' },
      { text: 'QA 시나리오 추가' },
    ],
  });
  await selectConfluencePage(page);
  const card = page.getByTestId('review-card');
  await expect(card).toContainText('플로우 누락');

  // 첫 item dislike
  await page.locator('[data-testid^="ri-dislike-"]').nth(0).click();
  // 두번째 item edit + 사용자 텍스트
  await page.locator('[data-testid^="ri-edit-"]').nth(1).click();
  const ta = page.locator('[data-testid^="ri-edit-area-"]').first();
  await ta.fill('숫자 예시 5개 이상 추가해줘');

  // Apply
  await page.getByTestId('review-fix').click();

  // ChangesCard 의 echo 응답에 prompt 가 description 으로 들어옴 → 검증
  const changesCard = page.getByTestId('changes-card');
  await expect(changesCard).toBeVisible();
  // disliked 의 텍스트 '플로우 누락' 은 prompt 에 들어가면 안 됨
  await expect(changesCard).not.toContainText('플로우 누락');
  // edited 항목 + 사용자 instruction 함께
  await expect(changesCard).toContainText('예시 부족');
  await expect(changesCard).toContainText('숫자 예시 5개 이상 추가해줘');
  // 마지막 item (liked default) 도 포함
  await expect(changesCard).toContainText('QA 시나리오 추가');
});
