$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'ChatGPT2Launcher.exe'
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "C2 launcher is missing: $launcherPath. Build it with build.ps1."
}
# All entry points use the same package discovery, profile, mutex and supervisor.
Start-Process -FilePath $launcherPath -WindowStyle Hidden
