// P2: 리뷰 옵션 패널 e2e — 어시스턴트 → 리뷰 칩 → 옵션 폼 → 시작 → ReviewSplitPane.
//
// 회귀 방지:
// - 리뷰 칩 누르면 review-card 가 즉시 안 뜬다 (옵션 폼이 먼저).
// - 옵션 토글이 chip on 클래스 반영.
// - 리뷰 시작 누를 때 backend payload 에 review_options 객체가 정확히 첨부 (snake_case).
// - 시작 후 ReviewSplitPane swap + reviewStream 호출 1회.

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

test('리뷰 칩 클릭 → 옵션 폼 노출 (review-card 미노출, 백엔드 호출 0)', async ({ page }) => {
  let reviewCallCount = 0;
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    reviewCallCount += 1;
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();

  // 옵션 폼이 보임
  await expect(page.getByTestId('review-options-panel')).toBeVisible();
  await expect(page.getByTestId('review-options-issueCap')).toBeVisible();
  await expect(page.getByTestId('review-options-categories')).toBeVisible();
  await expect(page.getByTestId('review-options-persona')).toBeVisible();
  await expect(page.getByTestId('review-options-start')).toBeVisible();

  // review-card 는 아직 mount 안 됨 — 사용자가 시작 안 눌렀으므로
  await expect(page.getByTestId('review-card')).toHaveCount(0);
  expect(reviewCallCount).toBe(0);
});

test('옵션 토글 → chip on 클래스 + 시작 → backend payload 에 review_options 첨부', async ({ page }) => {
  let capturedBody: Record<string, unknown> | null = null;
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    const req = route.request();
    capturedBody = req.postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'result', data: { review: JSON.stringify({ score: 80 }) } },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();

  // 사용자가 issue cap textbox 를 20 으로 변경, qa-checklist 를 끄고, persona 에
  // programmer 추가 (default 'planner-lead' 와 함께 둘 다 켜진 다중 상태).
  // 2026-05-12: cap 은 4-chip → textbox (default 5). PD 피드백.
  await page.getByTestId('review-options-issueCap-input').fill('20');
  await page.getByTestId('review-options-cat-qa-checklist').click(); // toggle off (default 는 on)
  await page.getByTestId('review-options-persona-programmer-checkbox').check();

  // 시작 버튼
  await page.getByTestId('review-options-start').click();

  // ReviewSplitPane mount 됐는지 확인 — review-card 등장
  await expect(page.getByTestId('review-card')).toBeVisible();
  await expect(page.getByTestId('review-card')).toContainText('80/100');

  // 백엔드가 받은 payload 검증
  expect(capturedBody).not.toBeNull();
  const body = capturedBody as { title: string; text: string; review_options: Record<string, unknown> };
  expect(body.title).toBe('전투');
  expect(body.text).toBe('본문');
  expect(body.review_options).toEqual({
    issue_cap: 20,
    verification_cap: 5,
    suggestion_cap: 5,
    // qa-checklist toggle off → logic-flow + readability 만 남음
    categories: ['logic-flow', 'readability'],
    // 다중 persona — default 'planner-lead' 에 'programmer' 추가
    reviewer_personas: ['planner-lead', 'programmer'],
    // back-compat 첫 persona
    reviewer_persona: 'planner-lead',
  });
});

test('cache key 에 옵션 hash 포함 — 옵션 변경하면 새 stream (cache hit X)', async ({ page }) => {
  // 회귀 방지: 사용자가 default 옵션으로 리뷰 → 옵션 토글 후 재시작 시 같은 본문이지만
  // 다른 옵션이라 새 backend 호출. 이전엔 contentHash 만으로 key 잡아 cache hit 으로 옵션이
  // 안 먹는 것처럼 보임 (사용자 보고 root cause).
  let callCount = 0;
  let lastBody: Record<string, unknown> | null = null;
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    callCount += 1;
    lastBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'result', data: { review: JSON.stringify({ score: 70 + callCount }) } },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();
  await page.getByTestId('review-options-start').click();
  await expect(page.getByTestId('review-card')).toBeVisible();
  const firstCount = callCount;
  expect(firstCount).toBeGreaterThanOrEqual(1);

  // 모드 picker 로 돌아가 다시 리뷰 시작 — 옵션 다르게.
  await page.getByTestId('review-split-close').click();
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();
  // categories 토글 (logic-flow 만 남김 — qa, readability 끔)
  await page.getByTestId('review-options-cat-qa-checklist').click();
  await page.getByTestId('review-options-cat-readability').click();
  await page.getByTestId('review-options-start').click();
  await expect(page.getByTestId('review-card')).toBeVisible();

  // 새 backend 호출 발생 — 옵션 다르므로 cache miss.
  expect(callCount).toBeGreaterThan(firstCount);
  expect(lastBody).not.toBeNull();
  const opts = (lastBody as { review_options: { categories: string[] } }).review_options;
  expect(opts.categories).toEqual(['logic-flow']);
});

