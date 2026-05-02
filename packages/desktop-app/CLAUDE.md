# Klaud (proj-k desktop-app) — Claude 작업 가이드

## 테스트 정책 (필수)

이 프로젝트는 **3-tier + 1 (real Electron)** 테스트 구조로 운영. "테스트 해줘" 라는 요청은 *모든 layer 회귀 + 신규 변경에 대한 추가 시나리오 설계 + 결과 리포트* 까지 한 번에 처리한다는 뜻.

### 4 Layer 별 책임

| Layer | 도구 | 어떤 bug 가 잡히는가 | 어떤 bug 가 안 잡히는가 |
|---|---|---|---|
| **Renderer unit** (`tests/unit/citations.test.ts` 등) | Vitest | 순수 함수 (파싱/변환/tree 빌더) | UI 흐름, IPC, async 상태 |
| **Main unit** (`tests/unit/onedrive-sync.test.ts`, `tree.test.ts`) | Vitest + `vi.mock('node:child_process')` 등 | OS boundary 함수 (registry 읽기, file system, P4 CLI parse) — 입출력 분기 검증 | 실제 IPC pipe, 실제 sidecar 응답 |
| **Sidecar unit** (`tests/sidecar/test_*.py`) | pytest + FastAPI `TestClient` + `tmp_path` | endpoint 응답 shape, fs 검색 로직 (sub-prefix), env var 분기 | renderer 의 fetch 패턴, IPC marshalling |
| **Web e2e** (`tests/e2e-renderer/*.spec.ts`) | Playwright (web mode, vite dev server) + `window.projk` mock | 사용자 click 흐름, useEffect 무한 루프, 컴포넌트 mount/unmount, mock IPC contract | main process / sidecar python / 진짜 OneDrive registry / 진짜 P4 CLI |
| **Real Electron e2e** (`tests/e2e-electron/*.spec.ts`) | Playwright `_electron.launch()` — 진짜 main + renderer + sidecar | 위 모든 layer + 진짜 IPC pipe 동작 + 진짜 OneDrive Sync 클라이언트 검출 + 진짜 sidecar 부팅 | 사용자 환경 의존 — CI 에서는 못 돌림 |

### 명령어

```bash
# 빠른 회귀 (CI 친화 — 사용자 PC 환경 무관)
npm run test           # vitest + sidecar pytest + web e2e
npm run test:unit      # vitest only
npm run test:sidecar   # sidecar pytest only
npm run test:e2e       # web e2e only

# 사용자 PC 환경에서만 (실제 OneDrive + P4 + sidecar 살아있어야)
npm run build          # out/ 생성
npm run test:electron  # 진짜 Klaud 띄움 + 시나리오 자동 click

# 전부
npm run test:all       # test + test:electron
```

`test:electron` 의 선행 조건:
1. `npm run build` 가 끝났어야 (`out/main/index.js` 존재).
2. 다른 Klaud 인스턴스가 떠있지 않아야 (`.vscode/tasks.json` 의 `kill-stale-klaud-everything` task 또는 VS Code "Klaud dev" stop 후).
3. settings.json 에 `repoRoot` / `p4WorkspaceRoot` / OneDrive Sync 클라이언트가 모두 정상.
4. Windows + 사용자 OneDrive Business 계정 로그인 상태.

### "테스트 해줘" 요청 처리 절차 (필수)

사용자가 "테스트해줘" / "검증해줘" / 비슷한 요청을 하면 다음 순서로:

1. **회귀 — 4 layer 다 돌림** (사용자가 명시적으로 일부만 지정한 경우 제외):
   ```bash
   npm run test           # vitest + pytest + web e2e
   npm run build && npm run test:electron   # 사용자 환경 ok 면
   ```

2. **신규 / 변경 기능 식별** — 직전 대화에서 사용자가 추가/수정한 코드 영역을 review.

3. **부족한 layer 의 테스트 직접 설계 + 추가**:
   - 새 main 함수 → vitest 단위 테스트 추가 (`tests/unit/`).
   - 새 sidecar endpoint → pytest 추가 (`tests/sidecar/`).
   - 새 사용자 흐름 → web e2e (mock 환경) 또는 real Electron e2e 시나리오 추가.
   - 어떤 layer 가 회귀 위험이 큰지 판단해 우선순위 결정.

