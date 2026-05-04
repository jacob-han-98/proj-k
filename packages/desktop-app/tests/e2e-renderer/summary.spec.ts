// P1: 요약 모드 e2e — 어시스턴트 → 요약 칩 → SummaryCard.
//
// 회귀 방지:
// - 요약 칩이 P0 시점엔 disabled 였으나 P1 에서 enabled 로 활성화.
// - 칩 클릭 시 /summary_stream NDJSON 호출 + result.data.summary 가 SummaryCard 에 렌더.
// - markdown 의 ## 헤더 / - 불릿 가 시각적으로 구분되어 표시.
// - error 이벤트 시 summary-error 메시지.
// - "← 모드 변경" 버튼 → mode picker 로 복귀.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
});

async function selectConfluencePageAndStubWebview(page: import('@playwright/test').Page, mockBody: string) {
  await page.goto('/');
  await page.getByTestId('activity-confluence').click();
  const tree = page.getByTestId('confluence-tree');
  await tree.getByText('Design', { exact: true }).click();
  await tree.getByText('시스템 디자인', { exact: true }).click();
  await tree.getByText('전투', { exact: true }).click();
  await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();
  await page.evaluate((body) => {
    const wv = document.querySelector('webview') as HTMLElement & { executeJavaScript?: (code: string) => Promise<string> };
    if (wv) wv.executeJavaScript = async () => body;
  }, mockBody);
}

function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('요약 칩이 P1 에서 활성화 (이전 P0 disabled → 사용자 클릭 가능)', async ({ page }) => {
  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await expect(page.getByTestId('mode-pick-summary')).toBeEnabled();
});

test('요약 칩 클릭 → /summary_stream 호출 → SummaryCard 에 markdown 렌더', async ({ page }) => {
  let summaryCallCount = 0;
  let capturedBody: Record<string, unknown> | null = null;
  const summaryMarkdown = '## 결론\n장비 아이템은 4단계 위상으로 구분.\n\n## 핵심 항목\n- 일반 → 고급 → 희귀 → 영웅\n- 합성 시 3개 + 재료 1개\n- White→Green 실패 0%';
  await page.route('**/127.0.0.1:**/summary_stream', async (route) => {
    summaryCallCount += 1;
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '📖 본문 정독 중…' },
        { type: 'token', text: '## 결론\n장비' },
        { type: 'result', data: { summary: summaryMarkdown, model: 'opus', usage: {} } },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문 텍스트');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-summary').click();

  // SummaryCard 노출 + markdown 렌더 검증
  await expect(page.getByTestId('summary-card')).toBeVisible();
  const body = page.getByTestId('summary-body');
  await expect(body).toBeVisible();
  // ## 헤더 → h3 (두 개)
  await expect(body.locator('h3.summary-heading')).toHaveCount(2);
  await expect(body.locator('h3.summary-heading').first()).toContainText('결론');
  // - 불릿 → li (3개)
  const bullets = body.locator('ul.summary-bullets li');
  await expect(bullets).toHaveCount(3);
  await expect(bullets.nth(0)).toContainText('일반');
  await expect(bullets.nth(1)).toContainText('합성');
  await expect(bullets.nth(2)).toContainText('White');

  // React StrictMode 의 double-mount 로 effect 두 번 발동 가능 — 의도된 동작.
  // 핵심은 "사용자 클릭 → 백엔드 호출 발생" 자체 검증.
  expect(summaryCallCount).toBeGreaterThanOrEqual(1);
  expect(capturedBody).not.toBeNull();
  expect((capturedBody as { title: string }).title).toBe('전투');
});

test('요약 — error 이벤트 시 summary-error 메시지 표시', async ({ page }) => {
  await page.route('**/127.0.0.1:**/summary_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'error', message: 'agent 백엔드 URL 미설정' }]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-summary').click();

  await expect(page.getByTestId('summary-error')).toContainText('[요약 오류]');
  await expect(page.getByTestId('summary-error')).toContainText('agent 백엔드 URL 미설정');
});

test('요약 → ← 뒤로 → mode picker 복귀 + summary-card 사라짐', async ({ page }) => {
  await page.route('**/127.0.0.1:**/summary_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'result', data: { summary: '## 결론\nx' } }]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-summary').click();
  await expect(page.getByTestId('summary-card')).toBeVisible();

  await page.getByTestId('doc-assistant-back').click();
  await expect(page.getByTestId('mode-picker-empty')).toBeVisible();
  await expect(page.getByTestId('summary-card')).toHaveCount(0);
});
