@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-setup.ps1"
if errorlevel 1 (
  echo Local Stream setup wizard build failed.
  pause
  exit /b 1
)
echo.
pause
