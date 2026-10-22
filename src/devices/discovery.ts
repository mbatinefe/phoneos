import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { modelNameForProductType, type DeviceIdentity } from '../device/identity.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
interface IosUtilities {
    getConnectedDevices(): Promise<string[]>;
    getDeviceName(udid: string): Promise<string>;
    getOSVersion(udid: string): Promise<string>;
    getDeviceInfo(udid: string): Promise<{ ProductType?: string; HardwareModel?: string }>;
}
const { utilities } = require('appium-ios-device') as { utilities: IosUtilities };

/** A device the host can currently see: a USB-attached iPhone or a booted simulator. */
export interface Device extends DeviceIdentity {
    osVersion: string;
    hardwareModel?: string;
}

export async function discoverConnectedDevices(): Promise<Device[]> {
    const udids = await discoverConnectedDeviceUdids();
    return Promise.all(udids.map(async (udid) => {
        const [name, osVersion, info] = await Promise.all([
            utilities.getDeviceName(udid), utilities.getOSVersion(udid), utilities.getDeviceInfo(udid),
        ]);
        const modelName = modelNameForProductType(info.ProductType);
        return {
            udid, kind: 'device' as const, name, osVersion,
            ...(info.ProductType ? { productType: info.ProductType } : {}),
            ...(info.HardwareModel ? { hardwareModel: info.HardwareModel } : {}),
            ...(modelName ? { modelName } : {}),
        };
    }));
}

export async function discoverConnectedDeviceUdids(): Promise<string[]> {
    return utilities.getConnectedDevices();
}

interface SimctlDevice { udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string }

/** Booted iOS simulators (`xcrun simctl list devices booted`). Empty when Xcode is absent. */
export async function discoverBootedSimulators(): Promise<Device[]> {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeout: 10_000 }));
    } catch {
        return [];
    }
    const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
    const found: Device[] = [];
    for (const [runtime, devices] of Object.entries(parsed.devices)) {
        const version = /iOS-(\d+)-(\d+)/.exec(runtime);
        const osVersion = version ? `${version[1]}.${version[2]}` : runtime;
        for (const device of devices) {
            if (device.state !== 'Booted' || device.isAvailable === false) continue;
            const modelName = modelNameForProductType(device.deviceTypeIdentifier);
            found.push({
                udid: device.udid, kind: 'simulator', name: device.name, osVersion,
                ...(device.deviceTypeIdentifier ? { productType: device.deviceTypeIdentifier } : {}),
                ...(modelName ? { modelName } : {}),
            });
        }
    }
    return found;
}

/** Everything reachable right now, devices first. */
export async function discoverAll(): Promise<Device[]> {
    const [devices, simulators] = await Promise.all([
        discoverConnectedDevices().catch(() => [] as Device[]),
        discoverBootedSimulators(),
    ]);
    return [...devices, ...simulators];
}

