// 2026-05-12: ModePickerEmpty ⚙ 설정 e2e — preset fetch + override 저장 + 백엔드 전달.
//
// 회귀 방지:
// - ⚙ 토글이 같은 패널 안에서 settings 뷰로 swap (모드 화면 안 닫음).
// - mount 시 GET /presets/{summary,review} 각각 호출 (병렬).
// - textarea 의 default = preset 이고, 사용자가 수정 → 저장 → localStorage 에 반영.
// - 같은 패널에서 '← back' 누르면 picker 화면 복귀.
// - 다음에 요약/리뷰 칩 클릭 시 백엔드 payload 에 prompt_override 가 첨부.
// - override = preset 그대로 저장 시 localStorage 에서 삭제 (다음부터 preset 자동 추종).

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  // localStorage 정리 — 다른 테스트 잔재로 인한 cross-talk 차단.
  await page.addInitScript({ content: 'try { localStorage.clear(); } catch {}' });
});

async function openConfluencePage(page: import('@playwright/test').Page, mockBody = '본문') {
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

const SUMMARY_PRESET = '문서를 3-5 문단으로 요약하라.\n핵심 수치와 시스템 관계를 강조하라.';
const REVIEW_PRESET = '문서를 리뷰하라.\nissues, verifications, suggestions 각각 JSON 으로 반환.';

async function stubPresets(page: import('@playwright/test').Page) {
  await page.route('**/127.0.0.1:**/presets/summary', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt: SUMMARY_PRESET, model: 'claude-opus-4-7', version: 'v1' }),
    });
  });
  await page.route('**/127.0.0.1:**/presets/review', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt: REVIEW_PRESET, model: 'claude-opus-4-7', version: 'v1' }),
    });
  });
}

test('⚙ 토글 → settings 뷰로 swap → preset fetch + textarea prefill + back 복귀', async ({ page }) => {
  let summaryPresetCalls = 0;
  let reviewPresetCalls = 0;
  await page.route('**/127.0.0.1:**/presets/summary', async (route) => {
    summaryPresetCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt: SUMMARY_PRESET, version: 'v1' }),
    });
  });
  await page.route('**/127.0.0.1:**/presets/review', async (route) => {
    reviewPresetCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt: REVIEW_PRESET, version: 'v1' }),
    });
  });

  await openConfluencePage(page);
  await page.getByTestId('confluence-assistant').click();

  // ⚙ 토글 노출되어 있어야
  await expect(page.getByTestId('mode-picker-settings')).toBeVisible();
  await page.getByTestId('mode-picker-settings').click();

  // settings 뷰로 swap
  await expect(page.getByTestId('assistant-prompt-settings')).toBeVisible();
  await expect(page.getByTestId('mode-picker-empty')).toHaveCount(0);

  // preset fetch 각각 호출됨 (React.StrictMode 가 dev 에서 effect 를 2번 invoke 하므로
  // 정확히 1번 단정은 못 — at-least-once 로 검증).
  await expect.poll(() => summaryPresetCalls).toBeGreaterThanOrEqual(1);
  await expect.poll(() => reviewPresetCalls).toBeGreaterThanOrEqual(1);

  // textarea 에 preset 이 prefill 됨
  await expect(page.getByTestId('assistant-prompt-mode-textarea-summary')).toHaveValue(SUMMARY_PRESET);
  await expect(page.getByTestId('assistant-prompt-mode-textarea-review')).toHaveValue(REVIEW_PRESET);

  // 둘 다 "preset 사용 중" 메타 표시
  await expect(page.getByTestId('assistant-prompt-mode-meta-summary')).toContainText('preset 사용 중');
  await expect(page.getByTestId('assistant-prompt-mode-meta-review')).toContainText('preset 사용 중');

  // back 누르면 picker 로 복귀
  await page.getByTestId('assistant-prompt-settings-back').click();
  await expect(page.getByTestId('mode-picker-empty')).toBeVisible();
  await expect(page.getByTestId('assistant-prompt-settings')).toHaveCount(0);
});

test('override 저장 → localStorage 에 반영 → 메타가 "사용자 override 사용 중"', async ({ page }) => {
  await stubPresets(page);
  await openConfluencePage(page);
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-picker-settings').click();

  await expect(page.getByTestId('assistant-prompt-mode-textarea-summary')).toHaveValue(SUMMARY_PRESET);

  // summary textarea 를 사용자가 새 내용으로 교체
  const customPrompt = '한 문단으로만 요약하라.';
  await page.getByTestId('assistant-prompt-mode-textarea-summary').fill(customPrompt);
  await page.getByTestId('assistant-prompt-mode-save-summary').click();

  // 메타 갱신
  await expect(page.getByTestId('assistant-prompt-mode-meta-summary')).toContainText('사용자 override 사용 중');

  // localStorage 검증
  const stored = await page.evaluate(() => localStorage.getItem('klaud:assistant-prompt-override:summary'));
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored as string) as { prompt: string; presetVersion: string; schemaVersion: number };
  expect(parsed.prompt).toBe(customPrompt);
  expect(parsed.presetVersion).toBe('v1');
  expect(parsed.schemaVersion).toBe(1);
});

