@echo off
rem =====================================================================
rem  DSH Voice Suite - instalador para Windows (wrapper de install.ps1)
rem  Uso:
rem    install.bat                 instala os dois plugins no profile voice-dev
rem    install.bat -Check          so verifica
rem    install.bat -Remove         remove os plugins do profile
rem    install.bat -Profile outro  escolhe outro profile
rem  Mensagens em ASCII; o trabalho real e feito por install.ps1.
rem =====================================================================
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install.ps1"
if not exist "%PS1%" (
  echo [x] install.ps1 nao encontrado em "%SCRIPT_DIR%"
  exit /b 1
)
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
  exit /b %errorlevel%
)
where powershell.exe >nul 2>nul
if %errorlevel%==0 (
  echo [!] PowerShell 7 ^(pwsh^) nao encontrado; tentando powershell.exe 5.1...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
  exit /b %errorlevel%
)
echo [x] PowerShell nao encontrado no PATH. Instale PowerShell 7 ^(pwsh^).
exit /b 1
