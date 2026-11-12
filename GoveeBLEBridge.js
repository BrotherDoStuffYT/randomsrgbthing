import udp from "@SignalRGB/udp";

/* global controller, service, discovery, LightingMode, forcedColor */

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 45871;
const FRAME_INTERVAL_MS = 100;
const CHANNEL_NAME = "Segments";
const DEVICE_IMAGE = "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png";

const DEVICE_DEFINITIONS = [
    {
        id: "govee-ble-office",
        deviceKey: "office",
        name: "Office Ceiling Light",
        sku: "H60A1",
        ledCount: 14,
    },
    {
        id: "govee-ble-bedside",
        deviceKey: "bedside",
        name: "Bedside Ceiling Light",
        sku: "H60A1",
        ledCount: 14,
    },
    {
        id: "govee-ble-desk",
        deviceKey: "desk",
        name: "Under-desk RGBIC Strip",
        sku: "H617A",
        ledCount: 8,
    },
];

let socket;
let socketConnected = false;
let lastFrameAt = 0;
let lastLoggedDevice = "";
let lastRenderDiagnosticAt = 0;
let loggedColorShapeWarning = false;

export function Name() { return "Govee BLE Bridge"; }
export function Version() { return "0.1.0"; }
export function Type() { return "network"; }
export function Publisher() { return "Stuffy"; }
// LED geometry is defined in the same order as the Govee segment indices.
// H60A1: segments 1-13 form the outer ring; segment 14 is the center panel.
// H617A: eight segments form a straight horizontal strip.
const CEILING_RING_POSITIONS = [
    [5, 1], [7, 1], [9, 3], [9, 4], [9, 7], [8, 8], [6, 9],
    [4, 9], [2, 8], [1, 7], [1, 4], [1, 3], [3, 1],
    [5, 5], // Segment 14: center panel
];
const DESK_STRIP_POSITIONS = Array.from({ length: 8 }, (_, index) => [index, 0]);

function GetLedPositions() {
    return controller?.deviceKey === "desk"
        ? DESK_STRIP_POSITIONS
        : CEILING_RING_POSITIONS;
}

export function Size() {
    return controller?.deviceKey === "desk" ? [8, 1] : [11, 11];
}

export function LedNames() {
    if (controller?.deviceKey === "desk") {
        return Array.from({ length: 8 }, (_, index) => `Segment ${index + 1}`);
    }
    return [
        ...Array.from({ length: 13 }, (_, index) => `Ring Segment ${index + 1}`),
        "Center Panel",
    ];
}

export function LedPositions() {
    return GetLedPositions();
}
export function SubdeviceController() { return true; }
export function ImageUrl() { return DEVICE_IMAGE; }

export function ControllableParameters() {
    return [
        {
            property: "LightingMode",
            group: "lighting",
            label: "Lighting Mode",
            description: "Canvas follows SignalRGB effects; Forced uses one fixed color.",
            type: "combobox",
            values: ["Canvas", "Forced"],
            default: "Canvas",
        },
        {
            property: "forcedColor",
            group: "lighting",
            label: "Forced Color",
            type: "color",
            default: "#009bde",
        },
    ];
}

function ParseForcedColor(value) {
    if (Array.isArray(value) && value.length >= 3) {
        return value.slice(0, 3).map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
    }
    const hex = String(value || "#009bde").replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
        return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
        ];
    }
    return [0, 155, 222];
}

function GetChannelRGB() {
    const ledCount = Number(controller.ledCount) || 14;
    if (LightingMode === "Forced") {
        const color = ParseForcedColor(forcedColor);
        return Array.from({ length: ledCount }, () => color).flat();
    }

    // SignalRGB's device.color(x, y) reads the rendered canvas pixel at
    // the LED's mapped position. The channel.getColors() API is for
    // configured component channels and can return no data when none are set.
    const colors = [];
    const positions = GetLedPositions();
    if (positions.length !== ledCount) return undefined;
    for (const [x, y] of positions) {
        const color = device.color(x, y);
        if (!Array.isArray(color) || color.length < 3) return undefined;
        colors.push(Number(color[0]) || 0, Number(color[1]) || 0, Number(color[2]) || 0);
    }
    return colors;
}

export function Initialize() {
    socketConnected = false;
    lastFrameAt = 0;
    lastLoggedDevice = "";
    lastRenderDiagnosticAt = 0;
    loggedColorShapeWarning = false;

    device.setName(`Govee BLE - ${controller.name || controller.sku}`);
    device.setImageFromUrl(DEVICE_IMAGE);
    if (socket !== undefined) {
        try { socket.close(); } catch (_) { /* Ignore stale socket during reinit. */ }
    }

    socket = udp.createSocket();
    socket.on("error", (err) => {
        device.log(`Bridge socket error: ${err}`);
    });
    socket.on("listening", () => {
        device.log("UDP listener bound for the local Govee BLE bridge.");
    });
    socket.on("connection", () => {
        socketConnected = true;
        device.log(`UDP socket connected to ${BRIDGE_HOST}:${BRIDGE_PORT}.`);
    });
    socket.bind(0);
    socket.connect(BRIDGE_HOST, BRIDGE_PORT);

    device.log(`Ready to stream ${controller.ledCount} segments to ${controller.deviceKey}.`);
}

