import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import type { DeviceKind } from './identity.js';
import type { AfcService } from './media.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export interface InstalledApp {
    bundleId: string;
    name: string;
    version?: string;
}

interface InstallationProxy {
    listApplications(options: { applicationType?: string; returnAttributes?: string[] }): Promise<Record<string, Record<string, unknown>>>;
    close(): void;
}

/** `plutil` reading a property list on stdin and writing JSON. */
export function plistToJson(plist: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile('plutil', ['-convert', 'json', '-o', '-', '-'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        child.stdin?.end(plist);
    });
}

/** User-installed apps, from the installation proxy over usbmux (devices) or simctl (simulators). */
export async function listInstalledApps(udid: string, kind: DeviceKind): Promise<InstalledApp[]> {
    if (kind === 'simulator') {
        // No shell: the udid is an argument, never part of a command line.
        const { stdout: plist } = await execFileAsync('xcrun', ['simctl', 'listapps', udid], { maxBuffer: 16 * 1024 * 1024 });
        const parsed = JSON.parse(await plistToJson(plist)) as Record<string, { CFBundleDisplayName?: string; CFBundleName?: string; CFBundleShortVersionString?: string; ApplicationType?: string }>;
        return Object.entries(parsed)
            .filter(([, info]) => info.ApplicationType === 'User')
            .map(([bundleId, info]) => ({
                bundleId,
                name: info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId,
                ...(info.CFBundleShortVersionString ? { version: info.CFBundleShortVersionString } : {}),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    const { services } = require('appium-ios-device') as { services: { startInstallationProxyService(udid: string): Promise<InstallationProxy> } };
    const client = await services.startInstallationProxyService(udid);
    try {
        const apps = await client.listApplications({
            applicationType: 'User',
            returnAttributes: ['CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName', 'CFBundleShortVersionString'],
        });
        return Object.entries(apps).map(([bundleId, info]) => ({
            bundleId,
            name: String(info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId),
            ...(info.CFBundleShortVersionString ? { version: String(info.CFBundleShortVersionString) } : {}),
        })).sort((a, b) => a.name.localeCompare(b.name));
    } finally {
        client.close();
    }
}

/** Well-known system apps an agent is likely to be asked for; they never show up in the user-app list. */
export const SYSTEM_APPS: readonly InstalledApp[] = [
    { bundleId: 'com.apple.Preferences', name: 'Settings' },
    { bundleId: 'com.apple.mobilesafari', name: 'Safari' },
    { bundleId: 'com.apple.mobilenotes', name: 'Notes' },
    { bundleId: 'com.apple.MobileSMS', name: 'Messages' },
    { bundleId: 'com.apple.mobilemail', name: 'Mail' },
    { bundleId: 'com.apple.mobileslideshow', name: 'Photos' },
    { bundleId: 'com.apple.camera', name: 'Camera' },
    { bundleId: 'com.apple.mobilecal', name: 'Calendar' },
    { bundleId: 'com.apple.reminders', name: 'Reminders' },
    { bundleId: 'com.apple.Maps', name: 'Maps' },
    { bundleId: 'com.apple.AppStore', name: 'App Store' },
    { bundleId: 'com.apple.mobilephone', name: 'Phone' },
    { bundleId: 'com.apple.MobileAddressBook', name: 'Contacts' },
    { bundleId: 'com.apple.Music', name: 'Music' },
    { bundleId: 'com.apple.weather', name: 'Weather' },
    { bundleId: 'com.apple.mobiletimer', name: 'Clock' },
    { bundleId: 'com.apple.calculator', name: 'Calculator' },
    { bundleId: 'com.apple.Health', name: 'Health' },
    { bundleId: 'com.apple.shortcuts', name: 'Shortcuts' },
    { bundleId: 'com.apple.DocumentsApp', name: 'Files' },
    { bundleId: 'com.apple.springboard', name: 'Home screen (SpringBoard)' },
];

// ---- install / uninstall ------------------------------------------------------

interface InstallationProxyWrite {
    installApplication(packagePath: string, options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    uninstallApplication(bundleId: string, timeoutMs?: number): Promise<unknown>;
    close(): void;
}


/**
 * Install an app: `.app` bundles on simulators (simctl); on real phones a
 * `.app` via `xcrun devicectl` (iOS 17+) or a signed `.ipa` staged over AFC
 * and installed by the installation proxy (any iOS). The build must be signed
 * for that phone (development / ad-hoc / enterprise / TestFlight).
 */
export async function installApp(target: { udid: string; kind: DeviceKind }, appPath: string, log: (line: string) => void = () => {}): Promise<void> {
    const extension = appPath.toLowerCase().endsWith('.ipa') ? '.ipa' : appPath.replace(/\/+$/, '').toLowerCase().endsWith('.app') ? '.app' : '';
    if (!extension) throw new Error('Give a .app bundle or a .ipa archive');
    if (target.kind === 'simulator') {
        if (extension === '.ipa') throw new Error('Simulators take .app bundles built for the simulator, not .ipa archives');
        await execFileAsync('xcrun', ['simctl', 'install', target.udid, appPath], { timeout: 300_000 });
        log(`apps: installed ${appPath} on the simulator`);
        return;
    }
    if (extension === '.app') {
        await execFileAsync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', target.udid, appPath], { timeout: 600_000 });
        log(`apps: installed ${appPath} via devicectl`);
        return;
    }
    const { services } = require('appium-ios-device') as {
        services: { startAfcService(udid: string): Promise<AfcService>; startInstallationProxyService(udid: string): Promise<InstallationProxyWrite> };
    };
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(appPath);
    const remote = `PublicStaging/${Date.now()}-${appPath.split('/').pop()}`;
    const afc = await services.startAfcService(target.udid);
    try {
        await afc.createDirectory('PublicStaging').catch(() => undefined);
        const { afcUpload } = await import('./media.js');
        await afcUpload(afc, remote, data);
    } finally {
        afc.close();
    }
    log(`apps: staged ${(data.length / 1_048_576).toFixed(1)} MB, installing…`);
    const proxy = await services.startInstallationProxyService(target.udid);
    try {
        await proxy.installApplication(remote, {}, 600_000);
    } finally {
        proxy.close();
    }
    log(`apps: installed ${appPath}`);
}

/**
 * Put an app back as freshly installed: no data, no granted permissions. A simulator's copy is
 * reinstalled from its own bundle; a phone keeps no installable copy, so it needs `appPath`
 * (the .ipa or .app to install again). Apple's own apps cannot be reinstalled.
 */
export async function resetApp(target: { udid: string; kind: DeviceKind }, bundleId: string, appPath: string | undefined, log: (line: string) => void = () => {}): Promise<void> {
    if (bundleId.startsWith('com.apple.')) throw new Error(`${bundleId} is part of iOS and cannot be reinstalled`);
    if (target.kind === 'simulator' && !appPath) {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'get_app_container', target.udid, bundleId, 'app'], { timeout: 30_000 })
            .catch(() => { throw new Error(`${bundleId} is not installed on this simulator`); });
        const { cp, mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const staging = await mkdtemp(`${tmpdir()}/phoneos-reset-`);
        const bundle = `${staging}/${stdout.trim().split('/').pop()}`;
        try {
            await cp(stdout.trim(), bundle, { recursive: true });
            await uninstallApp(target, bundleId, log);
            await installApp(target, bundle, log);
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
        await execFileAsync('xcrun', ['simctl', 'privacy', target.udid, 'reset', 'all', bundleId], { timeout: 30_000 }).catch(() => undefined);
        return;
    }
    if (!appPath) throw new Error('A phone keeps no copy of the app to reinstall: pass path= the .ipa or .app to install again');
    await uninstallApp(target, bundleId, log);
    await installApp(target, appPath, log);
}

export async function uninstallApp(target: { udid: string; kind: DeviceKind }, bundleId: string, log: (line: string) => void = () => {}): Promise<void> {
    if (target.kind === 'simulator') {
        await execFileAsync('xcrun', ['simctl', 'uninstall', target.udid, bundleId], { timeout: 120_000 });
    } else {
        const { services } = require('appium-ios-device') as { services: { startInstallationProxyService(udid: string): Promise<InstallationProxyWrite> } };
        const proxy = await services.startInstallationProxyService(target.udid);
        try {
            await proxy.uninstallApplication(bundleId, 120_000);
        } finally {
            proxy.close();
        }
    }
    log(`apps: uninstalled ${bundleId}`);
}
