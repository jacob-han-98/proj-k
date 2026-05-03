// A2: Command Palette (VS Code Ctrl+P 등가물) e2e.
// Ctrl+P → modal 열림, 입력 → fuzzy 매칭, Enter → 탭 열림, ESC → 닫힘.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

test('Ctrl+P 누르면 Command Palette 열림 + 다시 누르면 닫힘 (toggle)', async ({ page }) => {
  await expect(page.getByTestId('cmd-palette')).toHaveCount(0);

  await page.keyboard.press('Control+p');
  await expect(page.getByTestId('cmd-palette')).toBeVisible();
  await expect(page.getByTestId('cmd-palette-input')).toBeFocused();

  await page.keyboard.press('Control+p');
  await expect(page.getByTestId('cmd-palette')).toHaveCount(0);
});

test('ESC 로 닫기', async ({ page }) => {
  await page.keyboard.press('Control+p');
  await expect(page.getByTestId('cmd-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cmd-palette')).toHaveCount(0);
});

test('backdrop 클릭으로 닫기', async ({ page }) => {
  await page.keyboard.press('Control+p');
  await expect(page.getByTestId('cmd-palette')).toBeVisible();
  // backdrop 의 가장자리 클릭 (palette 본체 밖)
  await page.getByTestId('cmd-palette-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('cmd-palette')).toHaveCount(0);
});

test('입력 → fuzzy 매칭 → 결과 list', async ({ page }) => {
  await page.keyboard.press('Control+p');
  const input = page.getByTestId('cmd-palette-input');
  await input.fill('hud');

  // mock 의 P4 트리에 HUD_기본 / HUD_전투 두 sheet 존재 → 매칭됨.
  const results = page.getByTestId(/^cmd-palette-row-/);
  await expect(results.first()).toBeVisible();
  // 한 행이라도 'HUD' 포함된 title 이어야 (mock 트리 기반).
  const firstText = await results.first().innerText();
  expect(firstText.toLowerCase()).toContain('hud');
});

test('한글 query — 전투 → Confluence 페이지 매칭', async ({ page }) => {
  await page.keyboard.press('Control+p');
  await page.getByTestId('cmd-palette-input').fill('전투');

  const results = page.getByTestId(/^cmd-palette-row-/);
  await expect(results.first()).toBeVisible();
  // 결과 안에 '전투' 가 포함된 row 존재.
  const allText = await results.allInnerTexts();
  expect(allText.some((t) => t.includes('전투'))).toBe(true);
});

test('Enter 로 첫 결과 선택 → 탭 열림 + palette 닫힘', async ({ page }) => {
  await page.keyboard.press('Control+p');
  await page.getByTestId('cmd-palette-input').fill('hud');
  await expect(page.getByTestId('cmd-palette-row-0')).toBeVisible();

  await page.keyboard.press('Enter');

  // palette 닫힘
  await expect(page.getByTestId('cmd-palette')).toHaveCount(0);
  // 탭 바에 새 탭 추가 — title 에 HUD 포함
  const tabBar = page.getByTestId('tab-bar');
  await expect(tabBar).toContainText(/HUD/i);
});

test('ArrowDown / ArrowUp 으로 결과 탐색', async ({ page }) => {
  await page.keyboard.press('Control+p');
  await page.getByTestId('cmd-palette-input').fill('시스템');

  // 첫 row 가 active (aria-selected="true")
  await expect(page.getByTestId('cmd-palette-row-0')).toHaveAttribute('aria-selected', 'true');

  // 다운 한 번 → 둘째가 active
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('cmd-palette-row-0')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('cmd-palette-row-1')).toHaveAttribute('aria-selected', 'true');

  // 업 → 다시 첫 row.
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('cmd-palette-row-0')).toHaveAttribute('aria-selected', 'true');
});

test('매칭 안 되는 query → "결과 없음" 표시', async ({ page }) => {
  await page.keyboard.press('Control+p');
  await page.getByTestId('cmd-palette-input').fill('zxqv가나다');
  await expect(page.getByTestId('cmd-palette-results')).toContainText('결과 없음');
});
