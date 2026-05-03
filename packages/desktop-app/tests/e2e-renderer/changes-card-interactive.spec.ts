// B2-3a: ChangesCard 인터랙티브 — chrome ext 의 per-change ✓ 적용 / ✕ 미적용 / ↩ 되돌리기 +
// 전체 적용/거부 + Apply 시 accepted 만 전송. confluenceApplyEdits 가 받은 items 검증.

import { test, expect, type Page } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

// Suggest_edits mock 으로 3 changes 응답 + Apply 흐름 호출 capture.
async function setupChanges(page: Page): Promise<{ getApplyArgs: () => Promise<unknown> }> {
  await page.addInitScript({ content: mockProjkInitScript });
  // review mock — single change set 에 집중하려고 minimal review.
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'result', data: { review: JSON.stringify({ score: 60, issues: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }), model: 'sonnet' } },
      ]),
    });
  });
  // suggest_edits mock — 3 changes (id A/B/C, before/after distinct).
  await page.route('**/127.0.0.1:**/suggest_edits', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '수정안 생성' },
        {
          type: 'result',
          data: {
            changes: [
              { id: 'A', description: 'A 변경', section: 's1', before: 'old A text', after: 'new A text' },
              { id: 'B', description: 'B 변경', section: 's2', before: 'before B word', after: 'after B word' },
              { id: 'C', description: 'C 변경', section: 's3', before: 'C original', after: 'C improved' },
            ],
          },
        },
      ]),
    });
  });

  // mock-projk 의 confluenceApplyEdits 가 window.__lastApplyArgs 에 자동 capture.
  await page.goto('/');
  await page.getByTestId('activity-confluence').click();
  const tree = page.getByTestId('confluence-tree');
  await tree.getByText('Design', { exact: true }).click();
  await tree.getByText('시스템 디자인', { exact: true }).click();
  await tree.getByText('전투', { exact: true }).click();
  await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wv = document.querySelector('webview') as any;
    if (wv) wv.executeJavaScript = async () => '본문 mock';
  });

  // Review → "✏️ 원본 수정안" → ChangesCard
  await page.getByTestId('confluence-review').click();
  await page.getByTestId('review-fix').click();
  await expect(page.getByTestId('changes-card')).toBeVisible();
  await expect(page.getByTestId('change-A')).toBeVisible();
  await expect(page.getByTestId('change-B')).toBeVisible();
  await expect(page.getByTestId('change-C')).toBeVisible();

  return {
    getApplyArgs: async () => page.evaluate(() => (window as unknown as { __lastApplyArgs: unknown }).__lastApplyArgs),
  };
}

test('초기 상태 — 모든 row 가 pending, summary "0/0/3", Apply 버튼 disabled', async ({ page }) => {
  await setupChanges(page);
  await expect(page.getByTestId('change-A')).toHaveAttribute('data-decision', 'pending');
  await expect(page.getByTestId('change-B')).toHaveAttribute('data-decision', 'pending');
  await expect(page.getByTestId('change-C')).toHaveAttribute('data-decision', 'pending');
  const summary = page.getByTestId('changes-summary');
  await expect(summary).toContainText('0건 적용');
  await expect(summary).toContainText('3건 대기');
  // Apply disabled
  await expect(page.getByTestId('changes-apply')).toBeDisabled();
});

test('per-row ✓ 적용 클릭 → row decision=accepted + summary 갱신 + ↩ 되돌리기 버튼 표시', async ({ page }) => {
  await setupChanges(page);
  await page.getByTestId('change-accept-A').click();
  await expect(page.getByTestId('change-A')).toHaveAttribute('data-decision', 'accepted');
  await expect(page.getByTestId('changes-summary')).toContainText('1건 적용');
  // ↩ 버튼 노출 (pending 시 보였던 ✓/✕ 사라짐)
  await expect(page.getByTestId('change-undo-A')).toBeVisible();
  await expect(page.getByTestId('change-accept-A')).toHaveCount(0);
});

test('↩ 되돌리기 → pending 복구', async ({ page }) => {
  await setupChanges(page);
  await page.getByTestId('change-reject-B').click();
  await expect(page.getByTestId('change-B')).toHaveAttribute('data-decision', 'rejected');
  await page.getByTestId('change-undo-B').click();
  await expect(page.getByTestId('change-B')).toHaveAttribute('data-decision', 'pending');
});

test('전체 적용 → 모두 accepted, summary "3/0/0"', async ({ page }) => {
  await setupChanges(page);
  await page.getByTestId('changes-accept-all').click();
  for (const id of ['A', 'B', 'C']) {
    await expect(page.getByTestId(`change-${id}`)).toHaveAttribute('data-decision', 'accepted');
  }
  await expect(page.getByTestId('changes-summary')).toContainText('3건 적용');
  await expect(page.getByTestId('changes-summary')).toContainText('0건 대기');
});

test('Apply 시 accepted 만 confluenceApplyEdits 에 전달 (rejected/pending 제외)', async ({ page }) => {
  const ctrl = await setupChanges(page);
  // A 적용, B 거부, C 그대로 pending
  await page.getByTestId('change-accept-A').click();
  await page.getByTestId('change-reject-B').click();
  // Apply
  await expect(page.getByTestId('changes-apply')).toBeEnabled();
  await page.getByTestId('changes-apply').click();
  // confluenceApplyEdits 캡처 — items 가 A 만 포함, B/C 제외
  await expect.poll(async () => ctrl.getApplyArgs()).not.toBeNull();
  const captured = await ctrl.getApplyArgs() as { items: Array<{ id: string }> };
  expect(captured.items.length).toBe(1);
  expect(captured.items[0]!.id).toBe('A');
});

test('inline diff — added (초록) + removed (빨강) span 표시', async ({ page }) => {
  await setupChanges(page);
  // change-A 의 diff 안 added/removed span 둘 다 있음
  const diff = page.getByTestId('change-A').locator('[data-testid="change-diff"]');
  await expect(diff.locator('.diff-added')).toHaveCount(1);
  await expect(diff.locator('.diff-removed')).toHaveCount(1);
  // 'old' 가 removed, 'new' 가 added 안에
  await expect(diff.locator('.diff-removed')).toContainText('old');
  await expect(diff.locator('.diff-added')).toContainText('new');
});
