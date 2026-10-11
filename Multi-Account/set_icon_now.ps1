$targetPid = 36256
$scriptDir = $PSScriptRoot
$logPath = Join-Path $scriptDir "set_icon.log"

function Log-Msg($msg) {
    $time = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    Add-Content -Path $logPath -Value "[$time] $msg" -ErrorAction SilentlyContinue
}

Log-Msg "=== set_icon_now started for PID $targetPid ==="

Add-Type -Path (Join-Path $scriptDir "TaskbarManager.cs") -ErrorAction SilentlyContinue

$hwnds = [TaskbarManager]::FindWindowsForPid($targetPid)
Log-Msg "Found $($hwnds.Count) window(s)"

$icoPath = Join-Path $scriptDir "ChatGPT2.ico"
$appId = "OpenAI.Codex.Profile2"

foreach ($h in $hwnds) {
    $sb = New-Object System.Text.StringBuilder 256
    [TaskbarManager]::GetClassName($h, $sb, 256) | Out-Null
    $cls = $sb.ToString()
    Log-Msg "Applying to HWND: $h (Class: $cls)"
    $res = [TaskbarManager]::ApplyTaskbarProperties($h, $appId, $icoPath)
    Log-Msg "Result: $res"
}

Log-Msg "=== set_icon_now finished ==="
