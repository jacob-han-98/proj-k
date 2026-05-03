// A4: 최근 작업 문서 패널 — store.openTab 이 호출될 때마다 localStorage history 갱신,
// Ctrl+5 활동에서 노출. 클릭 시 같은 OpenTabSpec 으로 재오픈.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  // localStorage 의 옛 history 를 비워 테스트 격리.
  await page.addInitScript(() => {
    try { localStorage.removeItem('klaud.recents'); } catch { /* noop */ }
  });
  await page.goto('/');
});

test('빈 상태 — empty hint 노출', async ({ page }) => {
  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('recent-docs-panel')).toBeVisible();
  await expect(page.getByTestId('recent-docs-empty')).toBeVisible();
});

test('Confluence 페이지 열기 → 최근 패널에 entry 누적', async ({ page }) => {
  // mock confluence tree 에 page id=3 ('전투') 가 있음. 트리 펼치고 click.
  await page.keyboard.press('Control+2');
  const confluenceTree = page.getByTestId('confluence-tree');
  await confluenceTree.getByText('Design').click();
  await confluenceTree.getByText('시스템 디자인').click();
  await confluenceTree.getByText('전투').click();

  // 탭이 열렸는지 짧게 확인 (sidebar-host 의 active 탭 변경)
  await expect(page.getByTestId('center-pane')).toBeVisible();

  // Ctrl+5 → recent 패널.
  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('recent-docs-panel')).toBeVisible();
  // 1건 이상 entry — 페이지 ID 가 3 인 confluence 항목.
  const row = page.getByTestId('recent-doc-confluence:3');
  await expect(row).toBeVisible();
  await expect(row).toContainText('전투');
});

test('재오픈 — recent 항목 클릭 → 같은 탭으로 focus + openCount 증가', async ({ page }) => {
  await page.keyboard.press('Control+2');
  const confluenceTree = page.getByTestId('confluence-tree');
  await confluenceTree.getByText('Design').click();
  await confluenceTree.getByText('시스템 디자인').click();
  await confluenceTree.getByText('전투').click();

  await page.keyboard.press('Control+5');
  await page.getByTestId('recent-doc-confluence:3').click();

  // 다시 패널 열어보면 같은 row + openCount=2회 라벨 노출
  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('recent-doc-confluence:3')).toContainText('2회');
});

test('× 버튼 — 한 entry 만 제거', async ({ page }) => {
  await page.keyboard.press('Control+2');
  const confluenceTree = page.getByTestId('confluence-tree');
  await confluenceTree.getByText('Design').click();
  await confluenceTree.getByText('시스템 디자인').click();
  await confluenceTree.getByText('전투').click();

  await page.keyboard.press('Control+5');
  const row = page.getByTestId('recent-doc-confluence:3');
  await expect(row).toBeVisible();

  // hover 해서 ✕ 노출시킨 뒤 click.
  await row.hover();
  await page.getByTestId('recent-doc-remove-confluence:3').click({ force: true });

  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('recent-docs-empty')).toBeVisible();
});
