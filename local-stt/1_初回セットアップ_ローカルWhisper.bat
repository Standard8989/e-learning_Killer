@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_whisper.ps1"
if errorlevel 1 (
  echo.
  pause
)
