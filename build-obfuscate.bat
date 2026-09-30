@echo off
setlocal
title Build obfuscated userscript
cd /d "%~dp0"

where node >nul 2>nul || (echo [x] Node.js required: https://nodejs.org & pause & exit /b 1)
if not exist "ncepu-keygate.user.js" (echo [x] ncepu-keygate.user.js not found in this folder & pause & exit /b 1)

if not exist "node_modules\javascript-obfuscator" (
    echo [*] First run: installing obfuscator, one time only...
    call npm install --no-save javascript-obfuscator
    if errorlevel 1 (echo [x] install failed, check network & pause & exit /b 1)
)

node build-obfuscate.js
if errorlevel 1 (pause & exit /b 1)

echo.
echo Done: ncepu-keygate.obf.user.js  (install it in Tampermonkey)
echo Note: obfuscation is NOT real encryption; it keeps casual readers out.
pause