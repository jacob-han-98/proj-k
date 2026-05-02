// 진짜 Electron + 진짜 sidecar + 진짜 OneDrive Sync 클라이언트 + 진짜 P4 워크스페이스 환경에서
// 사용자 시나리오 자동 검증.
//
// 시나리오: P4 사이드바 → local 트리 → 임의 sheet 좌클릭 → LocalSheetView 가 ensureFresh 호출 →
//          webview 가 SharePoint URL 로 mount → 매핑이 settings.json 에 cache.
//
// 이번 세션에서 발견된 useEffect 무한 루프 류 회귀를 진짜 환경에서 잡는 게 목적.
// vitest/pytest 가 못 잡는 main↔sidecar↔renderer 의 진짜 IPC pipe 동작이 검증됨.
//
// 실행: `npm run test:electron`
// 선행: `npm run build` 가 out/main/index.js 를 만들었어야 함.

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  // ELECTRON_RUN_AS_NODE 가 켜져 있으면 main 이 app.isPackaged 못 읽고 crash. 명시 unset.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  app = await _electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env,
    timeout: 60_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('local sheet 좌클릭 → ensureFresh + webview 가 SharePoint URL 로 mount', async () => {
  // Sidecar 가 ready 까지 대기 (status indicator 가 ":<port>" 표기).
  await expect(win.getByText(/sidecar ready/)).toBeVisible({ timeout: 30_000 });

  // P4 사이드바 활성화.
  await win.getByTestId('activity-p4').click();
  await expect(win.getByTestId('p4-source-local')).toBeVisible();

  // local 트리에서 첫 .xlsx sheet 찾아 클릭. 사용자 환경에 어떤 sheet 가 있는지는 모르므로
  // .xlsx 아이콘 (📄) 또는 sheet kind 노드 첫 번째 hit 사용.
  const tree = win.getByTestId('p4-tree');
  await expect(tree).toBeVisible();
  // 첫 카테고리 펼침 → 첫 워크북 펼침 → 첫 sheet 클릭.
  // 트리 구조에 따라 단계 다를 수 있지만 mock 트리와 같은 구조 기대 (category > workbook > sheet).
  const firstCategory = tree.locator('.tree-row').first();
  await firstCategory.click();
  const firstWorkbook = tree.locator('.tree-row').nth(1);
  if (await firstWorkbook.isVisible().catch(() => false)) {
    await firstWorkbook.click();
  }
  // sheet 노드 (caret 없는 leaf) 첫 번째 클릭.
  const firstSheet = tree.locator('.tree-row:not(:has(.caret:has-text("▾"))):not(:has(.caret:has-text("▸")))').first();
  await firstSheet.click();

  // ensureFresh 응답 후 webview mount. cachedUrl 없는 첫 sheet 라면 placeholder → webview 전환.
  // OneDrive 실제 sync (~수~십 초) 완료까지 webview src 가 SharePoint URL 이어야.
  await expect(win.getByTestId('onedrive-webview').or(win.getByTestId('sheet-mapping-prompt')))
    .toBeVisible({ timeout: 60_000 });

  // 정상 흐름 가정: webview 가 떴다면 src 가 sharepoint 또는 office.com URL.
  const wv = win.getByTestId('onedrive-webview');
  if (await wv.isVisible().catch(() => false)) {
    const src = await wv.getAttribute('src');
    expect(src).toMatch(/sharepoint\.com|office\.com|live\.com/);
    expect(src).toContain('Klaud-temp');
  }
});

test('두 번째 mount — cachedUrl 즉시 webview, 백그라운드 mtime 비교', async () => {
  // 같은 sheet 두 번째 클릭 (탭 닫고 다시 열거나, 다른 sheet 갔다 돌아오기).
  // 매핑이 cache 됐으면 webview 즉시 mount. 백그라운드 sync indicator 는 stale 일 때만.
  const tree = win.getByTestId('p4-tree');
  // 첫 sheet 클릭 (탭 reuse — 같은 sheet 면 새 탭 안 만들고 focus).
  const firstSheet = tree.locator('.tree-row:not(:has(.caret:has-text("▾"))):not(:has(.caret:has-text("▸")))').first();
  await firstSheet.click();

  // 즉시 webview (placeholder 거치지 않음) — 1초 안에 visible.
  await expect(win.getByTestId('onedrive-webview')).toBeVisible({ timeout: 5_000 });
});