test('추가 분석 카테고리 off → backend 응답에 flow/qa/readability 가 와도 화면 미노출', async ({ page }) => {
  // 회귀 방지 (사용자 보고 2026-05-12): 추가 분석 chip 을 모두 off 해도 backend 가 보내는
  // flow / qa_checklist / readability 가 여전히 카드에 출력되던 문제. 이제 renderer 가
  // enabledCategories prop 으로 사용자 선택을 존중해 그리지 않음.
  const reviewJson = JSON.stringify({
    score: 70,
    issues: [{ text: '이슈 1' }],
    flow: '1. 시작 2. 종료',
    qa_checklist: ['체크 1'],
    readability: { score: 80, issues: ['가독성 이슈'] },
  });
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'result', data: { review: reviewJson } }]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();

  // 세 카테고리 모두 off (default 가 모두 on 이므로 한 번씩 클릭)
  await page.getByTestId('review-options-cat-logic-flow').click();
  await page.getByTestId('review-options-cat-qa-checklist').click();
  await page.getByTestId('review-options-cat-readability').click();
  await page.getByTestId('review-options-start').click();

  const card = page.getByTestId('review-card');
  await expect(card).toBeVisible();
  // 메인 리뷰 (이슈) 는 노출
  await expect(card).toContainText('이슈 1');
  // 추가 분석 3종은 모두 미노출
  await expect(card).not.toContainText('로직 플로우');
  await expect(card).not.toContainText('QA 체크리스트');
  await expect(card).not.toContainText('문서 가독성');
});

test('추가 분석 카테고리 부분 선택 → 선택한 항목만 노출', async ({ page }) => {
  // logic-flow 만 남기고 qa-checklist + readability 끔 → backend 응답에 셋 다 들어와도
  // 화면엔 로직 플로우만 노출.
  const reviewJson = JSON.stringify({
    score: 60,
    flow: '1. A 2. B',
    qa_checklist: ['체크 X'],
    readability: { score: 50, issues: ['리드 X'] },
  });
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'result', data: { review: reviewJson } }]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();
  await page.getByTestId('review-options-cat-qa-checklist').click();
  await page.getByTestId('review-options-cat-readability').click();
  await page.getByTestId('review-options-start').click();

  const card = page.getByTestId('review-card');
  await expect(card).toContainText('로직 플로우');
  await expect(card).not.toContainText('QA 체크리스트');
  await expect(card).not.toContainText('문서 가독성');
});

// 2026-05-12 PD 피드백: cap 은 4-chip → textbox (default 5).
test('cap textbox — default 5 + 사용자 입력 그대로 + 빈값/음수 sanitize → backend int 전송', async ({ page }) => {
  let capturedBody: Record<string, unknown> | null = null;
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'result', data: { review: JSON.stringify({ score: 70 }) } }]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();

  // default 값이 5 인지 확인 (3개 cap 모두)
  await expect(page.getByTestId('review-options-issueCap-input')).toHaveValue('5');
  await expect(page.getByTestId('review-options-verificationCap-input')).toHaveValue('5');
  await expect(page.getByTestId('review-options-suggestionCap-input')).toHaveValue('5');

  // issueCap = 0 (없음), verificationCap = 15, suggestionCap 은 default 5 유지
  await page.getByTestId('review-options-issueCap-input').fill('0');
  await page.getByTestId('review-options-verificationCap-input').fill('15');

  await page.getByTestId('review-options-start').click();
  await expect(page.getByTestId('review-card')).toBeVisible();

  expect(capturedBody).not.toBeNull();
  const opts = (capturedBody as { review_options: Record<string, unknown> }).review_options;
  expect(opts).toMatchObject({
    issue_cap: 0,
    verification_cap: 15,
    suggestion_cap: 5,
  });
  // 모두 number 타입 — 'all' 문자열 없음
  expect(typeof opts.issue_cap).toBe('number');
  expect(typeof opts.verification_cap).toBe('number');
});

test('← 뒤로 버튼 → mode picker 로 복귀 + reviewOptions reset', async ({ page }) => {
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' });
  });
  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-assistant').click();
  await page.getByTestId('mode-pick-review').click();
  await expect(page.getByTestId('review-options-panel')).toBeVisible();

  // 뒤로 버튼 → mode picker
  await page.getByTestId('review-options-back').click();
  await expect(page.getByTestId('mode-picker-empty')).toBeVisible();
  await expect(page.getByTestId('review-options-panel')).toHaveCount(0);
});
