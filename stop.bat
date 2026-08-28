@echo off
cd /d "%~dp0"
if not exist server.pid (
  echo No server.pid found. Server may not be running.
  pause
  exit /b 1
)
set /p PID=<server.pid
echo Stopping Codex Chat (PID %PID%) ...
taskkill /PID %PID% /T /F
pause
