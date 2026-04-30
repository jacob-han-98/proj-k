# Klaud — Project K Desktop App

윈도우즈 데스크톱 앱. **사용자에게 보이는 브랜드명은 `Klaud`**, 내부 프로젝트/레포/사내 게이트웨이 명은 `Project K` 로 분리. Electron + Python sidecar.

> 표기 정책:
> - 사용자 화면(타이틀바 / 작업표시줄 / 토바 / 마케팅): **Klaud**
> - 코드/문서/레포 식별자(package.json `name`, electron-builder `appId`/`productName`, NSIS 설치 디렉터리): **Project K** 그대로 — 자동 업데이트 경로와 OS-level 호환성을 유지하기 위함.

## 빠른 시작 (셋 중 골라서)

| 상황 | 방법 |
|------|------|
| **사용자처럼 설치파일로 받아서 실행 (자동 업데이트)** | Part A 참조 — `release/*.exe` 실행 |
| Windows에서 dev 모드로 (코드 수정하며 직접 테스트) | Part B 참조 — `dev.ps1` |
| **WSL에서 Claude/CI가 검증만 자동으로** | Part C 참조 — `npm test` |

---

## Part A. 설치파일로 실행 (사용자 모드)

이게 일반 사용자 배포 흐름과 동일. PowerShell, robocopy, 환경변수 등을 신경쓸 필요 없음.

### 첫 설치 (1번만)

WSL에서 빌드된 설치파일 위치:
```
\\wsl.localhost\Ubuntu-24.04\home\jacob\repos\proj-k\packages\desktop-app\release\ProjectK-Portable-0.1.0.exe
```

Windows 탐색기로 위 경로 → **`ProjectK-Portable-0.1.0.exe`** 더블클릭 → SmartScreen 경고가 뜨면 "추가 정보 → 실행" → 앱 시작.

### 자동 업데이트 받기 (선택)

새 버전이 푸시되면 자동으로 받게 하려면:

1. WSL 측에서 피드 서버 실행:
   ```bash
   cd packages/desktop-app
   npm run serve:feed
   ```
   → `http://localhost:8765/` 가 release 디렉터리를 노출 (WSL2 → Windows 로컬호스트 자동 포워딩)

2. Windows 측에서 앱을 실행할 때 환경변수 지정:
   ```powershell
   $env:PROJK_UPDATE_FEED_URL = "http://localhost:8765/"
   & "\\wsl.localhost\Ubuntu-24.04\home\jacob\repos\proj-k\packages\desktop-app\release\ProjectK-Portable-0.1.0.exe"
   ```

   매번 입력하기 싫으면 `setx`로 영구 등록:
   ```powershell
   setx PROJK_UPDATE_FEED_URL "http://localhost:8765/"
   ```

3. 앱 부팅 5초 후 자동 체크 → 새 버전 발견 시 우측 하단 토스트 → 사용자가 "지금 재시작" 클릭 또는 다음 종료 시 자동 설치.

### NSIS 인스톨러 (정식 설치 + 자동 업데이트)

Portable은 매번 임시 디렉터리에 풀려서 자동 업데이트 자체가 동작하지 않습니다. **자동 업데이트가 실제로 굴러가려면 NSIS 인스톨러**가 필요한데, 이건 Linux 빌드 환경에서 Wine 의존성이 있습니다:

```bash
sudo apt-get install -y wine
```

설치 후 `npm run release` 다시 돌리면 `ProjectK-Setup-0.1.0.exe` 가 정상 생성됩니다. 사용자는 그 인스톨러를 한 번 실행 → 시작 메뉴 등록 + 진짜 설치 → 자동 업데이트 풀 동작.

### 새 버전 푸시 워크플로우 (Claude WSL)

```bash
# 1) 코드 수정
# 2) 회귀 검증
npm test

# 3) 버전 bump + 빌드 + release/ 갱신
npm run release           # patch (0.1.0 → 0.1.1)
npm run release -- --version 0.2.0     # 명시 버전

# 4) 피드 서버는 그대로 — 사용자 앱이 다음 5초 폴링에서 자동 발견
```

