// Phase 4-2 / 4-3 / 4-3.5 e2e — Confluence webview 리뷰 → 변경안 파이프라인.
// renderer 단만 검증 (mock-projk 환경, Electron 없이 Chromium). webview 의
// executeJavaScript 는 Electron 전용이라 Chromium 의 <webview> 엘리먼트엔 없으니
// 클릭 직전에 stub.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
});

// 공통 헬퍼: Confluence 트리에서 페이지 선택 → webview mount → executeJavaScript 스텁
async function selectConfluencePageAndStubWebview(page: import('@playwright/test').Page, mockBody: string) {
  await page.goto('/');
  await page.getByText('Design').click();
  await page.getByText('시스템 디자인').click();
  await page.getByText('전투').click();

  // webview 가 attach 될 때까지 기다린 후 executeJavaScript 메서드를 mockBody 반환하도록 stub.
  await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();
  await page.evaluate((body) => {
    const wv = document.querySelector('webview') as HTMLElement & { executeJavaScript?: (code: string) => Promise<string> };
    if (wv) wv.executeJavaScript = async () => body;
  }, mockBody);
}

// 공통 헬퍼: NDJSON 스트림 응답 빌드.
function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('리뷰 버튼은 Confluence 페이지 선택 시 doc-header 에 노출, sheet 에선 노출 안 됨', async ({ page }) => {
  await page.goto('/');

  // 시작 (selection 없음) — 버튼 없음
  await expect(page.getByTestId('confluence-review')).toHaveCount(0);

  // Confluence 페이지 선택 → 버튼 등장
  await page.getByText('Design').click();
  await page.getByText('시스템 디자인').click();
  await page.getByText('전투').click();
  await expect(page.getByTestId('confluence-review')).toBeVisible();
});

test('리뷰 streaming → result.data.review (WSL 포맷, JSON 문자열) → ReviewCard 데이터 렌더', async ({ page }) => {
  // WSL 의 실제 포맷: status (message 키) + token (text 키) + result.data.review (JSON 문자열)
  const reviewJson = JSON.stringify({
    score: 75,
    issues: [
      { text: '의도가 모호한 섹션', perspective: '기획팀장' },
      '예시 누락',
    ],
    suggestions: ['QA 시나리오 추가 권장'],
    qa_checklist: ['신규 진입 동선 OK?'],
    readability: { score: 82, issues: ['긴 문단 분할 권장'] },
  });
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '📨 분석 중... (haiku)' },
        { type: 'token', text: '{"score":' },
        { type: 'token', text: '75,...' },
        { type: 'result', data: { review: reviewJson, model: 'haiku', usage: {} } },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문 mock 입니다');

  await page.getByTestId('confluence-review').click();

  const card = page.getByTestId('review-card');
  await expect(card).toBeVisible();

  // 데이터 섹션이 result 후 채워졌는지
  await expect(card).toContainText('75/100');
  await expect(card).toContainText('보강 필요 (2건)');
  await expect(card).toContainText('의도가 모호한 섹션');
  await expect(card).toContainText('[기획팀장]'); // perspective badge
  await expect(card).toContainText('예시 누락');
  await expect(card).toContainText('제안 (1건)');
  await expect(card).toContainText('QA 시나리오 추가 권장');
  await expect(card).toContainText('QA 체크리스트 (1건)');
  await expect(card).toContainText('문서 가독성 (82/100)');
  await expect(card).toContainText('긴 문단 분할 권장');

  // 4-3.5 의 "원본 수정" 버튼이 actionable item 있을 때 노출
  await expect(page.getByTestId('review-fix')).toBeVisible();
});

