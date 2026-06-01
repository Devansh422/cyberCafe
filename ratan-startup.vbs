Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -WindowStyle Hidden -NonInteractive -Command ""pm2 resurrect""", 0, False
