@echo off
setlocal
cd /d "%~dp0"
title Plural Starbot

REM Starts Plural Starbot (Node.js): installs dependencies once, builds when needed, runs it.

REM --- Find Node.js and npm ---
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo Node.js was not found on this computer.
    echo Install it from https://nodejs.org/ ^(version 20 or newer; the installer
    echo adds it to PATH^), then run this file again.
    echo.
    pause
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo npm was not found on this computer. It comes with Node.js:
    echo reinstall Node.js from https://nodejs.org/ and run this file again.
    echo.
    pause
    exit /b 1
)

REM --- Install dependencies the first time ---
if not exist "node_modules\" (
    echo Installing dependencies ^(only takes a moment the first time^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo Something went wrong installing dependencies. See the message above.
        pause
        exit /b 1
    )
)

REM --- Build when dist is missing or older than src ---
node -e "const fs=require('fs'),path=require('path');const out='dist/index.js';if(!fs.existsSync(out))process.exit(1);const built=fs.statSync(out).mtimeMs;const newer=d=>fs.readdirSync(d,{withFileTypes:true}).some(e=>{const f=path.join(d,e.name);return e.isDirectory()?newer(f):fs.statSync(f).mtimeMs>built;});process.exit(newer('src')?1:0);"
if errorlevel 1 (
    echo Building the bot ^(only needed after an update^)...
    call npm run build
    if errorlevel 1 (
        echo.
        echo Something went wrong building the bot. See the message above.
        pause
        exit /b 1
    )
)

echo.
echo ================================================================
echo  Starting the bot. Keep this window OPEN to keep the bot online.
echo  Press Ctrl+C to stop it.
echo ================================================================
echo.
call npm start

echo.
echo The bot has stopped.
pause