test('리뷰 — result.data.review 가 ```json ... ``` 마크다운 펜스로 감싸여도 파싱', async ({ page }) => {
  // WSL agent 가 LLM raw output 을 그대로 흘릴 때 코드펜스 포함. 실제 재현 케이스.
  const reviewData = {
    score: 82,
    issues: [{ text: '섹션 제목 누락', perspective: '기획팀장' }],
    suggestions: ['용어 통일 필요'],
  };
  const fencedReview = '```json\n' + JSON.stringify(reviewData) + '\n```';
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '🧠 문서 분석 중...' },
        { type: 'result', data: { review: fencedReview, model: 'sonnet', usage: {} } },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');
  await page.getByTestId('confluence-review').click();

  const card = page.getByTestId('review-card');
  await expect(card).toContainText('82/100');
  await expect(card).toContainText('섹션 제목 누락');
  await expect(card).toContainText('[기획팀장]');
  await expect(card).toContainText('용어 통일 필요');
});

test('리뷰 — legacy {type, payload} 포맷도 defensive 하게 파싱', async ({ page }) => {
  // 기존 chrome-extension/스텁 패턴: payload 가 ReviewData 자체 (data.review wrapper 없음)
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', payload: 'mock 시작' },
        { type: 'result', payload: { score: 50, suggestions: ['legacy 포맷 OK'] } },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, 'body');

  await page.getByTestId('confluence-review').click();
  const card = page.getByTestId('review-card');
  await expect(card).toContainText('50/100');
  await expect(card).toContainText('legacy 포맷 OK');
});

test('리뷰 → "원본 수정" → ChangesCard streaming → before/after 렌더', async ({ page }) => {
  // 1단계: review (간단)
  const reviewJson = JSON.stringify({
    score: 60,
    issues: [{ text: '용어 통일 필요' }],
  });
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '분석' },
        { type: 'result', data: { review: reviewJson } },
      ]),
    });
  });

  // 2단계: suggest_edits — WSL 포맷 (data.changes 배열)
  await page.route('**/127.0.0.1:**/suggest_edits', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'status', message: '수정안 생성' },
        { type: 'token', text: '[{"' },
        {
          type: 'result',
          data: {
            changes: [
              {
                id: 'c1',
                section: '도입부',
                description: '용어 통일',
                before: '플레이어가 캐릭터를',
                after: '유저가 PC를',
              },
            ],
          },
        },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, '본문');

  await page.getByTestId('confluence-review').click();
  await expect(page.getByTestId('review-card')).toContainText('60/100');

  await page.getByTestId('review-fix').click();

  const changes = page.getByTestId('changes-card');
  await expect(changes).toBeVisible();
  await expect(changes).toContainText('변경안 (1건)');
  // ChangesCard 는 description 우선 fallback section. 둘 다 있는 케이스라 description 가 보임.
  await expect(changes).toContainText('용어 통일');
  await expect(changes).toContainText('플레이어가 캐릭터를'); // before
  await expect(changes).toContainText('유저가 PC를'); // after

  const change = page.getByTestId('change-c1');
  await expect(change.locator('.change-before')).toContainText('플레이어');
  await expect(change.locator('.change-after')).toContainText('유저');
});

test('리뷰 — error 이벤트 시 review-error 메시지 표시', async ({ page }) => {
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'error', message: 'agent 백엔드 URL 미설정' },
      ]),
    });
  });

  await selectConfluencePageAndStubWebview(page, 'body');

  await page.getByTestId('confluence-review').click();
  const card = page.getByTestId('review-card');
  await expect(card).toContainText('[리뷰 오류]');
  await expect(card).toContainText('agent 백엔드 URL 미설정');
});

test('리뷰 — actionable 항목 0건이면 "원본 수정" 버튼 미노출', async ({ page }) => {
  // score / readability 만 있고 issues/verifications/suggestions 모두 빈 케이스
  const reviewJson = JSON.stringify({ score: 95, readability: { score: 90 } });
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([{ type: 'result', data: { review: reviewJson } }]),
    });
  });

  await selectConfluencePageAndStubWebview(page, 'body');

  await page.getByTestId('confluence-review').click();
  await expect(page.getByTestId('review-card')).toContainText('95/100');
  await expect(page.getByTestId('review-fix')).toHaveCount(0);
});
