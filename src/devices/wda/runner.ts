import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { installApp } from '../../device/apps.js';
import { resolveDerivedDataPath } from './xcode-env.js';

const MAGIC_CHANNEL = 0xffffffff;
/** The Xcode protocol version appium-ios-device announces to testmanagerd. */
const XCODE_PROTOCOL_VERSION = 29;

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** The WebDriverAgentRunner app `wda:prepare` built for real devices. */
export function builtRunnerPath(): string {
    return path.join(resolveDerivedDataPath(), 'Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app');
}

export function runnerBundleId(env: NodeJS.ProcessEnv = process.env): string {
    return `${env.WDA_BUNDLE_ID ?? 'com.facebook.WebDriverAgentRunner'}.xctrunner`;
}

/** Xcode 26's test stack only drives iOS 17+; older phones get the runner installed and started through testmanagerd. */
export function usesTestmanagerdLaunch(osVersion: string | undefined): boolean {
    const major = Number.parseInt(osVersion ?? '', 10);
    return Number.isInteger(major) && major < 17;
}

/**
 * Xcode 16+ builds the runner against Swift Testing, whose runtime iOS < 16 lacks:
 * `Testing.framework` needs `libswift_StringProcessing.dylib` (iOS 16+), and
 * `libXCTestSwiftSupport.dylib` both hard-links it and strongly references one of its
 * symbols — so the test bundle fails to dlopen and XCTest reports "Failed to load the
 * test bundle". WebDriverAgent links no Swift at all, so both can go; anything left
 * pointing at a framework that isn't in the bundle is turned into a weak link, and the
 * bundle is re-signed with the same identity and entitlements.
 */
async function makeRunnerLoadableOnOlderIos(app: string, log: (line: string) => void): Promise<void> {
    const identity = await signingIdentity(app);
    const entitlements = path.join(path.dirname(app), 'runner-entitlements.plist');
    const { stdout } = await execFileAsync('codesign', ['-d', '--entitlements', ':-', app], { maxBuffer: 4 * 1024 * 1024 });
    await writeFile(entitlements, stdout);
    for (const relative of ['Frameworks/Testing.framework', 'Frameworks/libXCTestSwiftSupport.dylib']) {
        await rm(path.join(app, relative), { recursive: true, force: true });
    }
    const script = fileURLToPath(new URL('./weaken-runner.cjs', import.meta.url));
    const { stdout: weakened } = await execFileAsync(process.execPath, [script], { cwd: app });
    for (const line of weakened.split('\n').filter(Boolean)) log(`runner: ${line.trim()}`);
    // Sign inside-out: nested code first, then the app bundle with its entitlements.
    const { readdir } = await import('node:fs/promises');
    const nested: string[] = [];
    for (const directory of ['Frameworks', 'PlugIns']) {
        const full = path.join(app, directory);
        for (const entry of await readdir(full).catch(() => [] as string[])) {
            nested.push(path.join(full, entry));
            const pluginFrameworks = path.join(full, entry, 'Frameworks');
            for (const inner of await readdir(pluginFrameworks).catch(() => [] as string[])) nested.push(path.join(pluginFrameworks, inner));
        }
    }
    for (const target of nested.reverse()) {
        await execFileAsync('codesign', ['--force', '--sign', identity, '--timestamp=none', target]).catch(() => undefined);
    }
    await execFileAsync('codesign', ['--force', '--sign', identity, '--timestamp=none', '--entitlements', entitlements, app]);
    await execFileAsync('codesign', ['--verify', '--strict', app]);
    log('runner: patched for iOS < 16 and re-signed');
}

/** The identity the runner was signed with, so the patched copy keeps the same one. `codesign -dvv` reports it on stderr. */
async function signingIdentity(app: string): Promise<string> {
    const { stderr } = await execFileAsync('codesign', ['-dvv', app]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? '' }));
    const authority = /^Authority=(.+)$/m.exec(stderr ?? '');
    if (authority?.[1]) return authority[1].trim();
    // Fall back to the first Apple Development identity in the keychain.
    const { stdout } = await execFileAsync('security', ['find-identity', '-v', '-p', 'codesigning']).catch(() => ({ stdout: '' }));
    const match = /"(Apple Develop(?:ment|er)[^"]*)"/.exec(stdout);
    if (match?.[1]) return match[1];
    throw new Error('Could not determine the signing identity of the built WebDriverAgentRunner (is it signed? run `npm run wda:prepare`)');
}

/** Zip the built runner into `Payload/…app` so the installation proxy accepts it. */
export async function packageRunnerIpa({ patchForOlderIos = false, log = () => {} }: { patchForOlderIos?: boolean; log?: (line: string) => void } = {}): Promise<string> {
    const app = builtRunnerPath();
    await access(app);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'phoneos-runner-'));
    const payload = path.join(workspace, 'Payload');
    await mkdir(payload, { recursive: true });
    const staged = path.join(payload, path.basename(app));
    await cp(app, staged, { recursive: true });
    if (patchForOlderIos) await makeRunnerLoadableOnOlderIos(staged, log);
    const ipa = path.join(workspace, 'WebDriverAgentRunner.ipa');
    await execFileAsync('zip', ['-qry', ipa, 'Payload'], { cwd: workspace });
    return ipa;
}

function markerPath(udid: string): string {
    return path.resolve('.wda', `${udid.replace(/[^a-zA-Z0-9_-]/g, '_')}.runner-installed`);
}

