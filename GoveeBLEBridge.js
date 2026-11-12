import udp from "@SignalRGB/udp";

/* global controller, device, discovery, service, LightingMode, forcedColor */

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 45871;
const FRAME_INTERVAL_MS = 100;
const CHANNEL_NAME = "Channel 1";
const DEVICE_IMAGE = "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png";
const CACHE_GROUP = "goveeBleBridge";
const CACHE_KEY = "devices";

const DEVICE_DEFINITIONS = [
    {
        id: "govee-ble-office",
        deviceKey: "office",
        name: "Office Ceiling Light",
        sku: "H60A1",
        ledCount: 14
    },
    {
        id: "govee-ble-bedside",
        deviceKey: "bedside",
        name: "Bedside Ceiling Light",
        sku: "H60A1",
        ledCount: 14
    },
    {
        id: "govee-ble-desk",
        deviceKey: "desk",
        name: "Under-desk RGBIC Strip",
        sku: "H617A",
        ledCount: 8
    }
];

let socket;
let socketConnected = false;
let lastFrameAt = 0;
let lastWarningAt = 0;
let lastWarningText = "";
let framesSent = 0;
let firstFrameLogged = false;

// These are the standard exports SignalRGB expects from a network add-on.
// DiscoveryService below creates the three virtual controllers.
export function Name() { return "Govee BLE Bridge"; }
export function Version() { return "1.0.1"; }
export function Type() { return "network"; }
export function DeviceType() { return "lightingcontroller"; }
export function Publisher() { return "Stuffy"; }
export function Size() { return [22, 1]; }
export function SubdeviceController() { return true; }
export function ImageUrl() { return DEVICE_IMAGE; }

export function ControllableParameters() {
    return [
        {
            property: "LightingMode",
            group: "lighting",
            label: "Lighting Mode",
            description: "Canvas follows SignalRGB effects. Forced sends one chosen color to every segment.",
            type: "combobox",
            values: ["Canvas", "Forced"],
            default: "Canvas"
        },
        {
            property: "forcedColor",
            group: "lighting",
            label: "Forced Color",
            type: "color",
            default: "#009bde"
        }
    ];
}

function GetDefinition(deviceKey) {
    for (let i = 0; i < DEVICE_DEFINITIONS.length; i++) {
        if (DEVICE_DEFINITIONS[i].deviceKey === deviceKey) {
            return DEVICE_DEFINITIONS[i];
        }
    }
    return undefined;
}

function LogWarning(message) {
    const now = Date.now();
    if (message !== lastWarningText || now - lastWarningAt >= 10000) {
        lastWarningText = message;
        lastWarningAt = now;
        device.log(message);
    }
}

function ConfigureChannel(expectedLedCount) {
    let channel = device.channel(CHANNEL_NAME);

    // Channels can survive an add-on hot reload. Reuse an existing channel so its
    // component layout is not unnecessarily discarded.
    if (channel === null || channel === undefined) {
        device.addChannel(CHANNEL_NAME, expectedLedCount);
        channel = device.channel(CHANNEL_NAME);
    }

    if (channel === null || channel === undefined) {
        throw new Error("SignalRGB did not create the '" + CHANNEL_NAME + "' component channel.");
    }

    channel.SetLedLimit(expectedLedCount);
    device.SetLedLimit(expectedLedCount);
    device.log("Component channel ready. Hardware segment count: " + expectedLedCount + ".");
}

function GetSequenceLength(value) {
    if (value === null || value === undefined) {
        return -1;
    }

    // SignalRGB can expose component colors as a host-provided array-like value.
    // It has numeric indexes and a length, but Array.isArray() is not reliable
    // across the host's JS/QML boundary. Validate the actual sequence contract.
    const length = value.length;
    if (typeof length !== "number" || !Number.isFinite(length) ||
        length < 0 || Math.floor(length) !== length) {
        return -1;
    }
    return length;
}

