# Govee BLE Bridge for SignalRGB

SignalRGB add-on plus a local Python companion process for these three BLE devices:

| SignalRGB controller | Govee model | SignalRGB channel / physical segments |
|---|---|---:|
| Office Ceiling Light | H60A1 | 14 |
| Bedside Ceiling Light | H60A1 | 14 |
| Under-desk RGBIC Strip | H617A | 8 |

The companion process owns the BLE connections. SignalRGB sends flattened RGB frames to `127.0.0.1:45871` over UDP; Python validates the frames, groups segments with identical colors, and writes the Govee BLE commands.

## Files

- `GoveeBLEBridge.js` — SignalRGB network add-on, virtual controller discovery, component channel, and UDP output.
- `GoveeBLEBridge.qml` — controller link/unlink UI.
- `govee_signalrgb_bridge.py` — UDP receiver and live BLE RGB streaming.
- `govee_persistent_ble.py` — BLE connection, H60A1 session negotiation, H617A keepalive, and protocol framing.
- `start_govee_ble_bridge.bat` — installs Python dependencies if missing and starts the companion process.
- `install_bridge_autostart.bat` / `remove_bridge_autostart.bat` — optional Windows sign-in shortcut management.

## Install the SignalRGB add-on

1. Put the contents of this folder at the **root** of a public GitHub repository. Do not put the files one extra folder deep.
2. In SignalRGB, open **Devices → Addons → Add** and enter the public repository URL.
3. Accept the installation prompt and fully restart SignalRGB from its system-tray menu.
4. Open the add-on under **Third Party Services** (the label can vary by SignalRGB version) and link the three virtual controllers.

The add-on uses the same `DiscoveryService` / virtual-controller pattern as SignalRGB's built-in Govee network add-on. The three controllers are created locally; they do not require Govee Wi-Fi/LAN discovery.

## Configure the component layout

Each controller exposes one component channel named **Channel 1**. Keep the user-configured channel count equal to the number of physical Govee segments:

- Each H60A1: 14 LEDs (13 rear/ring segments plus the front panel).
- H617A: 8 LEDs.

The add-on validates the RGB array against `channel.LedCount()` first, then separately checks that the configured count matches the physical device's segment count. It will not truncate, pad, or silently mis-map a mismatched layout. A mismatch is reported in the SignalRGB device log.

## Run the BLE companion

1. Extract this folder to a normal local folder on the PC.
2. Stop any previous `govee_persistent_ble.py` process. Only one process should own these BLE devices.
3. Make sure the three lights are powered on and Bluetooth is available on the PC.
4. Double-click `start_govee_ble_bridge.bat` and leave its terminal open.
5. Start SignalRGB streaming for the linked controllers.

The bridge listens only on `127.0.0.1:45871`. It does not expose a LAN listener. It does not send power-on or power-off commands; the devices must already be on. It reconnects BLE sessions and renegotiates the H60A1 encrypted session after disconnects.

## Optional startup

Run `install_bridge_autostart.bat` to add the launcher to the current Windows user's Startup folder. Run `remove_bridge_autostart.bat` to remove that shortcut. This starts the companion process at Windows sign-in; it does not make SignalRGB launch Python itself.

## Validation

Run:

```bat
py -3 -m unittest discover -s tests -v
py -3 -m py_compile govee_persistent_ble.py govee_signalrgb_bridge.py
node tests/smoke_addon.mjs
```

These checks validate local syntax, RGB framing, input validation, segment grouping, and the add-on logic against a mocked SignalRGB host. They do **not** simulate SignalRGB's host runtime or replace a test with the actual lights and Bluetooth adapter.

## Troubleshooting

- **No controllers:** fully quit and reopen SignalRGB after installing the add-on. Check the add-on service log for discovery/controller initialization errors.
- **No UDP connection:** start the Python bridge first; it should report listening on `127.0.0.1:45871`.
- **Component count warning:** edit the controller's Channel 1 component layout so the count is exactly 14 for an H60A1 or 8 for the H617A.
- **Python reports BLE connection errors:** check that each device is powered on, within Bluetooth range, and not already held by another BLE process.
- **RGB frames arrive but lights do not change:** inspect the Python terminal for `[UDP] First SignalRGB frame received` and `[... ] Applied RGB update` messages. If UDP frames arrive but BLE writes fail, the Python terminal reports the device-specific exception.

Do not run the old readback-only `govee_persistent_ble.py` as a separate process while this bridge is running; the active bridge already uses its classes internally and owns the BLE connections.
