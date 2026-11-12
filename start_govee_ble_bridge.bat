@echo off
setlocal
cd /d "%~dp0"

echo =============================================
echo       Govee SignalRGB BLE Bridge
echo =============================================
echo.

where py >nul 2>&1
if errorlevel 1 (
    echo Python Launcher "py" was not found.
    echo Install Python 3 and enable the Python Launcher, then try again.
    pause
    exit /b 1
)

py -3 -c "import bleak, cryptography" >nul 2>&1
if errorlevel 1 (
    echo Installing required Python packages: bleak and cryptography...
    py -3 -m pip install --user -r requirements.txt
    if errorlevel 1 (
        echo Package installation failed.
        pause
        exit /b 1
    )
)

echo Starting BLE sessions and local UDP listener...
echo Keep this window open while SignalRGB controls the lights.
echo.
py -3 govee_signalrgb_bridge.py

if errorlevel 1 (
    echo.
    echo The BLE bridge exited with an error.
    pause
)
