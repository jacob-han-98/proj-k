// 2026-05-12 PD 피드백 1b: Chrome 스타일 고정 탭 e2e.
//
// 회귀 방지:
// - 우클릭 → "고정" → 좌측 정렬 + .pinned 클래스 + 📌 마커 등장 + close X 숨김
// - 우클릭 → "고정 해제" → 기존 unpinned 영역에서 openTabs 원본 순서로 복귀
// - 컨텍스트 메뉴 "탭 닫기" 도 동작
// - ESC / 외부 클릭으로 메뉴 닫힘

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

async function openTwoConfluenceTabs(page: import('@playwright/test').Page) {
  const tree = page.getByTestId('confluence-tree');
  // 트리 펼침 — '전투' 가 안 보이면 부모 폴더 펼침.
  if (!(await tree.getByText('전투', { exact: true }).isVisible().catch(() => false))) {
    await tree.getByText('Design', { exact: true }).click();
    await tree.getByText('시스템 디자인', { exact: true }).click();
  }
  await tree.getByText('전투', { exact: true }).click();
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();
  await tree.getByText('탐색', { exact: true }).click();
  await expect(page.getByTestId('tab-confluence:4')).toBeVisible();
}

// data-testid 가 탭 행만 잡는 정규식 (close 버튼/마커/context-menu/bar/split/content-row 제외).
const TAB_ROW_RE = /^tab-(?!close-|pin-marker-|context-menu|content-row|bar|split-).+/;

async function getTabOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return await page
    .getByTestId('tab-bar')
    .getByTestId(TAB_ROW_RE)
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid ?? ''));
}

test('우클릭 → 고정 → 좌측 정렬 + .pinned 클래스 + close X 숨김', async ({ page }) => {
  await openTwoConfluenceTabs(page);

  // 초기 순서: 전투(3) → 탐색(4)
  let tabIds = await getTabOrder(page);
  expect(tabIds).toEqual(['tab-confluence:3', 'tab-confluence:4']);

  // 두 번째 탭 (탐색) 우클릭 → 메뉴 등장
  await page.getByTestId('tab-confluence:4').click({ button: 'right' });
  await expect(page.getByTestId('tab-context-menu')).toBeVisible();
  await expect(page.getByTestId('tab-context-menu-toggle-pin')).toContainText('고정');

  // "고정" 클릭
  await page.getByTestId('tab-context-menu-toggle-pin').click();
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0);

  // 탐색 탭이 이제 좌측 + .pinned 클래스
  await expect(page.getByTestId('tab-confluence:4')).toHaveClass(/pinned/);
  await expect(page.getByTestId('tab-pin-marker-confluence:4')).toBeVisible();
  // close 버튼은 DOM 에서 빠짐 (실수 닫힘 방지)
  await expect(page.getByTestId('tab-close-confluence:4')).toHaveCount(0);
  // 비고정 탭은 close 버튼 그대로
  await expect(page.getByTestId('tab-close-confluence:3')).toHaveCount(1);

  // 표시 순서: pinned (탐색) → unpinned (전투)
  tabIds = await getTabOrder(page);
  expect(tabIds).toEqual(['tab-confluence:4', 'tab-confluence:3']);
});

test('고정 해제 → 원래 unpinned 순서로 복귀', async ({ page }) => {
  await openTwoConfluenceTabs(page);

  // 전투 탭 고정
  await page.getByTestId('tab-confluence:3').click({ button: 'right' });
  await page.getByTestId('tab-context-menu-toggle-pin').click();
  await expect(page.getByTestId('tab-confluence:3')).toHaveClass(/pinned/);

  // 다시 우클릭 → 메뉴 라벨이 "고정 해제"
  await page.getByTestId('tab-confluence:3').click({ button: 'right' });
  await expect(page.getByTestId('tab-context-menu-toggle-pin')).toContainText('고정 해제');
  await page.getByTestId('tab-context-menu-toggle-pin').click();

  // .pinned 클래스 사라짐 + 원래 순서 (전투 → 탐색) 복귀
  await expect(page.getByTestId('tab-confluence:3')).not.toHaveClass(/pinned/);
  const tabIds = await getTabOrder(page);
  expect(tabIds).toEqual(['tab-confluence:3', 'tab-confluence:4']);
});

test('컨텍스트 메뉴 "탭 닫기" 동작 + pinned 탭 닫으면 pinned 목록 자동 정리', async ({ page }) => {
  await openTwoConfluenceTabs(page);

  // 탐색 탭 고정
  await page.getByTestId('tab-confluence:4').click({ button: 'right' });
  await page.getByTestId('tab-context-menu-toggle-pin').click();
  await expect(page.getByTestId('tab-confluence:4')).toHaveClass(/pinned/);

  // 다시 우클릭 → "탭 닫기" 로 닫음 (close X 숨겨져 있으니 메뉴가 유일한 GUI 경로)
  await page.getByTestId('tab-confluence:4').click({ button: 'right' });
  await page.getByTestId('tab-context-menu-close').click();
  await expect(page.getByTestId('tab-confluence:4')).toHaveCount(0);

  // 같은 페이지 (탐색) 를 다시 열면 unpinned 로 옴 — pinned 목록이 정리됐다는 신호
  await page.getByTestId('confluence-tree').getByText('탐색', { exact: true }).click();
  await expect(page.getByTestId('tab-confluence:4')).toBeVisible();
  await expect(page.getByTestId('tab-confluence:4')).not.toHaveClass(/pinned/);
});

test('ESC 로 컨텍스트 메뉴 닫힘', async ({ page }) => {
  await openTwoConfluenceTabs(page);
  await page.getByTestId('tab-confluence:3').click({ button: 'right' });
  await expect(page.getByTestId('tab-context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0);
});
