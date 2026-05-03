// A3-a: QnATab 의 추천 prompt chips — empty thread 에 노출, 클릭 시 input 채움.

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

test('빈 thread 에 추천 chips 노출 + 카테고리 grouping', async ({ page }) => {
  await openNewQnATab(page);
  const chips = page.getByTestId('preset-chips');
  await expect(chips).toBeVisible();
  await expect(chips).toContainText('추천 질문');
  // mock 4건: system 2 / spec 1 / overview 1
  await expect(page.getByTestId('preset-cat-system')).toContainText('시스템');
  await expect(page.getByTestId('preset-cat-spec')).toContainText('수치·공식');
  await expect(page.getByTestId('preset-cat-overview')).toContainText('개요');
  // chips 자체
  await expect(page.locator('.preset-chip')).toHaveCount(4);
});

test('chip 클릭 → input 자동 채움 (자동 send X)', async ({ page }) => {
  await openNewQnATab(page);
  await page.getByTestId('preset-chip-system-0').click();
  // mock 의 첫 번째 system chip 의 prompt = '변신 시스템의 목적을 정리해줘.'
  await expect(page.getByTestId('chat-input')).toHaveValue('변신 시스템의 목적을 정리해줘.');
  // chips 는 messages.length===0 이라 그대로 노출 (send 안 일어남)
  await expect(page.getByTestId('preset-chips')).toBeVisible();
});

test('메시지 보내고 나면 chips 사라짐', async ({ page }) => {
  await openNewQnATab(page);
  await page.getByTestId('preset-chip-system-0').click();
  // 보내기 클릭
  await page.getByTestId('chat-send').click();
  // user message 도착 → chips hide
  await expect(page.getByTestId('preset-chips')).toHaveCount(0);
});
