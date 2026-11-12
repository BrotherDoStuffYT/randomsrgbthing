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

export function Name() { return "Govee BLE Bridge"; }
export function Version() { return "0.1.0"; }
export function Type() { return "network"; }
export function Publisher() { return "Stuffy"; }
export function Size() { return [14, 1]; }
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

function ConfigureChannels() {
    const ledCount = Number(controller.ledCount) || 14;
    device.addChannel(CHANNEL_NAME, ledCount);
    device.channel(CHANNEL_NAME).SetLedLimit(ledCount);
    device.SetLedLimit(ledCount);
}

function GetChannelRGB() {
    const channel = device.channel(CHANNEL_NAME);
    const ledCount = channel.LedCount();

    if (LightingMode === "Forced") {
        return device.createColorArray(forcedColor, ledCount, "Inline");
    }

    if (channel.shouldPulseColors()) {
        return device.createColorArray(
            device.getChannelPulseColor(CHANNEL_NAME),
            channel.LedLimit(),
            "Inline"
        );
    }

    return channel.getColors("Inline");
}

export function Initialize() {
    socketConnected = false;
    lastFrameAt = 0;
    lastLoggedDevice = "";

    device.setName(`Govee BLE - ${controller.name || controller.sku}`);
    device.setImageFromUrl(DEVICE_IMAGE);
    ConfigureChannels();

    if (socket !== undefined) {
        try { socket.close(); } catch (_) { /* Ignore stale socket during reinit. */ }
    }

    socket = udp.createSocket();
    socket.on("connected", () => {
        socketConnected = true;
        device.log(`Connected to local Govee BLE bridge at ${BRIDGE_HOST}:${BRIDGE_PORT}.`);
    });
    socket.on("disconnected", () => {
        socketConnected = false;
        device.log("Disconnected from local Govee BLE bridge.");
    });
    socket.on("error", (err) => {
        socketConnected = false;
        device.log(`Bridge socket error: ${err}`);
    });
    socket.connect(BRIDGE_HOST, BRIDGE_PORT);

    device.log(`Ready to stream ${controller.ledCount} segments to ${controller.deviceKey}.`);
}

export function Render() {
    if (socket === undefined || !socketConnected) return;

    const now = Date.now();
    if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
    lastFrameAt = now;

    const colors = GetChannelRGB();
    if (!Array.isArray(colors) || colors.length !== Number(controller.ledCount) * 3) {
        return;
    }

    const payload = JSON.stringify({
        device: controller.deviceKey,
        colors: colors,
    });
    socket.send(payload);

    if (lastLoggedDevice !== controller.deviceKey) {
        lastLoggedDevice = controller.deviceKey;
        device.log(`Sending RGB frames for ${controller.deviceKey}.`);
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
