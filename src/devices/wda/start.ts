import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { forwardDevicePort, type PortForward } from '../../device/port-forward.js';
import { diagnoseWdaLaunchFailure, unavailableLimitMs, wdaUnavailableTooLong } from './diagnostics.js';
import { ensureRunnerInstalled, launchRunnerViaTestmanagerd, usesTestmanagerdLaunch, type RunnerHandle } from './runner.js';
import { resolveTarget } from './target-device.js';
import { deploymentTarget, destinationArgument, resolveDerivedDataPath, resolveDeveloperDir, resolveWdaProject, signingArguments } from './xcode-env.js';

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type WdaState = 'disconnected' | 'connecting' | 'unlock-required' | 'ready' | 'error';

let lastState = '';
function report(state: WdaState, message: string): void {
    const value = JSON.stringify({ state, message });
    if (value === lastState) return;
    lastState = value;
    console.log(`[wda-state] ${value}`);
}

// `--udid <udid>`, else IOS_UDID, else the sole registered device, else the sole connected one.
const target = await resolveTarget();
const { udid } = target;
const simulator = target.kind === 'simulator';
// iOS ≤ 16 phones can't be driven by Xcode 26's test stack; the runner is installed and started via testmanagerd instead.
const viaTestmanagerd = !simulator && usesTestmanagerdLaunch(target.osVersion);
const developerDir = resolveDeveloperDir();
const projectPath = resolveWdaProject();
const localPort = Number.parseInt(process.env.WDA_LOCAL_PORT ?? '8100', 10);
const remotePort = Number.parseInt(process.env.WDA_REMOTE_PORT ?? '8100', 10);
const mjpegLocalPort = Number.parseInt(process.env.MJPEG_LOCAL_PORT ?? '9100', 10);
const mjpegRemotePort = Number.parseInt(process.env.MJPEG_REMOTE_PORT ?? '9100', 10);

await access(projectPath);
if (![localPort, remotePort, mjpegLocalPort, mjpegRemotePort].every(Number.isSafeInteger)) {
    throw new Error('WDA and MJPEG port values must be integers');
}

// Two supervisors racing on the same device corrupt the shared WDA build (concurrent
// installs can leave WebDriverAgentRunner-Runner.app with no executable inside it), so
// only one `start.ts` per UDID is allowed at a time — whether spawned by wda-service.ts
// or run directly via `npm run wda:start`.
const lockPath = path.resolve('.wda', `${udid}.supervisor.lock`);

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function acquireDeviceLock(): Promise<void> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    for (;;) {
        try {
            await writeFile(lockPath, String(process.pid), { flag: 'wx' });
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const holder = Number.parseInt((await readFile(lockPath, 'utf8').catch(() => '')).trim(), 10);
        if (Number.isInteger(holder) && holder > 0 && isProcessAlive(holder)) {
            throw new Error(`Another WDA supervisor (pid ${holder}) is already managing device ${udid}. `
                + 'Stop it first — running two supervisors for the same device corrupts the shared build.');
        }
        await rm(lockPath, { force: true }); // stale lock from a crashed/killed supervisor
    }
}

async function releaseDeviceLock(): Promise<void> {
    await rm(lockPath, { force: true }).catch(() => {});
}

await acquireDeviceLock();

// appium-ios-device's testmanagerd launcher writes the test configuration through an AFC stream whose
// close acknowledgement can time out *after* the runner is already up; the library reports that as an
// unhandled stream error. It is harmless once the launch succeeded, so log it instead of dying.
process.on('uncaughtException', (error) => {
    if (/Close file handle|AfcWritableFileStream/.test(String(error))) {
        console.warn(`Ignoring late AFC stream error from the runner launcher: ${error.message}`);
        return;
    }
    console.error(error);
    void shutdown().finally(() => process.exit(1));
});

const require = createRequire(import.meta.url);
const { utilities } = require('appium-ios-device') as { utilities: { getConnectedDevices(): Promise<string[]> } };

async function deviceAttached(): Promise<boolean> {
    if (simulator) {
        const { execFile } = await import('node:child_process');
        return new Promise((resolve) => {
            execFile('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeout: 10_000 }, (error, stdout) => {
                if (error) return resolve(false);
                resolve(stdout.includes(udid));
            });
        });
    }
    return (await utilities.getConnectedDevices()).includes(udid);
}

const args = [
    'test-without-building',
    '-project', projectPath,
    '-scheme', 'WebDriverAgentRunner',
    '-derivedDataPath', resolveDerivedDataPath(),
    '-destination', destinationArgument(target),
    ...(simulator ? [] : [`IPHONEOS_DEPLOYMENT_TARGET=${deploymentTarget(target)}`]),
    ...signingArguments(target),
    'GCC_TREAT_WARNINGS_AS_ERRORS=0',
    'COMPILER_INDEX_STORE_ENABLE=NO',
];

let child: ChildProcess | undefined;
let runner: RunnerHandle | undefined;
let forwards: PortForward[] = [];
let stopping = false;
let locked = false;
let startedAt = 0;
let lastReadyAt: number | undefined;
let failures = 0;
let retryAt = 0;
let launchFailure: string | undefined;

async function releaseForwarding(): Promise<void> {
    const active = forwards;
    forwards = [];
    await Promise.all(active.map((forward) => forward.close().catch(() => undefined)));
}

