@echo off
rem pi-scope.cmd — start the Pi Scope app on Windows.
rem
rem   pi-scope              desktop app (Electron window, default)
rem   pi-scope --web        headless server + open the WebUI in your browser
rem   pi-scope --server     headless server only, stays in the foreground
rem
rem A tiny shim: it finds Node and hands off to pi-scope.mjs, where the actual
rem start-up logic lives (shared with the Linux/macOS pi-scope script). Works
rem from cmd.exe and PowerShell, and by double-click. Forwards every argument.
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo pi-scope: node not found on PATH - install Node.js 24+ ^(https://nodejs.org^) and open a new terminal
  exit /b 1
)

node "%~dp0pi-scope.mjs" %*
set EXITCODE=%ERRORLEVEL%
endlocal & exit /b %EXITCODE%
