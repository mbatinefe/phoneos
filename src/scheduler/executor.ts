import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import type { PluginProcessSpecification, TaskExecutionContext } from '../plugin.js';
import { DeviceFleet } from '../device/fleet.js';
import { resolvePoint } from '../device/points.js';
import { discoverAll, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import type { ExecutionRow } from '../database/schema.js';
import type { PluginRegistry } from '../registry.js';
import type { TaskExecutionResult } from '../types.js';
import type { SchedulerRepository } from './repository.js';

async function endpointReady(url: string): Promise<boolean> {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        return false;
    }
}

async function waitForDevice(execution: ExecutionRow, registered: RegisteredDevice, signal: AbortSignal): Promise<Device> {
    const wdaPort = registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100);
    let lastProblem = 'device is offline';
    while (Date.now() <= execution.deadlineAt.getTime()) {
        if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
        const device = (await discoverAll()).find(({ udid }) => udid === execution.deviceUdid);
        if (!device) lastProblem = 'device is offline';
        else if (!await endpointReady(`http://127.0.0.1:${wdaPort}/status`)) lastProblem = `WDA is unavailable on port ${wdaPort}`;
        else return device;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Execution window expired: ${lastProblem}`);
}

async function runPluginProcess(
    specification: PluginProcessSpecification,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onLines: (lines: string[]) => Promise<void>,
): Promise<TaskExecutionResult> {
    const child = spawn(process.execPath, [
        '--env-file-if-exists=.env', '--import', 'tsx',
        specification.entrypoint, ...(specification.args ?? []),
    ], { cwd: process.cwd(), env: { ...environment, ...specification.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending: string[] = [];
    const append = (chunk: Buffer | string) => { pending.push(...chunk.toString().split(/\r?\n/).filter(Boolean)); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const flush = async () => {
        if (!pending.length) return;
        const lines = pending;
        pending = [];
        await onLines(lines);
    };
    const timer = setInterval(() => void flush().catch(console.error), 3_000);
    let stopped = false;
    const stop = () => {
        stopped = true;
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
        const result = await new Promise<TaskExecutionResult>((resolve) => {
            child.once('error', (error) => resolve({ exitCode: null, stopped, error: error.message }));
            child.once('exit', (exitCode, childSignal) => resolve({
                exitCode,
                stopped,
                ...(exitCode === 0 ? {} : {
                    error: childSignal ? `Plugin process stopped by ${childSignal}` : `Plugin process exited with ${exitCode}`,
                }),
            }));
        });
        await flush();
        return result;
    } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
    }
}

export async function executeAutomation(
    repository: SchedulerRepository,
    plugins: PluginRegistry,
    execution: ExecutionRow,
    attempt: number,
    signal: AbortSignal,
): Promise<TaskExecutionResult> {
    const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === execution.deviceUdid);
    if (!registered) return { exitCode: null, stopped: false, error: 'Device is not registered' };
    if (Date.now() > execution.deadlineAt.getTime()) {
        return { exitCode: null, stopped: false, error: 'Execution window expired before the worker claimed the task' };
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    const stopPoll = setInterval(() => void repository.stopRequested(execution.id).then((requested) => {
        if (requested) controller.abort(new Error('Stop requested'));
    }).catch(console.error), 1_000);
    let device: Device;
    try {
        device = await waitForDevice(execution, registered, controller.signal);
    } catch (error) {
        clearInterval(stopPoll);
        signal.removeEventListener('abort', forwardAbort);
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    }
    const workspaceDirectory = await mkdtemp(`${os.tmpdir()}/phoneos-${execution.id}-`);
    const task = { pluginId: execution.pluginId, taskType: execution.taskType, taskVersion: execution.taskVersion, payload: execution.payload };
    try {
        const definition = plugins.task(task);
        const wdaPort = registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100);
        const mjpegPort = registered.mjpegLocalPort ?? Number(process.env.MJPEG_LOCAL_PORT ?? 9100);
        const environment: NodeJS.ProcessEnv = {
            ...process.env,
            IOS_UDID: device.udid,
            WDA_URL: `http://127.0.0.1:${wdaPort}`,
            MJPEG_URL: `http://127.0.0.1:${mjpegPort}`,
            PHONEOS_EXECUTION_ID: execution.id,
        };
        const log = (line: string) => repository.appendLogs(execution.id, attempt, [line]);
        // A fresh driver per execution whose humanizer is seeded by the execution id, so a run replays exactly.
        const fleet = new DeviceFleet({ seed: execution.id, log: (line) => void log(line).catch(console.error) });
        const driver = await fleet.driver(device.udid);
        // Leave the phone as we found it: a phone that was asleep should go back to
        // sleep, so a nightly task doesn't leave the screen on until morning.
        const wasLocked = await driver.client.locked().catch(() => false);
        const context: TaskExecutionContext = {
            executionId: execution.id,
            attempt,
            workspaceDirectory,
            device,
            registeredDevice: registered,
            devicePluginData: registered.pluginData[execution.pluginId] ?? {},
            driver,
            assets: await repository.executionAssets(execution),
            signal: controller.signal,
            log,
            runProcess: (specification) => runPluginProcess(specification, environment, controller.signal, (lines) => repository.appendLogs(execution.id, attempt, lines)),
            point: async (name) => resolvePoint(plugins.plugin(execution.pluginId), name, await driver.screen(), registered.coordinates),
        };
        const result = await driver.withHumanProfile(plugins.plugin(execution.pluginId).humanProfile, () => definition.execute(context, execution.payload));
        if (wasLocked) {
            await driver.client.lock().catch(() => undefined);
            await log('Device returned to sleep (it was locked before this run)');
        }
        return result;
    } catch (error) {
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    } finally {
        clearInterval(stopPoll);
        signal.removeEventListener('abort', forwardAbort);
        await rm(workspaceDirectory, { recursive: true, force: true });
    }
}
