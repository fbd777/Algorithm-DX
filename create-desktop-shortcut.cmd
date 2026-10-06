@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-desktop-shortcut.ps1"
if errorlevel 1 (
  echo Failed to create the shortcut. See the message above.
  pause
  exit /b 1
)
echo You can now launch Algorithm DX from your desktop.
pause
