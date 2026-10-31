' 2026-10-10 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Configure monochrome ChatGPT icon, fix Chrome native messaging, clean up OS integration, and enable CDP on port 9223":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/1
Set WshShell = CreateObject("WScript.Shell")
Set CodexUIFSO = CreateObject("Scripting.FileSystemObject")
CodexUIToolsDir = CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(WScript.ScriptFullName))
' 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
WshShell.Run """wscript.exe"" """ & CodexUIToolsDir & "\UI\ensure-ui.vbs""", 0, False
' 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Register staged MSIX updates in c1-runtime.ps1 and activate C1 on WinSta0\Default via IApplicationActivationManager":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/10
CodexPowerShell = WshShell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
WshShell.Run """" & CodexPowerShell & """ -NoLogo -NoProfile -NonInteractive -File """ & CodexUIToolsDir & "\UI\c1-runtime.ps1"" -Launch", 0, False
