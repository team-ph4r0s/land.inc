@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules" (
  rem npm ci installs exactly what package-lock.json pins, without changing it.
  call npm ci
  if errorlevel 1 (pause & exit /b 1)
)
start "" http://127.0.0.1:5173
call npm run dev
pause