---

## Part B. Windows 호스트에서 GUI 실행 (dev 모드)

소스는 WSL2(`~/repos/proj-k`)에 두고, Electron만 Windows 호스트에서 실행하는 워크플로우입니다.

### 1회 준비 — Windows 측 도구

| 도구 | 설치 명령 (PowerShell, winget) |
|------|-------------------------------|
| Node.js LTS 18+ | `winget install OpenJS.NodeJS.LTS` |
| Python 3.11+ | `winget install Python.Python.3.12` ("Add to PATH" 체크) |
| (선택) PowerShell 7 | `winget install Microsoft.PowerShell` |

설치 후 새 PowerShell 창에서 `node --version`, `python --version` 확인.

### 매 세션 — `dev.ps1` 한 줄

```powershell
# WSL 측 레포에서 한 번만 dev.ps1을 가져와도 되고, 매번 \\wsl.localhost 로 직접 호출해도 됨
pwsh \\wsl.localhost\Ubuntu-24.04\home\jacob\repos\proj-k\packages\desktop-app\scripts\dev.ps1
```

처음 실행 (10~15분):
1. WSL 배포판 자동 감지
2. 소스를 `%USERPROFILE%\projk-desktop\` 로 robocopy
3. `npm install` (Windows 바이너리 + native 모듈 ABI 매칭)
4. `npm run setup` (Windows 측 Python venv + sidecar 의존성)
5. **백그라운드 sync-watcher 시작** — WSL에서 코드 수정하면 2초 내 Windows로 자동 복사 → Vite HMR 반영
6. `npm run dev` → Electron 창 열림

다음 실행부터는 `package.json` 해시 비교로 install을 건너뛰어 30초 내로 시작.

### 옵션

```powershell
# node_modules / .venv 강제 재생성
pwsh ./scripts/dev.ps1 -ForceClean

# 자동 sync-watcher 끄기 (수동 robocopy 직접 하고 싶을 때)
pwsh ./scripts/dev.ps1 -NoWatch

# build 만 (dev 없이)
pwsh ./scripts/dev.ps1 -BuildOnly

# WSL 배포판이 자동 감지 안 될 때
pwsh ./scripts/dev.ps1 -WslDistro Ubuntu-24.04

