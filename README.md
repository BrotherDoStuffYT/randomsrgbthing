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
- `Components/` — editable 14-LED H60A1 and 8-LED H617A SignalRGB component definitions.
- `govee_signalrgb_bridge.py` — UDP receiver and live BLE RGB streaming.
- `govee_persistent_ble.py` — BLE connection, H60A1 session negotiation, H617A keepalive, and protocol framing.
- `start_govee_ble_bridge.bat` — installs Python dependencies if missing and starts the companion process.
- `install_bridge_autostart.bat` / `remove_bridge_autostart.bat` — optional Windows sign-in shortcut management.

## Install the SignalRGB add-on

1. Put the contents of this folder at the **root** of a public GitHub repository. Do not put the files one extra folder deep.
2. In SignalRGB, open **Devices → Addons → Add** and enter the public repository URL.
3. Accept the installation prompt and fully restart SignalRGB from its system-tray menu.
4. Open the add-on under **Third Party Services** (the label can vary by SignalRGB version) and link the three virtual controllers.

The add-on uses a local `DiscoveryService` and virtual controllers. `Type()` remains `"network"` for the local UDP transport; `DeviceType()` identifies the virtual devices as lighting controllers.

## Configure the component layout

Copy the two JSON files from this repository's `Components` folder into:

`%USERPROFILE%\Documents\WhirlwindFX\Components`

Restart SignalRGB. On each virtual controller, open **Channel 1** in the component picker. Remove the existing placeholder or previous component first, then select the matching component:

- Office Ceiling Light and Bedside Ceiling Light: **Govee H60A1 - 13 Segment Ring + Center** (14 LEDs).
- Under-desk RGBIC Strip: **Govee H617A - 8 Segment Strip** (8 LEDs).

The current log's `channel.LedCount()=7` means the H60A1 channel still has a seven-LED component selected. The BLE protocol needs fourteen separate segment colors, so that seven-LED assignment cannot be sent as-is.

You can then arrange the component in SignalRGB's component editor. The LED coordinates are defaults in the component definition; the add-on itself does not hardcode the ceiling light's geometry.

The BLE protocol addresses exactly 14 H60A1 segments and 8 H617A segments. The add-on checks `channel.LedCount()` before reading colors and refuses to send if the selected component count differs. It reads colors with SignalRGB's built-in Govee call `channel.getColors("Inline")` and validates the returned flat RGB array against the configured count. It will not pad, truncate, or silently remap a component layout.

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
