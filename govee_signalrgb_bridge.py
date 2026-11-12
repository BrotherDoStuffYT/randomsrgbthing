"""SignalRGB -> localhost UDP -> persistent Govee BLE bridge.

Uses the already reverse-engineered H60A1 encrypted BLE protocol and H617A
unencrypted BLE protocol from govee_persistent_ble.py. SignalRGB sends the
latest flattened RGB frame for each controller as JSON UDP datagrams.

Install: py -3 -m pip install bleak cryptography
Run:     py -3 govee_signalrgb_bridge.py

The bridge never turns devices on/off. It only streams RGB for devices that
are already powered on, while maintaining their BLE sessions and keepalives.
"""

from __future__ import annotations

import asyncio
import json
import math
from typing import Optional

from bleak import BleakClient

from govee_persistent_ble import (
    DEVICES,
    H60A1Session,
    H617ASession,
    DeviceConfig,
    WRITE_UUID,
    make_frame,
)

UDP_HOST = "127.0.0.1"
UDP_PORT = 45871
WRITE_SPACING_SECONDS = 0.012

DEVICE_LED_COUNTS = {
    "office": 14,
    "bedside": 14,
    "desk": 8,
}


def normalize_colors(device_key: str, raw_colors: object) -> list[tuple[int, int, int]]:
    """Validate SignalRGB's flattened [R,G,B,...] color array."""
    expected = DEVICE_LED_COUNTS[device_key] * 3
    if not isinstance(raw_colors, list) or len(raw_colors) != expected:
        raise ValueError(
            f"{device_key} expects {expected} RGB channel values; received "
            f"{len(raw_colors) if isinstance(raw_colors, list) else 'non-array'}"
        )

    values: list[int] = []
    for value in raw_colors:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("RGB values must be numeric")
        if not math.isfinite(value):
            raise ValueError("RGB values must be finite")
        values.append(max(0, min(255, int(round(value)))))

    return [tuple(values[i : i + 3]) for i in range(0, expected, 3)]  # type: ignore[list-item]


def group_changed_segments(
    current: list[tuple[int, int, int]],
    previous: list[Optional[tuple[int, int, int]]],
) -> list[tuple[tuple[int, int, int], int]]:
    """Combine segments with identical RGB values into one bitmask command."""
    grouped: dict[tuple[int, int, int], int] = {}
    for index, color in enumerate(current):
        if previous[index] == color:
            continue
        grouped[color] = grouped.get(color, 0) | (1 << index)
    return list(grouped.items())


class SegmentStreamingMixin:
    """Latest-frame-wins queue with per-segment change detection."""

    def _init_streaming(self, segment_count: int) -> None:
        self.segment_count = segment_count
        self.pending_colors: Optional[list[tuple[int, int, int]]] = None
        self.colors_event = asyncio.Event()
        self.last_colors: list[Optional[tuple[int, int, int]]] = [None] * segment_count
        self.frames_applied = 0

    def submit_colors(self, colors: list[tuple[int, int, int]]) -> None:
        # Overwrite pending data instead of building a backlog of stale frames.
        self.pending_colors = colors
        self.colors_event.set()

    def _rgb_frame(self, color: tuple[int, int, int], mask: int) -> bytes:
        r, g, b = color
        return make_frame(
            0x33,
            0x05,
            0x15,
            0x01,
            r,
            g,
            b,
            0,
            0,
            0,
            0,
            0,
            mask & 0xFF,
            (mask >> 8) & 0xFF,
        )

    async def color_loop(self) -> None:
        while self.client.is_connected:
            await self.colors_event.wait()
            if not self.client.is_connected:
                return

            colors = self.pending_colors
            self.pending_colors = None
            self.colors_event.clear()
            if colors is None:
                continue

            groups = group_changed_segments(colors, self.last_colors)
            if not groups:
                continue

            for color, mask in groups:
                frame = self._rgb_frame(color, mask)
                await self.send_rgb_frame(frame)

                # Only mark these segments current after the BLE write succeeds.
                for index in range(self.segment_count):
                    if mask & (1 << index):
                        self.last_colors[index] = color

                await asyncio.sleep(WRITE_SPACING_SECONDS)

            self.frames_applied += 1
            if self.frames_applied == 1 or self.frames_applied % 100 == 0:
                print(
                    f"[{self.label}] Applied RGB update {self.frames_applied} "
                    f"({len(groups)} BLE color command(s))"
                )


class StreamingH60A1Session(SegmentStreamingMixin, H60A1Session):
    def __init__(self, label: str, client: BleakClient):
        super().__init__(label, client)
        self._init_streaming(14)

    async def send_rgb_frame(self, frame: bytes) -> None:
        await self.send_plain_frame(frame)


