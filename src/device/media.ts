import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import type { DeviceKind } from './identity.js';
import type { WdaClient } from './wda-client.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const MIME_BY_EXTENSION: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
};

export function mediaMimeType(file: string): string | undefined {
    return MIME_BY_EXTENSION[path.extname(file).toLowerCase()];
}

export interface AddedMedia { file: string; name: string; mimeType: string; bytes: number }

/**
 * A path inside an app's Documents folder, normalised. Anything that climbs out of it
 * (`..`) is refused: on a simulator the folder is a directory on this Mac, and a path
 * that leaves it would read or write the Mac's own files.
 */
export function documentsPath(relative: string): string {
    const normalised = path.posix.normalize(relative.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^Documents(\/|$)/, ''));
    if (normalised === '..' || normalised.startsWith('../')) throw new Error(`"${relative}" leaves the app's Documents folder`);
    return normalised === '.' ? '' : normalised.replace(/\/+$/, '');
}

/** `name.jpg`, else `name-2.jpg`, `name-3.jpg`, … — whichever does not exist yet. */
export function freePath(file: string): string {
    if (!existsSync(file)) return file;
    const extension = path.extname(file);
    const stem = file.slice(0, file.length - extension.length);
    for (let index = 2; ; index += 1) {
        const candidate = `${stem}-${index}${extension}`;
        if (!existsSync(candidate)) return candidate;
    }
}

/** Files pulled to this Mac never replace one that is already there. */
export function refuseExisting(file: string): void {
    if (existsSync(file)) throw new Error(`${file} already exists; choose another output path or remove it first`);
}

/**
 * Put images / videos into the phone's Photos library.
 *
 * Simulators: `xcrun simctl addmedia` (no permission prompt). Devices: the
 * patched WDA route `/wda/import-media`, which needs the WebDriverAgentRunner
 * app to be allowed to add to Photos — iOS asks once, on the phone; tap
 * Allow and retry. Photos never holds documents; see `addDocument`.
 */
export async function addToPhotos(target: { udid: string; kind: DeviceKind; client: WdaClient }, files: string[], log: (line: string) => void = () => {}): Promise<AddedMedia[]> {
    if (!files.length) throw new Error('Give at least one image or video file');
    const added: AddedMedia[] = [];
    for (const file of files) {
        const mimeType = mediaMimeType(file);
        if (!mimeType) throw new Error(`${path.basename(file)}: Photos accepts images and videos only (${Object.keys(MIME_BY_EXTENSION).join(', ')})`);
        const info = await stat(file).catch(() => { throw new Error(`File not found: ${file}`); });
        added.push({ file: path.resolve(file), name: path.basename(file), mimeType, bytes: info.size });
    }
    if (target.kind === 'simulator') {
        await execFileAsync('xcrun', ['simctl', 'addmedia', target.udid, ...added.map((entry) => entry.file)], { timeout: 120_000 });
        log(`photos: added ${added.length} item${added.length === 1 ? '' : 's'} via simctl`);
        return added;
    }
    for (const entry of added) {
        if (entry.bytes > 350 * 1024 * 1024) throw new Error(`${entry.name} is ${(entry.bytes / 1_048_576).toFixed(0)} MB — the import limit is 350 MB`);
        try {
            const result = await target.client.importMedia(entry.name, entry.mimeType, await readFile(entry.file));
            log(`photos: imported ${entry.name} (${result.localIdentifier}); library now has ${result.assetCount} items`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/Photos permission|Photos access is denied/i.test(message)) {
                throw new Error(`${message}. On the phone, tap Allow for WebDriverAgentRunner (or enable it under Settings → Privacy & Security → Photos), then retry.`);
            }
            throw error;
        }
    }
    return added;
}

export interface AfcService {
    createDirectory(dir: string): Promise<void>;
    openFile(filePath: string, mode: number): Promise<number>;
    writeFile(fileHandle: number, buffer: Buffer): Promise<void>;
    closeFileHandle(fileHandle: number): Promise<void>;
    listDirectory(dir: string): Promise<string[]>;
    close(): void;
}

const AFC_WRITE_MODE = 0x00000003; // O_WRONLY | O_CREAT | O_TRUNC (appium-ios-device FileModes.w)
const AFC_CHUNK = 1024 * 1024;

/**
 * Upload a buffer over AFC in acknowledged 1 MB chunks. The library's write
 * stream buffers everything and then times out closing large files (a 40 MB
 * .ipa reliably); per-chunk round trips keep the device's replies flowing.
 */
export async function afcUpload(afc: AfcService, remotePath: string, data: Buffer): Promise<void> {
    const handle = await afc.openFile(remotePath, AFC_WRITE_MODE);
    try {
        for (let offset = 0; offset < data.length; offset += AFC_CHUNK) {
            await afc.writeFile(handle, data.subarray(offset, Math.min(data.length, offset + AFC_CHUNK)));
        }
    } finally {
        await afc.closeFileHandle(handle);
    }
}

