Option Explicit
Dim shell, command, i
Set shell = CreateObject("WScript.Shell")
command = ""
For i = 0 To WScript.Arguments.Count - 1
    If i > 0 Then command = command & " "
    command = command & """" & WScript.Arguments(i) & """"
Next
WScript.Quit shell.Run(command, 0, True)