/** Install (or reinstall, when the build is newer than the last install) the runner on an iOS ≤ 16 phone. */
export async function ensureRunnerInstalled(udid: string, log: (line: string) => void = () => {}, { patchForOlderIos = false }: { patchForOlderIos?: boolean } = {}): Promise<void> {
    const built = await stat(builtRunnerPath());
    const fingerprint = `${built.mtimeMs}:${runnerBundleId()}:${patchForOlderIos ? 'patched' : 'stock'}`;
    const marker = await readFile(markerPath(udid), 'utf8').catch(() => '');
    if (marker === fingerprint && await runnerPresent(udid)) return;
    log('runner: packaging WebDriverAgentRunner as .ipa and installing over USB');
    const ipa = await packageRunnerIpa({ patchForOlderIos, log });
    try {
        await installApp({ udid, kind: 'device' }, ipa, log);
    } finally {
        await rm(path.dirname(ipa), { recursive: true, force: true });
    }
    await mkdir(path.dirname(markerPath(udid)), { recursive: true });
    await writeFile(markerPath(udid), fingerprint);
}

async function runnerPresent(udid: string): Promise<boolean> {
    const { services } = require('appium-ios-device') as {
        services: { startInstallationProxyService(udid: string): Promise<{ lookupApplications(options: { bundleIds: string[] }): Promise<Record<string, unknown>>; close(): void }> };
    };
    const client = await services.startInstallationProxyService(udid);
    try {
        const apps = await client.lookupApplications({ bundleIds: [runnerBundleId()] });
        return Boolean(apps[runnerBundleId()]);
    } catch {
        return false;
    } finally {
        client.close();
    }
}

export interface RunnerHandle { stop(): void }

interface XctestInstance {
    start(): Promise<void>;
    stop(): void;
    _executing?: boolean;
    _execTestPlanSession?: {
        registerSelectorCallback(selector: string, callback: () => void): void;
        _callChannel(sync: boolean, channel: number, selector: string, aux: unknown): unknown;
    };
    _startExecSession(sessionIdentifier: string): Promise<void>;
}

let patched = false;

/**
 * Two adaptations to `appium-ios-device`'s XCTest launcher, both needed on iOS ≤ 16:
 *
 * 1. It starts the test plan 1 s after the runner reports ready, via a log-message
 *    heuristic written for the legacy `_XCT_testBundleReadyWithProtocolVersion:`
 *    flow. Modern XCTest (iOS 14+) instead sends
 *    `_XCT_testRunnerReadyWithCapabilities:` and gives up ~600 ms later — so the
 *    start command arrives after the runner has already exited. Sending it the
 *    instant that notification arrives is what makes the suite actually run.
 * 2. A spurious client-side error after the launch reply ("proxy has been revoked")
 *    makes `start()` throw and tear down sessions that the device is perfectly
 *    happy with. The runner is already up at that point, so the teardown is
 *    suppressed for the duration of the launch and the error swallowed.
 */
function patchXctestLauncher(Xctest: { prototype: XctestInstance }, DTXMessageAuxBuffer: new () => { appendObject(value: unknown): void }): void {
    if (patched) return;
    patched = true;
    const originalStartExec = Xctest.prototype._startExecSession;
    Xctest.prototype._startExecSession = async function (this: XctestInstance, sessionIdentifier: string) {
        const result = await originalStartExec.call(this, sessionIdentifier);
        this._execTestPlanSession?.registerSelectorCallback('_XCT_testRunnerReadyWithCapabilities:', () => {
            if (this._executing) return;
            this._executing = true;
            const message = new DTXMessageAuxBuffer();
            message.appendObject(XCODE_PROTOCOL_VERSION);
            this._execTestPlanSession?._callChannel(false, MAGIC_CHANNEL, '_IDE_startExecutingTestPlanWithProtocolVersion:', message);
        });
        return result;
    };
}

/**
 * Start the installed runner through testmanagerd (DTX), the pre-CoreDevice
 * protocol iOS 9–16 speak. WDA reads its ports from the launch environment.
 */
export async function launchRunnerViaTestmanagerd(udid: string, { wdaPort, mjpegPort }: { wdaPort: number; mjpegPort: number }): Promise<RunnerHandle> {
    const { Xctest } = require('appium-ios-device') as { Xctest: (new (udid: string, xctestBundleId: string, targetBundleId: string | null, options: { env?: Record<string, string> }) => XctestInstance) & { prototype: XctestInstance } };
    const { DTXMessageAuxBuffer } = require('appium-ios-device/build/lib/instrument/headers.js') as { DTXMessageAuxBuffer: new () => { appendObject(value: unknown): void } };
    patchXctestLauncher(Xctest, DTXMessageAuxBuffer);

    const xctest = new Xctest(udid, runnerBundleId(), null, {
        env: { USE_PORT: String(wdaPort), MJPEG_SERVER_PORT: String(mjpegPort) },
    });
    const realStop = xctest.stop.bind(xctest);
    let launching = true;
    xctest.stop = () => { if (!launching) realStop(); };
    try {
        await xctest.start();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/revoked/.test(message)) {
            launching = false;
            xctest.stop = realStop;
            realStop();
            throw error;
        }
        // The device already launched the runner; only our bookkeeping failed.
    } finally {
        launching = false;
        xctest.stop = realStop;
    }
    return { stop: realStop };
}
