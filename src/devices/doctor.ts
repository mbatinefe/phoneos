import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { DeviceFleet } from '../device/fleet.js';
import type { DeviceConnectionPhase } from './connection-manager.js';
import { activeDevices, defaultRegistryPath, loadRegisteredDevices } from './registry.js';
import { wdaServiceStatuses } from './wda-service-client.js';
import { resolveDerivedDataPath, resolveDeveloperDir, resolveWdaProject } from './wda/xcode-env.js';

const execFileAsync = promisify(execFile);

/**
 * `phone doctor`: everything that has to be true before an agent can drive a phone,
 * checked in the order a newcomer sets it up, each failure with the command that
 * fixes it. Facts are gathered first and judged by a pure function, so the
 * judgement is tested without a Mac, Xcode or a phone.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
    status: CheckStatus;
    title: string;
    detail?: string;
    fix?: string;
}

export interface DoctorDeviceFacts {
    name: string;
    udid: string;
    kind: 'device' | 'simulator';
    wdaPort: number;
    hasPasscode: boolean;
    present: boolean;
    ready: boolean;
    supervisor?: { wda: DeviceConnectionPhase; message: string };
    locked?: boolean;
}

export interface DoctorFacts {
    node: string;
    developerDir: string;
    /** `xcodebuild -version`'s first line, absent when it failed. */
    xcode?: string;
    wdaProjectPresent: boolean;
    envFile: boolean;
    devicesFile: { path: string; mode?: number };
    devices: DoctorDeviceFacts[];
    signing: { teamId?: string; bundleId?: string };
    builds: { simulator: boolean; device: boolean };
    serviceRunning: boolean;
    database: { configured: boolean; reachable: boolean };
}

const MIN_NODE_MAJOR = 22;

export function diagnose(facts: DoctorFacts): DoctorCheck[] {
    const checks: DoctorCheck[] = [];
    const nodeMajor = Number.parseInt(facts.node, 10);
    checks.push(nodeMajor >= MIN_NODE_MAJOR
        ? { status: 'ok', title: `Node.js ${facts.node}` }
        : { status: 'fail', title: `Node.js ${facts.node} is too old`, fix: `Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org)` });

    if (/CommandLineTools/.test(facts.developerDir)) {
        checks.push({
            status: 'fail', title: 'Xcode is not selected', detail: `xcode-select points at ${facts.developerDir}`,
            fix: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
        });
    } else if (!facts.xcode) {
        checks.push({
            status: 'fail', title: 'Xcode is not usable', detail: facts.developerDir,
            fix: 'Install Xcode from the App Store, open it once, then: sudo xcodebuild -license accept',
        });
    } else {
        checks.push({ status: 'ok', title: facts.xcode, detail: facts.developerDir });
    }

    checks.push(facts.wdaProjectPresent
        ? { status: 'ok', title: 'WebDriverAgent source present' }
        : { status: 'fail', title: 'WebDriverAgent source is not downloaded yet', fix: 'npm run wda:prepare   (downloads, patches and builds it)' });

    checks.push(facts.envFile
        ? { status: 'ok', title: '.env present' }
        : { status: 'warn', title: 'No .env (the defaults work for simulators)', fix: 'cp .env.example .env' });

    const devices = facts.devices;
    if (!devices.length) {
        checks.push({
            status: 'warn', title: 'No devices registered',
            fix: 'npm run demo (a ready simulator), or: npm run phone -- register (a USB iPhone) / npm run phone -- register-sim',
        });
    } else {
        const mode = facts.devicesFile.mode;
        checks.push(mode !== undefined && (mode & 0o077) !== 0
            ? { status: 'warn', title: `${devices.length} device${devices.length === 1 ? '' : 's'} registered, but devices.json is readable by others`, detail: 'It holds unlock passcodes', fix: `chmod 600 ${facts.devicesFile.path}` }
            : { status: 'ok', title: `${devices.length} device${devices.length === 1 ? '' : 's'} registered` });
    }

    const phones = devices.filter((device) => device.kind === 'device');
    const simulators = devices.filter((device) => device.kind === 'simulator');
    if (phones.length) {
        const missing = [
            !facts.signing.teamId || facts.signing.teamId === 'replace-me' ? 'XCODE_ORG_ID (your Team ID: Xcode → Settings → Accounts)' : '',
            !facts.signing.bundleId || facts.signing.bundleId.startsWith('com.example.') ? 'WDA_BUNDLE_ID (a bundle id you control)' : '',
        ].filter(Boolean);
        checks.push(missing.length
            ? { status: 'fail', title: 'Signing for real iPhones is not configured', fix: `Set ${missing.join(' and ')} in .env` }
            : { status: 'ok', title: `Signing team ${facts.signing.teamId}` });
    }
    if (simulators.length) {
        checks.push(facts.builds.simulator
            ? { status: 'ok', title: 'WebDriverAgent built for simulators' }
            : { status: 'fail', title: 'WebDriverAgent is not built for simulators', fix: 'npm run wda:prepare -- --sim   (a few minutes, once)' });
    }
    if (phones.length) {
        checks.push(facts.builds.device
            ? { status: 'ok', title: 'WebDriverAgent built for iPhones' }
            : { status: 'fail', title: 'WebDriverAgent is not built for iPhones', fix: 'npm run wda:prepare   (signs with your team; run it from Terminal.app, not SSH)' });
    }

    if (devices.length) {
        checks.push(facts.serviceRunning
            ? { status: 'ok', title: 'WebDriverAgent service is running' }
            : { status: 'fail', title: 'WebDriverAgent service is not running', detail: 'Nothing keeps the agent alive on the phones', fix: 'npm run wda:service   (leave it running; the MCP server also starts it by itself)' });
    }

    for (const device of devices) checks.push(diagnoseDevice(device, facts.serviceRunning));

    checks.push(!facts.database.configured
        ? { status: 'skip', title: 'Scheduler database not configured (only needed for scheduled tasks)' }
        : facts.database.reachable
            ? { status: 'ok', title: 'Scheduler database reachable' }
            : { status: 'skip', title: 'Scheduler database is not running (only needed for scheduled tasks)', fix: 'npm run db:up && npm run db:migrate' });
    return checks;
}

