// 2026-05-13 릴리스-A2: 🚨 제보 모달 e2e.
//
// 회귀 방지:
// - TitleBar 의 🚨 버튼이 보이고 클릭 시 모달 등장
// - 모달이 현재 컨텍스트 (active tab, mode) 를 자동 표시
// - 메모 비어있으면 "한 줄이라도" 안내, 채우면 main.klaudLog.submitReport 호출
// - 성공 응답 → 성공 안내 + 자동 닫기
// - 실패 응답 → 실패 안내 + 모달 유지

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  // klaudLog.submitReport mock 을 window.__klaudReportMock 으로 노출 — 각 테스트가 갈아끼움.
  await page.addInitScript({
    content: `
      (function() {
        const real = window.projk;
        window.__klaudReportLastPayload = null;
        window.__klaudReportNextResponse = { ok: true };
        window.__klaudCaptureNextResponse = { ok: true, screenshotB64: 'iVBORw0KGgoAAAANSUhEUg==', bytes: 18, skipped: false };
        window.__klaudCaptureCallCount = 0;
        if (real) {
          real.klaudLog = {
            push: async () => ({ ok: true }),
            submitReport: async (payload) => {
              window.__klaudReportLastPayload = payload;
              return window.__klaudReportNextResponse;
            },
            captureScreenshot: async () => {
              window.__klaudCaptureCallCount += 1;
              return window.__klaudCaptureNextResponse;
            },
          };
        }
      })();
    `,
  });
  await page.goto('/');
});

test('🚨 제보 버튼 노출 + 클릭 → 모달 등장 + 컨텍스트 자동 표시', async ({ page }) => {
  // TitleBar 🚨 버튼이 보임
  await expect(page.getByTestId('topbar-report')).toBeVisible();

  // 클릭 → 모달
  await page.getByTestId('topbar-report').click();
  await expect(page.getByTestId('report-modal')).toBeVisible();
  await expect(page.getByTestId('report-modal-note')).toBeVisible();
  await expect(page.getByTestId('report-modal-context')).toBeVisible();

  // 활성 문서 없는 상태에선 '없음'
  await expect(page.getByTestId('report-modal-context')).toContainText('없음');
});

test('메모 비어있으면 안내, 채우면 submitReport 호출 + 성공 안내', async ({ page }) => {
  await page.getByTestId('topbar-report').click();

  // 빈 메모로 전송 시도 → 에러 안내, submitReport 호출 X
  await page.getByTestId('report-modal-submit').click();
  await expect(page.getByTestId('report-modal-result')).toContainText('메모를 한 줄');

  // 메모 채우고 전송 → 성공 안내 + 자동 닫기
  await page.getByTestId('report-modal-note').fill('리뷰가 빈 결과만 나옵니다');
  await page.getByTestId('report-modal-submit').click();
  await expect(page.getByTestId('report-modal-result')).toContainText('전송되었습니다');

  // payload 검증
  const payload = await page.evaluate(() => (window as unknown as { __klaudReportLastPayload: unknown }).__klaudReportLastPayload);
  expect(payload).toBeTruthy();
  const p = payload as { note: string; context: Record<string, unknown> };
  expect(p.note).toBe('리뷰가 빈 결과만 나옵니다');
  expect(p.context).toBeTruthy();
  expect(p.context.url).toBeTruthy();

  // 1.5초 후 자동 닫힘
  await expect(page.getByTestId('report-modal')).toHaveCount(0, { timeout: 3000 });
});

test('전송 실패 시 — 실패 안내 + 모달 유지', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __klaudReportNextResponse: unknown }).__klaudReportNextResponse = {
      ok: false,
      reason: 'klaudLogSinkUrl unset',
    };
  });

  await page.getByTestId('topbar-report').click();
  await page.getByTestId('report-modal-note').fill('테스트 메모');
  await page.getByTestId('report-modal-submit').click();

  await expect(page.getByTestId('report-modal-result')).toContainText('전송 실패');
  await expect(page.getByTestId('report-modal-result')).toContainText('klaudLogSinkUrl unset');
  // 모달은 유지 — 사용자가 재시도 or 취소 결정.
  await expect(page.getByTestId('report-modal')).toBeVisible();
});

