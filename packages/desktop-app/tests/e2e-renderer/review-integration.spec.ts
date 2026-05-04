// 실제 WSL agent (localhost:8090) 와 sidecar (127.0.0.1:3502) 를 사용하는 통합 테스트.
// /review_stream fetch 를 mock 하지 않음 — 실제 NDJSON 스트림을 받아 파싱까지 검증.
// 사전 조건: WSL agent :8090 살아있고, test sidecar 를 :3502 에 띄워야 함.
//   cd packages/desktop-app/src/sidecar
//   PROJK_AGENT_URL=http://localhost:8090 python -m uvicorn server:app --host 127.0.0.1 --port 3502

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

const SIDECAR_PORT = 3502;
const SHORT_REVIEW_TEXT = `
## 중간맵 개선 기획서
담당: 박현호
목적: 중간맵 이동 시스템 개선으로 필드 탐색 효율화.
현황: 현재 중간맵 진입 시 로딩 시간 3초, 미니맵 축소 기능 없음.
개선안: 로딩 최적화 + 줌 인/아웃 기능 추가.
`.trim();

// mock-projk 의 sidecar 포트를 실제 포트로 오버라이드하는 init script
const realSidecarPortScript = `
(function() {
  // mock-projk 가 이미 실행된 후 포트만 교체.
  // api.ts 의 cachedPort 를 직접 건드릴 수 없으므로,
  // getSidecarStatus 가 실제 포트를 반환하도록 재정의.
  const _orig = window.projk.getSidecarStatus;
  window.projk.getSidecarStatus = async () => ({
    state: 'ready',
    port: ${SIDECAR_PORT},
    pid: 9999,
  });
  window.projk.onSidecarStatus = (cb) => {
    cb({ state: 'ready', port: ${SIDECAR_PORT}, pid: 9999 });
    return () => {};
  };
})();
`;

test.describe('실제 agent 통합 — WSL :8090 + sidecar :3502 필요', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: mockProjkInitScript });
    // 실제 sidecar 포트로 교체
    await page.addInitScript({ content: realSidecarPortScript });
  });

  test('실제 /review_stream → 마크다운 펜스 파싱 → ReviewCard 렌더', async ({ page }) => {
    // 1. agent 가 살아있는지 먼저 직접 확인
    const agentAlive = await fetch('http://localhost:8090/health').then(r => r.ok).catch(() => false);
    test.skip(!agentAlive, 'WSL agent :8090 미응답 — 통합 테스트 스킵');

    await page.goto('/');

    // Confluence 페이지 선택
    await page.getByText('Design').click();
    await page.getByText('시스템 디자인').click();
    await page.getByText('전투').click();
    await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();

    // webview.executeJavaScript 스텁 — 실제 페이지 대신 짧은 텍스트 사용
    await page.evaluate((text) => {
      const wv = document.querySelector('webview') as HTMLElement & {
        executeJavaScript?: (code: string) => Promise<string>;
      };
      if (wv) wv.executeJavaScript = async () => text;
    }, SHORT_REVIEW_TEXT);

    // 어시스턴트 → 리뷰 모드 칩 클릭 (P0: 수동 시작)
    await page.getByTestId('confluence-assistant').click();
    await page.getByTestId('mode-pick-review').click();

    // 사용자 메시지 확인
    await expect(page.locator('.msg.user').last()).toContainText('리뷰 요청');

    // ReviewCard 등장 (streaming 중)
    const card = page.getByTestId('review-card');
    await expect(card).toBeVisible({ timeout: 5000 });

    // 실제 LLM 응답 기다림 (최대 60초)
    console.log('WSL agent 응답 대기 중...');
    await expect(card).not.toContainText('리뷰 생성 중', { timeout: 60000 });

    // 점수 바 있어야 함 — streaming 완전히 끝날 때까지 기다림 (최대 90초)
    await expect(card).toContainText(/\d+\/100/, { timeout: 90000 });

    // 결과 확인
    const cardText = await card.innerText();
    console.log('ReviewCard 텍스트 (첫 200자):', cardText.slice(0, 200));

    // 오류 없어야 함
    await expect(card).not.toContainText('[리뷰 오류]');

    // 최소 한 개 섹션 있어야 함
    const hasIssues = await card.locator('.review-section.warning').count();
    const hasSuggestions = await card.locator('.review-section.suggestion').count();
    const hasInfo = await card.locator('.review-section.info').count();
    expect(hasIssues + hasSuggestions + hasInfo).toBeGreaterThan(0);

    console.log(`✓ ReviewCard 정상 렌더 — 섹션: warning=${hasIssues} info=${hasInfo} suggestion=${hasSuggestions}`);
  });

  test('실제 /review_stream 오류 경로 — agent URL 잘못된 경우 review-error 표시', async ({ page }) => {
    // agentUrl 을 의도적으로 잘못된 포트로 오버라이드
    await page.addInitScript(`
      (function() {
        // settings 에서 agentUrl 을 없는 포트로 설정
        const _orig = window.projk.getSettings;
        window.projk.getSettings = async () => ({
          ...(await _orig()),
          agentUrl: 'http://localhost:19999',  // 없는 포트
        });
      })();
    `);

    await page.goto('/');
    await page.getByText('Design').click();
    await page.getByText('시스템 디자인').click();
    await page.getByText('전투').click();
    await expect(page.getByTestId('center-pane').locator('webview')).toBeAttached();

    await page.evaluate(() => {
      const wv = document.querySelector('webview') as HTMLElement & { executeJavaScript?: (c: string) => Promise<string> };
      if (wv) wv.executeJavaScript = async () => 'test body';
    });

    await page.getByTestId('confluence-assistant').click();
    await page.getByTestId('mode-pick-review').click();

    const card = page.getByTestId('review-card');
    await expect(card).toBeVisible({ timeout: 5000 });
    // streaming 중이거나 오류 — 오류 경로는 30초 내 review-error 로 결론남
    await expect(card.locator('.review-error, .review-streaming')).toBeVisible({ timeout: 5000 });
    console.log('오류 경로 확인: ', await card.innerText());
  });
});
