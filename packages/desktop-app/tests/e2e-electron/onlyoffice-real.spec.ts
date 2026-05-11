// 진짜 Electron + 진짜 sidecar + 진짜 WSL OnlyOffice DS CE 컨테이너 환경에서 OnlyOffice
// viewer 통합 검증.
//
// PoC 0.1.53+: SharePoint 대안. settings 의 viewerMode='onlyoffice' + onlyOfficeUrl 채워두면
// CenterPane 이 OnlyOfficeSheetView 로 분기 → main 이 WSL serve.py spawn → 임베드 URL 반환 →
// webview src 에 마운트.
//
// 이 spec 은 IPC chain 자체를 직접 검증 (window.projk.onlyOffice.prepare 호출). UI 트리 클릭
// 검증은 P4 트리가 sidecar/PROJK_P4_ROOT 환경에 의존 → 환경 미설정 시 flaky → 별도 manual
// smoke 으로 미룸.
//
// 선행 조건:
//   1) `npm run build` (out/main/index.js 존재).
//   2) WSL Docker 의 `onlyoffice-ds-poc` 컨테이너 가동 (excel-viewer-poc/docker-compose.yml).
//   3) sidecar ready (settings.json 의 repoRoot 가 정상이어야 sidecar 부팅 성공).
//   4) ELECTRON_RUN_AS_NODE 미설정.

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

const EXPECTED_OO_URL_HINT = 'http://172.20.105.147:8080';
// settings.sheetMappings 에 항상 등록되어 있는 대표 시트 — sidecar 가 PROJK_P4_ROOT 로 resolve.
// jacob 환경의 D:\ProjectK\Design\7_System\PK_변신 및 스킬 시스템.xlsx 와 매칭.
const TEST_REL_PATH = '7_System/PK_변신 및 스킬 시스템';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // cwd 를 packages/desktop-app 로 맞춰 electron 이 그 디렉토리의 package.json 을 root
  // 로 인식하게 한다 → app.getAppPath() = 같은 dir → sidecar.ts 의 getSidecarDir() 가
  // `src/sidecar` 를 정확히 찾음. args=['.'] 면 electron 이 cwd 의 main 필드 (out/main/index.js) 사용.
  const pkgDir = join(__dirname, '..', '..');
  app = await _electron.launch({
    args: ['.'],
    cwd: pkgDir,
    env,
    timeout: 60_000,
  });
  // Klaud main process console 캡처 — onlyoffice-host 로그 추적용.
  app.process().stdout?.on('data', (d) => process.stdout.write(`[klaud-main] ${d}`));
  app.process().stderr?.on('data', (d) => process.stderr.write(`[klaud-main:err] ${d}`));
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  // viewerMode 원복 (다음 사용자 사용에 영향 안 가게).
  await win
    .evaluate(async () => {
      await window.projk.setSettings({ viewerMode: 'sp' });
    })
    .catch(() => {});
  await app?.close();
});

test('settings: 신규 필드 default — viewerMode "onlyoffice" (기본), onlyOfficeUrl 사전입력', async () => {
  // 기존 viewerMode 를 비우고 default 가 보이는지 확인. setSettings 가 undefined 값을 제거 처리.
  await win.evaluate(async () => {
    await window.projk.setSettings({ viewerMode: undefined, onlyOfficeUrl: undefined });
  });

  await win.getByTestId('topbar-settings').click();
  await expect(win.getByTestId('settings-viewer-mode')).toBeVisible();

  const mode = win.getByTestId('settings-viewer-mode');
  await expect(mode).toHaveValue('onlyoffice');

  const url = win.getByTestId('settings-onlyoffice-url');
  await expect(url).toHaveValue(EXPECTED_OO_URL_HINT);

  // 모달 닫음.
  const cancelBtn = win.getByRole('button', { name: '취소' });
  if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
});

test('IPC chain — prepare(relPath) → serve.py spawn → 임베드 URL 반환 + 실제 fetch 검증', async () => {
  test.setTimeout(120_000);

  // sidecar 가 진짜 ready 상태가 되길 기다림 (state='ready'). 환경에서 sidecar 부팅 실패면
  // 테스트는 skip — 내 OnlyOffice 코드와 무관한 환경 회귀 차단.
  let sidecarReady = false;
  for (let i = 0; i < 60; i++) {
    const state = await win.evaluate(async () => {
      const s = await window.projk.getSidecarStatus();
      return s.state;
    });
    if (state === 'ready') {
      sidecarReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!sidecarReady) {
    test.skip(true, 'sidecar 가 60s 안에 ready 안 됨 — 환경 (Python venv / repoRoot / port 8533) 점검 필요');
  }

  // settings: viewerMode=onlyoffice + URL 명시.
  await win.evaluate(
    async (url: string) => {
      await window.projk.setSettings({ viewerMode: 'onlyoffice', onlyOfficeUrl: url });
    },
    EXPECTED_OO_URL_HINT,
  );

  // 직접 IPC 호출. main → onlyoffice-host → wsl spawn → 포트 응답 → URL 반환까지.
  const result = await win.evaluate(async (rp: string) => {
    return await window.projk.onlyOffice.prepare(rp);
  }, TEST_REL_PATH);

  console.log(`[onlyoffice-real] prepare result: ${JSON.stringify(result)}`);

  if (!result.ok) {
    throw new Error(
      `prepare 실패: ${result.error}\n` +
        `(WSL 컨테이너 down? PROJK_P4_ROOT 미설정? serve.py path 잘못?)`,
    );
  }

  expect(result.viewerUrl).toMatch(/^http:\/\/[\d.]+:9000\/?$/);

  // viewerUrl 이 실제로 응답하는지 — 임베드 HTML 본문에 DocsAPI 호출이 있어야.
  const res = await fetch(result.viewerUrl);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('DocsAPI.DocEditor');
  expect(html).toContain('host.docker.internal:9000/sample.xlsx');
  console.log(`[onlyoffice-real] embed HTML (${html.length} bytes) contains DocsAPI 호출 ✓`);

  // sample.xlsx 도 reachable — serve.py 가 정확하게 file 도 host 함.
  const fileRes = await fetch(result.viewerUrl + 'sample.xlsx');
  expect(fileRes.status).toBe(200);
  const len = Number(fileRes.headers.get('content-length') ?? '0');
  expect(len).toBeGreaterThan(1024);
  console.log(`[onlyoffice-real] sample.xlsx 응답 ${len} bytes ✓`);
});

test('IPC chain — onlyOfficeUrl 미설정 시 친절한 에러 반환', async () => {
  test.setTimeout(60_000);

  // sidecar ready 가정 (앞 테스트 통과시).
  await win.evaluate(async () => {
    await window.projk.setSettings({ viewerMode: 'onlyoffice', onlyOfficeUrl: undefined });
  });

  const result = await win.evaluate(async (rp: string) => {
    return await window.projk.onlyOffice.prepare(rp);
  }, TEST_REL_PATH);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain('onlyOfficeUrl');
  }
});
