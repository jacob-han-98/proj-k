// P3: 일반 Agent 모드 e2e — 어시스턴트 → agent 칩 → DocFocusedChat.
//
// 핵심 회귀:
// - mode-pick-agent 가 P3 에서 활성 (P0/P1 시점엔 disabled).
// - 칩 클릭 직후 setDocContext POST 호출 (현재 본문 stash) — backend 가 agent 에게
//   read_current_doc 으로 이 본문을 노출.
// - 사용자 입력 → askStream 이 conversation_id 와 함께 호출됨 (POST body 검증).
// - agent 응답이 메시지로 렌더.
// - 뒤로 / 닫기 시 clearDocContext DELETE 호출.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
});

async function selectConfluencePageAndStubWebview(page: import('@playwright/test').Page, mockBody: string) {
  await page.goto('/');
  await page.getByTestId('activity-confluence').click();
  const tree = page.getByTestId('confluence-tree');
  await tree.getByText('Design', { exact: true }).click();
  await tree.getByText('시스템 디자인', { exact: true }).click();
  await tree.getByText('전투', { exact: true }).click();
  await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();
  await page.evaluate((body) => {
    const wv = document.querySelector('webview') as HTMLElement & { executeJavaScript?: (code: string) => Promise<string> };
    if (wv) wv.executeJavaScript = async () => body;
  }, mockBody);
}

function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('agent 칩이 P3 에서 활성화', async ({ page }) => {
  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await expect(page.getByTestId('mode-pick-agent')).toBeEnabled();
});

test('agent 칩 클릭 → setDocContext 호출 (본문 stash) + 채팅 UI 노출', async ({ page }) => {
  let stashCallCount = 0;
  let stashedBody: { title?: string; content?: string } | null = null;
  await page.route('**/127.0.0.1:**/conversations/*/doc_context', async (route) => {
    if (route.request().method() === 'POST') {
      stashCallCount += 1;
      stashedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, content_chars: 5, truncated: false }),
      });
    } else {
      await route.fulfill({ status: 200, body: '{"ok":true}' });
    }
  });

  await selectConfluencePageAndStubWebview(page, '본문 mock');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-agent').click();

  // DocFocusedChat 노출
  await expect(page.getByTestId('doc-focused-chat')).toBeVisible();
  await expect(page.getByTestId('doc-focused-input')).toBeVisible();
  // stash 성공 → empty 상태 보임
  await expect(page.getByTestId('doc-focused-empty')).toBeVisible();

  expect(stashCallCount).toBeGreaterThanOrEqual(1);
  expect(stashedBody).not.toBeNull();
  expect(stashedBody!.title).toBe('전투');
  expect(stashedBody!.content).toBe('본문 mock');
});

test('사용자 입력 → askStream 이 conversation_id 와 함께 호출 + 응답 메시지 렌더', async ({ page }) => {
  // mock-projk.ts 가 fetch 를 in-page 로 가로채므로 page.route 로는 ask_stream 매치 X.
  // window.__askStreamOverride 로 응답 정의 + window.__askStreamCapturedBody 로 payload 검증.
  await page.route('**/127.0.0.1:**/conversations/*/doc_context', async (route) => {
    await route.fulfill({ status: 200, body: '{"ok":true,"content_chars":5}' });
  });
  await page.addInitScript(() => {
    (window).__askStreamOverride =
      '{"type":"token","text":"이 문서는 "}\n' +
      '{"type":"token","text":"4단계 위상을 다룹니다."}\n' +
      '{"type":"result","data":{"answer":"이 문서는 4단계 위상을 다룹니다."}}\n';
  });

  await selectConfluencePageAndStubWebview(page, '본문 mock');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-agent').click();
  await expect(page.getByTestId('doc-focused-chat')).toBeVisible();

  // 입력 + 전송
  await page.getByTestId('doc-focused-input').fill('이 문서는 무엇?');
  await page.getByTestId('doc-focused-send').click();

  // 메시지 렌더 — user + assistant
  await expect(page.getByTestId('doc-focused-msg-user')).toContainText('이 문서는 무엇?');
  await expect(page.getByTestId('doc-focused-msg-assistant')).toContainText('4단계 위상');

  // askStream payload — conversation_id 가 함께 보내졌는지
  const captured = await page.evaluate(() => (window).__askStreamCapturedBody);
  expect(captured).not.toBeFalsy();
  expect(captured.question).toBe('이 문서는 무엇?');
  expect(typeof captured.conversation_id).toBe('string');
  expect(captured.conversation_id).toMatch(/^klaud-doc-/);
});

test('어시스턴트 닫기 → clearDocContext DELETE 호출 (메모리 정리)', async ({ page }) => {
  let clearCallCount = 0;
  await page.route('**/127.0.0.1:**/conversations/*/doc_context', async (route) => {
    if (route.request().method() === 'DELETE') {
      clearCallCount += 1;
      await route.fulfill({ status: 200, body: '{"ok":true,"cleared":true}' });
    } else {
      await route.fulfill({ status: 200, body: '{"ok":true,"content_chars":5}' });
    }
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-agent').click();
  await expect(page.getByTestId('doc-focused-chat')).toBeVisible();

  // 닫기 — DocFocusedChat unmount → cleanup useEffect 가 clearDocContext
  await page.getByTestId('doc-assistant-close').click();
  // split 패널 사라짐
  await expect(page.getByTestId('doc-focused-chat')).toHaveCount(0);

  // DELETE 호출 1회 이상 (StrictMode double-mount 가능성)
  expect(clearCallCount).toBeGreaterThanOrEqual(1);
});
