Set WshShell = CreateObject("WScript.Shell")
' Codex UI runtime modules
Set CodexUIFSO = CreateObject("Scripting.FileSystemObject")
CodexUIToolsDir = CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(WScript.ScriptFullName)))
WshShell.Run """wscript.exe"" """ & CodexUIToolsDir & "\UI\code\ensure-ui.vbs""", 0, False
' End Codex UI runtime modules
CodexPowerShell = WshShell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
WshShell.Run """" & CodexPowerShell & """ -NoLogo -NoProfile -NonInteractive -File """ & CodexUIToolsDir & "\UI\code\c1-runtime.ps1"" -Launch", 0, False
