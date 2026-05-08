// 액티비티 바 5번 ("내 작업 중 문서") — ActiveDocsPanel UI flow.
// 사용자 시나리오:
//  - Ctrl+5 / 5번 버튼 클릭 → 패널 열림 + 두 섹션 (P4 체크아웃 / Confluence 수정 중) 표시
//  - 빈 결과 → "체크아웃한 파일이 없어요." / "draft 상태인 문서가 없어요."
//  - 데이터 있음 → 행 클릭 시 P4 는 openDepotFile → excel 탭, Confluence 는 confluence 탭 open

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

test('Ctrl+5 → 패널 열림 + 빈 상태 메시지', async ({ page }) => {
  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('active-docs-panel')).toBeVisible();
  // 기본 mock 은 두 섹션 모두 빈 결과.
  await expect(page.getByTestId('active-docs-p4-empty')).toBeVisible();
  await expect(page.getByTestId('active-docs-confluence-empty')).toBeVisible();
  // section header label.
  await expect(page.getByTestId('sidebar-section-header-active')).toHaveText('내 작업 중 문서');
});

test('P4 + Confluence 데이터 표시 + 클릭으로 탭 open', async ({ page }) => {
  // mock data 주입 — addInitScript 가 hook 노출 (__setActiveDocsP4 / __setActiveDocsConfluence).
  await page.evaluate(() => {
    const setP4 = (window as unknown as { __setActiveDocsP4: (r: unknown) => void }).__setActiveDocsP4;
    const setConf = (window as unknown as { __setActiveDocsConfluence: (r: unknown) => void })
      .__setActiveDocsConfluence;
    setP4({
      ok: true,
      files: [
        { depotPath: '//main/ProjectK/HUD.xlsx', clientPath: '//jacob-D/HUD.xlsx', action: 'edit', revision: 3 },
      ],
    });
    setConf({
      ok: true,
      drafts: [
        {
          pageId: '12345',
          title: '신규 시스템 기획',
          spaceKey: 'PK',
          lastModified: new Date().toISOString(),
        },
      ],
    });
  });

  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('active-docs-panel')).toBeVisible();

  // P4 행 + Confluence 행 모두 보임.
  const p4Row = page.getByTestId('active-docs-p4-row-//main/ProjectK/HUD.xlsx');
  const confRow = page.getByTestId('active-docs-confluence-row-12345');
  await expect(p4Row).toBeVisible();
  await expect(p4Row).toContainText('HUD.xlsx');
  await expect(p4Row).toContainText('edit');
  await expect(p4Row).toContainText('#3');
  await expect(confRow).toBeVisible();
  await expect(confRow).toContainText('신규 시스템 기획');
  await expect(confRow).toContainText('PK');

  // P4 클릭 → openDepotFile mock 이 fake URL 반환 → excel 탭 open (탭 스트립에 새 탭).
  // tab-bar 안의 role=tab 버튼들로 카운트 — testid 가 'tab-${id}' 인데 id 에 콜론/슬래시 포함되어 regex 불편.
  const tabBar = page.getByTestId('tab-bar');
  await p4Row.click();
  await expect.poll(async () => tabBar.locator('[role="tab"]').count()).toBeGreaterThanOrEqual(1);

  // Confluence 클릭 → confluence 탭 추가.
  await confRow.click();
  await expect.poll(async () => tabBar.locator('[role="tab"]').count()).toBeGreaterThanOrEqual(2);
});

test('refresh 버튼 — 상태 다시 가져오기', async ({ page }) => {
  await page.evaluate(() => {
    const setP4 = (window as unknown as { __setActiveDocsP4: (r: unknown) => void }).__setActiveDocsP4;
    setP4({ ok: true, files: [] });
  });
  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('active-docs-p4-empty')).toBeVisible();

  // refresh 후 데이터 변경 → UI 도 갱신.
  await page.evaluate(() => {
    const setP4 = (window as unknown as { __setActiveDocsP4: (r: unknown) => void }).__setActiveDocsP4;
    setP4({
      ok: true,
      files: [{ depotPath: '//main/A.xlsx', action: 'add', revision: 1 }],
    });
  });
  await page.getByTestId('active-docs-refresh').click();
  await expect(page.getByTestId('active-docs-p4-row-//main/A.xlsx')).toBeVisible();
});

test('자격 미설정 — Confluence 섹션 에러 메시지', async ({ page }) => {
  await page.evaluate(() => {
    const setConf = (window as unknown as { __setActiveDocsConfluence: (r: unknown) => void })
      .__setActiveDocsConfluence;
    setConf({ ok: false, drafts: [], diagnostics: 'Confluence 자격 미설정 — 우상단 ⚙ 에서 입력하세요.' });
  });
  await page.keyboard.press('Control+5');
  const errBox = page.getByTestId('active-docs-confluence-error');
  await expect(errBox).toBeVisible();
  await expect(errBox).toContainText('자격 미설정');
});
