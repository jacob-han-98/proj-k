// 0.1.50 (Step 1+2) — LocalSheetView 의 ensureFresh 흐름 + 백그라운드 sync indicator + reload.
//
// 시나리오 3개:
//   A) ensureFresh fail (sync 클라이언트 미설정 등) → SheetMappingPrompt fallback
//   B) ensureFresh ok + alreadyFresh:true → webview 즉시 표시, 동기화 indicator 없음
//   C) ensureFresh ok + syncing:true → webview + "🔄 OneDrive 동기화 중…" 표시, 그 후
//      progress completed push → indicator 사라짐
//
// 주의: Playwright web-mode 환경에서 <webview> 는 진짜 Electron webview 가 아니라 그냥 무시되는
// HTMLElement. src/partition attribute 와 mount 여부만 검증 가능. reload() 호출 자체는 검증 X.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  // 1) <webview> 가 mount + src 세팅되면 chromium 이 그 URL 로 navigation 시도해 page 가
  //    close 되는 현상 (Electron 의 native sandbox 가 없는 vanilla chromium). 이 spec 은 webview
  //    의 src/partition attribute 만 검증하면 충분하므로 document.createElement('webview') 를
  //    fake <div> 로 swap (spec-local — 다른 webview 사용 spec 들 (review/workbench) 영향 없음).
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
  // P4 사이드바 활성화 + 트리 펼침.
  await page.getByTestId('activity-p4').click();
});

async function openSheet(page: import('@playwright/test').Page, sheetTitle: 'HUD_기본' | 'HUD_전투') {
  const tree = page.getByTestId('p4-tree');
  // 트리 펼침 (HUD_기본 가시화).
  if (!(await tree.getByText(sheetTitle, { exact: true }).isVisible().catch(() => false))) {
    await tree.getByText('7_System', { exact: true }).click();
    await tree.getByText('PK_HUD 시스템', { exact: true }).click();
  }
  await tree.getByText(sheetTitle, { exact: true }).click();
}

test('A) ensureFresh fail → SheetMappingPrompt fallback 으로 떨어짐', async ({ page }) => {
  // mock 의 기본 ensureFreshResponse 는 ok:false. (sync 클라이언트 미설정 케이스)
  await openSheet(page, 'HUD_기본');

  // fallback 신호 — SheetMappingPrompt mount 검증.
  await expect(page.getByTestId('sheet-mapping-prompt')).toBeVisible();
  // mock 환경에서 detect() 도 ok:false → syncDetected=false 분기 메시지가 보여야 한다.
  await expect(page.getByText(/OneDrive Business Sync 클라이언트가 감지되지 않았습니다/)).toBeVisible();

  // 사용자가 매핑 등록하지 않은 상태이므로 webview 는 mount 안 됨.
  await expect(page.getByTestId('onedrive-webview')).toHaveCount(0);
});

test('B) ensureFresh ok + alreadyFresh → webview 즉시, 동기화 indicator 없음', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock-tenant-my.sharepoint.com/personal/u/Documents/Klaud-temp/HUD.xlsx?web=1',
      alreadyFresh: true,
      syncing: false,
    });
  });

  await openSheet(page, 'HUD_기본');

  // webview mount + src 세팅.
  const wv = page.getByTestId('onedrive-webview');
  await expect(wv).toBeVisible();
  await expect(wv).toHaveAttribute('src', /sharepoint\.com.*HUD\.xlsx/);
  // 백그라운드 sync 가 안 시작됐으니 indicator 없음.
  await expect(page.getByTestId('onedrive-bg-syncing')).toHaveCount(0);

  // ensureFresh 가 어떤 relPath 로 호출됐는지 mock 이 기록 — 검증.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastRel = await page.evaluate(() => (window as any).__getLastEnsureFreshRelPath());
  expect(lastRel).toBe('7_System/PK_HUD 시스템/HUD_기본');
});

test('C) ensureFresh ok + syncing → indicator 표시 → completed push → indicator 사라짐', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock-tenant-my.sharepoint.com/personal/u/Documents/Klaud-temp/HUD.xlsx?web=1',
      alreadyFresh: false,
      syncing: true,
    });
  });

  await openSheet(page, 'HUD_기본');

  // webview 즉시 보이고 indicator 도 같이.
  await expect(page.getByTestId('onedrive-webview')).toBeVisible();
  await expect(page.getByTestId('onedrive-bg-syncing')).toBeVisible();

  // main 이 백그라운드 sync 끝났다는 신호를 push (시뮬레이션).
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__pushSyncProgress({
      relPath: '7_System/PK_HUD 시스템/HUD_기본',
      state: 'completed',
    });
  });

  // indicator 가 사라져야 (LocalSheetView 가 setBgSyncing(false) 호출).
  await expect(page.getByTestId('onedrive-bg-syncing')).toHaveCount(0);
  // webview 는 그대로 mount.
  await expect(page.getByTestId('onedrive-webview')).toBeVisible();
});
