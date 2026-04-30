# Project K — Windows 호스트에서 데스크톱 앱 dev 실행
#
# 전제: 소스는 WSL2의 ~/repos/proj-k 에 있고, 사용자는 Windows 측에서 GUI를 띄우고 싶다.
# 이 스크립트는 PowerShell에서 직접 실행할 수 있게 첫 셋업 + dev 시작을 한 번에 해 준다.
#
# 사용법 (Windows PowerShell):
#   cd \\wsl.localhost\Ubuntu\home\jacob\repos\proj-k\packages\desktop-app
#   pwsh ./scripts/dev-windows.ps1
#   # 또는: powershell -ExecutionPolicy Bypass -File .\scripts\dev-windows.ps1
#
# 옵션:
#   -SkipNpmInstall   : node_modules가 이미 Windows 바이너리로 설치되어 있을 때
#   -SkipVenvSetup    : Python venv를 이미 만들었을 때
#   -RepoRoot <path>  : 자동 감지가 실패하면 명시적으로 레포 루트 지정

param(
    [switch]$SkipNpmInstall,
    [switch]$SkipVenvSetup,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "[dev-windows] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[dev-windows] $msg" -ForegroundColor Yellow }

# Resolve script and package locations.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgDir = Split-Path -Parent $scriptDir
$repoRoot = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { (Resolve-Path (Join-Path $pkgDir '..\..')).Path }

Write-Step "package dir: $pkgDir"
Write-Step "repo root  : $repoRoot"

# Sanity-check that the data mirrors are reachable. They live in the same repo,
# so they should be next to packages/desktop-app — but warn if missing.
$xlsxOut    = Join-Path $repoRoot 'packages\xlsx-extractor\output'
$confluenceOut = Join-Path $repoRoot 'packages\confluence-downloader\output'
foreach ($p in @($xlsxOut, $confluenceOut)) {
    if (-not (Test-Path $p)) {
        Write-Warn "데이터 미러 없음: $p (트리는 비어 보일 수 있음)"
    }
}

# Toolchain checks.
function Require-Tool($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host "필수 도구 누락: $name" -ForegroundColor Red
        Write-Host "  $hint" -ForegroundColor Yellow
        exit 1
    }
    Write-Step "$name OK ($($cmd.Source))"
}

Require-Tool 'node' 'https://nodejs.org/en/download/ 에서 Node.js LTS 18+ 설치'
Require-Tool 'npm'  'Node.js와 함께 설치됨'
Require-Tool 'python' 'https://python.org 에서 Python 3.11+ 설치 (PATH 등록 체크)'

Push-Location $pkgDir
try {
    if (-not $SkipVenvSetup) {
        Write-Step 'Python venv 생성/업데이트 (npm run setup)'
        npm run setup
        if ($LASTEXITCODE -ne 0) { throw 'setup failed' }
    } else {
        Write-Step 'venv setup skipped'
    }

    if (-not $SkipNpmInstall) {
        # Check if node_modules\electron is present and looks Windows-shaped.
        # (Linux-built node_modules will fail when launched under Windows Electron.)
        $electronExe = Join-Path $pkgDir 'node_modules\electron\dist\electron.exe'
        if (-not (Test-Path $electronExe)) {
            Write-Step 'npm install (Windows 바이너리 설치)'
            npm install
            if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
        } else {
            Write-Step 'node_modules 이미 Windows 바이너리로 설치됨 — 건너뜀'
        }
    } else {
        Write-Step 'npm install skipped'
    }

    # Pass repo root explicitly so paths.ts doesn't depend on auto-detection
    # working under Windows ↔ \\wsl.localhost\ junctions.
    $env:PROJK_REPO_ROOT = $repoRoot

    Write-Step 'Electron dev 시작 (Ctrl+C 로 종료)'
    npm run dev
} finally {
    Pop-Location
}