function diagnoseDevice(device: DoctorDeviceFacts, serviceRunning: boolean): DoctorCheck {
    const label = `${device.name} (${device.kind === 'simulator' ? 'simulator' : 'iPhone'})`;
    if (!device.present) {
        return device.kind === 'simulator'
            ? { status: 'fail', title: `${label}: not booted`, fix: `xcrun simctl boot ${device.udid} && open -a Simulator` }
            : { status: 'fail', title: `${label}: not connected`, fix: 'Plug it in with a data cable, unlock it and tap "Trust This Computer"' };
    }
    if (device.ready) {
        if (device.locked && !device.hasPasscode) {
            return { status: 'warn', title: `${label}: ready, but locked with no passcode stored`, fix: `npm run phone -- passcode -d "${device.name}"` };
        }
        return { status: 'ok', title: `${label}: ready${device.locked ? ' (locked; actions unlock it)' : ''}` };
    }
    if (!serviceRunning) return { status: 'fail', title: `${label}: agent not running`, detail: 'Waiting for the WebDriverAgent service' };
    switch (device.supervisor?.wda) {
        case 'unlock-required':
            return { status: 'fail', title: `${label}: locked, so iOS will not start the agent`, fix: 'Unlock the phone once by hand; the agent then starts by itself within seconds' };
        case 'connecting':
            return { status: 'warn', title: `${label}: agent is starting`, detail: device.supervisor.message || 'A first start can take a minute', fix: 'Wait a minute and run doctor again' };
        case 'error':
            return { status: 'fail', title: `${label}: agent failed to start`, detail: device.supervisor.message, fix: `See .wda/${device.udid}.log` };
        default:
            return { status: 'fail', title: `${label}: agent not answering on port ${device.wdaPort}`, ...(device.supervisor?.message ? { detail: device.supervisor.message } : {}), fix: `See .wda/${device.udid}.log` };
    }
}

const SYMBOLS: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

