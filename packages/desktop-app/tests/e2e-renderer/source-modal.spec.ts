// A3-b: 답변 안 (출처: ...) 클릭 → SourceModal 띄움 + /source_view fetch + content 표시.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

async function openNewQnATab(page: import('@playwright/test').Page) {
  await page.getByTestId('activity-qna').click();
  await page.getByTestId('thread-new').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

test('답변 안 citation 클릭 → SourceModal 띄움 + content 표시', async ({ page }) => {
  await openNewQnATab(page);
  // mock /ask_stream 의 답변 안에 (출처: PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃) 가 들어있음.
  await page.getByTestId('chat-input').fill('HUD 의 기본 레이아웃은?');
  await page.getByTestId('chat-send').click();

  // 답변 stream 끝나면 citation-link 가 렌더된다.
  const link = page.getByTestId('citation-link-1');
  await expect(link).toBeVisible({ timeout: 5_000 });
  await expect(link).toHaveText('📑 출처');

  await link.click();
  await expect(page.getByTestId('source-modal')).toBeVisible();

  // mock /source_view 가 origin_label + content 를 응답.
  await expect(page.getByTestId('source-modal-origin')).toContainText('PK_HUD 시스템.xlsx');
  await expect(page.getByTestId('source-modal-content')).toBeVisible();

  // backdrop 클릭으로 닫힘.
  await page.getByTestId('source-modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('source-modal')).toHaveCount(0);
});

test('× 버튼으로 modal 닫힘', async ({ page }) => {
  await openNewQnATab(page);
  await page.getByTestId('chat-input').fill('HUD?');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('citation-link-1').click();
  await expect(page.getByTestId('source-modal')).toBeVisible();

  await page.getByTestId('source-modal-close').click();
  await expect(page.getByTestId('source-modal')).toHaveCount(0);
});