function NormalizeRGBArray(raw, expectedValueCount) {
    const rawLength = GetSequenceLength(raw);
    if (rawLength !== expectedValueCount) {
        return undefined;
    }

    const normalized = [];
    for (let i = 0; i < rawLength; i++) {
        const value = Number(raw[i]);
        if (!Number.isFinite(value)) {
            return undefined;
        }
        normalized.push(Math.max(0, Math.min(255, Math.round(value))));
    }
    return normalized;
}

function GetRGBFrame(expectedHardwareLedCount) {
    const channel = device.channel(CHANNEL_NAME);
    if (channel === null || channel === undefined) {
        LogWarning("Component channel '" + CHANNEL_NAME + "' is missing.");
        return undefined;
    }

    const configuredLedCount = channel.LedCount();

    // SignalRGB pulses an unconfigured channel while the user is choosing
    // components. Use the physical segment count for that setup preview.
    if (LightingMode !== "Forced" &&
        typeof channel.shouldPulseColors === "function" &&
        channel.shouldPulseColors()) {
        const pulseColor = device.getChannelPulseColor(CHANNEL_NAME);
        const pulse = device.createColorArray(pulseColor, expectedHardwareLedCount, "Inline");
        return {
            colors: NormalizeRGBArray(pulse, expectedHardwareLedCount * 3),
            ledCount: expectedHardwareLedCount,
            isPulse: true
        };
    }

    if (configuredLedCount <= 0) {
        LogWarning("No components are configured on channel '" + CHANNEL_NAME + "'. Add the matching Govee component in SignalRGB's component editor.");
        return undefined;
    }

    // The BLE protocol addresses a fixed number of physical segments. Refuse a
    // different SignalRGB component count before reading or sending any color data.
    if (configuredLedCount !== expectedHardwareLedCount) {
        const suggestedComponent = controller.sku === "H60A1"
            ? "Govee H60A1 - 13 Segment Ring + Center"
            : "Govee H617A - 8 Segment Strip";
        LogWarning(
            "Component layout mismatch: Channel 1 currently has " + configuredLedCount +
            " LEDs, but " + controller.sku + " requires " + expectedHardwareLedCount +
            ". Select '" + suggestedComponent + "' in the component picker."
        );
        return undefined;
    }

    let rawColors;
    if (LightingMode === "Forced") {
        rawColors = device.createColorArray(forcedColor, configuredLedCount, "Inline");
    } else {
        // Match SignalRGB's own Govee add-on exactly. The first argument selects
        // a flat RGB array; omitting the optional ColorOrder argument avoids
        // runtime-version differences in the component-channel binding.
        rawColors = channel.getColors("Inline");
    }

    const expectedValueCount = configuredLedCount * 3;
    const rawLength = GetSequenceLength(rawColors);
    if (rawLength !== expectedValueCount) {
        const actualLength = rawLength >= 0 ? rawLength : "unavailable/non-sequence";
        LogWarning(
            "SignalRGB component data mismatch: channel.LedCount()=" + configuredLedCount +
            ", getColors(\"Inline\") length=" + actualLength +
            ", expected=" + expectedValueCount + "."
        );
        return undefined;
    }

    const normalizedColors = NormalizeRGBArray(rawColors, expectedValueCount);
    if (normalizedColors === undefined) {
        LogWarning("SignalRGB returned non-numeric RGB values for channel '" + CHANNEL_NAME + "'.");
        return undefined;
    }

    return {
        colors: normalizedColors,
        ledCount: configuredLedCount,
        isPulse: false
    };
}

function CloseSocket() {
    socketConnected = false;
    if (socket !== undefined) {
        try {
            if (typeof socket.disconnect === "function") {
                socket.disconnect();
            }
        } catch (_) {
            // The socket may already be disconnected.
        }
        try {
            socket.close();
        } catch (_) {
            // The socket may already be closed.
        }
        socket = undefined;
    }
}

