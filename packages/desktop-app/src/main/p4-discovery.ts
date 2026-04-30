// P4 워크스페이스 자동 발견 — 사용자 PC 에 깔린 p4.exe 의 `p4 info` 출력에서
// Client root 추출. 사용자가 settings 에 path 입력하지 않아도 sidecar 가 알아서
// .xlsx 원본을 fetch 하게 됨. 사용자 부담 0회.
//
// 0.1.49 (PoC 2C) — 백엔드 서버 (= P4 워크스페이스) 에서 .xlsx 자동 다운로드 흐름.
// 향후 production 에서는 사내 file 게이트웨이 HTTP API 로 교체 가능 — 같은 sidecar
// /xlsx_raw 가 환경변수만 바뀌면 동작.

import { spawnSync } from 'node:child_process';

// `p4 info` 출력 예:
//   User name: jacob
//   Client name: jacob_HYBE
//   Client host: ...
//   Client root: D:\ProjectK\Design
//   Current directory: ...
//   ...
// 사용자가 P4 login 안 한 상태에서도 Client info 는 나옴. P4 client 가 PATH 에 있어야 함
// (보통 D:\Program Files\Perforce\... 가 인스톨러로 자동 추가).
export function discoverP4ClientRoot(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('p4', ['info'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      console.log(`[p4-discovery] p4 info failed status=${r.status} stderr=${r.stderr?.trim()}`);
      return null;
    }
    const m = r.stdout.match(/^Client root:\s+(.+)$/m);
    const root = m?.[1]?.trim();
    if (!root || root.toLowerCase() === 'unknown') return null;
    return root;
  } catch (e) {
    console.log(`[p4-discovery] spawn 예외 ${(e as Error).message}`);
    return null;
  }
}
