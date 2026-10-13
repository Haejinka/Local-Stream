@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cep.ps1" -ToolsOnly
if errorlevel 1 (
  echo Local Stream tool setup failed.
  pause
  exit /b 1
)
echo.
pause
