// PR8: M1 4-pane 워크벤치 동작 검증.
//
//   1) 탭 추가 / 같은 페이지 중복 방지 / 닫기 → 인접 탭 활성화
//   2) Activity Bar 토글 — 사이드바만 swap, editor 탭 보존
//   3) QnA 크로스플로우 — 사이드바 "+ 새" 가 thread 생성 + editor 탭 추가, 보던 문서 탭 보존
//   4) 리뷰 split — 활성 시 좌우 분할, 닫기 X / 다른 탭 영향 없음
//
// review.spec.ts 와 같은 mock-projk 환경 사용.

import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
  await page.goto('/');
});

// ---------- 헬퍼 ----------
// 트리 안의 텍스트만 매칭 (topbar breadcrumb / hint code 가 같은 단어를 가지면 strict 모드
// 실패하므로 sidebar pane / tree testid 안에서만 검색).

async function ensureConfluenceTreeReady(page: import('@playwright/test').Page) {
  // default activeIcon='confluence' 라 사이드바는 이미 confluence panel.
  const tree = page.getByTestId('confluence-tree');
  // '전투' (page) 가 안 보이면 부모 폴더 펼침.
  const leaf = tree.getByText('전투', { exact: true });
  if (!(await leaf.isVisible().catch(() => false))) {
    await tree.getByText('Design', { exact: true }).click();
    await tree.getByText('시스템 디자인', { exact: true }).click();
  }
}

async function openConfluencePage(page: import('@playwright/test').Page) {
  await ensureConfluenceTreeReady(page);
  await page.getByTestId('confluence-tree').getByText('전투', { exact: true }).click();
}

async function ensureP4TreeReady(page: import('@playwright/test').Page) {
  await page.getByTestId('activity-p4').click();
  const tree = page.getByTestId('p4-tree');
  // sheet 가 안 보이면 부모 펼침. 한 번만 펼치고 같은 폴더 다시 클릭하지 않는다 (collapse 방지).
  const sheet = tree.getByText('HUD_기본', { exact: true });
  if (!(await sheet.isVisible().catch(() => false))) {
    await tree.getByText('7_System', { exact: true }).click();
    await tree.getByText('PK_HUD 시스템', { exact: true }).click();
  }
}

async function openP4Sheet(
  page: import('@playwright/test').Page,
  sheetTitle: 'HUD_기본' | 'HUD_전투',
) {
  await ensureP4TreeReady(page);
  await page.getByTestId('p4-tree').getByText(sheetTitle, { exact: true }).click();
}

// ---------- 탭 시스템 ----------

test('탭 추가 — 같은 Confluence 페이지 두 번 클릭 = 1 탭 (focus only)', async ({ page }) => {
  await openConfluencePage(page);

  // 첫 클릭으로 탭 1개
  const tabBar = page.getByTestId('tab-bar');
  await expect(tabBar).toBeVisible();
  // confluence 페이지 id=3 → 탭 id = `confluence:3`
  const tab1 = page.getByTestId('tab-confluence:3');
  await expect(tab1).toBeVisible();
  await expect(tab1).toHaveClass(/active/);

  // 트리에서 같은 페이지 다시 클릭 → 새 탭 생성 X
  await page.getByTestId('confluence-tree').getByText('전투', { exact: true }).click();
  // tabBar 안의 tab 카운트가 1 그대로 (close 버튼 testid 가 tab-close-* 라 negative lookahead).
  await expect(tabBar.getByTestId(/^tab-(?!close-)/)).toHaveCount(1);
});

test('탭 추가 — 다른 페이지/시트 클릭 시 별도 탭 생성, active 가 따라감', async ({ page }) => {
  await openConfluencePage(page);
  await openP4Sheet(page, 'HUD_기본');

  // 두 탭 모두 존재
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();
  await expect(page.getByTestId('tab-excel:7_System/PK_HUD 시스템/HUD_기본')).toBeVisible();
  // 마지막 클릭 (HUD_기본) 이 active
  await expect(page.getByTestId('tab-excel:7_System/PK_HUD 시스템/HUD_기본')).toHaveClass(/active/);
  await expect(page.getByTestId('tab-confluence:3')).not.toHaveClass(/active/);

  // 첫 탭 클릭 → 활성 전환
  await page.getByTestId('tab-confluence:3').click();
  await expect(page.getByTestId('tab-confluence:3')).toHaveClass(/active/);
  await expect(page.getByTestId('tab-excel:7_System/PK_HUD 시스템/HUD_기본')).not.toHaveClass(/active/);
});

