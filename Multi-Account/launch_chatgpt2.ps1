# 2026-10-11 Dmitrii Fediuk https://github.com/dmitrii-fediuk
# "Relocate Multi-Account launcher scripts to persistent tool directory and remove hardcoded paths":
# https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/3
$uiEntry = Join-Path (Split-Path $PSScriptRoot -Parent) 'UI\ensure-ui.vbs'
# 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
# "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
# https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $uiEntry + '"') -WindowStyle Hidden
$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'ChatGPT2Launcher.exe'
if (-not (Test-Path -LiteralPath $launcherPath)) {
	throw "C2 launcher is missing: $launcherPath. Build it with build.ps1."
}
Start-Process -FilePath $launcherPath -WindowStyle Hidden
