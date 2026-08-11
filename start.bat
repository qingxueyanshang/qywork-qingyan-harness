@echo off
rem qywork one-click launcher. Double-click to run, or pass a mode:
rem   start.bat          desktop (Tauri native window)  -- default
rem   start.bat web      browser / phone
rem
rem Keep this file ASCII-only: cmd.exe parses it in the OEM codepage (936 here),
rem and UTF-8 comments get mangled into broken commands. The Chinese output
rem lives in scripts\start.ps1, which PowerShell reads as UTF-8 (BOM).
rem
rem -ExecutionPolicy Bypass: the default policy blocks unsigned .ps1 files, and
rem this one ships inside the repo -- no reason to make anyone change a global
rem policy just to start the app.
setlocal
set "MODE=%~1"
if "%MODE%"=="" set "MODE=desktop"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Mode %MODE%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo Failed to start. Exit code %CODE%
  pause
)
exit /b %CODE%
