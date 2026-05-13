// 2026-05-13 릴리스-B: SettingsModal 의 Google Workspace SSO 섹션 e2e.
//
// 회귀 방지:
// - 미로그인 상태 → "Google 로그인" 버튼 + 안내 문구
// - 클릭 → main.google.authStart() 호출 → 성공 응답 후 status 업데이트 ("✓ <email>")
// - 로그인 후 "로그아웃" 버튼 → signOut + 다시 "Google 로그인"
// - OAuth flow 자체는 main 의 BrowserWindow + 로컬 HTTP 서버 책임이라 e2e 에서 mock.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  // window.projk.google 를 테스트 mock 으로 교체 — 실제 OAuth 안 돌아감.
  await page.addInitScript({
    content: `
      (function () {
        const real = window.projk;
        if (!real) return;
        window.__googleAuthState = { creds: null };
        real.google = {
          authStart: async () => {
            window.__googleAuthState.creds = {
              email: 'jacob@bighitcorp.com',
              name: 'Jacob Han',
              picture: 'https://example/pic.png',
              hd: 'bighitcorp.com',
              hasToken: true,
              expiresInSeconds: 3500,
            };
            return { ok: true, email: 'jacob@bighitcorp.com', name: 'Jacob Han' };
          },
          getCreds: async () => window.__googleAuthState.creds,
          signOut: async () => {
            window.__googleAuthState.creds = null;
            return { ok: true };
          },
        };
      })();
    `,
  });
  await page.goto('/');
  await page.getByTestId('topbar-settings').click();
  await expect(page.getByTestId('settings-google-client-id')).toBeVisible();
});

test('미로그인 — "Google 로그인" 버튼 + 익명 안내', async ({ page }) => {
  await expect(page.getByTestId('settings-google-signin')).toBeVisible();
  await expect(page.getByTestId('settings-google-status')).toContainText('로그인 안 됨');
  // 로그아웃 버튼은 미존재.
  await expect(page.getByTestId('settings-google-signout')).toHaveCount(0);
});

test('로그인 클릭 → status 가 email + name 으로 갱신', async ({ page }) => {
  await page.getByTestId('settings-google-signin').click();
  // status 가 갱신될 때까지.
  await expect(page.getByTestId('settings-google-status')).toContainText('jacob@bighitcorp.com');
  await expect(page.getByTestId('settings-google-status')).toContainText('Jacob Han');
  await expect(page.getByTestId('settings-google-signout')).toBeVisible();
  await expect(page.getByTestId('settings-google-auth-msg')).toContainText('로그인 완료');
});

test('로그아웃 → 다시 미로그인 상태로 복원', async ({ page }) => {
  // 먼저 로그인.
  await page.getByTestId('settings-google-signin').click();
  await expect(page.getByTestId('settings-google-signout')).toBeVisible();

  // 로그아웃.
  await page.getByTestId('settings-google-signout').click();
  await expect(page.getByTestId('settings-google-signin')).toBeVisible();
  await expect(page.getByTestId('settings-google-status')).toContainText('로그인 안 됨');
  await expect(page.getByTestId('settings-google-auth-msg')).toContainText('로그아웃');
});

test('hd 칸은 disabled — 사내 정책으로 hybecorp.com 고정', async ({ page }) => {
  const hd = page.getByTestId('settings-google-hd');
  await expect(hd).toBeDisabled();
  await expect(hd).toHaveValue('hybecorp.com');
});

test('clientId 입력 후 저장 → settings.set 에 client_id 포함 + hd 는 undefined (옛 값 청소)', async ({ page }) => {
  await page.evaluate(() => {
    const real = (window as unknown as { projk: { setSettings: (p: unknown) => Promise<unknown> } }).projk;
    const orig = real.setSettings.bind(real);
    real.setSettings = async (p) => {
      (window as unknown as { __lastSetPayload: unknown }).__lastSetPayload = p;
      return orig(p);
    };
  });

  await page.getByTestId('settings-google-client-id').fill('123.apps.googleusercontent.com');
  await page.getByTestId('settings-save').click();

  await expect.poll(async () => {
    return await page.evaluate(() => (window as unknown as { __lastSetPayload?: Record<string, unknown> }).__lastSetPayload ?? null);
  }).not.toBeNull();

  const payload = (await page.evaluate(
    () => (window as unknown as { __lastSetPayload: Record<string, unknown> }).__lastSetPayload,
  )) as { googleOAuthClientId?: string; googleWorkspaceDomain?: string };
  expect(payload.googleOAuthClientId).toBe('123.apps.googleusercontent.com');
  // hd 는 사내 정책 고정이라 settings 에 더 이상 저장 X (undefined 로 보내 옛 값 청소).
  expect(payload.googleWorkspaceDomain).toBeUndefined();
});
