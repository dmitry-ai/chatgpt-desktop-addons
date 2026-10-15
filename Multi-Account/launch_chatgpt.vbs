Set WshShell = CreateObject("WScript.Shell")
' Codex UI runtime modules
Set CodexUIFSO = CreateObject("Scripting.FileSystemObject")
CodexUIToolsDir = CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(CodexUIFSO.GetParentFolderName(WScript.ScriptFullName)))
WshShell.Run """wscript.exe"" """ & CodexUIToolsDir & "\UI\code\ensure-ui.vbs""", 0, False
' End Codex UI runtime modules
WshShell.Run "cmd.exe /c start """" ""shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App"" --remote-debugging-port=9223", 0, False
