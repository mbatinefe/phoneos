import { discoverAll, type Device } from '../discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../registry.js';
import type { BuildDestination } from './xcode-env.js';

export interface ResolveTargetOptions {
    /** Defaults to `process.argv`. */
    argv?: readonly string[];
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Injectable for tests. Defaults to reading `devices.json`. */
    loadRegistered?: () => Promise<Array<Pick<RegisteredDevice, 'udid' | 'name' | 'kind' | 'osVersion'>>>;
    /** Injectable for tests. Defaults to a USB + simulator scan. */
    loadConnected?: () => Promise<Array<Pick<Device, 'udid' | 'kind'> & { osVersion?: string }>>;
}

function udidFromArgv(argv: readonly string[]): string | undefined {
    const flag = argv.indexOf('--udid');
    if (flag >= 0) {
        const value = argv[flag + 1];
        if (!value || value.startsWith('-')) throw new Error('--udid needs a device UDID');
        return value;
    }
    const inline = argv.find((entry) => entry.startsWith('--udid='));
    return inline ? inline.slice('--udid='.length) : undefined;
}

/**
 * Which device a WDA CLI command (`wda:prepare`, `wda:start`) should target, in
 * priority order:
 *
 *   1. `--udid <udid>` (or `--udid=<udid>`) on the command line
 *   2. `IOS_UDID` in the environment
 *   3. the only device in `devices.json`
 *   4. the only iPhone / booted simulator currently visible
 *
 * Anything ambiguous or empty throws with a message that names the options.
 * `--sim` (or `IOS_SIMULATOR=true`) marks the target as a simulator when it
 * is not registered yet.
 */
export async function resolveTarget(options: ResolveTargetOptions = {}): Promise<BuildDestination> {
    const argv = options.argv ?? process.argv;
    const env = options.env ?? process.env;
    const loadRegistered = options.loadRegistered ?? (() => loadRegisteredDevices());
    const loadConnected = options.loadConnected ?? discoverAll;
    const simulatorFlag = argv.includes('--sim') || env.IOS_SIMULATOR === 'true';

    const describe = async (udid: string): Promise<BuildDestination> => {
        const registered = (await loadRegistered()).find((entry) => entry.udid === udid);
        const connected = (await loadConnected().catch(() => [])).find((entry) => entry.udid === udid);
        const osVersion = registered?.osVersion ?? connected?.osVersion;
        return {
            udid,
            kind: simulatorFlag ? 'simulator' : registered?.kind ?? connected?.kind ?? 'device',
            ...(osVersion ? { osVersion } : {}),
        };
    };

    const fromArgv = udidFromArgv(argv);
    if (fromArgv) return describe(fromArgv);
    if (env.IOS_UDID) return describe(env.IOS_UDID);

    const registered = await loadRegistered();
    if (registered.length === 1) return describe(registered[0]!.udid);
    if (registered.length > 1) {
        throw new Error(
            `devices.json has ${registered.length} devices — pass --udid <udid>. Registered: `
            + registered.map(({ udid, name }) => `${udid} (${name})`).join(', '),
        );
    }

    const connected = await loadConnected();
    if (connected.length === 1) return describe(connected[0]!.udid);
    if (connected.length > 1) {
        throw new Error(`${connected.length} devices are connected — pass --udid <udid>: ${connected.map((entry) => entry.udid).join(', ')}`);
    }

    throw new Error(
        'No target device. Connect an iPhone, boot a simulator, register one in the dashboard, '
        + 'or pass --udid <udid> (xcrun xctrace list devices / xcrun simctl list devices booted).',
    );
}

/** Every device to build WDA for: all of `devices.json` with `--all`, otherwise a single resolved target. */
export async function resolveBuildTargets(options: ResolveTargetOptions = {}): Promise<BuildDestination[]> {
    const argv = options.argv ?? process.argv;
    if (argv.includes('--all')) {
        const loadRegistered = options.loadRegistered ?? (() => loadRegisteredDevices());
        const registered = await loadRegistered();
        if (registered.length === 0) throw new Error('--all was given but devices.json has no devices');
        return registered.map(({ udid, kind, osVersion }) => ({ udid, kind: kind ?? 'device', ...(osVersion ? { osVersion } : {}) }));
    }
    return [await resolveTarget(options)];
}
