import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { HumanProfile } from '../humanize/humanizer.js';
import { discoverBootedSimulators } from './discovery.js';
import { allocateDevicePorts } from './registration.js';
import { loadRegisteredDevices, mutateRegisteredDevices, type RegisteredDevice } from './registry.js';

const execFileAsync = promisify(execFile);

interface SimctlRuntime { identifier: string; name: string; isAvailable: boolean; platform?: string }
interface SimctlDeviceType { identifier: string; name: string; productFamily?: string }

/** The iPhone a new simulator is made from when none is named: the newest "Pro" model Xcode offers. */
export function defaultDeviceType(types: readonly SimctlDeviceType[]): SimctlDeviceType | undefined {
    const iphones = types.filter((entry) => /^iPhone \d+/.test(entry.name));
    const generation = (entry: SimctlDeviceType) => Number(/^iPhone (\d+)/.exec(entry.name)?.[1] ?? 0);
    const newest = Math.max(0, ...iphones.map(generation));
    return iphones.find((entry) => generation(entry) === newest && / Pro$/.test(entry.name))
        ?? iphones.find((entry) => generation(entry) === newest)
        ?? types.find((entry) => entry.name.startsWith('iPhone'));
}

/** Create a simulator (newest iOS runtime unless one is named), boot it and show it. */
export async function createSimulator(deviceType?: string, runtime?: string): Promise<{ udid: string; name: string; runtime: string }> {
    const { stdout: runtimesJson } = await execFileAsync('xcrun', ['simctl', 'list', 'runtimes', '-j']);
    const runtimes = (JSON.parse(runtimesJson) as { runtimes: SimctlRuntime[] }).runtimes
        .filter((entry) => entry.isAvailable && (entry.platform === 'iOS' || entry.identifier.includes('.iOS-')));
    const chosen = runtime ? runtimes.find((entry) => entry.identifier.endsWith(runtime) || entry.name === runtime) : runtimes[runtimes.length - 1];
    if (!chosen) {
        throw new Error(runtimes.length
            ? `Runtime not found. Available: ${runtimes.map((entry) => entry.identifier.split('.').pop()).join(', ')}`
            : 'No iOS simulator runtime is installed. Install one in Xcode → Settings → Components.');
    }
    const { stdout: typesJson } = await execFileAsync('xcrun', ['simctl', 'list', 'devicetypes', '-j']);
    const types = (JSON.parse(typesJson) as { devicetypes: SimctlDeviceType[] }).devicetypes;
    const type = deviceType
        ? types.find((entry) => entry.name.toLowerCase() === deviceType.toLowerCase() || entry.identifier === deviceType)
        : defaultDeviceType(types);
    if (!type) throw new Error(`Device type not found. Try: ${types.filter((entry) => entry.name.startsWith('iPhone')).map((entry) => entry.name).join(', ')}`);
    const name = `${type.name} (phoneos)`;
    const { stdout: udid } = await execFileAsync('xcrun', ['simctl', 'create', name, type.identifier, chosen.identifier]);
    await bootSimulator(udid.trim());
    return { udid: udid.trim(), name, runtime: chosen.name };
}

/**
 * Boot a simulator (a no-op when it already runs), wait until iOS has finished starting, and
 * show it. A new simulator's first boot migrates its data and can take ten minutes.
 */
export async function bootSimulator(udid: string): Promise<void> {
    await execFileAsync('xcrun', ['simctl', 'boot', udid]).catch((error: { stderr?: string }) => {
        if (!/current state: Booted/i.test(error.stderr ?? '')) throw error;
    });
    await execFileAsync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: 15 * 60_000 });
    await execFileAsync('open', ['-a', 'Simulator']).catch(() => undefined);
}

/**
 * Add a booted simulator to devices.json with free ports. With no reference, the only
 * booted simulator. Returns the existing entry when it is already registered.
 */
export async function registerSimulator(reference: string | undefined, name: string | undefined, profile: HumanProfile): Promise<{ device: RegisteredDevice; created: boolean }> {
    const booted = await discoverBootedSimulators();
    if (!booted.length) throw new Error('No booted simulator. Boot one (xcrun simctl boot <udid> / open Simulator.app) or run `phone sim-create "iPhone 17 Pro"`.');
    const needle = (reference ?? '').toLowerCase();
    const simulator = needle
        ? booted.find((entry) => entry.udid.toLowerCase() === needle || entry.name.toLowerCase() === needle || entry.udid.toLowerCase().startsWith(needle))
        : booted.length === 1 ? booted[0] : undefined;
    if (!simulator) throw new Error(`Which simulator? Booted: ${booted.map((entry) => `${entry.name} (${entry.udid})`).join(', ')}`);
    const existing = (await loadRegisteredDevices()).find((entry) => entry.udid === simulator.udid);
    if (existing) return { device: existing, created: false };
    const ports = await allocateDevicePorts(await loadRegisteredDevices());
    const device: RegisteredDevice = {
        name: name ?? simulator.name, udid: simulator.udid, kind: 'simulator',
        ...(simulator.productType ? { productType: simulator.productType } : {}),
        ...(simulator.modelName ? { modelName: simulator.modelName } : {}),
        osVersion: simulator.osVersion, ...ports, humanProfile: profile, pluginData: {},
    };
    await mutateRegisteredDevices((devices) => { devices.push(device); });
    return { device, created: true };
}
