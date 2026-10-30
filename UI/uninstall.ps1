$ErrorActionPreference='Stop'
$manifestPath=Join-Path $PSScriptRoot 'state\installation\manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {throw 'Резервная копия установки не найдена.'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach($file in $manifest.files) {
  if ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash -ne $file.installedHash) {throw "Файл менялся после установки; автоматическое восстановление остановлено: $($file.path)"}
}
$nodePath=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'node-path.txt')).Trim()
& $nodePath (Join-Path $PSScriptRoot 'manage.mjs') stop
foreach($file in $manifest.files) {Copy-Item -LiteralPath $file.backup -Destination $file.path -Force}
Write-Output 'Подключение UI отключено. Общий каталог Shared-Projects, штатные проекты и прежние ui-folders.json сохранены.'