async function stopRunner(): Promise<void> {
    if (runner) {
        try { runner.stop(); } catch { /* already gone */ }
        runner = undefined;
    }
    const running = child;
    child = undefined;
    if (running && running.exitCode === null && !running.killed) {
        running.kill('SIGTERM');
        await Promise.race([
            new Promise<void>((resolve) => running.once('exit', () => resolve())),
            delay(3_000),
        ]);
        if (running.exitCode === null) running.kill('SIGKILL');
    }
    await releaseForwarding();
}

function observeOutput(chunk: Buffer, stderr: boolean): void {
    const output = chunk.toString();
    (stderr ? process.stderr : process.stdout).write(output);
    const diagnosis = diagnoseWdaLaunchFailure(output);
    if (diagnosis?.startsWith('Unlock')) {
        locked = true;
        report('unlock-required', diagnosis);
    } else if (diagnosis) {
        launchFailure = diagnosis;
        report('error', diagnosis);
    }
}

async function startRunner(): Promise<void> {
    if (!simulator) {
        // USB: the phone's :8100/:9100 become 127.0.0.1:<local ports> on the Mac.
        forwards = [await forwardDevicePort(udid, localPort, remotePort)];
        try {
            forwards.push(await forwardDevicePort(udid, mjpegLocalPort, mjpegRemotePort));
        } catch (error) {
            await releaseForwarding();
            throw error;
        }
    }
    locked = false;
    launchFailure = undefined;
    startedAt = Date.now();
    lastReadyAt = undefined;
    report('connecting', 'Starting WDA');
    if (viaTestmanagerd) {
        try {
            // iOS < 16 can't load Xcode 16+'s Swift Testing frameworks; patch the runner for those.
            const major = Number.parseInt(target.osVersion ?? '', 10);
            await ensureRunnerInstalled(udid, (line) => console.log(line), { patchForOlderIos: Number.isInteger(major) && major < 16 });
            runner = await launchRunnerViaTestmanagerd(udid, { wdaPort: remotePort, mjpegPort: mjpegRemotePort });
            console.log(`WDA runner launched through testmanagerd (iOS ${target.osVersion ?? '<17'})`);
        } catch (error) {
            await releaseForwarding();
            throw error;
        }
        return;
    }
    const running = spawn('xcodebuild', args, {
        env: {
            ...process.env,
            DEVELOPER_DIR: developerDir,
            // A simulator shares the Mac's loopback: WDA listens on these ports directly.
            ...(simulator ? { SIMCTL_CHILD_USE_PORT: String(localPort), SIMCTL_CHILD_MJPEG_SERVER_PORT: String(mjpegLocalPort) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = running;
    running.stdout?.on('data', (chunk: Buffer) => observeOutput(chunk, false));
    running.stderr?.on('data', (chunk: Buffer) => observeOutput(chunk, true));
    running.once('error', (error) => report('error', `Unable to start xcodebuild: ${error.message}`));
    running.once('exit', (code, signal) => {
        if (child === running) child = undefined;
        void releaseForwarding();
        if (!stopping) {
            failures += 1;
            const retrySeconds = [2, 5, 10, 30][Math.min(failures - 1, 3)]!;
            retryAt = Date.now() + retrySeconds * 1_000;
            report('error', launchFailure
                ? `${launchFailure}; retrying in ${retrySeconds}s`
                : `WDA exited ${signal ? `after ${signal}` : `with code ${code ?? 'unknown'}`}; retrying in ${retrySeconds}s`);
        }
    });
}

async function wdaReady(): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${localPort}/status`, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await stopRunner();
    await releaseDeviceLock();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

console.log(`Supervising persistent WDA for ${udid} (${target.kind}${viaTestmanagerd ? ', testmanagerd launch' : ''})`);
while (!stopping) {
    let connected = false;
    try {
        connected = await deviceAttached();
    } catch (error) {
        report('error', `Could not inspect ${simulator ? 'simulators' : 'USB devices'}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const active = Boolean(child || runner);
    if (!connected) {
        if (active || forwards.length) await stopRunner();
        failures = 0;
        retryAt = 0;
        report('disconnected', simulator ? 'Boot the simulator' : 'Reconnect the USB cable');
    } else if (active) {
        if (await wdaReady()) {
            failures = 0;
            locked = false;
            lastReadyAt = Date.now();
            report('ready', 'WDA is ready');
        } else if (wdaUnavailableTooLong({
            now: Date.now(),
            launchedAt: startedAt,
            lastReadyAt,
            // While the phone is waiting to be unlocked, leave the launcher alone: it continues by itself.
            timeoutMs: unavailableLimitMs(locked),
        })) {
            const waited = Math.round(unavailableLimitMs(locked) / 1000);
            await stopRunner();
            failures += 1;
            retryAt = Date.now() + 30_000;
            report('error', `${lastReadyAt === undefined ? 'WDA did not become ready' : 'WDA remained unavailable'} for ${waited} seconds; retrying in 30s`);
        } else if (!locked) {
            report('connecting', 'Waiting for WDA to become ready');
        }
    } else if (Date.now() >= retryAt) {
        try {
            await startRunner();
        } catch (error) {
            failures += 1;
            const retrySeconds = [2, 5, 10, 30][Math.min(failures - 1, 3)]!;
            retryAt = Date.now() + retrySeconds * 1_000;
            report('error', `${error instanceof Error ? error.message : String(error)}; retrying in ${retrySeconds}s`);
        }
    }
    await delay(2_000);
}
