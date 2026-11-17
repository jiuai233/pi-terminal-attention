@echo off
setlocal

where pi >nul 2>nul
if errorlevel 1 (
  echo [pi-terminal-attention] pi command not found in PATH. 1>&2
  exit /b 1
)

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "SETTINGS_FILE=%USERPROFILE%\.pi\agent\settings.json"
set "INSTALLED=0"

if exist "%SETTINGS_FILE%" (
  findstr /C:"pi-terminal-attention" "%SETTINGS_FILE%" >nul 2>nul && set "INSTALLED=1"
)

if "%INSTALLED%"=="1" (
  pi %*
) else (
  pi -e "%SCRIPT_DIR%\src\index.ts" %*
)

endlocal & exit /b %errorlevel%
