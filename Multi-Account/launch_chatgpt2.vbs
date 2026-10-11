Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run """" & scriptDir & "\ChatGPT2Launcher.exe""", 0, False

