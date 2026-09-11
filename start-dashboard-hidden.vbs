Option Explicit

Dim shell, fso, projectDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Start the local dashboard without opening a console window.
shell.CurrentDirectory = projectDir
shell.Run "cmd.exe /d /c python server.py --no-open --port 8765", 0, False
