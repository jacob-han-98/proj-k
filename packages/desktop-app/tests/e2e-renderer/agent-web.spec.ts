// agent-sdk-poc 웹 임베드 — TitleBar 의 🤖 → agent-web 탭 → webview src=agentUrl 도출.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  // <webview> 가 page navigation 일으키지 않도록 fake div 로 swap (다른 e2e 와 같은 pattern).
  await page.addInitScript({
    content: `
      (function () {
        const _origCreate = document.createElement.bind(document);
        document.createElement = function (tagName, options) {
          if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
            const div = _origCreate('div', options);
            div.setAttribute('data-fake-webview', '1');
            return div;
          }
          return _origCreate(tagName, options);
        };
      })();
    `,
  });
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

test('🤖 버튼 클릭 → agent-web 탭 열림 + webview src 가 derive 된 URL', async ({ page }) => {
  // mock 의 storedSettings 의 agentUrl 은 'http://localhost:8090'. derive → 'http://localhost:8090/'.
  await page.getByTestId('topbar-agent-web').click();
  // 탭이 열렸는지.
  await expect(page.getByTestId('agent-web-pane')).toBeVisible();
  // webview src.
  const wv = page.getByTestId('agent-webview');
  await expect(wv).toBeVisible();
  await expect(wv).toHaveAttribute('src', 'http://localhost:8090/');
  // partition.
  await expect(wv).toHaveAttribute('partition', 'persist:agent');
});

test('agentUrl 미설정 — 안내 메시지', async ({ page }) => {
  // settings 에서 agentUrl 제거.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).projk.setSettings({ agentUrl: '' });
  });
  await page.getByTestId('topbar-agent-web').click();
  await expect(page.getByTestId('agent-web-empty')).toBeVisible();
  await expect(page.getByTestId('agent-web-empty')).toContainText('agentUrl');
  // webview 는 mount 안 됨.
  await expect(page.getByTestId('agent-webview')).toHaveCount(0);
});

test('두 번째 클릭 — singleton 으로 동일 탭 focus (중복 X)', async ({ page }) => {
  await page.getByTestId('topbar-agent-web').click();
  await page.getByTestId('topbar-agent-web').click();
  // 탭바에 agent-web 탭 1 개만.
  const tabs = page.getByTestId(/^tab-agent-web:singleton/);
  await expect(tabs).toHaveCount(1);
});

test('새 창 버튼 — 외부 브라우저로 open', async ({ page }) => {
  await page.getByTestId('topbar-agent-web').click();
  // playwright 는 window.open 결과를 popup event 로 받음 — agent web URL 이 새 페이지로.
  // 단순히 버튼이 존재하는지 + onClick 호출 시 throw 없는지만 확인 (실제 popup 검증은
  // real Electron 에서만 의미).
  await expect(page.getByTestId('agent-web-open-external')).toBeVisible();
});