test('탭 닫기 — 활성 탭 닫으면 인접 (오른쪽 우선) 탭이 활성화', async ({ page }) => {
  // 두 P4 시트로 탭 2개 (Confluence 까지 가면 테스트 길어짐, 같은 사이드바 안에서 검증)
  await openP4Sheet(page, 'HUD_기본');
  await openP4Sheet(page, 'HUD_전투');

  const tab1 = page.getByTestId('tab-excel:7_System/PK_HUD 시스템/HUD_기본');
  const tab2 = page.getByTestId('tab-excel:7_System/PK_HUD 시스템/HUD_전투');
  await expect(tab2).toHaveClass(/active/);

  // 활성 탭 (tab2 = 마지막) 닫기 → 왼쪽 (tab1) 으로 활성 이동
  await page
    .getByTestId('tab-close-excel:7_System/PK_HUD 시스템/HUD_전투')
    .click({ force: true }); // hover-only 가시화 우회
  await expect(tab2).toHaveCount(0);
  await expect(tab1).toHaveClass(/active/);

  // 마지막 남은 탭 닫기 → editor placeholder
  await page.getByTestId('tab-close-excel:7_System/PK_HUD 시스템/HUD_기본').click({ force: true });
  await expect(page.getByTestId('editor-empty')).toBeVisible();
});

// ---------- Activity Bar 토글 ----------

test('Activity Bar 토글 — 사이드바만 swap, editor 탭은 보존', async ({ page }) => {
  await openConfluencePage(page);
  // editor 탭이 살아있음
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();

  // QnA 사이드바 전환
  await page.getByTestId('activity-qna').click();
  await expect(page.getByTestId('sidebar-pane-qna')).toBeVisible();
  await expect(page.getByTestId('thread-list')).toBeVisible();
  // editor 탭 그대로 보임
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();
  await expect(page.getByTestId('tab-confluence:3')).toHaveClass(/active/);

  // P4 사이드바 전환
  await page.getByTestId('activity-p4').click();
  await expect(page.getByTestId('sidebar-pane-p4')).toBeVisible();
  await expect(page.getByTestId('p4-source-local')).toHaveClass(/active/);
  // editor 탭 여전히 살아있음
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();

  // Quick Find 도 동일
  await page.getByTestId('activity-find').click();
  await expect(page.getByTestId('quick-find-panel')).toBeVisible();
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();
});

// ---------- QnA 크로스플로우 ----------

test('QnA 크로스플로우 — 문서 탭 살아있는 채로 "+ 새" 가 qna-thread 탭 추가', async ({ page }) => {
  // 문서 탭 먼저 (Confluence)
  await openConfluencePage(page);
  await expect(page.getByTestId('tab-confluence:3')).toHaveClass(/active/);

  // QnA 사이드바 → "+ 새" 클릭 → 새 thread + editor 탭 자동 추가
  await page.getByTestId('activity-qna').click();
  await page.getByTestId('thread-new').click();

  // 탭 2개 — 기존 confluence:3 + 새 qna:* (id 는 mock 의 randomUUID)
  // tab-bar 안의 모든 tab 을 세본다
  const tabs = page.getByTestId('tab-bar').getByTestId(/^tab-(?!close-).+/);
  await expect(tabs).toHaveCount(2);

  // 새 qna 탭이 활성, confluence 탭은 비활성 + 그대로 살아있음
  await expect(page.getByTestId('tab-confluence:3')).toBeVisible();
  await expect(page.getByTestId('tab-confluence:3')).not.toHaveClass(/active/);

  // qna 탭 컨텐츠 = QnATab (chat-input 등장)
  await expect(page.getByTestId('chat-input')).toBeVisible();
});

// ---------- 리뷰 split ----------

// ---------- PR10: Quick Find ----------

