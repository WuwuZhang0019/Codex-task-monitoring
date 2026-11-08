@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.16 or newer is required. Install Node.js and try again.
  pause
  exit /b 1
)
if not exist "app\dist\index.html" (
  echo Frontend build not found. In app, run: npm ci ^&^& npm run build
  pause
  exit /b 1
)
node "app\server\launch.mjs"
if errorlevel 1 pause
