import { createRequire } from 'node:module';
import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';

import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import { wdaServiceStatuses } from '../devices/wda-service-client.js';
import type { DeviceFleet, FleetDevice } from './fleet.js';

const require = createRequire(import.meta.url);

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export interface DeviceHealth {
    udid: string;
    name: string;
    kind: 'device' | 'simulator';
    model?: string;
    osVersion?: string;
    present: boolean;
    wda: DeviceConnectionStatus['wda'] | 'ready' | 'unknown';
    wdaMessage?: string;
    supervisorRetries?: number;
    locked?: boolean;
    activeApp?: string | null;
    battery?: { level: number; state: 'unknown' | 'unplugged' | 'charging' | 'full' };
    thermal?: ThermalState;
    storage?: { freeBytes: number; totalBytes: number };
    lastActionAt?: string;
    /** Human-readable problems worth acting on (low battery, hot, full, offline, locked). */
    warnings: string[];
    checkedAt: string;
}

export const HEALTH_THRESHOLDS = {
    lowBattery: 0.15,
    lowStorageBytes: 1024 * 1024 * 1024,
};

const THERMAL: ThermalState[] = ['nominal', 'fair', 'serious', 'critical'];

interface Lockdown { getValue(query: { Domain?: string; Key?: string }): Promise<Record<string, unknown>> }

async function deviceStorage(udid: string): Promise<{ freeBytes: number; totalBytes: number } | undefined> {
    try {
        const { utilities } = require('appium-ios-device') as { utilities: { startLockdownSession(udid: string): Promise<Lockdown> } };
        const lockdown = await utilities.startLockdownSession(udid);
        const usage = await lockdown.getValue({ Domain: 'com.apple.disk_usage' });
        const free = Number(usage.TotalDataAvailable ?? usage.AmountDataAvailable);
        const total = Number(usage.TotalDataCapacity ?? usage.TotalDiskCapacity);
        return Number.isFinite(free) && Number.isFinite(total) && total > 0 ? { freeBytes: free, totalBytes: total } : undefined;
    } catch {
        return undefined;
    }
}

async function simulatorStorage(udid: string): Promise<{ freeBytes: number; totalBytes: number } | undefined> {
    try {
        const stats = await statfs(path.join(process.env.HOME ?? '', 'Library/Developer/CoreSimulator/Devices', udid, 'data'));
        return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
        return undefined;
    }
}

export async function lastActionAt(udid: string, stateDirectory = path.resolve(process.env.PHONEOS_STATE_DIR ?? '.phoneos')): Promise<string | undefined> {
    try {
        const stored = JSON.parse(await readFile(path.join(stateDirectory, `last-action-${udid.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), 'utf8')) as { at?: string };
        return stored.at;
    } catch {
        return undefined;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Health of one registered device. Cheap probes only; each is optional and never fails the whole report. */
export async function deviceHealth(fleet: DeviceFleet, entry: FleetDevice, supervisor?: DeviceConnectionStatus): Promise<DeviceHealth> {
    // A sleeping phone whose passcode we hold is the healthy idle state for an unattended phone, not a problem.
    const canSelfUnlock = Boolean(entry.registered.passcode);
    const { identity } = entry;
    const health: DeviceHealth = {
        udid: identity.udid, name: identity.name, kind: identity.kind,
        ...(identity.modelName ?? identity.productType ? { model: identity.modelName ?? identity.productType } : {}),
        ...(identity.osVersion ? { osVersion: identity.osVersion } : {}),
        present: entry.present,
        wda: supervisor?.wda ?? (entry.ready ? 'ready' : 'unknown'),
        ...(supervisor?.message ? { wdaMessage: supervisor.message } : {}),
        ...(supervisor ? { supervisorRetries: supervisor.retryCount } : {}),
        warnings: [],
        checkedAt: new Date().toISOString(),
    };
    const [storage, last] = await Promise.all([
        identity.kind === 'simulator' ? simulatorStorage(identity.udid) : entry.present ? deviceStorage(identity.udid) : Promise.resolve(undefined),
        lastActionAt(identity.udid),
    ]);
    if (storage) health.storage = storage;
    if (last) health.lastActionAt = last;
    if (entry.ready) {
        try {
            const driver = await fleet.driver(identity.udid);
            const [state, info] = await Promise.all([driver.state(), driver.client.deviceInfo().catch(() => undefined)]);
            health.locked = state.locked;
            health.activeApp = state.activeApp?.bundleId ?? null;
            if (state.battery) health.battery = state.battery;
            const thermal = typeof info?.thermalState === 'number' ? THERMAL[info.thermalState] : undefined;
            if (thermal) health.thermal = thermal;
        } catch (error) {
            health.warnings.push(`WDA answered but state failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!entry.present) health.warnings.push(identity.kind === 'simulator' ? 'simulator not booted' : 'not connected over USB');
    else if (!entry.ready) health.warnings.push(`WDA not ready${supervisor?.message ? ` — ${supervisor.message}` : ''}`);
    if (health.battery && health.battery.level >= 0 && health.battery.level < HEALTH_THRESHOLDS.lowBattery && health.battery.state !== 'charging' && health.battery.state !== 'full') {
        health.warnings.push(`low battery ${Math.round(health.battery.level * 100)}% and not charging`);
    }
    if (health.thermal === 'serious' || health.thermal === 'critical') health.warnings.push(`thermal state ${health.thermal}`);
    if (health.storage && health.storage.freeBytes < HEALTH_THRESHOLDS.lowStorageBytes) health.warnings.push(`only ${formatBytes(health.storage.freeBytes)} free`);
    if (health.locked && !canSelfUnlock) health.warnings.push('locked and no passcode registered — it cannot unlock itself');
    if ((supervisor?.retryCount ?? 0) >= 3) health.warnings.push(`WDA restarted ${supervisor!.retryCount} times`);
    return health;
}

export async function fleetHealth(fleet: DeviceFleet): Promise<DeviceHealth[]> {
    const [devices, supervisors] = await Promise.all([fleet.list(), wdaServiceStatuses()]);
    return Promise.all(devices.map((entry) => deviceHealth(fleet, entry, supervisors?.find((status) => status.udid === entry.identity.udid))));
}

export function renderHealth(health: DeviceHealth): string {
    const bits = [
        `${health.name} (${health.model ?? health.kind}${health.osVersion ? `, iOS ${health.osVersion}` : ''})`,
        health.present ? `wda=${health.wda}` : 'OFFLINE',
    ];
    if (health.battery && health.battery.level >= 0) bits.push(`battery=${Math.round(health.battery.level * 100)}% ${health.battery.state}`);
    if (health.thermal) bits.push(`thermal=${health.thermal}`);
    if (health.storage) bits.push(`free=${formatBytes(health.storage.freeBytes)}/${formatBytes(health.storage.totalBytes)}`);
    if (health.locked !== undefined) bits.push(health.locked ? 'LOCKED' : `app=${health.activeApp ?? 'home'}`);
    if (health.lastActionAt) bits.push(`last action ${health.lastActionAt}`);
    if (health.supervisorRetries) bits.push(`wda restarts=${health.supervisorRetries}`);
    const line = bits.join(' · ');
    return health.warnings.length ? `${line}\n  ⚠ ${health.warnings.join('; ')}` : line;
}
