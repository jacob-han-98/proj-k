// 진짜 Electron e2e — main + sidecar + renderer 모두 살린 채 사용자 시나리오 검증.
//
// 일반 e2e (playwright.config.ts) 와의 차이:
//   - 일반: vite renderer dev server 만 띄우고 vanilla chromium 으로 로드. window.projk mock 주입.
//   - 이 config: out/main/index.js 를 _electron.launch 로 띄움. 진짜 IPC, 진짜 sidecar python,
//     진짜 OneDrive registry 검출, 진짜 P4 워크스페이스 fs 접근. 사용자 PC 환경 의존.
//
// 언제 돌리는가:
//   - 사용자가 "테스트해줘" 하고 사용자 PC (Windows + OneDrive Sync + P4 워크스페이스) 에서.
//   - 사용자가 명시적으로 신규/변경 기능에 대한 사용자 시나리오 검증을 요청할 때.
//   - CI 에서는 안 돌림 (사용자 PC 환경 못 갖춤).
//
// 선행 조건:
//   1) `npm run build` 로 out/ 생성 (electron-vite build).
//   2) 다른 Klaud 인스턴스 없음 (좀비 청소: tasks.json 의 kill-stale-klaud-everything 또는
//      VS Code "Klaud dev" stop 후).
//   3) settings.json 에 repoRoot / p4WorkspaceRoot / OneDrive Sync 클라이언트 모두 정상.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e-electron',
  // Electron 부팅 + sidecar 초기화 + OneDrive registry probe 까지 ~15초 내외.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,  // 한 번에 한 Electron 만 띄움.
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