test('summary 칩 클릭 시 백엔드 payload 에 prompt_override 첨부', async ({ page }) => {
  await stubPresets(page);
  let capturedBody: Record<string, unknown> | null = null;
  await page.route('**/127.0.0.1:**/summary_stream', async (route) => {
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'result', data: { summary: '요약 결과', model: 'opus' } }]),
    });
  });

  await openConfluencePage(page);

  // 1단계: 어시스턴트 → ⚙ → summary override 저장
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-picker-settings').click();
  const customPrompt = '두 문장으로만 요약';
  await page.getByTestId('assistant-prompt-mode-textarea-summary').fill(customPrompt);
  await page.getByTestId('assistant-prompt-mode-save-summary').click();
  await page.getByTestId('assistant-prompt-settings-back').click();

  // 2단계: 요약 칩 클릭 → 백엔드 호출 발생, payload 에 prompt_override 첨부
  await page.getByTestId('mode-pick-summary').click();

  await expect.poll(() => capturedBody).not.toBeNull();
  const body = capturedBody as { title: string; text: string; prompt_override?: string };
  expect(body.prompt_override).toBe(customPrompt);
});

test('override 가 preset 과 동일하면 저장 시 localStorage 삭제 + 메타 "preset 사용 중"', async ({ page }) => {
  await stubPresets(page);
  await openConfluencePage(page);
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-picker-settings').click();

  // 먼저 override 하나 저장
  await page.getByTestId('assistant-prompt-mode-textarea-review').fill('커스텀 리뷰 prompt');
  await page.getByTestId('assistant-prompt-mode-save-review').click();
  await expect(page.getByTestId('assistant-prompt-mode-meta-review')).toContainText('사용자 override 사용 중');

  // 그 다음 textarea 를 preset 그대로 되돌리고 저장
  await page.getByTestId('assistant-prompt-mode-textarea-review').fill(REVIEW_PRESET);
  await page.getByTestId('assistant-prompt-mode-save-review').click();

  // localStorage 에서 삭제되어야
  await expect.poll(async () =>
    page.evaluate(() => localStorage.getItem('klaud:assistant-prompt-override:review')),
  ).toBeNull();
  await expect(page.getByTestId('assistant-prompt-mode-meta-review')).toContainText('preset 사용 중');
});

test('preset 으로 되돌리기 버튼 — textarea 리셋 + localStorage 삭제', async ({ page }) => {
  await stubPresets(page);
  await openConfluencePage(page);
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-picker-settings').click();

  // override 저장
  await page.getByTestId('assistant-prompt-mode-textarea-summary').fill('수정된 prompt');
  await page.getByTestId('assistant-prompt-mode-save-summary').click();
  await expect(page.getByTestId('assistant-prompt-mode-meta-summary')).toContainText('사용자 override 사용 중');

  // 되돌리기 버튼
  await page.getByTestId('assistant-prompt-mode-reset-summary').click();

  // textarea 가 preset 값으로 복원
  await expect(page.getByTestId('assistant-prompt-mode-textarea-summary')).toHaveValue(SUMMARY_PRESET);
  // localStorage 삭제
  await expect.poll(async () =>
    page.evaluate(() => localStorage.getItem('klaud:assistant-prompt-override:summary')),
  ).toBeNull();
  // 메타 "preset 사용 중"
  await expect(page.getByTestId('assistant-prompt-mode-meta-summary')).toContainText('preset 사용 중');
});

test('preset fetch 실패 시 — error 배너 + textarea 비활성, 기존 override 는 표시', async ({ page }) => {
  // 백엔드 안 떠있는 경우 시뮬레이션 (503).
  await page.route('**/127.0.0.1:**/presets/summary', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'agent down' }) });
  });
  await page.route('**/127.0.0.1:**/presets/review', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'agent down' }) });
  });

  // 사전에 override 저장해 둠 — preset fetch 실패해도 사용자 override 는 안전히 보여야.
  await page.addInitScript({
    content: `try {
      localStorage.setItem(
        'klaud:assistant-prompt-override:summary',
        JSON.stringify({ prompt: '저장된 override', presetVersion: 'v1', savedAt: 1, schemaVersion: 1 })
      );
    } catch {}`,
  });

  await openConfluencePage(page);
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-picker-settings').click();

  await expect(page.getByTestId('assistant-prompt-mode-error-summary')).toBeVisible();
  await expect(page.getByTestId('assistant-prompt-mode-error-review')).toBeVisible();
  // 기존 override 가 textarea 에 그대로 표시
  await expect(page.getByTestId('assistant-prompt-mode-textarea-summary')).toHaveValue('저장된 override');
  // review 는 override 없으니 빈 textarea
  await expect(page.getByTestId('assistant-prompt-mode-textarea-review')).toHaveValue('');
  // 저장 버튼은 preset 없으면 비활성
  await expect(page.getByTestId('assistant-prompt-mode-save-summary')).toBeDisabled();
});