export function renderDoctor(checks: readonly DoctorCheck[]): string {
    const lines = ['phoneos doctor', ''];
    for (const check of checks) {
        lines.push(`  ${SYMBOLS[check.status]} ${check.title}`);
        if (check.detail && check.status !== 'ok') lines.push(`      ${check.detail}`);
        if (check.fix && check.status !== 'ok') lines.push(`      fix: ${check.fix}`);
    }
    const failures = checks.filter((check) => check.status === 'fail').length;
    const warnings = checks.filter((check) => check.status === 'warn').length;
    lines.push('');
    if (failures) lines.push(`${failures} problem${failures === 1 ? '' : 's'}${warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}. Fix them from the top: an early fix often clears the ones below it.`);
    else if (warnings) lines.push(`Ready, with ${warnings} warning${warnings === 1 ? '' : 's'}.`);
    else lines.push('Everything is ready.');
    return lines.join('\n');
}

function reachable(url: string | undefined, timeoutMs = 600): Promise<boolean> {
    if (!url) return Promise.resolve(false);
    let host: string;
    let port: number;
    try {
        const parsed = new URL(url);
        host = parsed.hostname || '127.0.0.1';
        port = Number(parsed.port || 5432);
    } catch {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** Look at this Mac, the repo and every registered device. Never changes anything. */
export async function gatherDoctorFacts(): Promise<DoctorFacts> {
    const developerDir = resolveDeveloperDir();
    const xcode = await execFileAsync('xcodebuild', ['-version'], { env: { ...process.env, DEVELOPER_DIR: developerDir }, timeout: 20_000 })
        .then(({ stdout }) => stdout.split('\n')[0]?.trim() || undefined, () => undefined);
    let wdaProjectPresent = false;
    try { wdaProjectPresent = existsSync(resolveWdaProject()); } catch { /* not downloaded */ }

    const registryPath = defaultRegistryPath();
    let mode: number | undefined;
    try { mode = statSync(registryPath).mode & 0o777; } catch { /* no file */ }
    const registered = activeDevices(await loadRegisteredDevices().catch(() => []));
    const statuses = registered.length ? await wdaServiceStatuses() : undefined;
    const fleet = new DeviceFleet();
    const listed = registered.length ? await fleet.list().catch(() => []) : [];

    const devices = await Promise.all(registered.map(async (device): Promise<DoctorDeviceFacts> => {
        const entry = listed.find((candidate) => candidate.registered.udid === device.udid);
        const supervisor = statuses?.find((status) => status.udid === device.udid);
        let locked: boolean | undefined;
        if (entry?.ready) locked = await (await fleet.driver(device.udid)).client.locked().catch(() => undefined);
        return {
            name: device.name, udid: device.udid, kind: device.kind ?? 'device',
            wdaPort: device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100),
            hasPasscode: Boolean(device.passcode),
            present: entry?.present ?? false, ready: entry?.ready ?? false,
            ...(supervisor ? { supervisor: { wda: supervisor.wda, message: supervisor.message } } : {}),
            ...(locked === undefined ? {} : { locked }),
        };
    }));

    const products = path.join(resolveDerivedDataPath(), 'Build/Products');
    return {
        node: process.versions.node,
        developerDir,
        ...(xcode ? { xcode } : {}),
        wdaProjectPresent,
        envFile: existsSync('.env'),
        devicesFile: { path: path.relative(process.cwd(), registryPath) || registryPath, ...(mode !== undefined ? { mode } : {}) },
        devices,
        signing: {
            ...(process.env.XCODE_ORG_ID ? { teamId: process.env.XCODE_ORG_ID } : {}),
            ...(process.env.WDA_BUNDLE_ID ? { bundleId: process.env.WDA_BUNDLE_ID } : {}),
        },
        builds: {
            simulator: existsSync(path.join(products, 'Debug-iphonesimulator/WebDriverAgentRunner-Runner.app')),
            device: existsSync(path.join(products, 'Debug-iphoneos/WebDriverAgentRunner-Runner.app')),
        },
        serviceRunning: statuses !== undefined,
        database: { configured: Boolean(process.env.DATABASE_URL), reachable: await reachable(process.env.DATABASE_URL) },
    };
}

export async function runDoctor(): Promise<{ text: string; failures: number }> {
    const checks = diagnose(await gatherDoctorFacts());
    return { text: renderDoctor(checks), failures: checks.filter((check) => check.status === 'fail').length };
}