export function Render() {
    // UDP connect() sets the destination; it is not a TCP-style session.
    // SignalRGB's UDP documentation sends directly from Render().
    if (socket === undefined) return;

    const now = Date.now();
    if (now - lastRenderDiagnosticAt >= 5000) {
        lastRenderDiagnosticAt = now;
        device.log(`Render is running for ${controller.deviceKey}; preparing ${controller.ledCount} segments.`);
    }
    if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
    lastFrameAt = now;

    const colors = GetChannelRGB();
    if (!Array.isArray(colors) || colors.length !== Number(controller.ledCount) * 3) {
        if (!loggedColorShapeWarning) {
            loggedColorShapeWarning = true;
            const actualLength = Array.isArray(colors) ? colors.length : "device.color() did not return RGB data";
            device.log(`RGB data shape mismatch for ${controller.deviceKey}: expected ${Number(controller.ledCount) * 3} values, got ${actualLength}.`);
        }
        return;
    }

    const payload = JSON.stringify({
        device: controller.deviceKey,
        colors: colors,
    });
    try {
        socket.send(payload);
        if (lastLoggedDevice !== controller.deviceKey) {
            lastLoggedDevice = controller.deviceKey;
            device.log(`First RGB datagram queued for ${controller.deviceKey} (${colors.length / 3} segments).`);
        }
    } catch (err) {
        device.log(`UDP send failed for ${controller.deviceKey}: ${err}`);
    }
}

export function Shutdown() {
    socketConnected = false;
    if (socket !== undefined) {
        try { socket.close(); } catch (_) { /* Socket may already be closed. */ }
        socket = undefined;
    }
    // Deliberately leave the last color in place. Do not turn the Govee device off.
}

// ------------------------- SignalRGB network-service discovery -------------------------

class BridgeController {
    constructor(value) {
        this.id = value.id;
        var cached = discovery.cache.Get(value.id);
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
        this.deviceKey = value.deviceKey;
        this.name = value.name;
        this.sku = value.sku;
        this.ledCount = value.ledCount;
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
            initialized: value.initialized,
        });
    }
}

class BridgeCache {
    constructor() {
        this.items = new Map();
        this.Populate();
    }

    Populate() {
        const stored = service.getSetting("goveeBleBridge", "devices");
        if (stored === undefined) return;
        try {
            const parsed = JSON.parse(stored);
            for (const [key, value] of parsed) this.items.set(key, value);
        } catch (err) {
            service.log(`Could not read bridge device cache: ${err}`);
        }
    }

    Add(key, value) {
        this.items.set(key, value);
        service.saveSetting("goveeBleBridge", "devices", JSON.stringify(Array.from(this.items.entries())));
    }

    Remove(key) {
        this.items.delete(key);
        service.saveSetting("goveeBleBridge", "devices", JSON.stringify(Array.from(this.items.entries())));
    }

    Get(key) { return this.items.get(key); }
    Has(key) { return this.items.has(key); }
    Entries() { return this.items.entries(); }

    PurgeCache() {
        this.items.clear();
        service.removeSetting("goveeBleBridge", "devices");
    }
}

export function DiscoveryService() {
    this.IconUrl = DEVICE_IMAGE;
    this.firstRun = true;
    this.cache = new BridgeCache();

    this.Initialize = function () {
        service.log("Preparing the three local Govee BLE bridge controllers...");
    };

    this.LoadCachedDevices = function () {
        // Recreate the three known virtual devices, preserving each one's link state.
        for (const definition of DEVICE_DEFINITIONS) {
            const cached = this.cache.Get(definition.id);
            var deviceValue = {};
            for (var key in definition) {
                if (Object.prototype.hasOwnProperty.call(definition, key)) {
                    deviceValue[key] = definition[key];
                }
            }
            deviceValue.paired = cached && cached.paired !== undefined && cached.paired !== null
                ? cached.paired
                : false;
            this.CreateControllerDevice(deviceValue);
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
            entry.obj.update();
        }
    };

    this.link = function (controllerObject) {
        const target = service.getController(controllerObject.id);
        if (target === undefined) return;
        target.paired = true;
        target.updateWithValue(target);
        service.announceController(target);
        target.cacheControllerInfo(target);
        service.log(`Linked ${target.name} (${target.deviceKey}).`);
    };

    this.unlink = function (controllerObject) {
        const target = service.getController(controllerObject.id);
        if (target === undefined) return;
        target.paired = false;
        target.updateWithValue(target);
        service.suppressController(target);
        target.cacheControllerInfo(target);
        service.log(`Unlinked ${target.name} (${target.deviceKey}).`);
    };

    this.remove = function (controllerObject = false) {
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
        for (const definition of DEVICE_DEFINITIONS) {
            const target = service.getController(definition.id);
            if (target !== undefined) {
                service.suppressController(target);
                service.removeController(target);
            }
        }
    };

    this.Shutdown = function () { };
}
