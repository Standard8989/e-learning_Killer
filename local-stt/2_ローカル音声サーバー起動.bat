@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_whisper_server.ps1"
if errorlevel 1 (
  echo.
  pause
)
