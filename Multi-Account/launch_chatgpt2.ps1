# Codex UI runtime modules
$uiEntry=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'UI\code\ensure-ui.vbs'
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"'+$uiEntry+'"') -WindowStyle Hidden
# End Codex UI runtime modules
$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'ChatGPT2Launcher.exe'
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "C2 launcher is missing: $launcherPath. Build it with build.ps1."
}
# All entry points use the same package discovery, profile, mutex and supervisor.
Start-Process -FilePath $launcherPath -WindowStyle Hidden
