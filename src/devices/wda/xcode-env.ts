import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WDA_VERSION } from './source.js';

/** Xcode's Developer directory: `XCODE_DEVELOPER_DIR`, else `xcode-select -p`, else the default install. */
export function resolveDeveloperDir(): string {
    if (process.env.XCODE_DEVELOPER_DIR) return process.env.XCODE_DEVELOPER_DIR;
    try {
        const selected = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
        if (selected && existsSync(selected)) return selected;
    } catch { /* fall through */ }
    return '/Applications/Xcode.app/Contents/Developer';
}

/** The WebDriverAgent checkout we build: `WDA_ROOT`, else the release wda:prepare downloads and patches into `.wda/`. */
export function resolveWdaRoot(): string {
    if (process.env.WDA_ROOT) return path.resolve(process.env.WDA_ROOT);
    return fileURLToPath(new URL(`../../../.wda/webdriveragent-${WDA_VERSION}`, import.meta.url));
}

export function resolveWdaProject(): string {
    return process.env.WDA_PROJECT_PATH ? path.resolve(process.env.WDA_PROJECT_PATH) : path.join(resolveWdaRoot(), 'WebDriverAgent.xcodeproj');
}

/** Where xcodebuild puts the built runner; shared across devices so a single build serves the fleet. */
export function resolveDerivedDataPath(): string {
    return path.resolve(process.env.WDA_DERIVED_DATA ?? '.wda/derived-data');
}

export interface BuildDestination {
    kind: 'device' | 'simulator';
    udid: string;
    /** The device's iOS version (major.minor), when known — sets the deployment target so old phones build too. */
    osVersion?: string;
}

/** `IPHONEOS_DEPLOYMENT_TARGET` for a device: its own iOS major.minor, else `IOS_PLATFORM_VERSION`, else 15.0 (WDA's floor). */
export function deploymentTarget(destination: BuildDestination, env: NodeJS.ProcessEnv = process.env): string {
    const fromDevice = destination.osVersion && /^\d+\.\d+/.exec(destination.osVersion)?.[0];
    return fromDevice ?? env.IOS_PLATFORM_VERSION ?? '15.0';
}

export function destinationArgument(destination: BuildDestination): string {
    return destination.kind === 'simulator' ? `platform=iOS Simulator,id=${destination.udid}` : `id=${destination.udid}`;
}

/** Signing only applies to real devices; simulator builds are unsigned. */
export function signingArguments(destination: BuildDestination, env: NodeJS.ProcessEnv = process.env): string[] {
    if (destination.kind === 'simulator') return ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY='];
    const teamId = env.XCODE_ORG_ID;
    const bundleId = env.WDA_BUNDLE_ID;
    if (!teamId) throw new Error('XCODE_ORG_ID is required in .env for a real-device WDA build');
    if (!bundleId) throw new Error('WDA_BUNDLE_ID is required in .env for a real-device WDA build');
    return [
        `DEVELOPMENT_TEAM=${teamId}`,
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
        `CODE_SIGN_IDENTITY=${env.XCODE_SIGNING_ID ?? 'Apple Development'}`,
        'CODE_SIGN_STYLE=Automatic',
    ];
}
