import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The WebDriverAgent release the patches in `Patches/` are written against. */
export const WDA_VERSION = '8.9.1';
const TARBALL_URL = `https://registry.npmjs.org/appium-webdriveragent/-/appium-webdriveragent-${WDA_VERSION}.tgz`;
/** The release tarball's npm integrity; a download that does not match it is refused. */
const TARBALL_INTEGRITY = 'sha512-yhXkgE7WGuZLPR/bdp+OamLteTlqgQIjoze7ts/Pq4DXNGT92z5GaXg9kqDx9ulS6eM6M53khIt5n24v59Tbug==';

export interface WdaSourceOptions {
    url?: string;
    integrity?: string;
    fetchImpl?: typeof fetch;
}

/**
 * Downloads WebDriverAgent's source into `root` unless its Xcode project is already there.
 * Only the release's Xcode sources are needed, so the npm package's own dependencies
 * (an Appium server stack phoneos never runs) are not installed.
 */
export async function ensureWdaSource(root: string, options: WdaSourceOptions = {}): Promise<void> {
    if (existsSync(path.join(root, 'WebDriverAgent.xcodeproj'))) return;
    const url = options.url ?? TARBALL_URL;
    const integrity = options.integrity ?? TARBALL_INTEGRITY;
    const response = await (options.fetchImpl ?? fetch)(url);
    if (!response.ok) throw new Error(`Could not download WebDriverAgent ${WDA_VERSION} (${url}: HTTP ${response.status})`);
    const tarball = Buffer.from(await response.arrayBuffer());
    const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (actual !== integrity) throw new Error(`The WebDriverAgent ${WDA_VERSION} download does not match its pinned checksum; refusing to build it`);

    await mkdir(path.dirname(root), { recursive: true });
    const staging = await mkdtemp(`${root}.download-`);
    try {
        const file = path.join(staging, 'source.tgz');
        await writeFile(file, tarball);
        const unpacked = path.join(staging, 'source');
        await mkdir(unpacked);
        await execFileAsync('tar', ['-xzf', file, '-C', unpacked, '--strip-components', '1']);
        await rm(root, { recursive: true, force: true });
        await rename(unpacked, root);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    console.log(`Downloaded WebDriverAgent ${WDA_VERSION} into ${root}`);
}
