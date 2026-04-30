# Project K Desktop App — WSL 소스 변경 감시 + 자동 robocopy
#
# dev.ps1 이 백그라운드 Job 으로 자동 실행하지만, 단독 실행도 가능:
#   pwsh ./scripts/sync-watch.ps1                                 # 자동 감지
#   pwsh ./scripts/sync-watch.ps1 -Interval 1                     # 1초 간격
#   pwsh ./scripts/sync-watch.ps1 -WslSource <unc> -WinTarget <path>
#
# WSL UNC 경로는 FileSystemWatcher 가 신뢰성 떨어져서 폴링 방식 사용.
# /XO 옵션이라 변경분만 복사 — 보통 한 사이클 50~200ms.

param(
    [string]$WslSource,
    [string]$WinTarget = (Join-Path $env:USERPROFILE 'projk-desktop'),
    [int]$Interval = 2,
    [string]$WslDistro
)

$ErrorActionPreference = 'Continue'

if (-not $WslSource) {
    if (-not $WslDistro) {
        $defaultLine = wsl -l -v 2>$null | Where-Object { $_ -match '^\s*\*' } | Select-Object -First 1
        if ($defaultLine) {
            $WslDistro = (($defaultLine -replace '^\s*\*\s*', '') -split '\s+')[0]
        }
    }
    $WslSource = "\\wsl.localhost\$WslDistro\home\jacob\repos\proj-k\packages\desktop-app"
}

Write-Host "[sync-watch] $WslSource → $WinTarget (every ${Interval}s)" -ForegroundColor Cyan
Write-Host "[sync-watch] Ctrl+C 로 종료" -ForegroundColor DarkGray

$lastSyncMs = 0
while ($true) {
    $start = [DateTime]::UtcNow
    # /XO: source 가 더 새로울 때만, /NDL,/NJH,/NJS,/NP,/NS,/NC: 출력 최소화
    robocopy $WslSource $WinTarget /E /XO /NDL /NJH /NJS /NP /NS /NC `
        /XD node_modules .venv out dist .git release | Out-Null
    $code = $LASTEXITCODE
    $elapsed = ([DateTime]::UtcNow - $start).TotalMilliseconds
    if ($code -ge 8) {
        Write-Host "[sync-watch] robocopy 실패 exit=$code — 다시 시도" -ForegroundColor Red
    } elseif ($code -gt 0) {
        # 1~7 은 변경분 있음 — 정상
        Write-Host "[sync-watch] sync (${elapsed:N0}ms, $code 변경)" -ForegroundColor DarkGreen
    }
    Start-Sleep -Seconds $Interval
}
