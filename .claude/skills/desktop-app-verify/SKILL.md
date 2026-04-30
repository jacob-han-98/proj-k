---
name: desktop-app-verify
description: 3계층 자동 검증 (Vitest 단위 / pytest sidecar / Playwright 헤드리스 렌더러) for Project K 데스크톱 앱. Claude가 packages/desktop-app/ 안의 코드를 수정한 직후 반드시 트리거. Electron GUI를 띄울 수 없는 WSL 환경에서 사용자에게 "테스트해 주세요" 떠넘기기 전에 회귀를 잡아내는 마지막 게이트. 트리거 파일: src/main/, src/preload/, src/renderer/, src/sidecar/, src/shared/, tests/. 사용자가 "안 되네", "트리 비었어", "검색 안 돼", "스트림 멈춤", "타입 에러" 같은 증상을 보고할 때도 즉시 호출해서 어느 계층의 회귀인지 격리. Confluence webview / IPC / sidecar lifecycle 같은 Electron-only 동작은 이 스킬로 검증 불가 — 그건 Windows 호스트에서 dev.ps1 로 사용자가 확인.
user-invocable: false
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# Desktop App 3계층 검증 (Project K)

`packages/desktop-app/` 안에서 코드 수정한 후, 사용자에게 "Windows에서 테스트해 주세요" 라고 넘기기 **전에** 이 스킬이 자동 검증을 돌린다. WSL에서 GUI 없이 잡을 수 있는 회귀는 모두 여기서 잡는 게 목표.

## 언제 트리거하나 (자동)

다음 변경 직후 무조건 실행한다:

| 변경 위치 | 최소한 돌릴 검증 |
|----------|-----------------|
| `src/main/tree-core.ts` 또는 `src/main/tree.ts` | `npm run test:unit` |
| `src/main/{ipc,sidecar,paths,auth,index}.ts` | `npm run typecheck` (단위 테스트는 해당 모듈에 한해) |
| `src/preload/*.ts` | `npm run typecheck` |
| `src/renderer/**/*.{ts,tsx,css}` | `npm run test:e2e` |
| `src/sidecar/server.py` (또는 sidecar 안 *.py) | `npm run test:sidecar` |
| `src/shared/types.ts` | **전체** (`npm test`) — 모든 계층에 영향 |
| `package.json`, `tsconfig*.json`, `vite*.config.ts`, `playwright.config.ts`, `vitest.config.ts` | `npm test` 한 번 |

여러 계층이 동시에 바뀌었으면 `npm test` 한 방으로 묶어서 돌리는 게 빠르다 (~5초).

## 사용자 증상 트리거 (수동에 가까운 자동)

사용자가 다음 표현 중 하나를 쓰면 즉시 이 스킬로 들어간다:

- "트리가 비었어 / 안 보여" → `test:unit` (트리 빌더 회귀 의심) + `test:e2e` (렌더링 회귀 의심)
- "검색 안 돼 / 검색 결과 없어" → `test:sidecar` (`/search_docs` shape) + `test:e2e` (search-first 흐름)
- "스트림 멈춤 / 답변 끊김" → `test:sidecar` (`/ask_stream` NDJSON 계약)
- "타입 에러 / 빨간 줄" → `npm run typecheck`
- "앱이 안 떠 / 빈 창" → 일단 `typecheck` + `npm run build` (런타임 부팅 실패 → 컴파일/번들 단계가 깨졌을 가능성)
- "자격증명 / Confluence 인증 깨짐" → renderer 모킹 한계로 직접 검증 불가. 사용자에게 Windows GUI 확인 요청 + DevTools 네트워크 401 추적 안내

## 환경 (WSL)

```bash
cd packages/desktop-app
node --version           # >= 18
.venv/bin/python --version # 3.12+
npx playwright --version
```

최초 1회 셋업이 안 됐으면 다음을 먼저 시키지 말고 자동으로 돌린다:

```bash
npm install
npm run setup
npx playwright install chromium
```

## 표준 워크플로우

### 1) 변경 영향 식별

git status / 마지막 Edit 호출 결과로 어느 디렉터리가 바뀌었는지 본다. 위 표대로 매핑.

### 2) 가장 좁은 검증부터

```bash
# 트리 / 로직 (~1초)
npm run test:unit

# Sidecar HTTP 계약 (~1초)
npm run test:sidecar

# 렌더러 UI (~5초)
npm run test:e2e

# 또는 다 같이
npm test
```

### 3) 실패 처리

- **Vitest 실패**: 어떤 케이스가 깨졌는지 + 기대값/실제값 출력 그대로 사용자에게 보여주고 원인 분석. fixture 디렉터리 셋업 자체가 깨졌으면 `tests/unit/tree.test.ts` 의 `beforeAll` 부터 점검.
- **pytest 실패**: `from server import app` import 에러면 sidecar 코드의 syntax 깨짐 또는 사이드카 venv가 안 깔린 것 — `npm run setup` 다시.
- **Playwright 실패**: 거의 항상 mock projk 와 실제 컴포넌트 간 계약 불일치. `tests/e2e-renderer/mock-projk.ts` 가 새 IPC 메서드를 따라가지 못한 게 흔한 원인. 수정 후 재실행.
- **typecheck 실패**: tsconfig include 누락 또는 타입 정의 오류. `tsconfig.web.json` / `tsconfig.node.json` 의 include 패턴부터 점검.

### 4) 보고 형식

