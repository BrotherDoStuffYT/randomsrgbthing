import udp from "@SignalRGB/udp";

/* global controller, service, discovery, LightingMode, forcedColor */

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 45871;
const FRAME_INTERVAL_MS = 100;
const CHANNEL_NAME = "Channel 1";
const DEVICE_IMAGE = "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png";

const DEVICE_DEFINITIONS = [
    { id: "govee-ble-office", deviceKey: "office", name: "Office Ceiling Light", sku: "H60A1", ledCount: 14 },
    { id: "govee-ble-bedside", deviceKey: "bedside", name: "Bedside Ceiling Light", sku: "H60A1", ledCount: 14 },
    { id: "govee-ble-desk", deviceKey: "desk", name: "Under-desk RGBIC Strip", sku: "H617A", ledCount: 8 },
];

let socket;
let lastFrameAt = 0;
let lastDiagnosticAt = 0;
let firstFrameLogged = false;
let receivedColorCount = 0;

export function Name() { return "Govee BLE Bridge"; }
export function Version() { return "0.2.0"; }
export function Type() { return "network"; }
export function DeviceType() { return "lightingcontroller"; }
export function Publisher() { return "Stuffy"; }
export function Size() { return [22, 1]; }
export function SubdeviceController() { return true; }
export function ImageUrl() { return DEVICE_IMAGE; }

export function ControllableParameters() {
    return [
        {
            property: "LightingMode", group: "lighting", label: "Lighting Mode",
            description: "Canvas follows SignalRGB effects; Forced uses one fixed color.",
            type: "combobox", values: ["Canvas", "Forced"], default: "Canvas",
        },
        {
            property: "forcedColor", group: "lighting", label: "Forced Color",
            type: "color", default: "#009bde",
        },
    ];
}

function LedCountForController() {
    const key = (typeof controller !== "undefined" && controller) ? controller.deviceKey : undefined;
    const definition = DEVICE_DEFINITIONS.find((item) => item.deviceKey === key);
    return definition ? definition.ledCount : 14;
}

function ConfigureChannels() {
    const ledCount = LedCountForController();
    device.addChannel(CHANNEL_NAME, ledCount);
    device.channel(CHANNEL_NAME).SetLedLimit(ledCount);
    device.SetLedLimit(ledCount);
    device.log(`Configured component channel '${CHANNEL_NAME}' for ${ledCount} LEDs.`);
}

function NormalizeColorArray(raw, expectedLedCount) {
    if (!Array.isArray(raw)) return undefined;
    const output = [];
    for (let i = 0; i < expectedLedCount; i++) {
        const offset = i * 3;
        if (offset + 2 >= raw.length) return undefined;
        output.push(
            Math.max(0, Math.min(255, Math.round(Number(raw[offset]) || 0))),
            Math.max(0, Math.min(255, Math.round(Number(raw[offset + 1]) || 0))),
            Math.max(0, Math.min(255, Math.round(Number(raw[offset + 2]) || 0))),
        );
    }
    return output;
}

function GetRGBFrame() {
    const ledCount = LedCountForController();
    if (LightingMode === "Forced") {
        return device.createColorArray(forcedColor, ledCount, "Inline");
    }

    // Component mode: SignalRGB maps the user's selected fan/strip components
    // onto this channel. getColors() returns the resulting RGB values in chain order.
    const channel = device.channel(CHANNEL_NAME);
    if (!channel || typeof channel.getColors !== "function") {
        device.log("Component channel is unavailable; no RGB frame can be sent yet.");
        return undefined;
    }
    const raw = channel.getColors("Inline");

    device.log(
        "Component data: " +
        (Array.isArray(raw)
            ? "array, length=" + raw.length + ", sample=" + JSON.stringify(raw.slice(0, 6))
            : "type=" + typeof raw + ", value=" + String(raw))
    );
    
    return NormalizeColorArray(raw, ledCount);
}

export function Initialize() {
    lastFrameAt = 0;
    lastDiagnosticAt = 0;
    firstFrameLogged = false;
    receivedColorCount = 0;

    const ledCount = LedCountForController();
    device.setName(`Govee BLE - ${controller.name || controller.sku || controller.deviceKey}`);
    device.setImageFromUrl(DEVICE_IMAGE);
    ConfigureChannels();

    if (socket !== undefined) {
        try { socket.close(); } catch (_) { /* stale socket */ }
    }

    socket = udp.createSocket();
    socket.on("error", (err) => device.log(`Bridge UDP error: ${err}`));
    socket.on("connection", () => device.log(`UDP socket connected to ${BRIDGE_HOST}:${BRIDGE_PORT}.`));
    socket.on("listening", () => device.log("UDP socket listener bound."));
    socket.bind(0);
    socket.connect(BRIDGE_HOST, BRIDGE_PORT);
    device.log(`Ready to stream ${ledCount} LEDs for ${controller.deviceKey}.`);
}

