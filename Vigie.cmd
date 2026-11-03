@echo off
rem Lance Vigie en arriere-plan si besoin, puis ouvre le tableau de bord.
cd /d "%~dp0"
curl -s -f -m 2 http://localhost:4747/status.json >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process node -ArgumentList 'server.mjs' -WindowStyle Hidden"
  timeout /t 2 /nobreak >nul
)
start "" http://localhost:4747
