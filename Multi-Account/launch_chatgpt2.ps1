$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "launch_chatgpt2.log"

function Log-Msg($msg) {
    $time = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    Add-Content -Path $logPath -Value "[$time] $msg" -ErrorAction SilentlyContinue
}

Log-Msg "=== Launch script started ==="

try {
    # 1. Compile helpers
    Add-Type -Path (Join-Path $scriptDir "AppExecLink.cs") -ErrorAction SilentlyContinue
    Add-Type -Path (Join-Path $scriptDir "TaskbarManager.cs") -ErrorAction SilentlyContinue
    Log-Msg "Helpers loaded."

    # 2. Package path
    $pkgKey = Get-ChildItem "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages" |
        Where-Object { $_.PSChildName -match '^OpenAI\.Codex_' } |
        Select-Object -First 1

    if (-not $pkgKey) {
        Log-Msg "ERROR: Could not find OpenAI.Codex package in registry."
        exit 1
    }

    $pkgProps = Get-ItemProperty $pkgKey.PSPath
    $packageRoot = $pkgProps.PackageRootFolder
    $targetExe = Join-Path $packageRoot "app\ChatGPT.exe"
    Log-Msg "Found targetExe: $targetExe"

    # 3. Ensure AppExecutionAlias
    $aliasExe = "C:\Users\dfedi\AppData\Local\Microsoft\WindowsApps\ChatGPT2.exe"
    if (-not (Test-Path $aliasExe)) {
        Log-Msg "Creating alias: $aliasExe"
        $ok = [AppExecLink]::Create($aliasExe, "OpenAI.Codex_2p2nqsd0c76g0", "OpenAI.Codex_2p2nqsd0c76g0!App", $targetExe)
        Log-Msg "Alias creation result: $ok"
    } else {
        Log-Msg "Alias already exists."
    }

    # 4. Profile directory
    $profileDir = "C:\Users\dfedi\AppData\Roaming\Codex-Profile2"
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        Log-Msg "Created profileDir: $profileDir"
    }

    # 5. Environment
    $env:CODEX_HOME = $profileDir
    $env:CODEX_ELECTRON_USER_DATA_PATH = $profileDir
    Log-Msg "Set env vars to: $profileDir"

    # 6. Launch process
    Log-Msg "Starting process: $aliasExe --remote-debugging-port=9224"
    $proc = Start-Process $aliasExe -ArgumentList "--remote-debugging-port=9224" -PassThru
    Log-Msg "Process started with PID: $($proc.Id)"

    # 7. Apply Taskbar icon & AppUserModelID
    $icoPath = Join-Path $scriptDir "ChatGPT2.ico"
    $appId = "OpenAI.Codex.Profile2"

    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 500
        $hwnds = [TaskbarManager]::FindWindowsForPid($proc.Id)
        if ($hwnds -and $hwnds.Count -gt 0) {
            Log-Msg "Found $($hwnds.Count) window(s) for PID $($proc.Id)"
            foreach ($h in $hwnds) {
                [TaskbarManager]::ApplyTaskbarProperties($h, $appId, $icoPath) | Out-Null
            }
            break
        }
    }
    Log-Msg "=== Launch script finished ==="
} catch {
    Log-Msg "FATAL ERROR: $_"
}
