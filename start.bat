@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo [dsh-desktop] First run: installing dependencies, this can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo [dsh-desktop] npm install failed. Please make sure Node.js is installed and you are online.
    pause
    exit /b 1
  )
)

call npm start
endlocal