class StreamingH617ASession(SegmentStreamingMixin, H617ASession):
    def __init__(self, label: str, client: BleakClient):
        super().__init__(label, client)
        self._init_streaming(8)

    async def send_rgb_frame(self, frame: bytes) -> None:
        async with self.write_lock:
            await self.client.write_gatt_char(WRITE_UUID, frame, response=False)


class BridgeState:
    def __init__(self) -> None:
        self.sessions: dict[str, SegmentStreamingMixin] = {}
        self.latest_frames: dict[str, list[tuple[int, int, int]]] = {}
        self.seen_frames: dict[str, int] = {}

    def receive_datagram(self, data: bytes, addr: tuple[str, int]) -> None:
        try:
            message = json.loads(data.decode("utf-8"))
            key = message.get("device")
            if key not in DEVICE_LED_COUNTS:
                return
            colors = normalize_colors(key, message.get("colors"))
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, ValueError) as exc:
            print(f"[UDP] Ignored invalid frame from {addr[0]}: {exc}")
            return

        self.latest_frames[key] = colors
        session = self.sessions.get(key)
        if session is not None:
            session.submit_colors(colors)

        count = self.seen_frames.get(key, 0) + 1
        self.seen_frames[key] = count
        if count == 1:
            print(f"[UDP] First SignalRGB frame received for {key} ({len(colors)} segments)")


class RGBDatagramProtocol(asyncio.DatagramProtocol):
    def __init__(self, state: BridgeState) -> None:
        self.state = state

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        self.state.receive_datagram(data, addr)

    def error_received(self, exc: Exception) -> None:
        print(f"[UDP] Socket error: {exc}")


async def run_device(config: DeviceConfig, state: BridgeState) -> None:
    """Own one BLE connection and restart its handshake after disconnects."""
    while True:
        client = BleakClient(config.address, timeout=20.0)
        background_tasks: list[asyncio.Task] = []
        session: Optional[SegmentStreamingMixin] = None

        try:
            print(f"[{config.label}] Connecting to {config.address}...")
            await client.connect()
            if not client.is_connected:
                raise ConnectionError("BLE connection did not become active")
            print(f"[{config.label}] Connected")

            if config.kind == "h60a1":
                h60 = StreamingH60A1Session(config.label, client)
                session = h60
                await client.start_notify(
                    "00010203-0405-0607-0809-0a0b0c0d2b10", h60.on_notification
                )
                print(f"[{config.label}] Subscribed to Govee notifications")
                await h60.negotiate()
                await h60.startup_readback()
            else:
                h617 = StreamingH617ASession(config.label, client)
                session = h617
                await client.start_notify(
                    "00010203-0405-0607-0809-0a0b0c0d2b10", h617.on_notification
                )
                print(f"[{config.label}] Subscribed to Govee notifications")
                print(f"[{config.label}] Unencrypted BLE session ready")

            state.sessions[config.key] = session
            pending = state.latest_frames.get(config.key)
            if pending is not None:
                session.submit_colors(pending)

            background_tasks = [
                asyncio.create_task(session.keepalive_loop(), name=f"{config.key}-keepalive"),
                asyncio.create_task(session.color_loop(), name=f"{config.key}-rgb"),
            ]
            print(f"[{config.label}] Session active; RGB streaming is ready")

            while client.is_connected:
                done, _ = await asyncio.wait(
                    background_tasks,
                    timeout=0.5,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if done:
                    for task in done:
                        # Propagate a BLE write failure so this device reconnects cleanly.
                        task.result()
                    if client.is_connected:
                        raise RuntimeError("A BLE background task stopped unexpectedly")

            raise ConnectionError("BLE device disconnected")

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[{config.label}] Session ended: {type(exc).__name__}: {exc}")
        finally:
            if state.sessions.get(config.key) is session:
                state.sessions.pop(config.key, None)

            for task in background_tasks:
                if not task.done():
                    task.cancel()
            if background_tasks:
                await asyncio.gather(*background_tasks, return_exceptions=True)

            try:
                if client.is_connected:
                    await client.stop_notify(
                        "00010203-0405-0607-0809-0a0b0c0d2b10"
                    )
                    await client.disconnect()
            except Exception:
                pass

        print(f"[{config.label}] Reconnecting in 5s...")
        await asyncio.sleep(5.0)


async def main() -> None:
    state = BridgeState()
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: RGBDatagramProtocol(state),
        local_addr=(UDP_HOST, UDP_PORT),
    )

    print("Govee SignalRGB BLE Bridge")
    print(f"Listening for SignalRGB frames on UDP {UDP_HOST}:{UDP_PORT}")
    print("Devices: office H60A1 (14), bedside H60A1 (14), under-desk H617A (8)")
    print("Only RGB segment writes and keepalives are sent; power is not changed.")
    print("Stop with Ctrl+C. Do not run govee_persistent_ble.py at the same time.\n")

    tasks = [
        asyncio.create_task(run_device(config, state), name=config.key)
        for config in DEVICES
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        transport.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopping Govee SignalRGB BLE Bridge...")
