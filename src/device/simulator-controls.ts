import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { DeviceKind } from './identity.js';

const execFileAsync = promisify(execFile);

/**
 * What only a simulator lets a test set from outside: push notifications, privacy
 * permissions and a clean status bar. A phone has no such door (a push needs Apple's
 * servers, a permission needs a person to tap Allow), so these refuse it and say why.
 */

interface Target { udid: string; kind: DeviceKind }

function simulatorOnly(target: Target, refusal: string): void {
    if (target.kind !== 'simulator') throw new Error(refusal);
}

/** `simctl privacy` services. */
export const PRIVACY_SERVICES = ['all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri'] as const;
export type PrivacyService = typeof PRIVACY_SERVICES[number];

export async function setPermission(target: Target, bundleId: string, service: PrivacyService, action: 'grant' | 'revoke' | 'reset'): Promise<void> {
    simulatorOnly(target, 'Permissions can only be set on a simulator. On a phone, answer the prompt with alert action=accept or by tapping its button.');
    await execFileAsync('xcrun', ['simctl', 'privacy', target.udid, action, service, bundleId], { timeout: 30_000 });
}

/** The notification an app's push handler receives: a title and body, or an `aps` payload of your own. */
export function pushPayload({ title, body, payload }: { title?: string; body?: string; payload?: Record<string, unknown> }): Record<string, unknown> {
    if (payload) {
        if (!payload.aps || typeof payload.aps !== 'object') throw new Error('A push payload needs an "aps" object, e.g. {"aps":{"alert":"Hi"}}');
        return payload;
    }
    if (!title && !body) throw new Error('Give a title and/or body, or a full payload');
    return { aps: { alert: { ...(title ? { title } : {}), ...(body ? { body } : {}) }, sound: 'default' } };
}

export async function sendPush(target: Target, bundleId: string, payload: Record<string, unknown>): Promise<void> {
    simulatorOnly(target, 'A push notification can only be sent to a simulator. A phone receives pushes only through Apple\'s push service, from the app\'s own server.');
    await new Promise<void>((resolve, reject) => {
        const child = execFile('xcrun', ['simctl', 'push', target.udid, bundleId, '-'], { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
        child.stdin?.end(JSON.stringify(payload));
    });
}

/** The status bar App Store screenshots use: 9:41, full signal, full battery. */
export const CLEAN_STATUS_BAR = ['--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100'];

export async function setCleanStatusBar(target: Target, clean: boolean): Promise<void> {
    simulatorOnly(target, 'The status bar can only be changed on a simulator. A phone shows its real one.');
    await execFileAsync('xcrun', ['simctl', 'status_bar', target.udid, ...(clean ? ['override', ...CLEAN_STATUS_BAR] : ['clear'])], { timeout: 30_000 });
}