test('screenshot 토글 OFF (default) → captureScreenshot 호출 X, payload 에 screenshotB64 미포함', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __klaudCaptureCallCount: number }).__klaudCaptureCallCount = 0;
  });
  await page.getByTestId('topbar-report').click();
  await page.getByTestId('report-modal-note').fill('screenshot 없이 전송');
  await page.getByTestId('report-modal-submit').click();
  await expect(page.getByTestId('report-modal-result')).toContainText('전송되었습니다');

  const cap = await page.evaluate(() => (window as unknown as { __klaudCaptureCallCount: number }).__klaudCaptureCallCount);
  expect(cap).toBe(0);
  const payload = (await page.evaluate(() =>
    (window as unknown as { __klaudReportLastPayload: { screenshotB64?: string } | null }).__klaudReportLastPayload,
  )) as { screenshotB64?: string };
  expect(payload.screenshotB64).toBeUndefined();
});

test('screenshot 토글 ON → captureScreenshot 호출 + payload 에 b64 첨부', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __klaudCaptureCallCount: number }).__klaudCaptureCallCount = 0;
  });
  await page.getByTestId('topbar-report').click();
  await page.getByTestId('report-modal-note').fill('스크린샷 첨부 테스트');
  await page.getByTestId('report-modal-screenshot-toggle').check();
  await page.getByTestId('report-modal-submit').click();
  await expect(page.getByTestId('report-modal-result')).toContainText('전송되었습니다');

  const cap = await page.evaluate(() => (window as unknown as { __klaudCaptureCallCount: number }).__klaudCaptureCallCount);
  expect(cap).toBe(1);
  const payload = (await page.evaluate(() =>
    (window as unknown as { __klaudReportLastPayload: { screenshotB64?: string } | null }).__klaudReportLastPayload,
  )) as { screenshotB64?: string };
  expect(payload.screenshotB64).toBe('iVBORw0KGgoAAAANSUhEUg==');
});

test('screenshot 1MB 초과 시 (skipped:true, b64 빈 문자열) → payload 에 b64 미포함, 전송은 진행', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __klaudCaptureNextResponse: unknown }).__klaudCaptureNextResponse = {
      ok: true,
      screenshotB64: '',
      bytes: 2_000_000,
      skipped: true,
    };
  });
  await page.getByTestId('topbar-report').click();
  await page.getByTestId('report-modal-note').fill('큰 스크린샷');
  await page.getByTestId('report-modal-screenshot-toggle').check();
  await page.getByTestId('report-modal-submit').click();
  await expect(page.getByTestId('report-modal-result')).toContainText('전송되었습니다');

  const payload = (await page.evaluate(() =>
    (window as unknown as { __klaudReportLastPayload: { screenshotB64?: string } | null }).__klaudReportLastPayload,
  )) as { screenshotB64?: string };
  // 빈 문자열은 frontend 가 silent skip — payload 의 screenshotB64 는 undefined.
  expect(payload.screenshotB64).toBeUndefined();
});

test('ESC / 취소 → 모달 닫힘 + submitReport 호출 X', async ({ page }) => {
  // 초기화
  await page.evaluate(() => {
    (window as unknown as { __klaudReportLastPayload: unknown }).__klaudReportLastPayload = null;
  });

  await page.getByTestId('topbar-report').click();
  await page.getByTestId('report-modal-note').fill('도중 닫기');

  await page.getByTestId('report-modal-cancel').click();
  await expect(page.getByTestId('report-modal')).toHaveCount(0);

  // 호출 안 됨
  const payload = await page.evaluate(() => (window as unknown as { __klaudReportLastPayload: unknown }).__klaudReportLastPayload);
  expect(payload).toBeNull();

  // ESC 키로도 닫힘
  await page.getByTestId('topbar-report').click();
  await expect(page.getByTestId('report-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('report-modal')).toHaveCount(0);
});
