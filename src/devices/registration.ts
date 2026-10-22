import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeviceDriver } from '../device/driver.js';
import { identityOf } from '../device/fleet.js';
import { Humanizer, isHumanProfile, type HumanProfile } from '../humanize/humanizer.js';
import { pluginShortId, type PhoneosPlugin } from '../plugin.js';
import type { JsonObject } from '../types.js';
import { discoverAll, type Device } from './discovery.js';
import { loadRegisteredDevices, mutateRegisteredDevices, type RegisteredDevice } from './registry.js';
import { passcodeForDevice, setDevicePasscode } from './secrets.js';
import { diagnoseWdaLaunchFailure } from './wda/diagnostics.js';
import { resolveDeveloperDir } from './wda/xcode-env.js';

export type RegistrationCheckState = 'pending' | 'checking' | 'blocked' | 'passed' | 'failed';
export type RegistrationAction = 'refresh' | 'prepare' | 'verify' | 'finalize';
/**
 * Built-in check keys; app packs add `<shortId>:<checkId>` entries. Only the built-in
 * checks must pass to finish: a pack's checks say what that pack needs, and a phone is
 * useful without any pack.
 */
export type RegistrationCheckName = 'host' | 'connection' | 'signing' | 'developer' | 'wda' | 'video' | 'touch' | string;

export interface RegistrationCheck {
    state: RegistrationCheckState;
    message: string;
    updatedAt: string;
}

export interface RegistrationSnapshot {
    id: string;
    device: Device;
    name: string;
    humanProfile: HumanProfile;
    wdaLocalPort: number;
    mjpegLocalPort: number;
    /** Per-pack configuration collected by the wizard (e.g. a pack's usernames). */
    pluginData: Record<string, JsonObject>;
    hasPasscode: boolean;
    busy: boolean;
    checks: Record<RegistrationCheckName, RegistrationCheck>;
    logs: string[];
    canFinalize: boolean;
    finalized: boolean;
}

export interface RegistrationUpdate {
    name?: string;
    humanProfile?: string;
    pluginData?: Record<string, JsonObject>;
    passcode?: string;
}

interface RegistrationSession extends RegistrationSnapshot {
    passcode?: string;
    supervisor?: ChildProcess;
}

export interface DeviceRegistrationManager {
    start(): Promise<void>;
    close(): Promise<void>;
    candidates(): Promise<Device[]>;
    create(udid: string): Promise<RegistrationSnapshot>;
    get(id: string): Promise<RegistrationSnapshot | undefined>;
    update(id: string, input: RegistrationUpdate): Promise<RegistrationSnapshot>;
    run(id: string, action: RegistrationAction, options?: { authorizeTeamRegistration?: boolean }): Promise<RegistrationSnapshot>;
    cancel(id: string): Promise<void>;
}

interface RegistrationManagerOptions {
    repositoryRoot?: string;
    discoverDevices?: () => Promise<Device[]>;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    stateDirectory?: string;
    fetchImpl?: typeof fetch;
    /** Installed plugins, for their registration checks. */
    plugins?: readonly PhoneosPlugin[];
}

const builtInChecks: RegistrationCheckName[] = ['host', 'connection', 'signing', 'developer', 'wda', 'video', 'touch'];

/** A setup can finish once it has a name and every built-in check passed; a pack's checks never hold it up. */
export function readyToFinish(checks: Record<RegistrationCheckName, RegistrationCheck>, name: string): boolean {
    return Boolean(name) && Object.entries(checks).every(([key, entry]) => key.includes(':') || entry.state === 'passed');
}

function now(): string {
    return new Date().toISOString();
}

function check(state: RegistrationCheckState, message: string): RegistrationCheck {
    return { state, message, updatedAt: now() };
}

function publicSnapshot(session: RegistrationSession): RegistrationSnapshot {
    const { passcode: _passcode, supervisor: _supervisor, ...snapshot } = session;
    return structuredClone(snapshot);
}

