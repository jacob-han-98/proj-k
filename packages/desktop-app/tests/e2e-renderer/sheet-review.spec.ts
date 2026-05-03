// B3: P4 시트 doc review — LocalSheetView 의 📋 리뷰 버튼.
//
// 흐름: P4 트리 → sheet 클릭 → ensureFresh ok → webview mount → 리뷰 클릭 → /sheet_content
// → ReviewSplitPane 안 review_stream 입력으로 흘러감.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  // webview 가 page navigation 일으키지 않도록 fake div 로 swap (onedrive-sync.spec.ts 와 같은 pattern).
  await page.addInitScript({
    content: `
      (function () {
        const _origCreate = document.createElement.bind(document);
        document.createElement = function (tagName, options) {
          if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
            const div = _origCreate('div', options);
            div.setAttribute('data-fake-webview', '1');
            div.reload = function () {};
            div.executeJavaScript = function () { return Promise.resolve(''); };
            return div;
          }
          return _origCreate(tagName, options);
        };
      })();
    `,
  });
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
  await page.getByTestId('activity-p4').click();
});

async function openHudSheet(page: import('@playwright/test').Page) {
  const tree = page.getByTestId('p4-tree');
  await tree.getByText('7_System', { exact: true }).click();
  await tree.getByText('PK_HUD 시스템', { exact: true }).click();
  // 시트 leaf 클릭 → setSelection({kind:'sheet', node}) → LocalSheetView mount.
  await tree.getByText('HUD_기본', { exact: true }).click();
}

test('ensureFresh ok 에서만 리뷰 버튼 노출', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock.sharepoint.com/x.xlsx?web=1',
      alreadyFresh: true,
      syncing: false,
    });
  });
  await openHudSheet(page);
  const btn = page.getByTestId('sheet-review');
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('리뷰');
});

test('리뷰 버튼 클릭 → /sheet_content fetch → ReviewSplitPane 열림', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock.sharepoint.com/x.xlsx?web=1',
      alreadyFresh: true,
      syncing: false,
    });
  });
  await openHudSheet(page);
  await page.getByTestId('sheet-review').click();
  // /sheet_content fetch + onRequestReview → openSplit → ReviewSplitPane mount.
  // ReviewSplitPane 의 root testid 는 review-card 또는 review-streaming. status indicator 노출 검증.
  await expect(
    page.getByTestId('review-streaming').or(page.getByTestId('review-card')),
  ).toBeVisible({ timeout: 5_000 });
});

test('ensureFresh fail (fallback) → 리뷰 버튼 미노출', async ({ page }) => {
  // mock default 는 ok:false → SheetMappingPrompt fallback view 으로 빠짐.
  await openHudSheet(page);
  // 리뷰 버튼은 main render path 에만 있어 fallback view 에선 hidden.
  await expect(page.getByTestId('sheet-review')).toHaveCount(0);
});
