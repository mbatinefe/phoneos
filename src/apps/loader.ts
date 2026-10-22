import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { configuredPluginModules, loadPlugins } from '../loader.js';
import type { PhoneosPlugin } from '../plugin.js';

interface PackModule { default?: PhoneosPlugin; pack?: PhoneosPlugin; plugin?: PhoneosPlugin }

/** Repo-local app packs: every `apps/<name>/pack.ts` (or `pack.js`). */
export async function loadLocalAppPacks(appsDirectory = path.resolve(process.env.PHONEOS_APPS_DIR ?? 'apps')): Promise<PhoneosPlugin[]> {
    let entries: string[];
    try {
        entries = await readdir(appsDirectory);
    } catch {
        return [];
    }
    const packs: PhoneosPlugin[] = [];
    for (const entry of entries.sort()) {
        if (entry.startsWith('.') || entry.startsWith('_')) continue;
        const directory = path.join(appsDirectory, entry);
        if (!(await stat(directory)).isDirectory()) continue;
        let loaded: PackModule | undefined;
        for (const file of ['pack.ts', 'pack.js'].map((name) => path.join(directory, name))) {
            try {
                await stat(file);
            } catch {
                continue;
            }
            loaded = await import(pathToFileURL(file).href) as PackModule;
            break;
        }
        if (!loaded) continue;
        const pack = loaded.default ?? loaded.pack ?? loaded.plugin;
        if (!pack?.id || !Array.isArray(pack.tasks)) throw new Error(`${directory} does not export a phoneos app pack`);
        packs.push(pack);
    }
    return packs;
}

/** Local app packs plus any ESM packages named in `PHONEOS_PLUGINS`. */
export async function loadAllPlugins(): Promise<PhoneosPlugin[]> {
    const [local, external] = await Promise.all([loadLocalAppPacks(), loadPlugins(configuredPluginModules())]);
    const seen = new Set(local.map((pack) => pack.id));
    return [...local, ...external.filter((plugin) => !seen.has(plugin.id))];
}

/** The pack that owns a bundle id, if any. */
export function packForApp(plugins: readonly PhoneosPlugin[], bundleId: string | null | undefined): PhoneosPlugin | undefined {
    if (!bundleId) return undefined;
    return plugins.find((plugin) => plugin.bundleId === bundleId);
}
