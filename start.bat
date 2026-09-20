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
rem Hand console ownership to PowerShell; an active batch would prompt on Ctrl-C.
start "QyWork" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Mode "%MODE%"
exit /b %ERRORLEVEL%
