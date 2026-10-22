import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { plistToJson } from './apps.js';
import type { DeviceKind } from './identity.js';
import { freePath } from './media.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * What an app printed and how it crashed. A simulator keeps its log, so recent lines are
 * read back; a phone only streams its log live, so the first request starts a capture that
 * this process keeps in memory, and lines are there from that moment on.
 */

interface Target { udid: string; kind: DeviceKind }

interface InstallationProxy {
    listApplications(options: { applicationType?: string; returnAttributes?: string[] }): Promise<Record<string, Record<string, unknown>>>;
    close(): void;
}

/** The app's process name (`CFBundleExecutable`): what log lines and crash reports are named by. */
export async function executableName(target: Target, bundleId: string): Promise<string> {
    let executable: unknown;
    if (target.kind === 'simulator') {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'appinfo', target.udid, bundleId], { timeout: 30_000 });
        executable = (JSON.parse(await plistToJson(stdout)) as { CFBundleExecutable?: string }).CFBundleExecutable;
    } else {
        const { services } = require('appium-ios-device') as { services: { startInstallationProxyService(udid: string): Promise<InstallationProxy> } };
        const proxy = await services.startInstallationProxyService(target.udid);
        try {
            const apps = await proxy.listApplications({ applicationType: 'Any', returnAttributes: ['CFBundleIdentifier', 'CFBundleExecutable'] });
            executable = apps[bundleId]?.CFBundleExecutable;
        } finally {
            proxy.close();
        }
    }
    if (typeof executable !== 'string' || !executable) throw new Error(`${bundleId} is not installed on this device`);
    return executable;
}

/** Error and fault lines only: syslog marks them `<Error>` / `<Fault>`. */
export function errorLines(lines: readonly string[]): string[] {
    return lines.filter((line) => /<(Error|Fault)>/.test(line));
}

/** Lines written by one process: syslog prints `… Name(Subsystem)[pid] <Level>: …`, `log show` prints `… Name[pid:tid] …`. */
export function linesOfProcess(lines: readonly string[], processName: string): string[] {
    const escaped = processName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|\\s)${escaped}(\\(|\\[)`);
    return lines.filter((line) => pattern.test(line));
}

// ---- phones: a live capture --------------------------------------------------------

interface SyslogService { start(onData: (line: string) => void): void; close(): void }

const MAX_LINES = 20_000;

class SyslogCapture {
    readonly startedAt = Date.now();
    private readonly lines: Array<{ at: number; line: string }> = [];
    private service: SyslogService | undefined;

    async start(udid: string): Promise<void> {
        const { services } = require('appium-ios-device') as { services: { startSyslogService(udid: string): Promise<SyslogService> } };
        this.service = await services.startSyslogService(udid);
        this.service.start((line) => {
            this.lines.push({ at: Date.now(), line: line.trimEnd() });
            if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        });
    }

    since(at: number): string[] {
        return this.lines.filter((entry) => entry.at >= at).map((entry) => entry.line);
    }

    close(): void {
        this.service?.close();
    }
}

const captures = new Map<string, SyslogCapture>();

/** Start capturing a phone's log, if this process is not already. Returns when the capture began. */
export async function captureDeviceLog(udid: string): Promise<{ since: number; startedNow: boolean }> {
    const existing = captures.get(udid);
    if (existing) return { since: existing.startedAt, startedNow: false };
    const capture = new SyslogCapture();
    await capture.start(udid);
    captures.set(udid, capture);
    return { since: capture.startedAt, startedNow: true };
}

export function capturedDeviceLog(udid: string, since: number): string[] {
    return captures.get(udid)?.since(since) ?? [];
}

// ---- simulators: the log is kept ----------------------------------------------------

export async function simulatorLog(udid: string, processName: string, sinceSeconds: number, { errorsOnly = false } = {}): Promise<string[]> {
    const predicate = `process == "${processName.replace(/"/g, '\\"')}"${errorsOnly ? ' AND (messageType == error OR messageType == fault)' : ''}`;
    const { stdout } = await execFileAsync('xcrun', [
        'simctl', 'spawn', udid, 'log', 'show', '--last', `${Math.max(1, Math.round(sinceSeconds))}s`,
        '--style', 'compact', '--predicate', predicate,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    // The first line is the column header.
    return stdout.split('\n').slice(1).filter((line) => line.trim());
}

// ---- crash reports ----------------------------------------------------------------------

export interface CrashReport {
    name: string;
    /** Where the report is on this Mac. */
    path: string;
    summary: string;
}

interface IpsFrame { imageIndex?: number; symbol?: string; imageOffset?: number }

/**
 * The few lines of an `.ips` crash report that say what happened: the exception, why the
 * app was ended, and the top of the crashed thread. Reports are two JSON documents, a
 * one-line header and the body; anything else is shown as its first lines.
 */
export function summarizeCrash(text: string, frames = 8): string {
    const newline = text.indexOf('\n');
    try {
        const header = JSON.parse(text.slice(0, newline)) as { app_name?: string; app_version?: string; timestamp?: string; os_version?: string };
        const body = JSON.parse(text.slice(newline + 1)) as {
            exception?: { type?: string; signal?: string; codes?: string; subtype?: string };
            termination?: { namespace?: string; indicator?: string; reasons?: string[]; code?: number };
            faultingThread?: number;
            threads?: Array<{ frames?: IpsFrame[]; name?: string; queue?: string }>;
            usedImages?: Array<{ name?: string }>;
            asi?: Record<string, string[]>;
        };
        const lines = [`${header.app_name ?? 'app'} ${header.app_version ?? ''} crashed ${header.timestamp ?? ''} (${header.os_version ?? 'iOS'})`.replace(/\s+/g, ' ').trim()];
        const exception = body.exception;
        if (exception) lines.push(`exception: ${[exception.type, exception.signal && `(${exception.signal})`, exception.subtype].filter(Boolean).join(' ')}${exception.codes ? ` codes ${exception.codes}` : ''}`);
        const termination = body.termination;
        if (termination) lines.push(`termination: ${[termination.namespace, termination.indicator, ...(termination.reasons ?? [])].filter(Boolean).join(' · ')}`);
        for (const [image, messages] of Object.entries(body.asi ?? {})) lines.push(`${image}: ${messages.join(' ')}`);
        const thread = body.threads?.[body.faultingThread ?? 0];
        if (thread?.frames?.length) {
            lines.push(`crashed thread ${body.faultingThread ?? 0}${thread.queue ? ` (${thread.queue})` : ''}:`);
            thread.frames.slice(0, frames).forEach((frame, index) => {
                const image = frame.imageIndex === undefined ? '?' : body.usedImages?.[frame.imageIndex]?.name ?? '?';
                lines.push(`  ${index} ${image} ${frame.symbol ?? `+0x${(frame.imageOffset ?? 0).toString(16)}`}`);
            });
        }
        return lines.join('\n');
    } catch {
        return text.split('\n').slice(0, 30).join('\n');
    }
}

interface AfcService {
    listDirectory(path: string): Promise<string[]>;
    createReadStream(filePath: string, options?: { autoDestroy?: boolean }): Promise<NodeJS.ReadableStream>;
    close(): void;
}

/** Ask the phone to move new crash reports to where they can be copied (best-effort; it answers "ping"). */
async function moveCrashReports(udid: string): Promise<void> {
    const { utilities } = require('appium-ios-device') as {
        utilities: {
            startLockdownSession(udid: string): Promise<{ startService(name: string): Promise<{ Port: number }>; close(): void }>;
            connectPort(udid: string, port: number): Promise<import('node:net').Socket>;
        };
    };
    const lockdown = await utilities.startLockdownSession(udid);
    let port: number;
    try {
        ({ Port: port } = await lockdown.startService('com.apple.crashreportmover'));
    } finally {
        lockdown.close();
    }
    const socket = await utilities.connectPort(udid, port);
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 5_000);
        function done() { clearTimeout(timer); socket.destroy(); resolve(); }
        socket.once('data', done);
        socket.once('error', done);
    });
}

