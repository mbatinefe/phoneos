import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { DeviceDriver, JsonObject, PhoneosPlugin, SnapshotElement, TaskDefinition } from 'phoneos';

/**
 * An app pack for the built-in Settings app, small on purpose: it shows the shape of a
 * pack (a guide the agent reads, macros it can call, a task you can schedule). Settings
 * exposes every row as an element with a stable id, so all of it works from the tree.
 */

const SETTINGS = 'com.apple.Preferences';
const here = path.dirname(fileURLToPath(import.meta.url));

/** A row reads "Title, value": "Wi-Fi, Home Network" is the Wi-Fi row. */
export function rowTitle(label: string): string {
    const comma = label.indexOf(', ');
    return (comma < 0 ? label : label.slice(0, comma)).trim();
}

/** The row titled `title` on this page (its button when it has one), if it is on screen and enabled. */
export function findRow(elements: readonly SnapshotElement[], title: string): SnapshotElement | undefined {
    const wanted = title.trim().toLowerCase();
    // iOS 26 puts a button in each row's cell; iOS 15 has the cell alone, straight in the table.
    const rows = elements.filter((element) => (element.type === 'Button' || element.type === 'Cell') && element.enabled
        && element.label && (element.type === 'Cell' || element.path.includes('Cell')) && rowTitle(element.label).toLowerCase() === wanted);
    return rows.find((element) => element.type === 'Button') ?? rows[0];
}

/**
 * The rows of General → About worth reporting, by their ids. The serial number, IMEI, EID
 * and network addresses identify the phone, so they are never read.
 */
const ABOUT_ROWS: Readonly<Record<string, string>> = {
    NAME_CELL_ID: 'name',
    SW_VERSION_SPECIFIER: 'iosVersion',
    ProductModelName: 'model',
    APPLICATIONS: 'apps',
    PHOTOS: 'photos',
    VIDEOS: 'videos',
    'User Data Capacity': 'capacity',
    'User Data Available': 'available',
};

/** About's rows read "Label, Value": the values of the rows above that are on screen. */
export function aboutFacts(elements: readonly SnapshotElement[]): Record<string, string> {
    const facts: Record<string, string> = {};
    for (const element of elements) {
        const key = element.identifier ? ABOUT_ROWS[element.identifier] : undefined;
        const comma = element.label?.indexOf(', ') ?? -1;
        if (key && !(key in facts) && comma >= 0) facts[key] = element.label!.slice(comma + 2).trim();
    }
    return facts;
}

/**
 * The rows on screen. Settings is a plain list, so a slow read means a slow phone (an iPhone 7
 * Plus takes longer than the usual 8 seconds), not an app that cannot be read: it gets longer.
 */
async function readRows(driver: DeviceDriver): Promise<SnapshotElement[]> {
    const { elements, treeStatus } = await driver.observe({ tree: true, treeTimeoutMs: 30_000 });
    if (treeStatus !== 'ok') throw new Error(`Settings' rows could not be read (the tree was ${treeStatus}); try again once the phone is idle`);
    return elements;
}

/**
 * Open Settings fresh and walk to a page by its rows: "Battery", "General > About". Rows
 * are read from the tree, a page at a time. (Settings' own search would be shorter, but
 * its results screen takes about 15 seconds to read.) Returns the page it landed on.
 */
export async function openPage(driver: DeviceDriver, path: string): Promise<string> {
    const steps = path.split('>').map((step) => step.trim()).filter(Boolean);
    if (!steps.length) throw new Error('Name a page, such as "Battery" or "General > About"');
    await driver.unlock();
    await driver.openApp(SETTINGS, { relaunch: true });
    await driver.wait(1_000);
    for (const step of steps) {
        let row: SnapshotElement | undefined;
        let seen = '';
        for (let swipe = 0; swipe < 8 && !row; swipe += 1) {
            if (swipe) await driver.scroll('down', 0.5, { intent: 'drag' });
            const elements = await readRows(driver);
            row = findRow(elements, step);
            // The same rows twice: the bottom of the page.
            const now = elements.map((element) => element.label ?? '').join('|');
            if (!row && now === seen) break;
            seen = now;
        }
        if (!row) throw new Error(`Settings shows no "${step}" row on this page`);
        await driver.tap({ elementId: row.id });
        await driver.wait(1_000);
    }
    const bar = (await readRows(driver)).find((element) => element.type === 'NavigationBar');
    return bar?.identifier ?? bar?.label ?? steps.at(-1)!;
}

/** iOS version, model, storage and counts from General → About. */
export async function readAbout(driver: DeviceDriver): Promise<Record<string, string>> {
    await openPage(driver, 'General > About');
    let facts: Record<string, string> = {};
    for (let screen = 0; screen < 4 && !facts.available; screen += 1) {
        if (screen) await driver.scroll('down', 0.3, { intent: 'drag' });
        facts = { ...aboutFacts(await readRows(driver)), ...facts };
    }
    return facts;
}

const aboutTask: TaskDefinition<JsonObject> = {
    type: 'about', version: 1, displayName: 'Log iOS version and free storage',
    fields: [],
    validate: () => ({}),
    summarize: () => 'Read Settings → General → About',
    estimateDurationMs: () => 30_000,
    retryPolicy: () => ({ retryLimit: 1, retryDelaySeconds: 60, retryBackoff: false }),
    supportsStop: () => false,
    async execute(context) {
        try {
            const facts = await readAbout(context.driver);
            await context.log(`iOS ${facts.iosVersion ?? '?'} on ${facts.model ?? '?'}: ${facts.available ?? '?'} free of ${facts.capacity ?? '?'}, ${facts.apps ?? '?'} apps`);
            await context.driver.home();
            return { exitCode: 0, stopped: false };
        } catch (error) {
            return { exitCode: null, stopped: false, error: error instanceof Error ? error.message : String(error) };
        }
    },
};

export const settingsPack: PhoneosPlugin = {
    id: 'com.phoneos.settings',
    version: '0.1.0',
    displayName: 'Settings',
    bundleId: SETTINGS,
    shortId: 'settings',
    guidePath: path.join(here, 'GUIDE.md'),
    tasks: [aboutTask],
    macros: [
        {
            name: 'open',
            description: 'Open Settings fresh on a page, walking its rows: "Battery", "Wi-Fi", "General > About", "Display & Brightness > Auto-Lock". Returns the page it landed on.',
            input: z.object({ page: z.string().min(1).max(160).describe('The page as Settings names it; deeper pages as a path joined with >') }),
            async run(context, input: { page: string }) {
                return `Settings is on ${await openPage(context.driver, input.page)}`;
            },
        },
        {
            name: 'about',
            description: 'Read General → About: the phone\'s name, iOS version, model, storage capacity and free space, and how many apps, photos and videos it holds. Leaves out the serial number, IMEI and network addresses.',
            input: z.object({}),
            async run(context) {
                return readAbout(context.driver);
            },
        },
    ],
};

export default settingsPack;