4. **결과 리포트**:
   - 통과/실패 layer 별 카운트.
   - 실패 한 거 있으면 root cause 추론 + fix 제안 (또는 즉시 fix).
   - 신규 테스트가 어떤 회귀 시나리오를 잡는지 한 줄 설명.

### 새 기능을 추가할 때 어디 layer 가 적합한가

| 변경 종류 | 추가해야 할 테스트 |
|---|---|
| renderer 컴포넌트의 사용자 click 흐름 변경 | 우선 web e2e (mock) — fast feedback. 사용자 환경 의존이면 real Electron 도. |
| main 의 OS boundary 함수 (registry / fs / spawn) | vitest + `vi.mock` — 입력 분기들 다 |
| sidecar endpoint 새로 추가 | pytest + `TestClient` + `tmp_path` — happy + error path |
| IPC channel 신규 (preload bridge + main handler) | vitest + e2e mock 양쪽 update. 회귀 자주 나는 영역. |
| 사용자 환경에서만 드러나는 동작 (좀비 정리, registry 분기, OneDrive Sync) | real Electron e2e — manual smoke 으로라도 |

### Bug 수정 시 — 회귀 테스트 의무

bug fix 마다 *그 회귀를 잡는 테스트* 를 추가해야 함. 추가 안 했으면 fix 가 미완. 예시:

- **2026-05-02**: OneDrive `UserUrl` 레지스트리 키 부재 → fallback 추가 (`detectSyncAccount`). 회귀 방지: `tests/unit/onedrive-sync.test.ts` 의 "userUrl resolve 우선순위" 3개 테스트.
- **2026-05-02**: P4 client view sub-prefix (`Design/`) 자동 발견 — sidecar `xlsx_raw`. 회귀 방지: `tests/sidecar/test_xlsx_endpoints.py` 의 "finds_file_under_one_level_subfolder".
- **2026-05-02**: `LocalSheetView` 의 useEffect dep 무한 루프. 회귀 방지: `tests/e2e-renderer/onedrive-sync.spec.ts` 의 시나리오 B/C (mock 환경에서 page hang 으로 즉시 드러남).

## Windows ↔ WSL split (사이드카 import 경로)

Klaud dev 모드는 main process 가 `getSidecarDir() = repoRoot + 'packages/desktop-app/src/sidecar'` 로 sidecar 를 spawn. 사용자의 `repoRoot` 가 `\\wsl.localhost\Ubuntu-24.04\...` 면 **WSL 측 server.py 가 import 됨** (Windows e:\ 측이 아님).

함의:
- sidecar Python 코드를 e:\ 만 수정하면 사용자 dev 환경에 반영 X.
- 양쪽 동기화 필요: e:\ 변경 후 WSL 측 같은 path 에도 동일 변경 (UNC `\\wsl.localhost\Ubuntu-24.04\home\jacob\repos\proj-k\packages\desktop-app\src\sidecar\server.py` 에 직접 write 가능). 또는 push → WSL pull.
- main process 와 renderer 는 Windows e:\ 측만.

## Klaud dev 라이프사이클 (Windows)

VS Code "Klaud dev" debug stop 시 npm/electron 자식 트리가 OS-clean 종료 안 됨 (Windows SIGTERM 한계). 좀비 누적 방지:
- `.vscode/launch.json` 의 `preLaunchTask` + `postDebugTask` = `kill-stale-klaud-everything` 자동 청소 (sidecar python, electron.exe, node.exe, cmd.exe 모두 — `proj-k` 또는 `electron-vite` keyword 로 안전 필터).
- `src/main/sidecar.ts` 의 `killStaleSidecars()` 가 부팅 시 다시 안전망.
- `stopSidecar()` 가 Windows 면 `taskkill /F /T /PID` 로 자식 트리째.

## 코드 변경 시 주의

- `ELECTRON_RUN_AS_NODE` env 가 셋되어 있으면 `npm run dev` 에서 main 이 `app.isPackaged` 못 읽고 crash. Bash 기반 자동화 시작 전에 `unset ELECTRON_RUN_AS_NODE`.
- e2e mock 의 hook 들 (`__setEnsureFreshResponse`, `__pushSyncProgress` 등) 은 spec 별로 page.evaluate 로 호출. 새 IPC 추가 시 mock-projk.ts 도 stub + hook 추가.
- 신규 testid 부여 — 사용자 시나리오 테스트가 잡을 수 있게. testid 없으면 Playwright 가 텍스트로 잡는데 한국어 + 깨질 수 있음.