# 별도 디렉터리에 작업
pwsh ./scripts/dev.ps1 -WinTarget D:\projk-dev
```

### 실행 정책 차단되면

```powershell
# 현재 PowerShell 세션에만 적용
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\dev.ps1
```

### 자격증명 입력 (Confluence webview)

앱 우측 상단 "자격증명 설정" → 이메일 + Atlassian API Token (https://id.atlassian.com/manage-profile/security/api-tokens) → 저장. `safeStorage`(DPAPI)로 암호화 저장.

---

## Part C. WSL에서 자동 검증 (Claude / CI 용)

GUI 없이 코드 정합성을 확인하기 위한 3계층 테스트. 모두 **WSL Linux 안에서 단독 실행**됩니다.

### 1회 준비

```bash
cd packages/desktop-app
npm install                       # Linux 바이너리 (Windows용과 분리)
npm run setup                     # Python venv + sidecar 의존성
npx playwright install chromium   # headless Chromium (~110MB)
```

### 전체 한 방

```bash
npm test
```

순서대로:
1. `npm run test:unit` — Vitest (트리 빌더 등 순수 로직)
2. `npm run test:sidecar` — pytest (FastAPI TestClient로 sidecar HTTP 계약)
3. `npm run test:e2e` — Playwright (헤드리스 Chromium + 모킹된 `window.projk` 로 React 렌더러 검증)

소요 시간 ~5초.

### 개별 실행

```bash
npm run test:unit            # 빠름 (~1초)
npm run test:unit:watch      # 파일 변경 시 자동 재실행
npm run test:sidecar         # ~1초
npm run test:e2e             # ~5초
npm run renderer:test-server # 렌더러만 단독 서버 (수동 디버깅용 — http://127.0.0.1:5180/)
npm run typecheck            # tsc --noEmit (Node + Web)
```

### 테스트 계층 무엇을 검증하나

| 계층 | 위치 | 검증 대상 |
|------|------|----------|
| **Vitest** (단위) | `tests/unit/` | 순수 함수 — 트리 빌더, API 파서. fixtures 디렉터리 사용 |
| **pytest** (sidecar) | `tests/sidecar/` | FastAPI 엔드포인트 — `/health`, `/search_docs` shape, `/ask_stream` NDJSON 계약 |
| **Playwright** (web mode) | `tests/e2e-renderer/` | React 렌더러 — 트리 페인트, 검색-우선 흐름, 자격증명 배너. `window.projk` 모킹 |

### Playwright 웹모드 작동 원리

Electron을 쓸 수 없는 환경(WSL)에서 React 렌더러만 검증할 수 있도록:
1. `vite.renderer.config.ts` 가 `src/renderer/` 만 단독 서빙 (port 5180)
2. `playwright.config.ts` 의 `webServer` 가 자동 부팅
3. `tests/e2e-renderer/mock-projk.ts` 가 `window.projk` 와 `fetch` 를 가짜로 채움
4. 실제 IPC / 사이드카 / Confluence 인증 없이 UI 동작 검증

Electron 자체 통합 테스트(`<webview>`, IPC, sidecar lifecycle)는 Phase 5에 별도 `playwright-electron`으로 추가 — Windows 호스트에서만 실행.

---

## 환경 변수

| 변수 | 용도 |
|------|------|
| `PROJK_REPO_ROOT` | 레포 루트 절대경로. Windows 호스트에서는 `dev.ps1` 가 자동 주입 |
| `PROJK_PYTHON` | sidecar 실행 시 사용할 Python 경로. 기본은 `.venv` 자동 탐지 |
| `PROJK_PROXY_URL` | LLM 프록시 게이트웨이 URL (Phase 2+) |

## 디렉터리 구조

```
src/
  main/                Electron 메인 프로세스
    tree.ts            electron-aware 트리 wrapper
    tree-core.ts       순수 트리 빌더 (테스트 대상)
  preload/             contextBridge + Confluence 인젝트
  renderer/            React UI
  sidecar/             Python FastAPI
  shared/              메인/preload/렌더러 공통 타입
scripts/
  dev.ps1              Windows 호스트 원클릭 (sync + install + dev)
  sync-watch.ps1       WSL → Windows 폴링 sync (2초 간격)
  setup.mjs            크로스플랫폼 venv 셋업
tests/
  unit/                Vitest
  sidecar/             pytest
  e2e-renderer/        Playwright (web mode)
```

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| `'electron-vite' is not recognized` | `node_modules`가 Linux 바이너리. `dev.ps1 -ForceClean` 로 재설치 |
| `'\\wsl.localhost\... ' UNC 경로는 지원되지 않습니다` | cmd.exe가 UNC를 cwd로 못 받음. `dev.ps1` 가 자동으로 robocopy → 로컬 경로로 우회 |
| `sidecar error :포트` | venv 미생성. `npm run setup` 또는 `dev.ps1 -ForceClean` |
| `[main] xlsx-extractor/output: MISSING` | `PROJK_REPO_ROOT` 미설정 또는 잘못된 경로. dev 콘솔 확인 |
| Vitest가 `app.getAppPath` 에러 | `tree-core.ts` 가 아닌 `tree.ts` 를 import 한 것. 테스트는 `-core` 모듈 사용 |
| Playwright가 Chromium을 못 찾음 | `npx playwright install chromium` |
| `node-gyp` 컴파일 에러 (Windows) | Visual Studio Build Tools 설치 또는 native dep 제거 (better-sqlite3 같은) |
| 한글 자격증명 / 경로가 깨짐 | PowerShell 코드페이지 UTF-8 강제: `chcp 65001` |
