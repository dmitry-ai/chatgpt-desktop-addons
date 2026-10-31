# 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
# "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
# https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $PSScriptRoot 'state\installation\manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
	throw 'Installation backup manifest not found.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
	if ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash -ne $file.installedHash) {
		throw "File was modified after installation; automatic restore stopped: $($file.path)"
	}
}
$nodePath = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'node-path.txt')).Trim()
& $nodePath (Join-Path $PSScriptRoot 'manage.mjs') stop
foreach ($file in $manifest.files) {
	Copy-Item -LiteralPath $file.backup -Destination $file.path -Force
}
Write-Output 'UI integration disabled. Shared-Projects catalog, native projects, and existing ui-folders.json files were preserved.'
