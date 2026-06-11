// 신규 백엔드(AI-TEST-02, 172.19.3.82:8090) 검증 — 백엔드 데이터 확장 + 벡터검색 활성화
// 후 프론트 GUI 체크리스트를 빌드된 Klaud 로 실제 구동.
//
// 검증 경로: renderer → 로컬 sidecar(127.0.0.1:port) → PROJK_AGENT_URL(settings.json agentUrl)
//            → agent-sdk-poc /quick_find · /ask_stream.
// settings.json 의 agentUrl 이 172.19.3.82:8090 이어야 sidecar 가 그쪽으로 forward.
//
// 선행: npm run build (out/ 최신), 다른 Klaud 인스턴스 없음, 백엔드 8090 가동.

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

let app: ElectronApplication;
let win: Page;

const SHOTS = join(__dirname, '..', '..', 'test-results');

test.beforeAll(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 안 지우면 main 이 app.isPackaged undefined 로 크래시
  // 첫 인자는 out/main/index.js 가 아니라 패키지 디렉토리 — electron 이 package.json 의
  // main(out/main/index.js)을 로드하면서 app.getAppPath() 를 패키지 루트로 잡는다.
  // 파일 직접 지정 시 appPath=out/main 이 되어 getSidecarDir()=out/main/src/sidecar(부재)
  // → sidecar spawn 이 cwd ENOENT 로 죽는다. 실제 dev/packaged 경로와 동일하게 맞춤.
  app = await _electron.launch({
    args: [join(__dirname, '..', '..')],
    env,
    timeout: 60_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

// 자동으로 뜨는 자격증명/설정 모달이 클릭을 막으므로 "취소" 로 닫는다.
async function dismissModals() {
  const cancel = win.locator('.creds-modal button, .modal button', { hasText: '취소' });
  for (let i = 0; i < 3; i++) {
    if (await cancel.first().isVisible().catch(() => false)) {
      await cancel.first().click().catch(() => {});
      await win.waitForTimeout(300);
    } else break;
  }
}

// sidecar 가 'ready' 될 때까지 폴링 (venv 자동생성 첫 부팅이면 길 수 있음).
async function waitSidecarReady(timeoutMs = 90_000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (Date.now() - start < timeoutMs) {
    const s = await win.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).projk.getSidecarStatus(),
    );
    if (s?.state === 'ready') {
      console.log(`[sidecar] ready in ${Date.now() - start}ms`, JSON.stringify(s));
      return s;
    }
    if (s?.state === 'error') throw new Error(`sidecar error: ${JSON.stringify(s)}`);
    await win.waitForTimeout(1000);
  }
  throw new Error('sidecar not ready within timeout');
}

test('① settings.agentUrl 이 신규 백엔드를 가리킨다', async () => {
  await dismissModals();
  const s = await win.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).projk.getSettings(),
  );
  console.log('agentUrl =', s.agentUrl);
  console.log('retrieverUrl =', s.retrieverUrl);
  expect(s.agentUrl).toBe('http://172.19.3.82:8090');
});

test('② 빠른검색: 페리안느 → 8_Contents(PK_몬스터_왕) hit + 벡터 활성', async () => {
  await dismissModals();
  await waitSidecarReady();

  await win.getByTestId('activity-find').click();
  await expect(win.getByTestId('quick-find-panel')).toBeVisible({ timeout: 15_000 });

  const input = win.getByTestId('qf-input');
  await input.fill('페리안느');
  await input.press('Enter'); // Enter = 풀 검색 (fast=false, 벡터 포함)

  // hit 이 하나라도 렌더될 때까지.
  await expect(win.locator('[data-testid^="qf-hit-"]').first()).toBeVisible({ timeout: 30_000 });

  const hitCount = await win.locator('[data-testid^="qf-hit-"]').count();
  const status = await win.getByTestId('qf-status').textContent().catch(() => '');
  const meta = await win.getByTestId('qf-meta').textContent().catch(() => '');
  const bodyText = await win.getByTestId('qf-results').textContent().catch(() => '');
  console.log('[qf] hits =', hitCount);
  console.log('[qf] status =', status);
  console.log('[qf] meta =', meta);

  await win.screenshot({ path: join(SHOTS, 'qf-perianne.png') });

  expect(hitCount).toBeGreaterThan(0);
  // 8_Contents 재변환 데이터가 실제로 검색되는지 — 몬스터_왕 워크북.
  expect(bodyText).toContain('몬스터_왕');
});

test('③ QnA: 기본 이동속도 → DataSheet 답변(400) + 출처 카드', async () => {
  test.setTimeout(260_000); // agent opus 응답 ~1~2분.
  await dismissModals();
  await waitSidecarReady();

  await win.getByTestId('activity-qna').click();
  // activity-qna 는 "QNA 스레드" 사이드바(히스토리 목록)만 연다. 실제 채팅 입력은
  // "+ 새 대화"(thread-new) → onOpenInEditor 로 editor 탭의 QnATab 이 mount 돼야 나온다.
  await expect(win.getByTestId('qna-threads-panel')).toBeVisible({ timeout: 15_000 });
  await win.getByTestId('thread-new').click();

  const chat = win.getByTestId('chat-input');
  await expect(chat).toBeVisible({ timeout: 20_000 });

  await win.getByTestId('qna-model-select').selectOption('opus').catch(() => {});
  await chat.fill('기본 이동속도 값은?');
  await win.getByTestId('chat-send').click();

  // 답변 끝에 출처 카드가 붙을 때까지 대기 (= 스트림 완료 신호).
  await expect(win.getByTestId('qna-message-sources').first()).toBeVisible({ timeout: 240_000 });

  const answer = await win.locator('[data-testid^="msg-assistant-"]').last().textContent();
  const srcCount = await win.locator('[data-testid^="qna-source-card-"]').count();
  console.log('[qna] answer snippet =', (answer || '').replace(/\s+/g, ' ').slice(0, 500));
  console.log('[qna] source cards =', srcCount);

  await win.screenshot({ path: join(SHOTS, 'qna-movespeed.png'), fullPage: true });

  expect(srcCount).toBeGreaterThan(0);
  expect(answer || '').toContain('400');
});
