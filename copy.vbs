Set WshShell = WScript.CreateObject("WScript.Shell")
' 等待 50 毫秒，确保按键没冲突
WScript.Sleep 50
' 发送 Ctrl + C
WshShell.SendKeys "^c"