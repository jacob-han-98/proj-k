// A1: ActivityBar 단축키 (Ctrl+1~4 / Cmd+1~4) — VS Code 의 Ctrl+Shift+E 등가물.
//
// 4 개 패널 (Perforce / Confluence / 빠른검색 / QnA) 각각에 Ctrl+숫자 매핑. 사용자가 텍스트
// 입력 (input/textarea/contenteditable) 에 focus 일 때는 단축키 무시 — 충돌 회피.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

// 헬퍼 — 현재 active 한 activity 버튼이 어느 kind 인지 반환 (active 클래스 + aria-pressed).
async function activeKind(page: import('@playwright/test').Page): Promise<string | null> {
  const buttons = await page.getByTestId(/^activity-/).all();
  for (const b of buttons) {
    const pressed = await b.getAttribute('aria-pressed');
    if (pressed === 'true') {
      const tid = await b.getAttribute('data-testid');
      return tid?.replace('activity-', '') ?? null;
    }
  }
  return null;
}

test('Ctrl+1~5 → 5 개 패널 순차 활성화 (P4 / Confluence / 빠른검색 / QnA / 최근)', async ({ page }) => {
  // default 는 confluence (store 의 default activeIcon).
  await expect.poll(() => activeKind(page)).toBe('confluence');

  await page.keyboard.press('Control+1');
  await expect.poll(() => activeKind(page)).toBe('p4');

  await page.keyboard.press('Control+2');
  await expect.poll(() => activeKind(page)).toBe('confluence');

  await page.keyboard.press('Control+3');
  await expect.poll(() => activeKind(page)).toBe('find');

  await page.keyboard.press('Control+4');
  await expect.poll(() => activeKind(page)).toBe('qna');

  await page.keyboard.press('Control+5');
  await expect.poll(() => activeKind(page)).toBe('recent');
});

test('Tooltip + aria-keyshortcuts 에 단축키 명시', async ({ page }) => {
  const p4Btn = page.getByTestId('activity-p4');
  await expect(p4Btn).toHaveAttribute('title', /Ctrl\+1/);
  await expect(p4Btn).toHaveAttribute('aria-keyshortcuts', 'Control+1');

  const confBtn = page.getByTestId('activity-confluence');
  await expect(confBtn).toHaveAttribute('aria-keyshortcuts', 'Control+2');

  const findBtn = page.getByTestId('activity-find');
  await expect(findBtn).toHaveAttribute('aria-keyshortcuts', 'Control+3');

  const qnaBtn = page.getByTestId('activity-qna');
  await expect(qnaBtn).toHaveAttribute('aria-keyshortcuts', 'Control+4');

  const recentBtn = page.getByTestId('activity-recent');
  await expect(recentBtn).toHaveAttribute('aria-keyshortcuts', 'Control+5');
});

test('input 에 focus 일 때 단축키 무시 — 텍스트 입력 충돌 회피', async ({ page }) => {
  // 빠른검색 패널 띄우고 거기 input 에 focus.
  await page.keyboard.press('Control+3');
  await expect.poll(() => activeKind(page)).toBe('find');

  // QuickFind 패널의 search input 에 focus
  const searchInput = page.getByTestId('qf-input');
  await searchInput.click();
  await searchInput.fill('테스트');

  // input focus 상태에서 Ctrl+1 — 무시되어야 (panel 안 바뀜)
  await page.keyboard.press('Control+1');
  await expect.poll(() => activeKind(page)).toBe('find');

  // input 에서 escape (blur) → 다시 단축키 동작
  await searchInput.press('Escape');
  // input 의 onChange 가 escape 처리 안 하면 blur 직접
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+1');
  await expect.poll(() => activeKind(page)).toBe('p4');
});

test('Shift 또는 Alt 함께 누르면 무시 — VS Code 의 Ctrl+Shift+P 등 다른 단축키와 충돌 회피', async ({ page }) => {
  await page.keyboard.press('Control+2');
  await expect.poll(() => activeKind(page)).toBe('confluence');

  // Ctrl+Shift+1 — 무시되어야
  await page.keyboard.press('Control+Shift+1');
  await expect.poll(() => activeKind(page)).toBe('confluence');

  // Ctrl+Alt+1 — 무시
  await page.keyboard.press('Control+Alt+1');
  await expect.poll(() => activeKind(page)).toBe('confluence');

  // 단순 Ctrl+1 — 동작
  await page.keyboard.press('Control+1');
  await expect.poll(() => activeKind(page)).toBe('p4');
});