export function Render() {
    if (socket === undefined) return;
    const now = Date.now();
    if (now - lastDiagnosticAt >= 10000) {
        lastDiagnosticAt = now;
        device.log(`Render active for ${controller.deviceKey}; reading ${LedCountForController()} component LEDs.`);
    }
    if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
    lastFrameAt = now;

    const colors = GetRGBFrame();
    const expectedValues = LedCountForController() * 3;
    if (!Array.isArray(colors) || colors.length !== expectedValues) {
        device.log(`No valid component RGB frame for ${controller.deviceKey}; expected ${expectedValues} values.`);
        return;
    }

    const payload = JSON.stringify({ device: controller.deviceKey, colors });
    try {
        socket.send(payload);
        receivedColorCount++;
        if (!firstFrameLogged) {
            firstFrameLogged = true;
            device.log(`First component RGB frame sent for ${controller.deviceKey} (${colors.length / 3} LEDs).`);
        }
        if (receivedColorCount % 100 === 0) {
            device.log(`Sent ${receivedColorCount} RGB frames for ${controller.deviceKey}.`);
        }
    } catch (err) {
        device.log(`UDP send failed for ${controller.deviceKey}: ${err}`);
    }
}

export function Shutdown() {
    if (socket !== undefined) {
        try { socket.close(); } catch (_) { /* already closed */ }
        socket = undefined;
    }
}

// ---------------- SignalRGB network-service discovery ----------------

class BridgeController {
    constructor(value) {
        this.id = value.id;
        const cached = discovery.cache.Get(value.id);
        this.paired = (value.paired !== undefined && value.paired !== null) ? value.paired : ((cached && cached.paired !== undefined) ? cached.paired : false);
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
        this.paired = (value.paired !== undefined && value.paired !== null) ? value.paired : this.paired;
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
            id: value.id, paired: value.paired, deviceKey: value.deviceKey,
            name: value.name, sku: value.sku, ledCount: value.ledCount,
            ip: BRIDGE_HOST, deviceImage: DEVICE_IMAGE, initialized: value.initialized,
        });
    }
}

class BridgeCache {
    constructor() { this.items = new Map(); this.Populate(); }
    Populate() {
        const stored = service.getSetting("goveeBleBridge", "devices");
        if (stored === undefined) return;
        try { for (const [key, value] of JSON.parse(stored)) this.items.set(key, value); }
        catch (err) { service.log(`Could not read bridge device cache: ${err}`); }
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
    PurgeCache() { this.items.clear(); service.removeSetting("goveeBleBridge", "devices"); }
}

export function DiscoveryService() {
    this.IconUrl = DEVICE_IMAGE;
    this.firstRun = true;
    this.cache = new BridgeCache();
    this.Initialize = function () { service.log("Preparing the three local Govee BLE component controllers..."); };
    this.LoadCachedDevices = function () {
        for (const definition of DEVICE_DEFINITIONS) {
            const cached = this.cache.Get(definition.id);
            var deviceValue = Object.assign({}, definition);
            deviceValue.paired = (cached && cached.paired !== undefined && cached.paired !== null) ? cached.paired : false;
            this.CreateControllerDevice(deviceValue);
        }
    };
    this.CreateControllerDevice = function (value) {
        const existing = service.getController(value.id);
        if (existing === undefined) service.addController(new BridgeController(value));
        else existing.updateWithValue(value);
    };
    this.Update = function () {
        if (this.firstRun) { this.LoadCachedDevices(); this.firstRun = false; }
        for (const entry of service.controllers) entry.obj.update();
    };
    this.link = function (controllerObject) {
        const target = service.getController(controllerObject.id);
        if (!target) return;
        target.paired = true;
        target.updateWithValue(target);
        service.announceController(target);
        target.cacheControllerInfo(target);
        service.log(`Linked ${target.name} (${target.deviceKey}).`);
    };
    this.unlink = function (controllerObject) {
        const target = service.getController(controllerObject.id);
        if (!target) return;
        target.paired = false;
        target.updateWithValue(target);
        service.suppressController(target);
        target.cacheControllerInfo(target);
        service.log(`Unlinked ${target.name} (${target.deviceKey}).`);
    };
    this.remove = function (controllerObject = false) {
        if (controllerObject) {
            const target = service.getController(controllerObject.id);
            if (target) { this.cache.Remove(target.id); service.suppressController(target); service.removeController(target); }
            return;
        }
        this.cache.PurgeCache();
        for (const definition of DEVICE_DEFINITIONS) {
            const target = service.getController(definition.id);
            if (target) { service.suppressController(target); service.removeController(target); }
        }
    };
    this.Shutdown = function () {};
}
