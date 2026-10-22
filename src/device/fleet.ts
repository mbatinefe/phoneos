import { DeviceDriver } from './driver.js';
import type { DeviceIdentity } from './identity.js';
import { Humanizer, type HumanProfile } from '../humanize/humanizer.js';
import { discoverAll, type Device } from '../devices/discovery.js';
import { activeDevices, loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';

export interface FleetDevice {
    identity: DeviceIdentity;
    registered: RegisteredDevice;
    /** Physically attached / booted right now. */
    present: boolean;
    /** WDA answers on its port. */
    ready: boolean;
    wdaUrl: string;
}

export interface DeviceFleetOptions {
    loadDevices?: () => Promise<RegisteredDevice[]>;
    discover?: () => Promise<Device[]>;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
    /** Overrides every device's profile (e.g. the CLI's `--precise`). */
    humanProfile?: HumanProfile;
    /** A fixed seed makes every driver's gestures replayable. */
    seed?: string;
}

export function wdaUrlFor(device: RegisteredDevice): string {
    return `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
}

export function mjpegUrlFor(device: RegisteredDevice): string {
    return `http://127.0.0.1:${device.mjpegLocalPort ?? Number(process.env.MJPEG_LOCAL_PORT ?? 9100)}`;
}

export function identityOf(device: RegisteredDevice, live?: Device): DeviceIdentity {
    return {
        udid: device.udid,
        kind: device.kind ?? live?.kind ?? 'device',
        name: device.name,
        ...((live?.productType ?? device.productType) ? { productType: live?.productType ?? device.productType } : {}),
        ...((live?.modelName ?? device.modelName) ? { modelName: live?.modelName ?? device.modelName } : {}),
        ...((live?.osVersion ?? device.osVersion) ? { osVersion: live?.osVersion ?? device.osVersion } : {}),
    };
}

/**
 * One driver per registered device, built from devices.json on first use and
 * kept until `forget(udid)` (after a passcode/port/profile change).
 */
export class DeviceFleet {
    private readonly drivers = new Map<string, DeviceDriver>();
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly discover: () => Promise<Device[]>;
    private readonly fetchImpl: typeof fetch | undefined;
    private readonly log: (line: string) => void;
    private readonly humanProfile: HumanProfile | undefined;
    private readonly seed: string | undefined;

    constructor(options: DeviceFleetOptions = {}) {
        this.loadDevices = options.loadDevices ?? loadRegisteredDevices;
        this.discover = options.discover ?? discoverAll;
        this.fetchImpl = options.fetchImpl;
        this.log = options.log ?? (() => {});
        this.humanProfile = options.humanProfile;
        this.seed = options.seed;
    }

    /** The profile forced on every device for this session (the CLI's `--precise`, PHONEOS_HUMAN_PROFILE), if any. */
    get profileOverride(): HumanProfile | undefined {
        return this.humanProfile;
    }

    async registered(udid: string): Promise<RegisteredDevice> {
        const device = (await this.loadDevices()).find((entry) => entry.udid === udid);
        if (!device) throw new Error(`Device ${udid} is not registered (see devices.json / the dashboard's Register device)`);
        return device;
    }

    /** Resolve a udid, or a unique prefix / name, to a registered device. */
    async resolve(reference: string): Promise<RegisteredDevice> {
        const devices = activeDevices(await this.loadDevices());
        const exact = devices.find((entry) => entry.udid === reference);
        if (exact) return exact;
        const needle = reference.toLowerCase();
        const matches = devices.filter((entry) => entry.udid.toLowerCase().startsWith(needle) || entry.name.toLowerCase() === needle);
        if (matches.length === 1) return matches[0]!;
        if (matches.length > 1) throw new Error(`"${reference}" matches several devices: ${matches.map((entry) => `${entry.name} (${entry.udid})`).join(', ')}`);
        if (devices.length === 1 && (reference === '' || reference === 'default')) return devices[0]!;
        throw new Error(`No registered device matches "${reference}". Registered: ${devices.map((entry) => `${entry.name} (${entry.udid})`).join(', ') || 'none'}`);
    }

    async driver(udid: string): Promise<DeviceDriver> {
        const cached = this.drivers.get(udid);
        if (cached) return cached;
        const device = await this.registered(udid);
        const profile = this.humanProfile ?? device.humanProfile ?? 'natural';
        const driver = new DeviceDriver({
            identity: identityOf(device),
            wdaUrl: wdaUrlFor(device),
            mjpegUrl: mjpegUrlFor(device),
            ...(device.passcode ? { passcode: device.passcode } : {}),
            // The run seed may change every session; the persona must not — handedness is a trait of the phone's owner.
            humanizer: new Humanizer({ profile, seed: this.seed ?? `${udid}:${Date.now()}`, persona: udid }),
            ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
            log: (line) => this.log(`[${device.name}] ${line}`),
        });
        this.drivers.set(udid, driver);
        return driver;
    }

    forget(udid: string): void {
        this.drivers.delete(udid);
    }

    async list(): Promise<FleetDevice[]> {
        const [devices, live] = await Promise.all([this.loadDevices(), this.discover().catch(() => [] as Device[])]);
        const present = new Map(live.map((entry) => [entry.udid, entry]));
        return Promise.all(activeDevices(devices).map(async (device) => {
            const seen = present.get(device.udid);
            const wdaUrl = wdaUrlFor(device);
            let ready = false;
            if (seen) {
                try {
                    const driver = await this.driver(device.udid);
                    ready = await driver.isReady();
                } catch { /* unreachable */ }
            }
            return { identity: identityOf(device, seen), registered: device, present: Boolean(seen), ready, wdaUrl };
        }));
    }
}
