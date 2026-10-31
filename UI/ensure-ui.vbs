' 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
Set ProcEnv = WshShell.Environment("Process")
appData = WshShell.ExpandEnvironmentStrings("%APPDATA%")
localAppData = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
' 2026-10-30 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Support unprivileged staged MSIX discovery (GetStagedPackagePathByFullName), Win32/NT process scanning without WMI, and Rolldown bundle chain":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/14
If 0 < Len(appData) And 0 < Len(localAppData) Then
	If LCase(appData & "\") = LCase(Left(userProfile, Len(appData) + 1)) Then
		realHome = FSO.GetParentFolderName(FSO.GetParentFolderName(localAppData))
		If FSO.FolderExists(realHome) Then
			ProcEnv("USERPROFILE") = realHome
			ProcEnv("HOME") = realHome
		End If
	End If
End If
codeDir = FSO.GetParentFolderName(WScript.ScriptFullName)
nodePath = "node.exe"
If FSO.FileExists(codeDir & "\node-path.txt") Then
	Set nodeFile = FSO.OpenTextFile(codeDir & "\node-path.txt", 1)
	nodePath = Trim(nodeFile.ReadLine)
	nodeFile.Close
End If
WshShell.Run """" & nodePath & """ """ & codeDir & "\daemon.mjs""", 0, False