function sanitizedLine(line: string): string {
    return line
        .replace(/(-?password\s*[=:]\s*)\S+/gi, '$1<redacted>')
        .replace(/passcode["']?\s*[:=]\s*["']?\d+/gi, 'passcode=<redacted>')
        .slice(0, 1_000);
}

async function portAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

export function allocateDevicePorts(devices: RegisteredDevice[], reserved: Array<{ wdaLocalPort: number; mjpegLocalPort: number }> = []): Promise<{ wdaLocalPort: number; mjpegLocalPort: number }> {
    return (async () => {
        const used = new Set<number>();
        for (const device of devices) {
            used.add(device.wdaLocalPort ?? 8100);
            used.add(device.mjpegLocalPort ?? 9100);
        }
        for (const pair of reserved) {
            used.add(pair.wdaLocalPort);
            used.add(pair.mjpegLocalPort);
        }
        for (let offset = 0; offset < 1_000; offset += 1) {
            const wdaLocalPort = 8100 + offset;
            const mjpegLocalPort = 9100 + offset;
            if (used.has(wdaLocalPort) || used.has(mjpegLocalPort)) continue;
            if (await portAvailable(wdaLocalPort) && await portAvailable(mjpegLocalPort)) {
                return { wdaLocalPort, mjpegLocalPort };
            }
        }
        throw new Error('No free WDA/MJPEG port pair is available');
    })();
}

export class DeviceRegistrationService implements DeviceRegistrationManager {
    private readonly workspaceRoot: string;
    private readonly packageRoot: string;
    private readonly discoverDevices: () => Promise<Device[]>;
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly stateDirectory: string;
    private readonly fetch: typeof fetch;
    private readonly plugins: readonly PhoneosPlugin[];
    private readonly sessions = new Map<string, RegistrationSession>();
    private activePreparation?: string;

    constructor(options: RegistrationManagerOptions = {}) {
        this.workspaceRoot = options.repositoryRoot ?? process.cwd();
        this.packageRoot = fileURLToPath(new URL('../../', import.meta.url));
        this.discoverDevices = options.discoverDevices ?? discoverAll;
        this.loadDevices = options.loadDevices ?? loadRegisteredDevices;
        this.stateDirectory = options.stateDirectory ?? path.join(this.workspaceRoot, '.wda/registrations');
        this.fetch = options.fetchImpl ?? fetch;
        this.plugins = options.plugins ?? [];
    }

    private checkNames(): RegistrationCheckName[] {
        return [
            ...builtInChecks,
            ...this.plugins.flatMap((plugin) => (plugin.registrationChecks ?? []).map((entry) => `${pluginShortId(plugin)}:${entry.id}`)),
        ];
    }

    async start(): Promise<void> {
        await mkdir(this.stateDirectory, { recursive: true });
        for (const entry of await readdir(this.stateDirectory)) {
            if (!entry.endsWith('.json')) continue;
            try {
                const stored = JSON.parse(await readFile(path.join(this.stateDirectory, entry), 'utf8')) as Partial<RegistrationSnapshot> & { id: string; device: Device };
                if (stored.finalized) continue;
                const hasPasscode = Boolean(await passcodeForDevice(stored.id));
                const checks = Object.fromEntries(this.checkNames().map((name) => [name, stored.checks?.[name] ?? check('pending', 'Not checked yet')]));
                this.sessions.set(stored.id, {
                    id: stored.id, device: stored.device, name: stored.name ?? stored.device.name,
                    humanProfile: isHumanProfile(stored.humanProfile) ? stored.humanProfile : 'natural',
                    wdaLocalPort: stored.wdaLocalPort ?? 8100, mjpegLocalPort: stored.mjpegLocalPort ?? 9100,
                    pluginData: stored.pluginData ?? {}, hasPasscode, busy: false, checks,
                    logs: stored.logs ?? [], canFinalize: false, finalized: false,
                });
            } catch {
                // Ignore an incomplete local draft and let the user start again.
            }
        }
    }

    async close(): Promise<void> {
        await Promise.all(Array.from(this.sessions.values(), (session) => this.stopSupervisor(session)));
    }

    async candidates(): Promise<Device[]> {
        const [connected, registered] = await Promise.all([this.discoverDevices(), this.loadDevices()]);
        const known = new Set(registered.map(({ udid }) => udid));
        return connected.filter(({ udid }) => !known.has(udid) || this.sessions.get(udid)?.finalized === false);
    }

    async create(udid: string): Promise<RegistrationSnapshot> {
        const existing = this.sessions.get(udid);
        if (existing) {
            await this.refresh(existing);
            await this.persist(existing);
            return publicSnapshot(existing);
        }
        const candidate = (await this.candidates()).find((device) => device.udid === udid);
        if (!candidate) throw new Error('The selected device is not connected or is already registered');
        const ports = await allocateDevicePorts(await this.loadDevices(), Array.from(this.sessions.values()));
        const checks = Object.fromEntries(this.checkNames().map((name) => [name, check('pending', 'Not checked yet')]));
        const session: RegistrationSession = {
            id: udid, device: candidate, name: candidate.name, humanProfile: 'natural', ...ports,
            pluginData: {}, hasPasscode: false, busy: false, checks, logs: [], canFinalize: false, finalized: false,
        };
        this.sessions.set(udid, session);
        await this.refresh(session);
        return publicSnapshot(session);
    }

    async get(id: string): Promise<RegistrationSnapshot | undefined> {
        const session = this.sessions.get(id);
        return session ? publicSnapshot(session) : undefined;
    }

    async update(id: string, input: RegistrationUpdate): Promise<RegistrationSnapshot> {
        const session = this.required(id);
        if (session.busy) throw new Error('Wait for the current registration check to finish');
        if (input.name !== undefined) {
            const name = input.name.trim();
            if (!name) throw new Error('Device name is required');
            session.name = name.slice(0, 100);
        }
        if (input.humanProfile !== undefined) {
            if (!isHumanProfile(input.humanProfile)) throw new Error('humanProfile must be precise, natural, or relaxed');
            session.humanProfile = input.humanProfile;
        }
        if (input.pluginData !== undefined) {
            if (!input.pluginData || typeof input.pluginData !== 'object' || Array.isArray(input.pluginData)) throw new Error('pluginData must be an object');
            session.pluginData = structuredClone(input.pluginData);
            for (const name of Object.keys(session.checks)) {
                if (name.includes(':')) session.checks[name] = check('pending', 'Re-verify after changing app settings');
            }
        }
        if (input.passcode !== undefined) {
            if (input.passcode && !/^\d{4,}$/.test(input.passcode)) throw new Error('Device passcode must contain at least four digits');
            session.passcode = input.passcode || undefined;
            session.hasPasscode = Boolean(input.passcode);
        }
        this.recalculate(session);
        await this.persist(session);
        return publicSnapshot(session);
    }

    async run(id: string, action: RegistrationAction, options: { authorizeTeamRegistration?: boolean } = {}): Promise<RegistrationSnapshot> {
        const session = this.required(id);
        if (session.busy) throw new Error('A registration action is already running');
        if (action === 'prepare' && this.activePreparation && this.activePreparation !== id) {
            throw new Error('Another device is currently being provisioned by Xcode');
        }
        if (action === 'finalize') {
            session.busy = true;
            try {
                return await this.finalize(session);
            } finally {
                session.busy = false;
                await this.persist(session);
            }
        }
        if (action === 'prepare') this.activePreparation = id;
        session.busy = true;
        void (async () => {
            try {
                if (action === 'refresh') await this.refresh(session);
                if (action === 'prepare') await this.prepare(session, Boolean(options.authorizeTeamRegistration));
                if (action === 'verify') await this.verify(session);
            } catch (error) {
                this.log(session, error instanceof Error ? error.message : String(error));
            } finally {
                if (action === 'prepare' && this.activePreparation === id) this.activePreparation = undefined;
                session.busy = false;
                this.recalculate(session);
                await this.persist(session).catch((error: unknown) => {
                    this.log(session, `Failed to persist registration state: ${error instanceof Error ? error.message : String(error)}`);
                });
            }
        })().catch((error: unknown) => {
            console.error('Registration background task crashed:', error);
        });
        await this.persist(session);
        return publicSnapshot(session);
    }

    async cancel(id: string): Promise<void> {
        const session = this.required(id);
        await this.stopSupervisor(session);
        this.sessions.delete(id);
        await rm(this.statePath(id), { force: true });
    }

    private required(id: string): RegistrationSession {
        const session = this.sessions.get(id);
        if (!session) throw new Error('Registration draft not found');
        return session;
    }

    private isSimulator(session: RegistrationSession): boolean {
        return session.device.kind === 'simulator';
    }

    private driverFor(session: RegistrationSession): DeviceDriver {
        return new DeviceDriver({
            identity: identityOf({ name: session.name, udid: session.device.udid, kind: session.device.kind, pluginData: {} }, session.device),
            wdaUrl: `http://127.0.0.1:${session.wdaLocalPort}`,
            mjpegUrl: `http://127.0.0.1:${session.mjpegLocalPort}`,
            ...(session.passcode ? { passcode: session.passcode } : {}),
            humanizer: new Humanizer({ profile: session.humanProfile, seed: `registration:${session.id}` }),
            fetchImpl: this.fetch,
            log: (line) => this.log(session, line),
        });
    }

    private async refresh(session: RegistrationSession): Promise<void> {
        session.checks.host = check('checking', 'Checking local iOS tooling');
        session.checks.connection = check('checking', this.isSimulator(session) ? 'Checking the simulator' : 'Checking the USB device');
        try {
            // The WebDriverAgent source is downloaded by the build step, so only Xcode is checked here.
            await access(resolveDeveloperDir());
            session.checks.host = check('passed', 'Xcode is available');
        } catch {
            session.checks.host = check('blocked', 'Install Xcode (xcode-select -p must point at it)');
        }
        const connected = (await this.discoverDevices()).find(({ udid }) => udid === session.device.udid);
        if (connected) {
            session.device = connected;
            session.checks.connection = check('passed', this.isSimulator(session)
                ? `${connected.name} (simulator) is booted`
                : `${connected.name} is connected, paired, and readable over USB`);
        } else {
            session.checks.connection = check('blocked', this.isSimulator(session)
                ? 'Boot the simulator (xcrun simctl boot <udid>)'
                : 'Reconnect USB, unlock the device, and accept Trust This Computer');
        }
        if (this.isSimulator(session)) {
            session.checks.signing = check('passed', 'Simulator builds are unsigned');
            session.checks.developer = check('passed', 'Developer Mode does not apply to simulators');
        } else {
            const signingValues = ['XCODE_ORG_ID', 'WDA_BUNDLE_ID'].filter((name) => !process.env[name]);
            session.checks.signing = signingValues.length
                ? check('blocked', `Configure ${signingValues.join(' and ')} in .env after signing in to Xcode`)
                : check('passed', 'Shared WDA signing settings are configured');
        }
        await this.inspectWda(session);
        await this.persist(session);
    }

    private async prepare(session: RegistrationSession, authorized: boolean): Promise<void> {
        if (session.checks.connection!.state !== 'passed' || session.checks.host!.state !== 'passed') {
            throw new Error('Connect the device and complete host setup before preparing WDA');
        }
        const simulator = this.isSimulator(session);
        if (!simulator) {
            session.checks.signing = check('checking', 'Building and provisioning WebDriverAgent');
            session.checks.developer = check('checking', 'Checking Developer Mode through an Xcode device build');
        }
        session.checks.wda = check('checking', 'Preparing WebDriverAgent');
        const prepareScript = path.join(this.packageRoot, 'src/devices/wda/prepare.ts');
        const result = await this.runCommand(session, process.execPath, [
            '--env-file-if-exists=.env', '--import', 'tsx', prepareScript,
        ], {
            ...process.env,
            IOS_UDID: session.device.udid,
            ...(simulator ? { IOS_SIMULATOR: 'true' } : {}),
            WDA_LOCAL_PORT: String(session.wdaLocalPort),
            MJPEG_LOCAL_PORT: String(session.mjpegLocalPort),
            ALLOW_PROVISIONING_DEVICE_REGISTRATION: String(authorized),
        });
        if (!result.ok) {
            const diagnosis = diagnoseWdaLaunchFailure(result.output) ?? 'WDA preparation failed; inspect the sanitized setup log';
            const target: RegistrationCheckName = /Developer Mode/i.test(diagnosis) ? 'developer' : 'signing';
            if (!simulator) session.checks[target] = check('blocked', diagnosis);
            session.checks.wda = check('failed', diagnosis);
            return;
        }
        if (!simulator) {
            session.checks.signing = check('passed', 'Xcode signing and provisioning succeeded');
            session.checks.developer = check('passed', 'The device accepted an Xcode development build');
        }
        await this.startSupervisor(session);
        const ready = await this.waitForEndpoint(`http://127.0.0.1:${session.wdaLocalPort}/status`, 180_000);
        if (!ready) {
            session.checks.wda = check('blocked', simulator
                ? 'WDA did not become ready on the simulator; inspect the setup log'
                : 'WDA did not become ready; unlock the phone and trust WebDriverAgent under VPN & Device Management if prompted');
            return;
        }
        session.checks.wda = check('passed', 'WebDriverAgent is installed, running, and reachable');
    }

    private async verify(session: RegistrationSession): Promise<void> {
        await this.inspectWda(session);
        if (session.checks.wda!.state !== 'passed') throw new Error('Prepare and start WDA before runtime verification');
        session.checks.video = check('checking', 'Reading the WDA video stream');
        session.checks.touch = check('checking', 'Checking observation and touch input');
        const driver = this.driverFor(session);
        try {
            const stream = await driver.mjpegStream();
            const reader = stream.body!.getReader();
            const first = await reader.read();
            await reader.cancel();
            if (first.done || !first.value?.length) throw new Error('The WDA video stream returned no frames');
            session.checks.video = check('passed', 'WDA returned a live MJPEG frame');
        } catch (error) {
            session.checks.video = check('failed', error instanceof Error ? error.message : String(error));
        }
        try {
            await driver.unlock();
            await driver.openApp('com.apple.Preferences');
            await driver.wait(1_200);
            const before = await driver.observe({ tree: true });
            if (before.treeStatus !== 'ok' || !before.elements.length) throw new Error(`Could not read the Settings screen (${before.treeStatus})`);
            const target = before.elements.find((element) => element.type === 'Cell' && element.enabled) ?? before.elements.find((element) => element.interactive);
            if (!target) throw new Error('Settings showed no tappable element');
            await driver.tap({ elementId: target.id });
            await driver.wait(1_000);
            const after = await driver.observe({ tree: true });
            const signature = (elements: typeof before.elements) => elements.map((element) => `${element.type}:${element.label ?? element.name ?? ''}`).join('|');
            if (signature(before.elements) === signature(after.elements)) throw new Error(`Tapping "${target.label ?? target.name ?? target.id}" produced no visible change`);
            await driver.home();
            session.checks.touch = check('passed', `Observed ${before.elements.length} elements and a tap on "${target.label ?? target.name ?? target.type}" changed the screen`);
        } catch (error) {
            session.checks.touch = check('failed', error instanceof Error ? error.message : String(error));
        }
        const identity = identityOf({ name: session.name, udid: session.device.udid, kind: session.device.kind, pluginData: {} }, session.device);
        for (const plugin of this.plugins) {
            for (const entry of plugin.registrationChecks ?? []) {
                const key = `${pluginShortId(plugin)}:${entry.id}`;
                session.checks[key] = check('checking', entry.displayName);
                try {
                    const result = await entry.run(identity, session.pluginData[plugin.id] ?? {}, { driver, log: (line) => this.log(session, line) });
                    session.checks[key] = check(result.status, result.message);
                } catch (error) {
                    session.checks[key] = check('failed', error instanceof Error ? error.message : String(error));
                }
            }
        }
    }

    private async finalize(session: RegistrationSession): Promise<RegistrationSnapshot> {
        this.recalculate(session);
        if (!session.canFinalize) throw new Error('Every built-in readiness check must pass before registration can finish');
        const added = await mutateRegisteredDevices((devices) => {
            if (devices.some(({ udid }) => udid === session.device.udid)) return false;
            devices.push({
                name: session.name,
                udid: session.device.udid,
                ...(this.isSimulator(session) ? { kind: 'simulator' as const } : {}),
                ...(session.device.productType ? { productType: session.device.productType } : {}),
                ...(session.device.modelName ? { modelName: session.device.modelName } : {}),
                ...(session.device.osVersion ? { osVersion: session.device.osVersion } : {}),
                wdaLocalPort: session.wdaLocalPort,
                mjpegLocalPort: session.mjpegLocalPort,
                humanProfile: session.humanProfile,
                ...(session.passcode ? { passcode: session.passcode } : {}),
                pluginData: structuredClone(session.pluginData),
            });
            return true;
        });
        if (!added && session.passcode) {
            await setDevicePasscode(session.device.udid, session.passcode);
        }
        session.checks.wda = check('checking', 'Handing WDA ownership to the persistent fleet service');
        await this.stopSupervisor(session);
        if (!(await this.waitForEndpoint(`http://127.0.0.1:${session.wdaLocalPort}/status`, 45_000))) {
            session.checks.wda = check('blocked', 'The device is saved, but the fleet WDA service is not ready yet (is `npm run wda:service` running?); recheck and finish again');
            this.recalculate(session);
            await this.persist(session);
            return publicSnapshot(session);
        }
        session.checks.wda = check('passed', 'Persistent fleet WDA is ready');
        session.finalized = true;
        this.recalculate(session);
        await this.persist(session);
        return publicSnapshot(session);
    }

    private async inspectWda(session: RegistrationSession): Promise<void> {
        const ready = await this.waitForEndpoint(`http://127.0.0.1:${session.wdaLocalPort}/status`, 5_000);
        session.checks.wda = ready ? check('passed', 'WebDriverAgent is reachable') : check('pending', 'Prepare WebDriverAgent for this device');
    }

    private async startSupervisor(session: RegistrationSession): Promise<void> {
        await this.stopSupervisor(session);
        const script = path.join(this.packageRoot, 'src/devices/wda/start.ts');
        const child = spawn(process.execPath, [
            '--env-file-if-exists=.env', '--import', 'tsx', script,
        ], {
            cwd: this.workspaceRoot,
            env: {
                ...process.env,
                IOS_UDID: session.device.udid,
                ...(this.isSimulator(session) ? { IOS_SIMULATOR: 'true' } : {}),
                WDA_LOCAL_PORT: String(session.wdaLocalPort),
                MJPEG_LOCAL_PORT: String(session.mjpegLocalPort),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        session.supervisor = child;
        const append = (chunk: Buffer) => {
            for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) this.log(session, line);
        };
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        child.once('exit', () => { if (session.supervisor === child) session.supervisor = undefined; });
    }

    private async stopSupervisor(session: RegistrationSession): Promise<void> {
        const child = session.supervisor;
        session.supervisor = undefined;
        if (!child || child.exitCode !== null || child.killed) return;
        child.kill('SIGTERM');
        await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
    }

    private async runCommand(session: RegistrationSession, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
        return new Promise((resolve) => {
            const child = spawn(command, args, { cwd: this.workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            const append = (chunk: Buffer) => {
                const value = chunk.toString();
                output = `${output}${value}`.slice(-100_000);
                for (const line of value.split(/\r?\n/).filter(Boolean)) this.log(session, line);
            };
            child.stdout.on('data', append);
            child.stderr.on('data', append);
            child.once('error', (error) => resolve({ ok: false, output: `${output}\n${error.message}` }));
            child.once('exit', (code) => resolve({ ok: code === 0, output }));
        });
    }

    private async endpointReady(url: string): Promise<boolean> {
        try {
            const response = await this.fetch(url, { signal: AbortSignal.timeout(2_000) });
            return response.ok;
        } catch {
            return false;
        }
    }

    private async waitForEndpoint(url: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.endpointReady(url)) return true;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        return false;
    }

    private recalculate(session: RegistrationSession): void {
        session.canFinalize = readyToFinish(session.checks, session.name);
    }

    private log(session: RegistrationSession, value: string): void {
        const line = sanitizedLine(value.trim());
        if (!line) return;
        session.logs.push(line);
        session.logs = session.logs.slice(-100);
    }

    private statePath(id: string): string {
        return path.join(this.stateDirectory, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }

    private async persist(session: RegistrationSession): Promise<void> {
        await mkdir(this.stateDirectory, { recursive: true });
        const target = this.statePath(session.id);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(publicSnapshot(session), null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, target);
    }
}