export function Initialize() {
    const definition = GetDefinition(controller.deviceKey);
    if (definition === undefined) {
        throw new Error("Unknown Govee BLE device key: " + controller.deviceKey);
    }

    lastFrameAt = 0;
    lastWarningAt = 0;
    lastWarningText = "";
    framesSent = 0;
    firstFrameLogged = false;

    device.setName("Govee BLE - " + definition.name);
    device.setImageFromUrl(DEVICE_IMAGE);
    ConfigureChannel(definition.ledCount);

    CloseSocket();
    socket = udp.createSocket();
    if (socket === undefined || socket === null) {
        throw new Error("SignalRGB could not create a UDP socket.");
    }

    socket.on("connection", function () {
        socketConnected = true;
        device.log("UDP connected to local BLE bridge at " + BRIDGE_HOST + ":" + BRIDGE_PORT + ".");
    });
    socket.on("error", function (error) {
        socketConnected = false;
        device.log("Local BLE bridge UDP error: " + error);
    });
    socket.on("listening", function () {
        device.log("Local BLE bridge UDP socket bound.");
    });

    // Match SignalRGB's built-in Govee add-on socket setup: bind an ephemeral local
    // port, then connect the UDP socket to the local companion process.
    socket.bind(0);
    socket.connect(BRIDGE_HOST, BRIDGE_PORT);

    device.log("Initialized " + definition.name + " (" + definition.ledCount + " physical segments).");
}

export function Render() {
    if (socket === undefined || !socketConnected) {
        return;
    }

    const now = Date.now();
    if (now - lastFrameAt < FRAME_INTERVAL_MS) {
        return;
    }
    lastFrameAt = now;

    const definition = GetDefinition(controller.deviceKey);
    if (definition === undefined) {
        return;
    }

    const frame = GetRGBFrame(definition.ledCount);
    if (frame === undefined || !Array.isArray(frame.colors)) {
        return;
    }

    if (frame.colors.length !== definition.ledCount * 3) {
        LogWarning(
            "Refusing to send malformed RGB frame: got " + frame.colors.length +
            " values; hardware requires " + (definition.ledCount * 3) + "."
        );
        return;
    }

    const payload = JSON.stringify({
        device: definition.deviceKey,
        colors: frame.colors
    });

    try {
        const result = socket.send(payload);
        if (result === -1) {
            LogWarning("UDP send returned -1 for " + definition.deviceKey + ".");
            return;
        }
        framesSent++;
        if (!firstFrameLogged) {
            firstFrameLogged = true;
            device.log("First RGB frame sent for " + definition.deviceKey + " (" + frame.ledCount + " segments).");
        }
        if (framesSent % 300 === 0) {
            device.log("Sent " + framesSent + " RGB frames for " + definition.deviceKey + ".");
        }
    } catch (error) {
        LogWarning("UDP send failed for " + definition.deviceKey + ": " + error);
    }
}

export function Shutdown() {
    CloseSocket();
    // Do not switch the Govee devices off; leave their last received color in place.
}

// --------------------------- Third-party service / controller discovery ---------------------------

class BridgeCache {
    constructor() {
        this.items = new Map();
        this.load();
    }

    load() {
        const stored = service.getSetting(CACHE_GROUP, CACHE_KEY);
        if (stored === undefined || stored === null || stored === "") {
            return;
        }

        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                this.items = new Map(parsed);
            }
        } catch (error) {
            service.log("Could not load Govee BLE controller cache: " + error);
        }
    }

    save() {
        service.saveSetting(CACHE_GROUP, CACHE_KEY, JSON.stringify(Array.from(this.items.entries())));
    }

    Add(key, value) {
        this.items.set(key, value);
        this.save();
    }

    Remove(key) {
        this.items.delete(key);
        this.save();
    }

    Get(key) {
        return this.items.get(key);
    }

    PurgeCache() {
        this.items.clear();
        service.removeSetting(CACHE_GROUP, CACHE_KEY);
    }
}

