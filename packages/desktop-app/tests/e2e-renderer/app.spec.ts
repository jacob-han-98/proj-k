import { test, expect } from '@playwright/test';
import { mockProjkInitScript } from './mock-projk';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: mockProjkInitScript });
});

test('app shell renders 4-pane workbench with sidecar ready + 버전 표기', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  // M1: Activity Bar (48) + Sidebar (240) + Editor (1fr). 우측 ChatPanel 은 제거됨.
  await expect(page.getByTestId('activity-bar')).toBeVisible();
  await expect(page.getByTestId('sidebar-host')).toBeVisible();
  await expect(page.getByTestId('editor-host')).toBeVisible();
  // default activeIcon='confluence' → confluence panel + 트리 visible.
  await expect(page.getByTestId('sidebar-pane-confluence')).toBeVisible();
  await expect(page.getByTestId('confluence-tree')).toBeVisible();
  // P4 트리는 활동바 토글 후 보임 (사이드바 swap).
  await page.getByTestId('activity-p4').click();
  await expect(page.getByTestId('p4-tree')).toBeVisible();
  // editor 처음 빈 상태 — placeholder.
  await expect(page.getByTestId('editor-empty')).toBeVisible();
  // Sidecar status pill picks up the mock 'ready' status
  await expect(page.locator('.status-pill')).toContainText('ready');
  // 토바에 v숫자.숫자.숫자 형식 버전이 보여야 함 (자동 업데이트 후에도 항상 표기)
  await expect(page.getByTestId('app-version')).toContainText(/v\d+\.\d+\.\d+/);
});

test('P4 tree expands and selects a sheet', async ({ page }) => {
  await page.goto('/');

  // M1: P4 사이드바는 default 가 아니라 활동바 토글 필요.
  await page.getByTestId('activity-p4').click();
  const tree = page.getByTestId('p4-tree');
  await expect(tree.getByText('7_System', { exact: true })).toBeVisible();

  // Expand category → workbook
  await tree.getByText('7_System', { exact: true }).click();
  await expect(tree.getByText('PK_HUD 시스템', { exact: true })).toBeVisible();

  await tree.getByText('PK_HUD 시스템', { exact: true }).click();
  await expect(tree.getByText('HUD_기본', { exact: true })).toBeVisible();

  // Click sheet → editor 에 탭 추가 + center pane (sheet mapping prompt) 렌더.
  await tree.getByText('HUD_기본', { exact: true }).click();
  const center = page.getByTestId('center-pane');
  await expect(center).toContainText('HUD_기본');
  // 0.1.46 (PoC 2C) — Sync detect 실패 (mock 환경) 시 manual share URL 등록 fallback.
  // 자동 매핑 카드는 Sync 클라이언트 detect 결과 따라 노출 — Linux 환경 mock 은 false.
  await center.getByText('또는 share URL 직접 등록').click();
  await expect(center.getByTestId('sheet-mapping-input')).toBeVisible();
});

test('Confluence tree shows hierarchy', async ({ page }) => {
  await page.goto('/');

  // 'Design' is the root manifest node
  await expect(page.getByText('Design')).toBeVisible();
  await page.getByText('Design').click();
  await expect(page.getByText('시스템 디자인')).toBeVisible();
});

