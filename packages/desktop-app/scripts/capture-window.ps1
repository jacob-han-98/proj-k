# Klaud BrowserWindow capture helper.
#
# Win32 PrintWindow(PW_RENDERFULLCONTENT) 로 hidden / occluded window 도 진짜 frame 캡처.
# Electron 의 webContents.capturePage() 는 background spawn 한 BrowserWindow 의 OS-level
# DWM occlusion 때문에 빈 frame 만 받음 — Win32 native API 만이 우회 가능.
#
# 사용:
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 -Hwnd <hwnd> -Out <path>
#
# 결과: $Out 경로에 PNG 저장. exit 0 성공, 다른 코드면 실패.

param(
    [Parameter(Mandatory=$true)] [Int64] $Hwnd,
    [Parameter(Mandatory=$true)] [string] $Out
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class KlaudCap {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);
    [DllImport("user32.dll")]
    public static extern bool UpdateWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint nFlags);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }
}
"@

$h = [IntPtr] $Hwnd

# OS DWM occlusion 깨기 — invisible/minimized 에서 paint 시작.
# SW_RESTORE = 9
[KlaudCap]::ShowWindow($h, 9) | Out-Null
[KlaudCap]::BringWindowToTop($h) | Out-Null
[KlaudCap]::SetForegroundWindow($h) | Out-Null
# RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN = 0x0001 | 0x0100 | 0x0080 = 0x0181
[KlaudCap]::RedrawWindow($h, [IntPtr]::Zero, [IntPtr]::Zero, 0x0181) | Out-Null
[KlaudCap]::UpdateWindow($h) | Out-Null
Start-Sleep -Milliseconds 300

$rect = New-Object KlaudCap+RECT
$rectOk = [KlaudCap]::GetWindowRect($h, [ref] $rect)
if (-not $rectOk) { Write-Error "GetWindowRect failed for hwnd=$Hwnd"; exit 2 }
$w = $rect.right - $rect.left
$h2 = $rect.bottom - $rect.top
if ($w -le 0 -or $h2 -le 0) { Write-Error "invalid window size ${w}x${h2}"; exit 3 }

$bmp = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 0x00000002 — Windows 8.1+ 에서 hidden/composited window 도 정상 capture.
$pwOk = [KlaudCap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $pwOk) {
    $bmp.Dispose()
    Write-Error "PrintWindow returned false"
    exit 4
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "${w}x${h2} bytes=$((Get-Item -LiteralPath $Out).Length)"
exit 0
