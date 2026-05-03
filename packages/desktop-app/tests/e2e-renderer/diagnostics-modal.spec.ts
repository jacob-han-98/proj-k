// C1: 환경 진단 모달 — TitleBar 의 🩺 버튼 → modal 띄움 → 9 항목 status 표시.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

test('🩺 버튼 클릭 → 진단 모달 열림 + 9 항목 표시', async ({ page }) => {
  await page.getByTestId('topbar-diagnostics').click();
  await expect(page.getByTestId('diag-modal')).toBeVisible();
  // 9 개 row 모두 노출.
  for (const id of ['sidecar', 'repo-root', 'p4-root', 'p4-cli', 'xlsx-extractor', 'confluence', 'agent', 'updater', 'onedrive']) {
    await expect(page.getByTestId(`diag-row-${id}`)).toBeVisible();
  }
  // summary — 검사 끝나면 ✅ X · ⚠ Y 표기
  await expect(page.getByTestId('diag-summary')).not.toContainText('검사 중');
});

test('Confluence creds 미등록 → warn + 설정 열기 단축키', async ({ page }) => {
  // mock-projk 의 getConfluenceCreds 는 항상 null. → confluence row 가 warn.
  await page.getByTestId('topbar-diagnostics').click();
  const conf = page.getByTestId('diag-row-confluence');
  await expect(conf).toHaveAttribute('data-status', 'warn');
  await expect(page.getByTestId('diag-action-confluence')).toContainText('설정');
});

test('설정 열기 action → 진단 닫고 SettingsModal 띄움', async ({ page }) => {
  await page.getByTestId('topbar-diagnostics').click();
  const credsAction = page.getByTestId('diag-action-confluence');
  await expect(credsAction).toBeVisible();
  await credsAction.click();
  await expect(page.getByTestId('diag-modal')).toHaveCount(0);
  // SettingsModal 의 input 중 하나 (settings-repo-root) 가 보이면 모달 노출.
  await expect(page.getByTestId('settings-repo-root')).toBeVisible();
});

test('새로고침 (🔄) — 다시 검사', async ({ page }) => {
  await page.getByTestId('topbar-diagnostics').click();
  await expect(page.getByTestId('diag-summary')).not.toContainText('검사 중');
  await page.getByTestId('diag-refresh').click();
  // 한 번 검사중으로 갔다가 다시 결과로.
  await expect(page.getByTestId('diag-summary')).not.toContainText('검사 중');
});

test('× 버튼 / backdrop 클릭 — 모달 닫힘', async ({ page }) => {
  await page.getByTestId('topbar-diagnostics').click();
  await page.getByTestId('diag-modal-close').click();
  await expect(page.getByTestId('diag-modal')).toHaveCount(0);
  // backdrop 도 동일
  await page.getByTestId('topbar-diagnostics').click();
  await page.getByTestId('diag-modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('diag-modal')).toHaveCount(0);
});
