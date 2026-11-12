"""Persistent BLE session manager for two Govee H60A1 ceiling lights and one H617A strip.

Connects to all three devices, negotiates a fresh H60A1 v1 encryption session per
connection, subscribes to notifications, performs read-only startup checks, and
keeps each connection alive. It does not change lighting settings.

Requires: py -m pip install bleak cryptography
"""

import asyncio
import os
from dataclasses import dataclass
from typing import Optional

from bleak import BleakClient

try:
    from cryptography.hazmat.decrepit.ciphers.algorithms import ARC4
except ImportError:  # Compatibility with older cryptography releases.
    from cryptography.hazmat.primitives.ciphers.algorithms import ARC4

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


WRITE_UUID = "00010203-0405-0607-0809-0a0b0c0d2b11"
NOTIFY_UUID = "00010203-0405-0607-0809-0a0b0c0d2b10"
KEY_COMMUNICATION = bytes.fromhex("4d616b696e674c696665536d61727465")
HANDSHAKE_TIMEOUT = 8.0
H60A1_KEEPALIVE_SECONDS = 3.0
H617A_KEEPALIVE_SECONDS = 2.0
RECONNECT_DELAY_SECONDS = 5.0


@dataclass(frozen=True)
class DeviceConfig:
    key: str
    label: str
    address: str
    kind: str  # "h60a1" or "h617a"


DEVICES = (
    DeviceConfig("office", "Office H60A1", "5C:E7:53:AF:E9:5B", "h60a1"),
    DeviceConfig("bedside", "Bedside H60A1", "5C:E7:53:B2:66:FF", "h60a1"),
    DeviceConfig("desk", "Under-desk H617A strip", "DB:48:C0:C6:2F:4A", "h617a"),
)


def xor_checksum(data: bytes) -> int:
    value = 0
    for byte in data:
        value ^= byte
    return value


def make_frame(header: int, command: int, *params: int) -> bytes:
    body = bytearray((header, command, *params))
    if len(body) > 19:
        raise ValueError("Govee frame payload exceeds 19 bytes")
    body.extend(bytes(19 - len(body)))
    body.append(xor_checksum(body))
    return bytes(body)