class BridgeController {
    constructor(value) {
        this.id = value.id;
        const cached = discovery.cache.Get(value.id);

        if (value.paired !== undefined && value.paired !== null) {
            this.paired = value.paired;
        } else if (cached && cached.paired !== undefined && cached.paired !== null) {
            this.paired = cached.paired;
        } else {
            this.paired = false;
        }

        this.deviceKey = value.deviceKey;
        this.name = value.name;
        this.sku = value.sku;
        this.ledCount = value.ledCount;
        this.ip = BRIDGE_HOST;
        this.deviceImage = DEVICE_IMAGE;
        this.initialized = false;
        this.cacheControllerInfo(this);
    }

    updateWithValue(value) {
        if (value.paired !== undefined && value.paired !== null) {
            this.paired = value.paired;
        }
        this.deviceKey = value.deviceKey || this.deviceKey;
        this.name = value.name || this.name;
        this.sku = value.sku || this.sku;
        this.ledCount = value.ledCount || this.ledCount;
        this.ip = BRIDGE_HOST;
        this.deviceImage = DEVICE_IMAGE;
        service.updateController(this);
        this.cacheControllerInfo(this);
    }

    update() {
        if (!this.initialized) {
            this.initialized = true;
            service.updateController(this);
            service.announceController(this);
            this.cacheControllerInfo(this);
        }
    }

    cacheControllerInfo(value) {
        discovery.cache.Add(value.id, {
            id: value.id,
            paired: value.paired,
            deviceKey: value.deviceKey,
            name: value.name,
            sku: value.sku,
            ledCount: value.ledCount,
            ip: BRIDGE_HOST,
            deviceImage: DEVICE_IMAGE,
            initialized: value.initialized
        });
    }
}

export function DiscoveryService() {
    this.IconUrl = DEVICE_IMAGE;
    this.firstRun = true;
    this.cache = new BridgeCache();

    this.Initialize = function () {
        service.log("Preparing the three local Govee BLE virtual controllers.");
    };

    this.LoadCachedDevices = function () {
        for (let i = 0; i < DEVICE_DEFINITIONS.length; i++) {
            const definition = DEVICE_DEFINITIONS[i];
            const cached = this.cache.Get(definition.id);
            const value = {
                id: definition.id,
                deviceKey: definition.deviceKey,
                name: definition.name,
                sku: definition.sku,
                ledCount: definition.ledCount,
                paired: cached && cached.paired !== undefined && cached.paired !== null
                    ? cached.paired
                    : false
            };
            this.CreateControllerDevice(value);
        }
    };

    this.CreateControllerDevice = function (value) {
        const existing = service.getController(value.id);
        if (existing === undefined) {
            service.addController(new BridgeController(value));
        } else {
            existing.updateWithValue(value);
        }
    };

    this.Update = function () {
        if (this.firstRun) {
            this.LoadCachedDevices();
            this.firstRun = false;
        }

        for (const entry of service.controllers) {
            if (entry.obj && typeof entry.obj.update === "function") {
                entry.obj.update();
            }
        }
    };

    this.link = function (controllerObject) {
        const target = service.getController(controllerObject.id);
        if (target === undefined) {
            return;
        }
        target.paired = true;
        target.updateWithValue(target);
        service.announceController(target);
        target.cacheControllerInfo(target);
        service.log("Linked " + target.name + " (" + target.deviceKey + ").");
    };

    this.unlink = function (controllerObject) {
        const target = service.getController(controllerObject.id);
        if (target === undefined) {
            return;
        }
        target.paired = false;
        target.updateWithValue(target);
        service.suppressController(target);
        target.cacheControllerInfo(target);
        service.log("Unlinked " + target.name + " (" + target.deviceKey + ").");
    };

    this.remove = function (controllerObject) {
        if (controllerObject) {
            const target = service.getController(controllerObject.id);
            if (target !== undefined) {
                this.cache.Remove(target.id);
                service.suppressController(target);
                service.removeController(target);
            }
            return;
        }

        this.cache.PurgeCache();
        for (let i = 0; i < DEVICE_DEFINITIONS.length; i++) {
            const target = service.getController(DEVICE_DEFINITIONS[i].id);
            if (target !== undefined) {
                service.suppressController(target);
                service.removeController(target);
            }
        }
    };

    this.Shutdown = function () { };
}
