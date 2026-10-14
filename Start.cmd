@echo off
rem Start.cmd — double-click friendly Windows entry point for Pi Scope.
rem
rem Runs Start.ps1 with the execution policy bypassed for this launch only, and
rem forwards every argument (`Start.cmd -Web`, `Start.cmd -Server -Port 8080`).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1" %*
set EXITCODE=%ERRORLEVEL%
endlocal & exit /b %EXITCODE%
