Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
codeDir = FSO.GetParentFolderName(WScript.ScriptFullName)
nodePath = "node.exe"
If FSO.FileExists(codeDir & "\node-path.txt") Then
  Set nodeFile = FSO.OpenTextFile(codeDir & "\node-path.txt", 1)
  nodePath = Trim(nodeFile.ReadLine)
  nodeFile.Close
End If
WshShell.Run """" & nodePath & """ """ & codeDir & "\daemon.mjs""", 0, False
