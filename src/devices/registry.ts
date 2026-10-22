import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeviceKind } from '../device/identity.js';
import type { HumanProfile } from '../humanize/humanizer.js';
import { isHumanProfile } from '../humanize/humanizer.js';
import type { JsonObject } from '../types.js';

export interface Point { x: number; y: number }

export interface RegisteredDevice {
    name: string;
    udid: string;
    /** `device` (USB iPhone, default) or `simulator` (booted iOS Simulator). */
    kind?: DeviceKind;
    productType?: string;
    modelName?: string;
    osVersion?: string;
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    /** Device unlock passcode. Lives here (devices.json is 0600 and git-ignored), never in an API response. */
    passcode?: string;
    /** How gestures are humanised on this device; default `natural`. */
    humanProfile?: HumanProfile;
    /** Named tap-point overrides that app packs may consult (dashboard calibration). */
    coordinates?: Record<string, Point>;
    /** When true phoneos keeps the entry but stops supervising it — no WDA, no worker, no discovery polling. */
    disabled?: boolean;
    pluginData: Record<string, JsonObject>;
}

/** Devices phoneos should actively supervise (everything except the disabled ones). */
export function activeDevices(devices: readonly RegisteredDevice[]): RegisteredDevice[] {
    return devices.filter((device) => !device.disabled);
}

export const PASSCODE_PATTERN = /^\d{4,}$/;
/** Device and simulator UDIDs are letters, digits and hyphens; anything else never reaches a command line. */
export const UDID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** A device with its passcode removed and a boolean marker in its place — safe to serialize. */
export function redactDevice<T extends { passcode?: string }>(device: T): Omit<T, 'passcode'> & { hasPasscode: boolean } {
    const { passcode, ...rest } = device;
    return { ...rest, hasPasscode: Boolean(passcode) };
}

/** Validate a named-point override map: `{ name: { x, y } }` with finite, non-negative numbers. Bounds are checked at use time against the live screen. */
export function validateCoordinateOverrides(value: unknown): Record<string, Point> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coordinates must be an object');
    const result: Record<string, Point> = {};
    for (const [key, point] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) throw new Error(`Invalid point name "${key}"`);
        if (!point || typeof point !== 'object') throw new Error(`${key} must be a {x, y} point`);
        const { x, y } = point as { x: unknown; y: unknown };
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 5000 || y > 5000) {
            throw new Error(`${key} x and y must be non-negative point coordinates`);
        }
        result[key] = { x: Math.round(x), y: Math.round(y) };
    }
    return result;
}

/** Resolved per call so tests (and tools) can point `DEVICES_CONFIG_PATH` elsewhere after import. */
export function defaultRegistryPath(): string {
    return path.resolve(process.env.DEVICES_CONFIG_PATH ?? 'devices.json');
}

export async function loadRegisteredDevices(registryPath = defaultRegistryPath()): Promise<RegisteredDevice[]> {
    let raw: string;
    try {
        raw = await readFile(registryPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let devices: RegisteredDevice[];
    try {
        devices = JSON.parse(raw) as RegisteredDevice[];
    } catch (error) {
        throw new Error(`${registryPath} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const device of devices) {
        device.pluginData ??= {};
        if (device.humanProfile !== undefined && !isHumanProfile(device.humanProfile)) delete device.humanProfile;
    }
    return devices;
}

export async function saveRegisteredDevices(devices: RegisteredDevice[], registryPath = defaultRegistryPath()): Promise<void> {
    const unique = new Set<string>();
    for (const device of devices) {
        if (!UDID_PATTERN.test(device.udid)) throw new Error(`Device UDID ${JSON.stringify(device.udid)} must be letters, digits and hyphens`);
        if (device.passcode !== undefined && !PASSCODE_PATTERN.test(device.passcode)) {
            throw new Error(`Device ${device.udid} passcode must contain at least four digits`);
        }
        if (device.coordinates !== undefined) {
            device.coordinates = validateCoordinateOverrides(device.coordinates);
            if (Object.keys(device.coordinates).length === 0) delete device.coordinates;
        }
        if (device.humanProfile !== undefined && !isHumanProfile(device.humanProfile)) {
            throw new Error(`Device ${device.udid} humanProfile must be precise, natural, or relaxed`);
        }
        if (device.kind === 'device') delete device.kind;
        if (device.disabled !== true) delete device.disabled;
        if (unique.has(device.udid)) throw new Error(`Device ${device.udid} is already registered`);
        unique.add(device.udid);
    }
    await mkdir(path.dirname(registryPath), { recursive: true });
    const temporaryPath = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, registryPath);
}

// Every load-modify-save of devices.json in one process must go through here,
// or two overlapping mutations (a passcode save racing a disable toggle) each
// read the same file and the second write clobbers the first.
let registryMutation: Promise<unknown> = Promise.resolve();

export function mutateRegisteredDevices<T>(
    mutate: (devices: RegisteredDevice[]) => T | Promise<T>,
    registryPath = defaultRegistryPath(),
): Promise<T> {
    const run = registryMutation.then(async () => {
        const devices = await loadRegisteredDevices(registryPath);
        const result = await mutate(devices);
        await saveRegisteredDevices(devices, registryPath);
        return result;
    });
    registryMutation = run.catch(() => undefined);
    return run;
}
