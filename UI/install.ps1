$ErrorActionPreference='Stop'
$toolsRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$accountCode=Join-Path $toolsRoot 'Multi-Account\code'
$backupRoot=Join-Path $PSScriptRoot 'state\installation'
$manifestPath=Join-Path $backupRoot 'manifest.json'
$desktopPath=[Environment]::GetFolderPath('Desktop')
$shortcutPath=Join-Path $desktopPath 'C2.lnk'
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$version=& $nodePath --version
if ([version]$version.TrimStart('v') -lt [version]'22.16.0') {throw 'Нужен Node.js 22.16 или новее.'}
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$targets=@('launch_chatgpt.vbs','launch_chatgpt2.vbs','launch_chatgpt2.ps1')
if (-not (Test-Path -LiteralPath $manifestPath)) {
  $files=@()
  foreach($name in $targets) {
    $file=Join-Path $accountCode $name
    Copy-Item -LiteralPath $file -Destination (Join-Path $backupRoot $name)
    $files += @{path=$file;backup=(Join-Path $backupRoot $name)}
  }
  Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $backupRoot 'C2.lnk')
  $files += @{path=$shortcutPath;backup=(Join-Path $backupRoot 'C2.lnk')}
  @{schemaVersion=1;files=$files} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}
$previousManifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach($file in $previousManifest.files) {
  if($file.installedHash) {
    $currentHash=(Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash
    $backupHash=(Get-FileHash -LiteralPath $file.backup -Algorithm SHA256).Hash
    if($currentHash -ne $file.installedHash -and $currentHash -ne $backupHash) {throw "Файл изменён после предыдущей установки; подключение остановлено: $($file.path)"}
  }
}
$vbsHook=@'
' Codex UI runtime modules
Set CodexUIFSO = CreateObject("Scripting.FileSystemObject")
CodexUIToolsDir = CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(WScript.ScriptFullName)))
WshShell.Run """wscript.exe"" """ & CodexUIToolsDir & "\UI\code\ensure-ui.vbs""", 0, False
' End Codex UI runtime modules
'@
foreach($name in @('launch_chatgpt.vbs','launch_chatgpt2.vbs')) {
  $file=Join-Path $accountCode $name
  $text=[IO.File]::ReadAllText($file)
  if (-not $text.Contains("' Codex UI runtime modules")) {
    $match=[regex]::Match($text,'(?m)^Set WshShell = CreateObject\("WScript.Shell"\)\r?$')
    if (-not $match.Success) {throw "Не найдена точка подключения в $name"}
    $text=$text.Insert($match.Index+$match.Length,"`r`n"+$vbsHook)
    if ($name -eq 'launch_chatgpt.vbs') {
      $c1Launch = "CodexPowerShell = WshShell.ExpandEnvironmentStrings(""%WINDIR%"") & ""\System32\WindowsPowerShell\v1.0\powershell.exe""`r`nWshShell.Run """""""" & CodexPowerShell & """""" -NoLogo -NoProfile -NonInteractive -File """""" & CodexUIToolsDir & ""\UI\code\c1-runtime.ps1"""" -Launch"", 0, False"
      $text = [regex]::Replace($text, '(?m)^WshShell\.Run "cmd\.exe /c start .*$', $c1Launch)
    }
    [IO.File]::WriteAllText($file,$text,[Text.UTF8Encoding]::new($false))
  }
}
$psFile=Join-Path $accountCode 'launch_chatgpt2.ps1'
$psText=[IO.File]::ReadAllText($psFile)
if (-not $psText.Contains('# Codex UI runtime modules')) {
  $psHook=@'
# Codex UI runtime modules
$uiEntry=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'UI\code\ensure-ui.vbs'
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"'+$uiEntry+'"') -WindowStyle Hidden
# End Codex UI runtime modules
'@
  [IO.File]::WriteAllText($psFile,$psHook+"`r`n"+$psText,[Text.UTF8Encoding]::new($false))
}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'node-path.txt'),$nodePath+"`r`n",[Text.Encoding]::ASCII)
$shell=New-Object -ComObject WScript.Shell
$originalShortcut=$shell.CreateShortcut((Join-Path $backupRoot 'C2.lnk'))
$shortcut=$shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments='"'+(Join-Path $accountCode 'launch_chatgpt2.vbs')+'"'
$shortcut.WorkingDirectory=$originalShortcut.WorkingDirectory
$shortcut.Save()
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach($file in $manifest.files) {
  $hash=(Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash
  $file | Add-Member -NotePropertyName installedHash -NotePropertyValue $hash -Force
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"'+(Join-Path $PSScriptRoot 'ensure-ui.vbs')+'"') -WindowStyle Hidden
for($attempt=0;$attempt -lt 10;$attempt++) {
  Start-Sleep -Milliseconds 250
  $uiStatus=& $nodePath (Join-Path $PSScriptRoot 'manage.mjs') status 2>$null
  if($LASTEXITCODE -eq 0) {break}
}
if($LASTEXITCODE -ne 0) {throw 'Помощник UI не запустился. Проверьте UI/code/ui.log.'}
Write-Output 'Помощник Folders/CSS запущен. C1, потерявший UI-порт после обновления, будет штатно перезапущен после завершения активных ответов.'
