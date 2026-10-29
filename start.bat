@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Nie znaleziono Node.js. Zainstaluj go ze strony https://nodejs.org
  pause
  exit /b 1
)
node server.js %*
echo.
echo Serwer zatrzymany.
pause