test('Quick Find — 입력 시 debounce 후 hits 표시 + 클릭 시 editor 탭 open', async ({ page }) => {
  // Quick Find 사이드바 활성화.
  await page.getByTestId('activity-find').click();
  await expect(page.getByTestId('quick-find-panel')).toBeVisible();

  const input = page.getByTestId('qf-input');
  await input.fill('HUD');
  // 200ms debounce + mock NDJSON yield. 점진 hit 가 등장.
  const xlsxHit = page.getByTestId('qf-hit-xlsx::PK_HUD::HUD_기본');
  const confHit = page.getByTestId('qf-hit-conf::Design/HUD-개편');
  await expect(xlsxHit).toBeVisible();
  await expect(confHit).toBeVisible();

  // fast=true (typing) 라 두 번째 hit 도 source=l1.
  await expect(page.getByTestId('qf-meta')).toContainText('48ms');

  // hit 클릭 → editor 탭 추가.
  await xlsxHit.click();
  await expect(page.getByTestId('tab-bar').getByTestId(/^tab-(?!close-).+/)).toHaveCount(1);
});

test('Quick Find — Enter 시 fast=false (auto v2.1) 로 즉시 풀 검색', async ({ page }) => {
  await page.getByTestId('activity-find').click();
  const input = page.getByTestId('qf-input');
  await input.fill('변신');
  await input.press('Enter');

  // result.latency_ms 가 mock 의 fast=false 값 (312ms) 로 표시.
  await expect(page.getByTestId('qf-meta')).toContainText('312ms');
  // 두 번째 hit 의 source 는 vector (mock 분기).
  await expect(page.getByTestId('qf-hit-conf::Design/HUD-개편')).toBeVisible();
});

// ---------- PR9b: P4 depot 탭 ----------

test('P4 depot 탭 — 활성 시 root 자동 fetch + 2단계 auto-expand + 파일 클릭 시 read-only 탭 오픈', async ({ page }) => {
  await page.getByTestId('activity-p4').click();
  // local 이 default 라 depot 탭 클릭으로 전환.
  await page.getByTestId('p4-source-depot').click();
  await expect(page.getByTestId('p4-source-depot')).toHaveClass(/active/);

  // root depot 2 개 (mock-projk: //depot, //archive) 가 보여야 함.
  const tree = page.getByTestId('depot-tree');
  await expect(tree.getByTestId('depot-row-//depot')).toBeVisible();
  await expect(tree.getByTestId('depot-row-//archive')).toBeVisible();

  // 2단계 auto-expand — //depot 의 자식이 클릭 없이 즉시 보여야 함.
  await expect(tree.getByTestId('depot-row-//depot/Design')).toBeVisible();
  await expect(tree.getByTestId('depot-row-//depot/HUD.xlsx')).toBeVisible();

  // 3단계 (//depot/Design/Combat.xlsx) 는 manual click 필요.
  await tree.getByTestId('depot-row-//depot/Design').click();
  await expect(tree.getByTestId('depot-row-//depot/Design/Combat.xlsx')).toBeVisible();

  // PR9c: 파일 클릭 → openDepotFile IPC → 새 excel 탭 (mock revision 42).
  // tabIdOf 가 oneDriveUrl 있을 때 node.id 기반 → 'excel:depot://depot/HUD.xlsx#rev42'.
  await tree.getByTestId('depot-row-//depot/HUD.xlsx').click();
  await expect(page.getByTestId('tab-slot-excel:depot://depot/HUD.xlsx#rev42')).toBeVisible();
  await expect(page.getByTestId('center-pane')).toContainText('읽기 전용');
});

test('리뷰 split — 활성 시 좌우 분할 + 닫기 X 동작', async ({ page }) => {
  // review.spec 에서 검증한 review_stream 기본 응답을 그대로 활용 (간단 stub).
  await page.route('**/127.0.0.1:**/review_stream', async (route) => {
    const body = JSON.stringify({ score: 70, suggestions: ['mock'] });
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'result', data: { review: body } }) + '\n',
    });
  });

  await openConfluencePage(page);
  // webview executeJavaScript stub (review.spec 와 동일)
  await expect(page.getByTestId('center-pane').locator('webview').first()).toBeAttached();
  await page.evaluate(() => {
    const wv = document.querySelector('webview') as HTMLElement & {
      executeJavaScript?: (code: string) => Promise<string>;
    };
    if (wv) wv.executeJavaScript = async () => '본문 mock';
  });

  // 리뷰 트리거 → split-right 등장
  await page.getByTestId('confluence-review').click();
  const splitRight = page.getByTestId('tab-split-right-confluence:3');
  await expect(splitRight).toBeVisible();
  await expect(page.getByTestId('review-split-pane')).toBeVisible();

  // 닫기 X → split-right 사라짐
  await page.getByTestId('review-split-close').click();
  await expect(splitRight).toHaveCount(0);
});