interface HouseArrestService {
    vendDocuments(bundleId: string): Promise<AfcService>;
    close(): void;
}

/**
 * Copy a file into an app's Documents folder, where it appears under Files →
 * On My iPhone → <App> (the app must declare `UIFileSharingEnabled`).
 *
 * Simulators: written straight into the app's data container on disk.
 * Devices: house arrest + AFC over USB.
 */
export async function addDocument(
    target: { udid: string; kind: DeviceKind },
    bundleId: string,
    file: string,
    { name, subdirectory = '' }: { name?: string; subdirectory?: string } = {},
    log: (line: string) => void = () => {},
): Promise<{ bundleId: string; destination: string; bytes: number }> {
    const info = await stat(file).catch(() => { throw new Error(`File not found: ${file}`); });
    const fileName = (name ?? path.basename(file)).replace(/[/\\]/g, '_');
    const folder = documentsPath(subdirectory);
    const relative = folder ? `${folder}/${fileName}` : fileName;
    if (target.kind === 'simulator') {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'get_app_container', target.udid, bundleId, 'data'], { timeout: 30_000 })
            .catch(() => { throw new Error(`${bundleId} is not installed on the simulator (or has no data container)`); });
        const destination = path.join(stdout.trim(), 'Documents', relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(file, destination);
        log(`files: copied ${fileName} into ${bundleId}/Documents/${relative}`);
        return { bundleId, destination: `Documents/${relative}`, bytes: info.size };
    }
    const { services } = require('appium-ios-device') as { services: { startHouseArrestService(udid: string): Promise<HouseArrestService> } };
    const houseArrest = await services.startHouseArrestService(target.udid);
    let afc: AfcService | undefined;
    try {
        afc = await houseArrest.vendDocuments(bundleId).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Cannot open the Documents folder of ${bundleId}: ${reason}. The app must be installed and declare UIFileSharingEnabled (it then shows under Files → On My iPhone).`);
        });
        if (subdirectory) {
            let current = '';
            for (const segment of subdirectory.replace(/^\/+|\/+$/g, '').split('/')) {
                current = current ? `${current}/${segment}` : segment;
                await afc.createDirectory(current).catch(() => undefined);
            }
        }
        await afcUpload(afc, relative, await readFile(file));
        log(`files: uploaded ${fileName} (${info.size} bytes) into ${bundleId}/Documents/${relative}`);
        return { bundleId, destination: `Documents/${relative}`, bytes: info.size };
    } finally {
        afc?.close();
        houseArrest.close();
    }
}

/** Files in an app's Documents folder (same access rules as `addDocument`). */
export async function listDocuments(target: { udid: string; kind: DeviceKind }, bundleId: string, subdirectory = ''): Promise<string[]> {
    subdirectory = documentsPath(subdirectory);
    if (target.kind === 'simulator') {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'get_app_container', target.udid, bundleId, 'data'], { timeout: 30_000 });
        const { readdir } = await import('node:fs/promises');
        return readdir(path.join(stdout.trim(), 'Documents', subdirectory)).catch(() => []);
    }
    const { services } = require('appium-ios-device') as { services: { startHouseArrestService(udid: string): Promise<HouseArrestService> } };
    const houseArrest = await services.startHouseArrestService(target.udid);
    let afc: AfcService | undefined;
    try {
        afc = await houseArrest.vendDocuments(bundleId);
        return (await afc.listDirectory(subdirectory || '.')).filter((entry) => entry !== '.' && entry !== '..');
    } finally {
        afc?.close();
        houseArrest.close();
    }
}

// ---- pulling files back ------------------------------------------------------

export interface PulledFile { name: string; path: string; bytes: number; modifiedAt?: string }

interface AfcRootService extends AfcService {
    getFileInfo(path: string): Promise<{ st_size?: string | number; st_mtime?: string | number; st_ifmt?: string }>;
    createReadStream(filePath: string, options?: { autoDestroy?: boolean }): Promise<NodeJS.ReadableStream & { destroy(): void }>;
}

const CAMERA_EXTENSIONS = /\.(jpe?g|png|heic|heif|gif|webp|dng|mov|mp4|m4v)$/i;

function simulatorMediaRoot(udid: string): string {
    return path.join(process.env.HOME ?? '', 'Library/Developer/CoreSimulator/Devices', udid, 'data/Media');
}

async function ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
}

/**
 * Newest photos / videos from the camera roll (DCIM), copied to `outDirectory`.
 * Devices: AFC over USB (the media partition every iPhone exposes when paired).
 * Simulators: the DCIM folder on disk.
 */
export async function getPhotos(
    target: { udid: string; kind: DeviceKind },
    { count = 10, outDirectory }: { count?: number; outDirectory: string },
    log: (line: string) => void = () => {},
): Promise<PulledFile[]> {
    await ensureDirectory(outDirectory);
    if (target.kind === 'simulator') {
        const { readdir, copyFile: copy } = await import('node:fs/promises');
        const dcim = path.join(simulatorMediaRoot(target.udid), 'DCIM');
        const candidates: Array<{ name: string; full: string; mtime: number; bytes: number }> = [];
        for (const folder of await readdir(dcim).catch(() => [] as string[])) {
            const directory = path.join(dcim, folder);
            for (const name of await readdir(directory).catch(() => [] as string[])) {
                if (!CAMERA_EXTENSIONS.test(name)) continue;
                const info = await stat(path.join(directory, name));
                candidates.push({ name, full: path.join(directory, name), mtime: info.mtimeMs, bytes: info.size });
            }
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        const pulled: PulledFile[] = [];
        for (const entry of candidates.slice(0, count)) {
            const destination = freePath(path.join(outDirectory, entry.name));
            await copy(entry.full, destination, constants.COPYFILE_EXCL);
            pulled.push({ name: entry.name, path: destination, bytes: entry.bytes, modifiedAt: new Date(entry.mtime).toISOString() });
        }
        log(`photos: pulled ${pulled.length} of ${candidates.length} camera-roll items`);
        return pulled;
    }
    const { services } = require('appium-ios-device') as { services: { startAfcService(udid: string): Promise<AfcRootService> } };
    const afc = await services.startAfcService(target.udid);
    try {
        const candidates: Array<{ name: string; remote: string; mtime: number; bytes: number }> = [];
        for (const folder of await afc.listDirectory('DCIM').catch(() => [] as string[])) {
            if (folder === '.' || folder === '..') continue;
            for (const name of await afc.listDirectory(`DCIM/${folder}`).catch(() => [] as string[])) {
                if (!CAMERA_EXTENSIONS.test(name)) continue;
                const info: { st_size?: string | number; st_mtime?: string | number } = await afc.getFileInfo(`DCIM/${folder}/${name}`).catch(() => ({}));
                candidates.push({ name, remote: `DCIM/${folder}/${name}`, mtime: afcTimeToMs(info.st_mtime), bytes: Number(info.st_size ?? 0) });
            }
        }
        candidates.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
        const pulled: PulledFile[] = [];
        for (const entry of candidates.slice(0, count)) {
            const destination = freePath(path.join(outDirectory, entry.name));
            await pullAfcFile(afc, entry.remote, destination);
            const info = await stat(destination);
            pulled.push({ name: entry.name, path: destination, bytes: info.size, ...(entry.mtime ? { modifiedAt: new Date(entry.mtime).toISOString() } : {}) });
        }
        log(`photos: pulled ${pulled.length} of ${candidates.length} camera-roll items over USB`);
        return pulled;
    } finally {
        afc.close();
    }
}

/** AFC reports st_mtime in nanoseconds since the epoch (older builds: seconds). */
function afcTimeToMs(value: string | number | undefined): number {
    const raw = Number(value ?? 0);
    if (!raw) return 0;
    if (raw > 1e17) return raw / 1e6; // ns
    if (raw > 1e14) return raw / 1e3; // µs
    if (raw > 1e11) return raw;       // ms
    return raw * 1000;                // s
}

async function pullAfcFile(afc: AfcRootService | AfcService, remote: string, destination: string): Promise<void> {
    const { createWriteStream } = await import('node:fs');
    const source = await (afc as AfcRootService).createReadStream(remote, { autoDestroy: true });
    await new Promise<void>((resolve, reject) => {
        const sink = createWriteStream(destination, { flags: 'wx' });
        source.once('error', reject);
        sink.once('error', reject);
        sink.once('finish', () => resolve());
        source.pipe(sink);
    });
}

/** A file out of an app's Documents folder (same access rules as `addDocument`). */
export async function getDocument(
    target: { udid: string; kind: DeviceKind },
    bundleId: string,
    remotePath: string,
    outPath: string,
    log: (line: string) => void = () => {},
): Promise<PulledFile> {
    const relative = documentsPath(remotePath);
    if (!relative) throw new Error('Give the path of a file inside Documents');
    refuseExisting(outPath);
    await ensureDirectory(path.dirname(outPath));
    if (target.kind === 'simulator') {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'get_app_container', target.udid, bundleId, 'data'], { timeout: 30_000 })
            .catch(() => { throw new Error(`${bundleId} is not installed on the simulator (or has no data container)`); });
        await copyFile(path.join(stdout.trim(), 'Documents', relative), outPath, constants.COPYFILE_EXCL);
    } else {
        const { services } = require('appium-ios-device') as { services: { startHouseArrestService(udid: string): Promise<HouseArrestService> } };
        const houseArrest = await services.startHouseArrestService(target.udid);
        let afc: AfcService | undefined;
        try {
            afc = await houseArrest.vendDocuments(bundleId);
            await pullAfcFile(afc, relative, outPath);
        } finally {
            afc?.close();
            houseArrest.close();
        }
    }
    const info = await stat(outPath);
    log(`files: pulled ${bundleId}/Documents/${relative} (${info.size} bytes)`);
    return { name: path.basename(outPath), path: outPath, bytes: info.size };
}
