# Govee BLE Bridge for SignalRGB

This repository contains a custom SignalRGB network Addon and its companion Python BLE bridge.

## Install the SignalRGB Addon

1. Create a **public** GitHub repository.
2. Upload every file in this repository to the GitHub repository's root (not into a nested folder).
3. In SignalRGB, open **Devices → Addons → Add**.
4. Paste the public GitHub repository URL and approve installation.
5. Fully quit SignalRGB using its system-tray menu, then reopen it.

The three virtual Govee controllers should appear in the Addon/device discovery UI. Use each controller's **Link** control to add it.

## Run the Python BLE bridge

1. Download/extract this repository's files to a normal folder on the PC.
2. Run `start_govee_ble_bridge.bat`. It installs `bleak` and `cryptography` if needed, then starts the bridge.
3. Leave its terminal window open while SignalRGB controls the lights.

SignalRGB sends RGB frames to the local bridge over UDP at `127.0.0.1:45871`.

## Optional Windows startup

Run `install_bridge_autostart.bat` to add the launcher to the current Windows user's Startup folder. Run `remove_bridge_autostart.bat` to remove the shortcut. This starts Python at Windows sign-in; it does not make SignalRGB spawn Python directly.

## Important

- Keep all three Govee devices powered on before starting the bridge.
- Stop the older `govee_persistent_ble.py` process before starting this bridge. Do not run both simultaneously because they would compete for the same BLE connections.
- This is an initial test addon. SignalRGB loading and real-device RGB streaming still need to be verified on the target PC.
