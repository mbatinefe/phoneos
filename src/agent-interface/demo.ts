import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeviceFleet } from '../device/fleet.js';
import { discoverBootedSimulators } from '../devices/discovery.js';
import { ensureWdaService } from '../devices/ensure-wda-service.js';
import { activeDevices, loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { bootSimulator, createSimulator, registerSimulator } from '../devices/simulators.js';
import { wdaServiceStatuses } from '../devices/wda-service-client.js';
import { resolveDerivedDataPath } from '../devices/wda/xcode-env.js';
import { AgentTools } from './tools.js';

/**
 * `npm run demo`: from a fresh clone to an agent-drivable simulator in one command.
 * Reuses whatever already exists (a registered or booted simulator, a WDA build, a
 * running service) and only creates what is missing.
 */

type Write = (line: string) => void;

const prepareScript = fileURLToPath(new URL('../devices/wda/prepare.ts', import.meta.url));

/** A registered simulator, else a booted one, else a new one — booted and registered. */
async function pickSimulator(write: Write): Promise<RegisteredDevice> {
    const registered = activeDevices(await loadRegisteredDevices()).find((device) => device.kind === 'simulator');
    if (registered) {
        write(`   using ${registered.name}, already registered`);
        await bootSimulator(registered.udid).catch((error: unknown) => {
            throw new Error(`Could not boot ${registered.name} (${registered.udid}): ${error instanceof Error ? error.message : String(error)}. Was it deleted? Remove it from devices.json and run the demo again.`);
        });
        return registered;
    }
    const booted = (await discoverBootedSimulators()).find((device) => /iPhone/.test(device.name) || /iPhone/.test(device.productType ?? ''));
    if (booted) {
        write(`   using ${booted.name}, which is already running`);
        return (await registerSimulator(booted.udid, undefined, 'natural')).device;
    }
    write('   creating one (the newest iPhone Pro on the newest iOS); its first boot can take several minutes…');
    const created = await createSimulator();
    write(`   created ${created.name} on ${created.runtime}`);
    return (await registerSimulator(created.udid, undefined, 'natural')).device;
}

/** Build WebDriverAgent for simulators unless a build exists. The xcodebuild chatter goes to a log, not the screen. */
async function ensureSimulatorBuild(udid: string, write: Write): Promise<void> {
    const runner = path.join(resolveDerivedDataPath(), 'Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app');
    if (existsSync(runner)) {
        write('   already built');
        return;
    }
    const logPath = path.resolve('.wda/prepare.log');
    await mkdir(path.dirname(logPath), { recursive: true });
    write(`   building it for simulators: a few minutes, only the first time (log: ${path.relative(process.cwd(), logPath)})`);
    const logFd = openSync(logPath, 'w');
    const started = Date.now();
    const ticker = setInterval(() => write(`   … still building (${Math.round((Date.now() - started) / 60_000)} min)`), 60_000);
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', prepareScript, '--sim', '--udid', udid], { stdio: ['ignore', logFd, logFd] });
            child.once('error', reject);
            child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the WebDriverAgent build failed (exit ${code})`))));
        });
    } catch (error) {
        const tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-15).join('\n');
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Last lines of ${logPath}:\n${tail}`);
    } finally {
        clearInterval(ticker);
        closeSync(logFd);
    }
    write(`   built in ${Math.round((Date.now() - started) / 1000)} s`);
}

async function waitUntilReady(fleet: DeviceFleet, device: RegisteredDevice, write: Write, timeoutMs = 300_000): Promise<void> {
    const started = Date.now();
    let said = '';
    while (Date.now() - started < timeoutMs) {
        const entry = (await fleet.list()).find((candidate) => candidate.registered.udid === device.udid);
        if (entry?.ready) {
            write(`   ready after ${Math.round((Date.now() - started) / 1000)} s`);
            return;
        }
        const status = (await wdaServiceStatuses())?.find((candidate) => candidate.udid === device.udid);
        const message = status?.message ?? 'waiting for the service';
        if (message !== said) write(`   ${message}`);
        said = message;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`The agent did not come up on ${device.name} within ${timeoutMs / 60_000} minutes. See .wda/${device.udid}.log, or run npm run doctor.`);
}

export async function runDemo(write: Write = (line) => process.stdout.write(`${line}\n`)): Promise<void> {
    write('phoneos demo: an iOS Simulator an agent can drive, set up from scratch.\n');
    write('1/4 Simulator');
    const device = await pickSimulator(write);
    write('2/4 WebDriverAgent (the app that does the tapping, inside the simulator)');
    await ensureSimulatorBuild(device.udid, write);
    write('3/4 Starting it');
    await ensureWdaService();
    const fleet = new DeviceFleet();
    await waitUntilReady(fleet, device, write);
    write('4/4 Driving it\n');
    const tools = new AgentTools({ fleet });
    await tools.openApp(device.udid, { app: 'Settings', relaunch: true });
    const observed = await tools.observe(device.udid);
    const lines = observed.text.split('\n');
    write(`Settings is open on ${device.name}. This is what an agent reads:\n`);
    write(lines.slice(0, 12).map((line) => `  ${line}`).join('\n'));
    if (lines.length > 12) write(`  … ${lines.length - 12} more lines`);
    write([
        '',
        'Try it yourself:',
        '  npm run phone -- tap "General"',
        '  npm run phone -- observe --screenshot shot.jpg',
        '',
        'Or open this folder in Claude Code and ask it to "turn on Dark Mode in Settings".',
        'If something stops working, npm run doctor says what and how to fix it.',
    ].join('\n'));
}