def v1_transform(data: bytes, key: bytes, *, encrypt: bool) -> bytes:
    if len(key) != 16:
        raise ValueError("Govee v1 keys must be exactly 16 bytes")
    boundary = (len(data) // 16) * 16
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    context = cipher.encryptor() if encrypt else cipher.decryptor()
    result = context.update(data[:boundary]) + context.finalize()
    if boundary < len(data):
        tail_cipher = Cipher(ARC4(key), mode=None).encryptor()
        result += tail_cipher.update(data[boundary:]) + tail_cipher.finalize()
    return result


def build_v1_handshake(opcode: int) -> bytes:
    if opcode not in (1, 2):
        raise ValueError("Handshake opcode must be 1 or 2")
    body = bytes((0xE7, opcode)) + os.urandom(17)
    plaintext = body + bytes((xor_checksum(body),))
    return v1_transform(plaintext, KEY_COMMUNICATION, encrypt=True)


class H60A1Session:
    def __init__(self, label: str, client: BleakClient):
        self.label = label
        self.client = client
        self.session_key: Optional[bytes] = None
        self.expected_opcode: Optional[int] = None
        self.handshake_future: Optional[asyncio.Future[bytes]] = None
        self.write_lock = asyncio.Lock()
        self.rx_valid = 0
        self.rx_other = 0

    def on_notification(self, _sender, data: bytearray) -> None:
        raw = bytes(data)

        future = self.handshake_future
        if future is not None and not future.done():
            try:
                candidate = v1_transform(raw, KEY_COMMUNICATION, encrypt=False)
            except Exception:
                candidate = b""
            if len(candidate) == 20 and candidate[0] == 0xE7 and xor_checksum(candidate) == 0:
                opcode = candidate[1]
                if opcode == self.expected_opcode:
                    future.set_result(candidate)
                    print(f"[{self.label}] Handshake E7 {opcode:02X} acknowledged")
                else:
                    print(f"[{self.label}] Ignored delayed E7 {opcode:02X} handshake reply")
                return

        if self.session_key is not None:
            try:
                plain = v1_transform(raw, self.session_key, encrypt=False)
            except Exception:
                plain = b""
            if len(plain) == 20 and xor_checksum(plain) == 0:
                self.rx_valid += 1
                if plain[0] == 0xAA and plain[1] == 0x01 and plain[2] in (0, 1):
                    state = "ON" if plain[2] else "OFF"
                    print(f"[{self.label}] Power status: {state}")
                elif plain[0] == 0xAA and plain[1] == 0xA5:
                    print(f"[{self.label}] Segment page {plain[2]} readback received")
                return

        self.rx_other += 1
        # Keep diagnostics concise; do not dump encrypted session material.
        print(f"[{self.label}] Received an unclassified notification ({len(raw)} bytes)")

    async def handshake_phase(self, opcode: int) -> bytes:
        loop = asyncio.get_running_loop()
        self.handshake_future = loop.create_future()
        self.expected_opcode = opcode
        frame = build_v1_handshake(opcode)
        try:
            async with self.write_lock:
                await self.client.write_gatt_char(WRITE_UUID, frame, response=False)
            return await asyncio.wait_for(self.handshake_future, HANDSHAKE_TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"{self.label}: E7 {opcode:02X} handshake timed out") from exc
        finally:
            self.handshake_future = None
            self.expected_opcode = None

    async def negotiate(self) -> None:
        key_reply = await self.handshake_phase(1)
        self.session_key = key_reply[2:18]
        if len(self.session_key) != 16:
            raise RuntimeError(f"{self.label}: invalid session key length")
        await self.handshake_phase(2)
        print(f"[{self.label}] Encrypted session ready")

    async def send_plain_frame(self, frame: bytes) -> None:
        if self.session_key is None:
            raise RuntimeError(f"{self.label}: encryption session is not ready")
        encrypted = v1_transform(frame, self.session_key, encrypt=True)
        async with self.write_lock:
            await self.client.write_gatt_char(WRITE_UUID, encrypted, response=False)

    async def startup_readback(self) -> None:
        # These are read-only AA requests; no lighting settings are modified.
        await self.send_plain_frame(make_frame(0xAA, 0x01, 0x00))
        await asyncio.sleep(0.25)
        for page in range(1, 5):
            await self.send_plain_frame(make_frame(0xAA, 0xA5, page))
            await asyncio.sleep(0.25)

    async def keepalive_loop(self) -> None:
        heartbeat = make_frame(0xAA, 0x00)
        while self.client.is_connected:
            await self.send_plain_frame(heartbeat)
            await asyncio.sleep(H60A1_KEEPALIVE_SECONDS)


class H617ASession:
    def __init__(self, label: str, client: BleakClient):
        self.label = label
        self.client = client
        self.write_lock = asyncio.Lock()
        self.rx_count = 0

    def on_notification(self, _sender, data: bytearray) -> None:
        self.rx_count += 1
        raw = bytes(data)
        if len(raw) == 20 and xor_checksum(raw) == 0:
            print(f"[{self.label}] Valid Govee notification received")
        else:
            print(f"[{self.label}] Notification received ({len(raw)} bytes)")

    async def keepalive_loop(self) -> None:
        # The tested H617A strip responds to this 0xAA 0x01 keepalive/status frame.
        heartbeat = make_frame(0xAA, 0x01)
        while self.client.is_connected:
            async with self.write_lock:
                await self.client.write_gatt_char(WRITE_UUID, heartbeat, response=False)
            await asyncio.sleep(H617A_KEEPALIVE_SECONDS)


async def run_device(config: DeviceConfig) -> None:
    """Own one device connection; reconnect and renegotiate after any disconnect."""
    while True:
        client = BleakClient(config.address, timeout=20.0)
        keepalive_task: Optional[asyncio.Task] = None
        try:
            print(f"[{config.label}] Connecting to {config.address}...")
            await client.connect()
            if not client.is_connected:
                raise ConnectionError("BLE connection did not become active")
            print(f"[{config.label}] Connected")
            if config.kind == "h60a1":
                h60 = H60A1Session(config.label, client)
                await client.start_notify(NOTIFY_UUID, h60.on_notification)
                print(f"[{config.label}] Subscribed to Govee notifications")
                await h60.negotiate()
                await h60.startup_readback()
                keepalive_task = asyncio.create_task(h60.keepalive_loop())
            else:
                h617 = H617ASession(config.label, client)
                await client.start_notify(NOTIFY_UUID, h617.on_notification)
                print(f"[{config.label}] Subscribed to Govee notifications")
                print(f"[{config.label}] Unencrypted BLE session ready")
                keepalive_task = asyncio.create_task(h617.keepalive_loop())

            print(f"[{config.label}] Session is active; keepalive running")
            while client.is_connected:
                await asyncio.sleep(0.5)
            raise ConnectionError("BLE device disconnected")

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[{config.label}] Session ended: {type(exc).__name__}: {exc}")
        finally:
            if keepalive_task is not None:
                keepalive_task.cancel()
                try:
                    await keepalive_task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass
            try:
                if client.is_connected:
                    await client.stop_notify(NOTIFY_UUID)
                    await client.disconnect()
            except Exception:
                pass
        print(f"[{config.label}] Reconnecting in {RECONNECT_DELAY_SECONDS:.0f}s...")
        await asyncio.sleep(RECONNECT_DELAY_SECONDS)


async def main() -> None:
    print("Govee persistent BLE session manager")
    print("Devices: office H60A1, bedside H60A1, under-desk H617A")
    print("Lighting-control writes are disabled; only handshakes, status reads and keepalives are sent.")
    print("Leave this window running to keep the BLE sessions open. Press Ctrl+C to stop.\n")

    tasks = [asyncio.create_task(run_device(device), name=device.key) for device in DEVICES]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopping BLE sessions...")