const reportOf = (name: string, executable: string) => name.startsWith(`${executable}-`) && /\.ips$/.test(name);

/** The newest crash reports of one app, newest first, copied to this Mac when they come from a phone. */
export async function crashReports(target: Target, executable: string, { count = 3, outDirectory }: { count?: number; outDirectory: string }): Promise<{ reports: CrashReport[]; total: number }> {
    if (target.kind === 'simulator') {
        // Simulator apps are Mac processes: their reports land in the Mac's own folder.
        const directory = path.join(os.homedir(), 'Library/Logs/DiagnosticReports');
        const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => reportOf(name, executable));
        const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(directory, name))).mtimeMs })));
        dated.sort((a, b) => b.at - a.at);
        const reports = await Promise.all(dated.slice(0, count).map(async ({ name }) => {
            const file = path.join(directory, name);
            return { name, path: file, summary: summarizeCrash(await readFile(file, 'utf8')) };
        }));
        return { reports, total: names.length };
    }
    await moveCrashReports(target.udid).catch(() => undefined);
    const { services } = require('appium-ios-device') as { services: { startCrashLogService(udid: string): Promise<AfcService> } };
    const afc = await services.startCrashLogService(target.udid);
    try {
        const names = (await afc.listDirectory('/')).filter((name) => reportOf(name, executable)).sort().reverse();
        await mkdir(outDirectory, { recursive: true });
        const reports: CrashReport[] = [];
        for (const name of names.slice(0, count)) {
            const local = freePath(path.join(outDirectory, name));
            const source = await afc.createReadStream(`/${name}`, { autoDestroy: true });
            const chunks: Buffer[] = [];
            for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
            const text = Buffer.concat(chunks).toString('utf8');
            await writeFile(local, text, { flag: 'wx' });
            reports.push({ name, path: local, summary: summarizeCrash(text) });
        }
        return { reports, total: names.length };
    } finally {
        afc.close();
    }
}
