@echo off
setlocal
set "GOVEE_BRIDGE_DIR=%~dp0"

echo This adds a shortcut to the current Windows user's Startup folder.
echo The BLE bridge will start automatically when you sign in to Windows.
echo.
set /p CONFIRM=Continue? (Y/N): 
if /I not "%CONFIRM%"=="Y" exit /b 0

powershell -NoProfile -ExecutionPolicy Bypass -Command "$target = Join-Path $env:GOVEE_BRIDGE_DIR 'start_govee_ble_bridge.bat'; $startup = [Environment]::GetFolderPath('Startup'); $shortcutPath = Join-Path $startup 'Govee BLE Bridge.lnk'; $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut($shortcutPath); $shortcut.TargetPath = $target; $shortcut.WorkingDirectory = $env:GOVEE_BRIDGE_DIR; $shortcut.WindowStyle = 7; $shortcut.Description = 'Start the Govee SignalRGB BLE bridge'; $shortcut.Save(); Write-Host ('Created ' + $shortcutPath)"
if errorlevel 1 (
    echo Failed to create the Startup shortcut.
    pause
    exit /b 1
)
echo.
echo Done. The bridge will start the next time you sign in to Windows.
pause