사용자에게 결과를 알릴 때 이런 식으로 정리:

```
✅ Vitest 7/7
✅ pytest 5/5
✅ Playwright 5/5
✅ typecheck OK
```

또는 부분 실패:

```
✅ Vitest 7/7
❌ Playwright 4/5 — "search-first flow" 가 search-results testid를 못 찾음
   원인: ChatPanel.tsx 에서 className 만 있고 data-testid 누락
   수정: data-testid="search-results" 추가
✅ pytest 5/5
```

## 무엇을 검증할 수 없나 (한계)

이 스킬로 **불가능한** 것 — 사용자에게 GUI 확인을 명시적으로 요청한다:

1. **`<webview>` Confluence 임베드** — 헤드리스 Chromium 으로 모킹 불가. partition 격리 / 인증 헤더 주입 / preload 인젝션 모두 Electron 환경 필요.
2. **IPC contextBridge 실제 연결** — 모킹된 `window.projk` 가 아닌 실제 main↔preload↔renderer 메시지 라우팅
3. **Sidecar 라이프사이클** (spawn / health / restart / SIGTERM)
4. **OS 키체인 / safeStorage** 실제 암호화 동작
5. **p4 CLI invoke / shell.openPath / shell.openExternal**
6. **Confluence webRequest 헤더 주입 + 401 재시도**
7. **drag/drop / 클립보드 / 시스템 트레이**

이런 변경을 했으면 검증 결과를 보고할 때 명시적으로:

> 단위/계약/렌더러 회귀는 클리어. `<webview>` 동작은 Windows 호스트에서 dev.ps1 로 직접 확인 부탁드립니다.

## Gotchas

- **`tree.ts` import 금지 (테스트에서)**: Vitest 환경에서 `tree.ts`는 `paths.ts`를 통해 electron `app`을 호출하다 죽는다. 항상 `tree-core.ts`만 import. 새로운 main-process 모듈을 만들 때도 같은 분리 원칙: electron API에 의존하는 wrapper와 순수 로직을 파일로 분리.
- **mock-projk 동기화**: `src/preload/index.ts`의 contextBridge API에 새 메서드를 추가하면 `tests/e2e-renderer/mock-projk.ts`도 같이 추가해야 Playwright가 `undefined is not a function`으로 죽지 않는다. 두 파일은 항상 같은 PR 안에서 변경.
- **mock-projk의 fetch 인터셉트**: `/search_docs`, `/ask_stream` 외 새 sidecar 엔드포인트를 호출하는 컴포넌트가 생기면 mock-projk의 `window.fetch` 오버라이드에도 분기 추가. 안 그러면 실제 fetch가 5180 포트(Vite dev)로 가서 404.
- **Playwright webServer 재사용**: `playwright.config.ts` 의 `reuseExistingServer: !CI` 옵션 때문에 로컬에서 두 번째 실행은 빠르다. 단 5180 포트가 다른 프로세스에 점유되어 있으면 `EADDRINUSE` — 기존 vite-renderer 프로세스 죽이고 재시도.
- **pytest TestClient + lifespan**: FastAPI lifespan 이벤트가 있는 sidecar는 `with TestClient(app) as client:` 패턴이 필요. 현재 sidecar는 lifespan 미사용이라 module-scope fixture로 충분 — lifespan 추가하면 fixture도 같이 업데이트.
- **`npm test`는 e2e도 돈다**: ~5초로 짧지만 watch 모드로 돌리고 싶을 땐 `npm run test:unit:watch` 만 별도. e2e는 webServer 부팅 비용 때문에 watch 부적합.
- **fixture에 한글 파일명**: `tests/unit/tree.test.ts`의 `mkdtemp` 안 fixture는 한글 디렉터리명 사용 — Linux ext4는 잘 처리하지만, Windows에서 같은 테스트를 돌리면 PATH 길이 제한(260자)에 걸릴 수 있다. WSL에서만 돌린다는 가정.
- **Windows 호스트 측 robocopy 동기화**: 사용자가 Windows에서 dev.ps1 켜둔 상태로 내가 WSL에서 코드 수정하면 sync-watcher 가 2초 안에 반영. 여기서 검증을 통과시킨 다음에야 사용자 측이 실수로 깨진 코드를 받지 않는다.

## 관련 스킬과의 차이

- **`playwright-web-verify`**: chrome-extension + qna-poc 검증용. 실제 Confluence 페이지 자동화. 이 스킬과 코드 베이스가 다름.
- **`dev-frontend`**: agent-sdk-poc React 프론트엔드 dev 서버 운영. desktop-app과 무관.
- **`ui-consistency`**: agent-sdk-poc App/Shared/Admin 페이지 일관성. desktop-app엔 적용 안 됨.

## 빠른 점검 (Claude 가 코드 변경 직후 자가 점검 체크리스트)

- [ ] git status 로 어느 디렉터리가 바뀌었는지 확인
- [ ] 위 매핑에 따라 `test:unit` / `test:sidecar` / `test:e2e` / `npm test` 중 적절한 것 선택
- [ ] 실행 + 모두 통과 확인
- [ ] 통과 못 했으면 원인 분석 후 수정 → 재실행 (반복)
- [ ] mock-projk / tsconfig include 가 새 코드를 따라잡고 있는지 확인
- [ ] 사용자에게 보고할 때 "✅ N/N" 포맷 + 한계(`<webview>` 등) 명시
