@echo off
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP%\Govee BLE Bridge.lnk"
if exist "%SHORTCUT%" (
    del "%SHORTCUT%"
    echo Removed Govee BLE Bridge from Windows Startup.
) else (
    echo No Govee BLE Bridge Startup shortcut was found.
)
pause
