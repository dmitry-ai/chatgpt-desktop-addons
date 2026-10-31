' 2026-10-11 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Relocate Multi-Account launcher scripts to persistent tool directory and remove hardcoded paths":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/3
Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
Set CodexUIFSO = CreateObject("Scripting.FileSystemObject")
CodexUIToolsDir = CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(WScript.ScriptFullName))
' 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
WshShell.Run """wscript.exe"" """ & CodexUIToolsDir & "\UI\ensure-ui.vbs""", 0, False
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run """" & scriptDir & "\ChatGPT2Launcher.exe""", 0, False
