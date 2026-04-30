# Project K Desktop App — Windows dev 부트스트래퍼 (한 방 실행)
#
# 한 번 실행하면 자동으로:
#   1. WSL 배포판 자동 감지
#   2. WSL 소스를 Windows 네이티브 디스크로 robocopy (idempotent)
#   3. node_modules / .venv 가 최신인지 확인 후 부족할 때만 설치
#   4. PROJK_REPO_ROOT 환경변수 자동 설정
#   5. (옵션) 백그라운드 sync-watcher 동시 실행 → WSL 측 코드 수정이 즉시 Vite HMR로 반영
#   6. npm run dev
#
# 일반 사용:
#   pwsh ./scripts/dev.ps1                 # 처음 사용 + 평소 실행
#   pwsh ./scripts/dev.ps1 -ForceClean     # node_modules / .venv 강제 재생성
#   pwsh ./scripts/dev.ps1 -NoWatch        # 동시 sync-watcher 비활성화 (수동 robocopy)
#   pwsh ./scripts/dev.ps1 -BuildOnly      # dev 대신 build 만 실행

param(
    [string]$WslDistro,
    [string]$WslRepo,
    [string]$WinTarget = (Join-Path $env:USERPROFILE 'projk-desktop'),
    [switch]$ForceClean,
    [switch]$NoSync,
    [switch]$NoInstall,
    [switch]$NoWatch,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "[dev] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "[dev] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[dev] $msg" -ForegroundColor Yellow }

# ---------- 1. WSL 배포판 감지 ----------

if (-not $WslDistro) {
    $defaultLine = wsl -l -v 2>$null | Where-Object { $_ -match '^\s*\*' } | Select-Object -First 1
    if ($defaultLine) {
        $WslDistro = (($defaultLine -replace '^\s*\*\s*', '') -split '\s+')[0]
    }
    if (-not $WslDistro) {
        Write-Host "WSL 배포판을 자동으로 찾지 못했습니다. -WslDistro <name> 으로 지정하세요." -ForegroundColor Red
        Write-Host "확인: wsl -l -v" -ForegroundColor Yellow
        exit 1
    }
    Write-Step "WSL 배포판 자동 감지: $WslDistro"
}

if (-not $WslRepo) {
    $WslRepo = "\\wsl.localhost\$WslDistro\home\jacob\repos\proj-k"
}

$WslSource = Join-Path $WslRepo 'packages\desktop-app'
if (-not (Test-Path $WslSource)) {
    Write-Host "WSL 소스 경로를 찾을 수 없습니다: $WslSource" -ForegroundColor Red
    exit 1
}

Write-Step "WSL 소스: $WslSource"
Write-Step "Windows 작업 디렉터리: $WinTarget"

# ---------- 2. 도구 체크 ----------

function Require-Tool($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host "필수 도구 누락: $name" -ForegroundColor Red
        Write-Host "  $hint" -ForegroundColor Yellow
        exit 1
    }
}
Require-Tool 'node'   'https://nodejs.org → LTS 18+ 설치'
Require-Tool 'npm'    'Node.js와 함께 설치됨'
Require-Tool 'python' 'https://python.org → 3.11+ (Add to PATH 체크)'

# ---------- 3. 초기 sync (robocopy) ----------

if (-not $NoSync) {
    if (-not (Test-Path $WinTarget)) {
        New-Item -ItemType Directory -Path $WinTarget -Force | Out-Null
    }
    Write-Step "WSL → Windows sync (node_modules, .venv, out 제외)"
    # /MIR 안 쓰는 이유: node_modules 등 제외 디렉터리도 Windows 측 변경분(설치 산출물)을 보호하기 위함
    # /XO: source가 더 새로울 때만 복사 → 빠름
    robocopy $WslSource $WinTarget /E /XO /XD node_modules .venv out dist .git release | Out-Null
    if ($LASTEXITCODE -ge 8) {
        # robocopy: 0~7 = success, 8+ = failure
        Write-Host "robocopy 실패 (exit=$LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
    Write-OK "sync 완료"
}

# ---------- 4. install / setup ----------

Push-Location $WinTarget
try {
    $pkgHashFile = Join-Path $WinTarget '.last-pkg-hash'
    $currentHash = (Get-FileHash 'package.json' -Algorithm SHA256).Hash
    $electronExe = Join-Path $WinTarget 'node_modules\electron\dist\electron.exe'

    $needsInstall =
        $ForceClean -or
        -not (Test-Path $electronExe) -or
        (-not (Test-Path $pkgHashFile)) -or
        ((Get-Content $pkgHashFile -ErrorAction SilentlyContinue) -ne $currentHash)

    if ($ForceClean) {
        Write-Step "ForceClean: node_modules / .venv 제거"
        @('node_modules', '.venv', 'package-lock.json', $pkgHashFile) | ForEach-Object {
            if (Test-Path $_) { Remove-Item -Recurse -Force $_ -ErrorAction SilentlyContinue }
        }
    }

    if ((-not $NoInstall) -and $needsInstall) {
        Write-Step "npm install (5~10분 소요 가능)"
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        $currentHash | Out-File -FilePath $pkgHashFile -NoNewline
        Write-OK "npm install 완료"
    } else {
        Write-OK "node_modules 최신 — 건너뜀"
    }

    $venvPython = Join-Path $WinTarget '.venv\Scripts\python.exe'
    if ((-not $NoInstall) -and (-not (Test-Path $venvPython))) {
        Write-Step "Python venv 생성 + sidecar 의존성 설치"
        npm run setup
        if ($LASTEXITCODE -ne 0) { throw "npm run setup failed" }
        Write-OK "venv 셋업 완료"
    } else {
        Write-OK ".venv 존재 — 건너뜀"
    }

    if ($BuildOnly) {
        Write-Step "build 실행 (BuildOnly 모드)"
        npm run build
        return
    }

    # ---------- 5. sync-watcher 백그라운드 실행 ----------
    $watcherJob = $null
    if (-not $NoSync -and -not $NoWatch) {
        Write-Step "백그라운드 sync-watcher 시작 (WSL 변경 → Windows 자동 반영, 2초 간격)"
        $watcherScript = Join-Path $PSScriptRoot 'sync-watch.ps1'
        if (Test-Path $watcherScript) {
            $watcherJob = Start-Job -ScriptBlock {
                param($src, $dst, $script)
                & pwsh -NoLogo -NonInteractive -File $script -WslSource $src -WinTarget $dst -Interval 2
            } -ArgumentList $WslSource, $WinTarget, $watcherScript
            Write-OK "sync-watcher 실행 중 (Job Id: $($watcherJob.Id))"
        } else {
            Write-Warn "sync-watch.ps1 없음 — 수동 robocopy 필요"
        }
    }

    # ---------- 6. dev 시작 ----------
    $env:PROJK_REPO_ROOT = $WslRepo
    Write-Step "PROJK_REPO_ROOT = $env:PROJK_REPO_ROOT"
    Write-Step "Electron dev 시작 (Ctrl+C 로 종료)"
    try {
        npm run dev
    } finally {
        if ($watcherJob) {
            Stop-Job -Job $watcherJob -ErrorAction SilentlyContinue
            Remove-Job -Job $watcherJob -ErrorAction SilentlyContinue
            Write-OK "sync-watcher 종료"
        }
    }
} finally {
    Pop-Location
}