// M1: 채팅/검색은 editor 의 qna-thread 탭 안에서만 동작. 사용자가 사이드바에서 새 thread 만들면
// editor 탭 자동 추가 + active. 그 탭 안에 chat-input/search-results 가 렌더된다.
async function openNewQnATab(page: import('@playwright/test').Page) {
  await page.getByTestId('activity-qna').click();
  await page.getByTestId('thread-new').click();
  // QnATab 이 mount 되며 chat-input 등장.
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

test('search-first flow: hits before answer + 헤더/카운트', async ({ page }) => {
  await page.goto('/');

  await openNewQnATab(page);
  await page.getByTestId('chat-input').fill('HUD 관련 문서');
  await page.getByTestId('chat-send').click();

  // 검색 결과 섹션 + "관련 문서 N개" 헤더가 보여야 함
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-results')).toContainText('관련 문서 2개');
  await expect(page.getByTestId('search-results')).toContainText('PK_HUD 시스템');
  await expect(page.getByTestId('search-results')).toContainText('HUD 개편안');

  // 답변도 들어와야 함
  await expect(page.locator('.msg.assistant').last()).toContainText('HUD');
});

test('cited 인용 매칭: 답변에 등장한 hit 에 인용 배지', async ({ page }) => {
  await page.goto('/');

  await openNewQnATab(page);
  await page.getByTestId('chat-input').fill('HUD 레이아웃');
  await page.getByTestId('chat-send').click();

  // 답변 스트림 끝나길 기다림 (mock 의 result 이벤트 처리 후 cited 부착)
  await expect(page.locator('.msg.assistant').last()).toContainText('레이아웃');

  // PK_HUD 시스템 카드는 cited (mock 답변이 그 워크북을 인용)
  const hudCard = page.getByTestId('hit-PK_HUD 시스템');
  await expect(hudCard).toHaveAttribute('data-cited', 'true');
  await expect(hudCard).toContainText('인용');

  // HUD 개편안 (Confluence) 은 답변 안에 등장하지 않음 → cited=false
  const reformCard = page.getByTestId('hit-design/hud-改편');
  await expect(reformCard).toHaveAttribute('data-cited', 'false');
});

test('confluence page 선택 시 webview 가 즉시 띄워짐 (creds 없어도 — webview 안에서 native 로그인)', async ({ page }) => {
  // 0.1.38 부터: Basic auth header inject 제거 + creds-banner 제거. partition 의 cookie 로
  // chrome-extension 식 동선 — 첫 진입이면 atlassian.net 로그인 페이지가 webview 안에서.
  await page.goto('/');

  await page.getByText('Design').click();
  await page.getByText('시스템 디자인').click();
  await page.getByText('전투').click();

  // CenterPane 이 webview 를 즉시 렌더 (자격증명 게이트 없이).
  const center = page.getByTestId('center-pane');
  await expect(center).toContainText('전투');
  await expect(center.locator('webview')).toBeAttached();
});

test('첫 부팅: settings 비어있으면 ⚙ 설정 모달이 자동으로 뜨고 default 값이 pre-fill', async ({ page }) => {
  // mock-projk 가 이미 init 한 직후 storedSettings 를 비움 (App.tsx 의 useEffect 가 getSettings 호출하기 전).
  // addInitScript 는 등록 순서대로 실행되므로 beforeEach 의 mock-projk 다음에 이 스크립트가 동작.
  await page.addInitScript(() => {
    (window as unknown as { __resetSettings?: () => void }).__resetSettings?.();
  });
  await page.goto('/');

  // 모달이 자동 오픈
  await expect(page.getByTestId('settings-feed-url')).toBeVisible();
  await expect(page.getByTestId('settings-feed-url')).toHaveValue('http://localhost:8766/');
  await expect(page.getByTestId('settings-repo-root')).toHaveValue(/wsl\.localhost/);

  // 그냥 저장 누르면 default 값이 settings 로 들어감
  await page.getByRole('button', { name: /저장하고 적용/ }).click();
  const stored = await page.evaluate(
    () => (window as unknown as { __getStoredSettings: () => unknown }).__getStoredSettings(),
  );
  expect(stored).toMatchObject({ updateFeedUrl: 'http://localhost:8766/' });
});

test('settings modal: 명시적으로 열어 사용자 값으로 덮어쓸 수 있다', async ({ page }) => {
  await page.goto('/');

  // 기본 storedSettings 가 채워져있어 모달이 자동 오픈되지 않음 — 버튼으로 연다.
  await page.getByRole('button', { name: /설정/ }).click();

  await page.getByTestId('settings-repo-root').fill('\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k');
  await page.getByTestId('settings-feed-url').fill('http://localhost:9999/');
  await page.getByTestId('settings-email').fill('user@hybe.im');
  await page.getByTestId('settings-token').fill('mock-token');

  await page.getByRole('button', { name: /저장하고 적용/ }).click();

  const stored = await page.evaluate(
    () => (window as unknown as { __getStoredSettings: () => unknown }).__getStoredSettings(),
  );
  // retrieverUrl / agentUrl 은 default pre-fill 로 채워진 후 저장되므로 toMatchObject 로
  // 우리가 명시 입력한 키만 검증.
  expect(stored).toMatchObject({
    repoRoot: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k',
    updateFeedUrl: 'http://localhost:9999/',
  });
});

test('update indicator: 토바에 항상 떠있고 클릭 시 수동 체크/재시작', async ({ page }) => {
  await page.goto('/');

  // 항상 보임
  const indicator = page.getByTestId('update-indicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('data-state', 'idle');

  // 클릭 → 수동 체크 (window.__manualCheckCalled 증가)
  await indicator.click();
  const calls = await page.evaluate(
    () => (window as unknown as { __manualCheckCalled?: number }).__manualCheckCalled,
  );
  expect(calls).toBeGreaterThanOrEqual(1);

  // ready 상태 푸시 → indicator 가 attention 레벨로
  await page.evaluate(() => {
    (window as unknown as { __pushUpdaterState: (s: unknown) => void }).__pushUpdaterState({
      state: 'ready',
      version: '0.1.99',
    });
  });
  await expect(indicator).toHaveAttribute('data-state', 'ready');
  await expect(indicator).toContainText('v0.1.99');

  // 클릭하면 quitAndInstall 호출
  await indicator.click();
  const installCalled = await page.evaluate(
    () => (window as unknown as { __quitAndInstallCalled?: boolean }).__quitAndInstallCalled === true,
  );
  expect(installCalled).toBe(true);
});

test('update toast: hidden when idle, shows progress, then ready button', async ({ page }) => {
  await page.goto('/');

  // 처음엔 idle — 토스트 없음
  await expect(page.getByTestId('update-toast')).not.toBeVisible();

  // 다운로드 중 → 진행률 토스트
  await page.evaluate(() => {
    (window as unknown as { __pushUpdaterState: (s: unknown) => void }).__pushUpdaterState({
      state: 'downloading',
      percent: 42,
      bytesPerSecond: 1024 * 500,
    });
  });
  await expect(page.getByTestId('update-toast')).toBeVisible();
  await expect(page.getByTestId('update-toast')).toContainText('42%');

  // 다운로드 완료 → "지금 재시작" 버튼
  await page.evaluate(() => {
    (window as unknown as { __pushUpdaterState: (s: unknown) => void }).__pushUpdaterState({
      state: 'ready',
      version: '0.1.1',
      releaseNotes: '검색-우선 UX 개선',
    });
  });
  await expect(page.getByTestId('update-toast')).toContainText('v0.1.1');
  await page.getByTestId('update-restart').click();

  // quitAndInstall 호출 확인
  const called = await page.evaluate(
    () => (window as unknown as { __quitAndInstallCalled?: boolean }).__quitAndInstallCalled === true,
  );
  expect(called).toBe(true);
});
