' 2026-10-16 Dmitrii Fediuk https://github.com/dmitrii-fediuk
' "Fix C2 window lifecycle supervision, cold-start VBS visibility, and disable duplicate Sparkle auto-updater in C2":
' https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/8
Option Explicit
Dim shell, command, i
Set shell = CreateObject("WScript.Shell")
command = ""
For i = 0 To WScript.Arguments.Count - 1
	If 0 < i Then command = command & " "
	command = command & """" & WScript.Arguments(i) & """"
Next
WScript.Quit shell.Run(command, 0, True)
