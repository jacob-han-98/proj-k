// 0.1.51 v6 — LocalSheetView 의 ensureFresh 흐름. main 이 모든 단계 (stat 비교 +
// writeViaTempCopy + cloud HEAD polling) 를 직렬로 처리 후 ready/cloud-not-ready/실패 중 하나로
// return. 옛 fire-and-forget 흐름 (cachedUrl 즉시 mount + BG progress event) 제거됨.
//
// 시나리오:
//   A) ensureFresh ok:false → SheetMappingPrompt fallback
//   B) ensureFresh ok + status:'ready' → webview 마운트
//   C) ensureFresh ok + status:'cloud-not-ready' → inline 에러 카드 + 재시도 버튼
//   D) C 에서 재시도 클릭 + repoll ready:true → 카드 사라지고 webview 마운트
//   E) C 에서 재시도 클릭 + repoll ready:false → 카드 유지, 메타 갱신
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

test('B) ensureFresh ok + status:ready → webview 즉시 마운트', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock-tenant-my.sharepoint.com/personal/u/Documents/Klaud-temp/HUD.xlsx?web=1',
      status: 'ready',
    });
  });

  await openSheet(page, 'HUD_기본');

  // webview mount + src 세팅.
  const wv = page.getByTestId('onedrive-webview');
  await expect(wv).toBeVisible();
  await expect(wv).toHaveAttribute('src', /sharepoint\.com.*HUD\.xlsx/);
  // v6 — 카드도 placeholder 도 없어야 (ready 상태).
  await expect(page.getByTestId('onedrive-cloud-not-ready')).toHaveCount(0);
  await expect(page.getByTestId('onedrive-syncing-placeholder')).toHaveCount(0);

  // ensureFresh 가 어떤 relPath 로 호출됐는지 mock 이 기록 — 검증.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastRel = await page.evaluate(() => (window as any).__getLastEnsureFreshRelPath());
  expect(lastRel).toBe('7_System/PK_HUD 시스템/HUD_기본');
});

test('C) ensureFresh ok + status:cloud-not-ready → inline 에러 카드 + webview 차단', async ({ page }) => {
  // v6: main 이 IPC return 으로 직접 cloud-not-ready 전달. 옛 progress event push 흐름 제거.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock-tenant-my.sharepoint.com/personal/u/Documents/Klaud-temp/HUD.xlsx?web=1',
      status: 'cloud-not-ready',
      pollAttempts: 11,
      pollLastStatus: 404,
    });
  });

  await openSheet(page, 'HUD_기본');

  // inline 에러 카드 — testid + 본문 텍스트 검증.
  await expect(page.getByTestId('onedrive-cloud-not-ready')).toBeVisible();
  await expect(page.getByText(/OneDrive 동기화 미완료/)).toBeVisible();
  await expect(page.getByText(/11회 폴링/)).toBeVisible();
  await expect(page.getByText(/status=404/)).toBeVisible();

  // webview / placeholder 안 보임 (사용자가 SP 404 / stub 페이지 직접 보는 일 없음).
  await expect(page.getByTestId('onedrive-webview')).toHaveCount(0);
  await expect(page.getByTestId('onedrive-syncing-placeholder')).toHaveCount(0);
  // 재시도 버튼 활성.
  const retry = page.getByTestId('onedrive-retry');
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
});

test('D) cloud-not-ready 카드 → 재시도 → repoll ready:true → webview 마운트', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock-tenant-my.sharepoint.com/personal/u/Documents/Klaud-temp/HUD.xlsx?web=1',
      status: 'cloud-not-ready',
      pollAttempts: 11,
      pollLastStatus: 404,
    });
    // 재시도 시 repoll 은 ready:true 반환.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setRepollResponse({ ok: true, ready: true, pollAttempts: 1, pollLastStatus: 302 });
  });

  await openSheet(page, 'HUD_기본');
  await expect(page.getByTestId('onedrive-cloud-not-ready')).toBeVisible();

  // 재시도 클릭. ready:true → 카드 사라지고 webview mount.
  await page.getByTestId('onedrive-retry').click();
  await expect(page.getByTestId('onedrive-cloud-not-ready')).toHaveCount(0);
  await expect(page.getByTestId('onedrive-webview')).toBeVisible();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repollCount = await page.evaluate(() => (window as any).__getRepollCallCount());
  expect(repollCount).toBe(1);
});

test('E) cloud-not-ready 카드 → 재시도 → repoll ready:false → 카드 유지 + 메타 갱신', async ({ page }) => {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setEnsureFreshResponse({
      ok: true,
      url: 'https://mock-tenant-my.sharepoint.com/personal/u/Documents/Klaud-temp/HUD.xlsx?web=1',
      status: 'cloud-not-ready',
      pollAttempts: 11,
      pollLastStatus: 404,
    });
    // repoll 도 여전히 cloud 못 찾음.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setRepollResponse({ ok: true, ready: false, pollAttempts: 8, pollLastStatus: 503 });
  });

  await openSheet(page, 'HUD_기본');
  await expect(page.getByTestId('onedrive-cloud-not-ready')).toBeVisible();
  await expect(page.getByText(/status=404/)).toBeVisible();

  await page.getByTestId('onedrive-retry').click();

  // 카드 유지 + 메타 변경.
  await expect(page.getByTestId('onedrive-cloud-not-ready')).toBeVisible();
  await expect(page.getByText(/8회 폴링/)).toBeVisible();
  await expect(page.getByText(/status=503/)).toBeVisible();
  await expect(page.getByTestId('onedrive-webview')).toHaveCount(0);
});

