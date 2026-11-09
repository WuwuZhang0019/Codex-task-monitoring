@echo off
cd /d "%~dp0"
if not exist "src-tauri\target\debug\prototypestop-panel.exe" (
  echo Please build the demo first. See README.md.
  pause
  exit /b 1
)
start "" "src-tauri\target\debug\prototypestop-panel.exe"
