@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Install Node.js 24.15 or newer from https://nodejs.org
  pause
  exit /b 1
)
REM Share config with npm run dashboard; open only after successful listen.
node src\server\server.ts --open %*
if errorlevel 1 (
  pause
  exit /b 1
)
