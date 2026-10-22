import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { DeviceKind } from './identity.js';
import { refuseExisting } from './media.js';
import type { WdaClient } from './wda-client.js';

const execFileAsync = promisify(execFile);

export interface RecordingInfo { uuid: string; fps: number; codec: number; startedAt: number }

interface RecordingTarget { udid: string; kind: DeviceKind; client: WdaClient }

function stateFile(udid: string): string {
    return path.resolve(process.env.PHONEOS_STATE_DIR ?? '.phoneos', 'recordings', `${udid.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

/**
 * Screen recording through XCTest's daemon (Xcode 15+ / iOS 17+): WDA starts
 * it, the daemon writes a .mov attachment, and we pull that file afterwards.
 * The active recording id is kept on disk so a later CLI process can stop it.
 */
export async function startRecording(target: RecordingTarget, { fps = 10, codec = 0 }: { fps?: number; codec?: 0 | 1 } = {}): Promise<RecordingInfo> {
    const info = await target.client.request<RecordingInfo>('POST', '/wda/video/start', { fps, codec }, 20_000);
    if (!info?.uuid) throw new Error('WDA did not start a screen recording (Xcode 15+ and iOS 17+ are required)');
    await mkdir(path.dirname(stateFile(target.udid)), { recursive: true });
    await writeFile(stateFile(target.udid), JSON.stringify(info));
    return info;
}

export async function activeRecording(udid: string): Promise<RecordingInfo | undefined> {
    try {
        return JSON.parse(await readFile(stateFile(udid), 'utf8')) as RecordingInfo;
    } catch {
        return undefined;
    }
}

async function locateSimulatorAttachment(udid: string, uuid: string): Promise<string> {
    const root = path.join(process.env.HOME ?? '', 'Library/Developer/CoreSimulator/Devices', udid, 'data/Containers/Data/InternalDaemon');
    for (const daemon of await readdir(root).catch(() => [] as string[])) {
        // Xcode 15 wrote Attachments/<uuid>; Xcode 16+ writes tmp/Attachments/<uuid>.
        for (const candidate of [path.join(root, daemon, 'tmp', 'Attachments', uuid), path.join(root, daemon, 'Attachments', uuid)]) {
            try {
                if ((await stat(candidate)).isFile()) return candidate;
            } catch { /* keep looking */ }
        }
    }
    throw new Error(`Recording ${uuid} was not found under ${root}`);
}

/** Stop the active recording and save it as a .mov at `outPath`. */
export async function stopRecording(target: RecordingTarget, outPath: string, log: (line: string) => void = () => {}): Promise<{ path: string; bytes: number; info: RecordingInfo }> {
    // Checked before stopping, so a bad path does not cost the recording.
    refuseExisting(outPath);
    const known = await activeRecording(target.udid);
    // Whatever the phone answers, the recording it had is over: forget it, so the next start is not refused.
    const info = await target.client.request<RecordingInfo | null>('POST', '/wda/video/stop', {}, 30_000).finally(() => rm(stateFile(target.udid), { force: true }));
    const recording = info?.uuid ? info : known;
    if (!recording?.uuid) throw new Error('No screen recording is active on this device');
    await mkdir(path.dirname(outPath), { recursive: true });
    // The daemon finalises the file a moment after stop.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (target.kind === 'simulator') {
        const source = await locateSimulatorAttachment(target.udid, recording.uuid);
        await copyFile(source, outPath, constants.COPYFILE_EXCL);
    } else {
        let lastError: unknown;
        for (const source of [`tmp/Attachments/${recording.uuid}`, `Attachments/${recording.uuid}`]) {
            try {
                await execFileAsync('xcrun', [
                    'devicectl', 'device', 'copy', 'from', '--device', target.udid,
                    '--source', source, '--destination', outPath,
                    '--user', 'mobile', '--domain-type', 'appDataContainer', '--domain-identifier', 'com.apple.testmanagerd',
                ], { timeout: 180_000 });
                lastError = undefined;
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (lastError) throw new Error(`Could not pull recording ${recording.uuid} from the phone: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    const { size } = await stat(outPath);
    if (!size) {
        await rm(outPath, { force: true });
        throw new Error('The recording came back empty: iOS could not finish it (it fails while the phone is locked). Unlock the phone and record again.');
    }
    log(`recording: saved ${outPath} (${(size / 1024).toFixed(0)} KB)`);
    return { path: outPath, bytes: size, info: recording };
}
