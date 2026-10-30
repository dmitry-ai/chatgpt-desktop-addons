Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
Set ProcEnv = WshShell.Environment("Process")
appData = WshShell.ExpandEnvironmentStrings("%APPDATA%")
localAppData = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
If Len(appData) > 0 And Len(localAppData) > 0 Then
  If LCase(Left(userProfile, Len(appData) + 1)) = LCase(appData & "\") Then
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
