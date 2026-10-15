Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
' Codex UI runtime modules
Set CodexUIFSO = CreateObject("Scripting.FileSystemObject")
CodexUIToolsDir = CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(WScript.ScriptFullName)))
WshShell.Run """wscript.exe"" """ & CodexUIToolsDir & "\UI\code\ensure-ui.vbs""", 0, False
' End Codex UI runtime modules
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run """" & scriptDir & "\ChatGPT2Launcher.exe""", 0, False

