import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { packForApp } from '../apps/loader.js';
import { SYSTEM_APPS, type InstalledApp } from '../device/apps.js';
import { captureDeviceLog, capturedDeviceLog, crashReports, errorLines, executableName, linesOfProcess, simulatorLog } from '../device/logs.js';
import { freePath } from '../device/media.js';
import { pushPayload, sendPush, setCleanStatusBar, setPermission, type PrivacyService } from '../device/simulator-controls.js';
import type { DeviceDriver, SwipeDirection, TapTarget } from '../device/driver.js';
import type { DeviceFleet } from '../device/fleet.js';
import { resolvePoint } from '../device/points.js';
import { fleetHealth, renderHealth } from '../device/health.js';
import { runDoctor } from '../devices/doctor.js';
import { addVideoMetadata, type AddVideoMetadataInput } from '../media/video-metadata.js';
import { normalizeVideo, type NormalizeVideoInput } from '../media/video-normalize.js';
import { auditAccessibility, renderAudit } from '../observe/a11y.js';
import { renderChanges } from '../observe/diff.js';
import { markableElements, markScreenshot } from '../observe/marks.js';
import { findElements } from '../observe/tree.js';
import { renderElement, renderSnapshot, renderState } from '../observe/render.js';
import type { Snapshot } from '../observe/types.js';
import { pluginShortId, type MacroContext, type PhoneosPlugin } from '../plugin.js';
import { RunReports } from './report.js';
import type { JsonObject } from '../types.js';

export interface ToolImage { data: Buffer; mimeType: 'image/jpeg' | 'image/png' }

export interface ToolResult {
    text: string;
    image?: ToolImage;
}

export interface AgentToolsOptions {
    fleet: DeviceFleet;
    plugins?: readonly PhoneosPlugin[];
    /** Where the per-session action log goes; `null` disables recording. */
    recordDirectory?: string | null;
    /**
     * Files this process writes on the Mac (pulled files, recordings) must land inside this
     * folder. The MCP server sets it, since an agent can be talked into anything by what it
     * reads on screen; the CLI does not, since a person typed the path.
     */
    outputRoot?: string;
    log?: (line: string) => void;
}

/** Tool names an MCP client can call for a pack macro: `<shortId>_<macro>` (dots are unsafe in some clients). */
export function macroToolName(plugin: PhoneosPlugin, macro: { name: string }): string {
    return `${pluginShortId(plugin)}_${macro.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The phone as a tool set. Model-agnostic: every method takes plain data and
 * returns text (plus an optional image), so the MCP server and the CLI are
 * thin wrappers over the same behaviour.
 */
export class AgentTools {
    readonly fleet: DeviceFleet;
    readonly plugins: readonly PhoneosPlugin[];
    private readonly recordDirectory: string | null;
    private readonly outputRoot: string | undefined;
    /** `.phoneos/` (or PHONEOS_STATE_DIR): sessions, reports, pulled files, recordings, crash reports. */
    private readonly stateRoot: string;
    private readonly reports: RunReports;
    private readonly sessionFile: string;
    private readonly log: (line: string) => void;
    private appsCache = new Map<string, { at: number; apps: InstalledApp[] }>();

    constructor(options: AgentToolsOptions) {
        this.fleet = options.fleet;
        this.plugins = options.plugins ?? [];
        const stateRoot = path.resolve(process.env.PHONEOS_STATE_DIR ?? '.phoneos');
        this.recordDirectory = options.recordDirectory === undefined ? path.join(stateRoot, 'sessions') : options.recordDirectory;
        this.stateRoot = this.recordDirectory ? path.dirname(this.recordDirectory) : stateRoot;
        this.outputRoot = options.outputRoot ? path.resolve(options.outputRoot) : undefined;
        this.reports = new RunReports(path.join(this.stateRoot, 'reports'));
        this.sessionFile = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`;
        this.log = options.log ?? (() => {});
    }

    // ---- plumbing ----------------------------------------------------------

    async driver(reference: string | undefined): Promise<DeviceDriver> {
        const device = await this.fleet.resolve(reference ?? '');
        const driver = await this.fleet.driver(device.udid);
        if (!driver.snapshot) await this.restoreSnapshot(driver);
        return driver;
    }

    private snapshotPath(udid: string): string | null {
        return this.recordDirectory ? path.join(this.recordDirectory, `last-snapshot-${udid.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`) : null;
    }

    /** The CLI is one process per command: keep the last observation on disk so `tap e7` works after `observe`. */
    private async persistSnapshot(driver: DeviceDriver): Promise<void> {
        const file = this.snapshotPath(driver.udid);
        const snapshot = driver.snapshot;
        if (!file || !snapshot) return;
        try {
            await mkdir(path.dirname(file), { recursive: true });
            const { screenshot: _screenshot, ...rest } = snapshot;
            await writeFile(file, JSON.stringify(rest));
        } catch { /* best-effort */ }
    }

    private async restoreSnapshot(driver: DeviceDriver): Promise<void> {
        const file = this.snapshotPath(driver.udid);
        if (!file) return;
        try {
            const stored = JSON.parse(await readFile(file, 'utf8')) as Snapshot;
            if (Date.now() - Date.parse(stored.state.takenAt) < 10 * 60_000) driver.restoreSnapshot(stored);
        } catch { /* nothing stored */ }
    }

    /** A path to write on the Mac, refused when it falls outside `outputRoot`. */
    private outputPath(requested: string): string {
        const resolved = path.resolve(requested);
        if (this.outputRoot) {
            const relative = path.relative(this.outputRoot, resolved);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`Files can only be written inside ${this.outputRoot}; ${requested} is outside it. Leave the path out to use the default folder.`);
            }
        }
        return resolved;
    }

    private async record(event: Record<string, unknown>): Promise<void> {
        if (!this.recordDirectory) return;
        try {
            await mkdir(this.recordDirectory, { recursive: true });
            const at = new Date().toISOString();
            await appendFile(path.join(this.recordDirectory, this.sessionFile), `${JSON.stringify({ at, ...event })}\n`);
            if (typeof event.device === 'string' && event.action !== 'observe') {
                await writeFile(path.join(this.stateRoot, `last-action-${event.device.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), JSON.stringify({ at, action: event.action }));
            }
        } catch { /* recording is best-effort */ }
    }

    /** Battery, thermal state, storage, WDA state, lock/app and last action for every registered device, with warnings. */
    async fleetStatus(): Promise<ToolResult> {
        const report = await fleetHealth(this.fleet);
        if (!report.length) return { text: 'No registered devices.' };
        const warnings = report.filter((entry) => entry.warnings.length).length;
        return { text: `${report.map(renderHealth).join('\n')}\n${warnings ? `${warnings} device${warnings === 1 ? '' : 's'} with warnings.` : 'All devices healthy.'}` };
    }

    /** Setup checks, each problem with its fix: Xcode, the agent build, the service, every registered device. */
    async doctor(): Promise<ToolResult> {
        return { text: (await runDoctor()).text };
    }

    private async afterAction(driver: DeviceDriver, action: string, detail: Record<string, unknown> = {}): Promise<ToolResult> {
        let summary: string;
        let state: Awaited<ReturnType<DeviceDriver['state']>> | undefined;
        try {
            state = await driver.state();
            summary = renderState(state);
        } catch (error) {
            summary = `state unavailable (${error instanceof Error ? error.message : String(error)})`;
        }
        await this.record({ device: driver.udid, action, ...detail, state: state ? { app: state.activeApp?.bundleId ?? null, locked: state.locked, keyboard: state.keyboardVisible, alert: state.alert } : undefined });
        await this.reportStep(driver, action, summary);
        return { text: `${action} done. ${summary}\nObserve again before the next action: what changed has new ids (observe changes=true lists only that).` };
    }

    // ---- run reports ---------------------------------------------------------------

    /** With a report open for this device, the step and a screenshot of what followed. */
    private async reportStep(driver: DeviceDriver, action: string, state?: string, failed = false): Promise<void> {
        try {
            if (!(await this.reports.active(driver.udid))) return;
            const image = await driver.screenshot('jpeg').then((shot) => shot.data, () => undefined);
            await this.reports.step(driver.udid, { action, ...(state ? { state } : {}), ...(image ? { image } : {}), failed });
        } catch { /* a report never fails the action it describes */ }
    }

    /** A tool call that failed, as a failed step of the open report (if there is one). */
    async noteFailure(device: string | undefined, tool: string, message: string): Promise<void> {
        try {
            const driver = await this.driver(device);
            await this.reportStep(driver, `${tool} failed: ${message.replace(/^Error: /, '')}`, undefined, true);
        } catch { /* no device to report on */ }
    }

    async startReport(device: string | undefined, title: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const report = await this.reports.start(driver.udid, driver.identity.name, title);
        await this.reportStep(driver, 'Start', renderState(await driver.state()));
        return { text: `Report "${title}" is open for ${report.device}: every action from now on is written down with a screenshot of what followed. finish_report writes it out.` };
    }

    async finishReport(device: string | undefined, input: { outcome?: 'passed' | 'failed'; notes?: string } = {}): Promise<ToolResult> {
        const driver = await this.driver(device);
        await this.reportStep(driver, 'End', renderState(await driver.state()));
        const finished = await this.reports.finish(driver.udid, input);
        return { text: `Report written: ${finished.path} (${finished.steps} steps${finished.failures ? `, ${finished.failures} failed` : ''}). It is one HTML file with the screenshots inside, ready to attach or share.` };
    }

    private packHint(snapshot: Snapshot): string {
        const pack = packForApp(this.plugins, snapshot.state.activeApp?.bundleId);
        if (!pack) return '';
        const macros = (pack.macros ?? []).map((macro) => macroToolName(pack, macro));
        return `\napp pack "${pluginShortId(pack)}" is active — read phoneos://guide/${pluginShortId(pack)} for its layout and gotchas${macros.length ? `; macros: ${macros.join(', ')}` : ''}`;
    }

    // ---- read ----------------------------------------------------------------

    async listDevices(): Promise<ToolResult> {
        const devices = await this.fleet.list();
        if (!devices.length) return { text: 'No registered devices. Register one from the dashboard (http://127.0.0.1:3000/devices/register) or `phone register-sim` for a simulator.' };
        const lines = await Promise.all(devices.map(async (entry) => {
            const identity = entry.identity;
            let state = '';
            if (entry.ready) {
                try {
                    const driver = await this.fleet.driver(identity.udid);
                    state = ` · ${renderState(await driver.state())}`;
                } catch (error) {
                    state = ` · state error: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
            const availability = !entry.present ? 'not connected' : entry.ready ? 'ready' : 'connected, WDA not ready (is `npm run wda:service` running?)';
            return `${identity.name} — udid ${identity.udid} · ${identity.modelName ?? identity.productType ?? identity.kind}${identity.osVersion ? ` iOS ${identity.osVersion}` : ''} · ${identity.kind} · ${availability}${state}`;
        }));
        return { text: lines.join('\n') };
    }

    async deviceState(device?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        return { text: renderState(await driver.state()) };
    }

    async observe(device: string | undefined, { screenshot = false, maxElements = 120, treeTimeoutMs, marks = true, changes = false }: { screenshot?: boolean; maxElements?: number; treeTimeoutMs?: number; marks?: boolean; changes?: boolean } = {}): Promise<ToolResult> {
        const driver = await this.driver(device);
        const previous = driver.snapshot;
        const snapshot = await driver.observe({ tree: true, screenshot, maxElements, ...(treeTimeoutMs ? { treeTimeoutMs } : {}) });
        await this.persistSnapshot(driver);
        await this.record({ device: driver.udid, action: 'observe', treeStatus: snapshot.treeStatus, elements: snapshot.elements.length, app: snapshot.state.activeApp?.bundleId ?? null });
        const changed = changes ? renderChanges(previous, snapshot) : undefined;
        const text = `${changed ?? `${changes ? 'the screen changed too much to list only the changes; all of it:\n' : ''}${renderSnapshot(snapshot, { truncated: driver.truncatedElements })}`}${this.packHint(snapshot)}`;
        const shot = snapshot.screenshot;
        if (!shot) return { text };
        const marked = marks ? markableElements(snapshot.elements).length : 0;
        if (!marked) return { text, image: { data: shot.data, mimeType: shot.mimeType } };
        return {
            text: `${text}\nThe screenshot shows the id of each of the ${marked} tappable elements: tap them by element_id.`,
            image: { data: await markScreenshot(shot.data, shot, snapshot.elements, shot.mimeType), mimeType: shot.mimeType },
        };
    }

    /** Accessibility problems on the screen in front, with the offending elements boxed on a screenshot if asked. */
    async a11yAudit(device: string | undefined, { screenshot = false }: { screenshot?: boolean } = {}): Promise<ToolResult> {
        const driver = await this.driver(device);
        const snapshot = await driver.observe({ tree: true, screenshot, maxElements: 400 });
        await this.persistSnapshot(driver);
        if (snapshot.treeStatus === 'skipped') return { text: 'This is a phone\'s home screen, whose element tree is not read (it takes ~20 s and holds up the phone). Open the app to check and run this again.' };
        if (snapshot.treeStatus !== 'ok') return { text: `The screen's element tree could not be read (${snapshot.treeStatus}), so there is nothing to check. Custom-drawn screens are invisible to VoiceOver as well.` };
        const findings = auditAccessibility(snapshot.elements);
        const checked = snapshot.elements.filter((element) => element.interactive && element.type !== 'Key').length;
        await this.record({ device: driver.udid, action: 'a11y_audit', findings: findings.length });
        const text = renderAudit(findings, checked);
        const shot = snapshot.screenshot;
        if (!shot) return { text };
        const flagged = [...new Map(findings.map((finding) => [finding.element.id, finding.element])).values()];
        return { text, image: { data: flagged.length ? await markScreenshot(shot.data, shot, flagged, shot.mimeType) : shot.data, mimeType: shot.mimeType } };
    }

    async screenshot(device?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const shot = await driver.screenshot('jpeg');
        return { text: `screenshot ${shot.width}×${shot.height} points (coordinates in this image are tap coordinates)`, image: { data: shot.data, mimeType: shot.mimeType } };
    }

    async find(device: string | undefined, text: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        // Always look at the live screen: the ids reported here must be the ones a
        // following `tap` resolves, and a restored snapshot may describe an older screen.
        await driver.observe({ tree: true });
        await this.persistSnapshot(driver);
        const matches = driver.snapshot ? findElements(driver.snapshot.elements, text) : [];
        return { text: matches.length ? matches.map(renderElement).join('\n') : `Nothing on screen matches "${text}".` };
    }

    async listApps(device?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const apps = await this.installedApps(driver);
        return { text: [...apps.map((app) => `${app.bundleId} — ${app.name}${app.version ? ` (${app.version})` : ''}`), '— system apps —', ...SYSTEM_APPS.map((app) => `${app.bundleId} — ${app.name}`)].join('\n') };
    }

    private async installedApps(driver: DeviceDriver): Promise<InstalledApp[]> {
        const cached = this.appsCache.get(driver.udid);
        if (cached && Date.now() - cached.at < 60_000) return cached.apps;
        const apps = await driver.listApps();
        this.appsCache.set(driver.udid, { at: Date.now(), apps });
        return apps;
    }

    // ---- act ----------------------------------------------------------------

    private target(input: { elementId?: string; x?: number; y?: number; text?: string; spread?: number }): TapTarget {
        if (input.elementId) return { elementId: input.elementId };
        if (typeof input.x === 'number' && typeof input.y === 'number') return { x: input.x, y: input.y, ...(typeof input.spread === 'number' ? { spread: input.spread } : {}) };
        if (input.text) return { text: input.text };
        throw new Error('Give an element id (preferred), a text label, or x/y coordinates in points');
    }

    async tap(device: string | undefined, input: { elementId?: string; x?: number; y?: number; text?: string; spread?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const result = await driver.tap(this.target(input));
        return this.afterAction(driver, `tap at (${result.x}, ${result.y})${result.element ? ` on ${result.element.type} "${result.element.label ?? result.element.name ?? ''}"` : ''}`, { x: result.x, y: result.y, element: result.element?.id });
    }

    async tapKeys(device: string | undefined, text: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const count = await driver.tapKeys(text);
        // The text itself stays out of the session log: it may be a password or a code.
        return this.afterAction(driver, `tapped ${count} keys`);
    }

    async doubleTap(device: string | undefined, input: { elementId?: string; x?: number; y?: number; text?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const result = await driver.doubleTap(this.target(input));
        return this.afterAction(driver, `double-tap at (${result.x}, ${result.y})`, result);
    }

    async longPress(device: string | undefined, input: { elementId?: string; x?: number; y?: number; text?: string; durationMs?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const result = await driver.longPress(this.target(input), input.durationMs ?? 800);
        return this.afterAction(driver, `long-press at (${result.x}, ${result.y})`, result);
    }

    async swipe(device: string | undefined, input: { direction?: SwipeDirection; amount?: number; from?: { x: number; y: number }; to?: { x: number; y: number } }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const result = input.from && input.to
            ? await driver.swipe({ from: input.from, to: input.to, intent: 'drag' })
            : await driver.swipe({ direction: input.direction ?? 'up', ...(input.amount !== undefined ? { amount: input.amount } : {}), intent: 'flick' });
        return this.afterAction(driver, `swipe (${result.from.x},${result.from.y}) → (${result.to.x},${result.to.y}) in ${result.durationMs}ms`, result);
    }

    async flickFeed(device: string | undefined, direction: 'next' | 'previous' = 'next'): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.flickFeed(direction);
        return this.afterAction(driver, `flicked to the ${direction} item`);
    }

    async scroll(device: string | undefined, input: { direction: SwipeDirection; amount?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const result = await driver.scroll(input.direction, input.amount ?? 0.5);
        return this.afterAction(driver, `scroll ${input.direction}`, result);
    }

    /** Scroll until an element containing `text` is on screen (bounded). With no direction: down first, then back up past the start. */
    async scrollTo(device: string | undefined, input: { text: string; direction?: SwipeDirection; maxSwipes?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const maxSwipes = Math.min(20, input.maxSwipes ?? 8);
        const plan: Array<{ direction: SwipeDirection; swipes: number }> = input.direction
            ? [{ direction: input.direction, swipes: maxSwipes }]
            : [{ direction: 'down', swipes: maxSwipes }, { direction: 'up', swipes: maxSwipes * 2 }];
        let total = 0;
        const check = async () => {
            const snapshot = await driver.observe({ tree: true });
            return findElements(snapshot.elements, input.text);
        };
        let matches = await check();
        for (const leg of plan) {
            for (let swipe = 0; swipe < leg.swipes && !matches.length; swipe++) {
                // A deliberate drag, not a flick: inertia from a flick can skip whole
                // screens of a list, which is how a search can miss what it is looking for.
                await driver.scroll(leg.direction, 0.3, { intent: 'drag' });
                total += 1;
                matches = await check();
            }
            if (matches.length) break;
        }
        // Floating search pills / tab bars sit over the bottom, nav bars over the top: bring the
        // match into the middle band so a tap lands on it and not on whatever floats above it.
        if (matches.length) {
            const screen = await driver.screen();
            const centreY = matches[0]!.frame.y + matches[0]!.frame.height / 2;
            const nudge = centreY > screen.height * 0.82 ? 'down' as const : centreY < screen.height * 0.14 ? 'up' as const : undefined;
            if (nudge) {
                await driver.scroll(nudge, 0.2, { intent: 'drag' });
                total += 1;
                const again = await check();
                if (again.length) matches = again;
            }
        }
        await this.persistSnapshot(driver);
        if (matches.length) return { text: `Found after ${total} swipe${total === 1 ? '' : 's'}:\n${matches.map(renderElement).join('\n')}` };
        return { text: `"${input.text}" did not appear after ${total} swipes (${plan.map((leg) => `${leg.swipes} ${leg.direction}`).join(', then ')}). It may be on another screen.` };
    }

    async typeText(device: string | undefined, input: { text: string; submit?: boolean }): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.typeText(input.text, { submit: input.submit ?? false });
        // The text itself stays out of the session log: it may be a password or a code.
        return this.afterAction(driver, `typed ${input.text.length} character${input.text.length === 1 ? '' : 's'}${input.submit ? ' + return' : ''}`);
    }

    async pressButton(device: string | undefined, button: 'home' | 'volume_up' | 'volume_down' | 'lock'): Promise<ToolResult> {
        const driver = await this.driver(device);
        const name = button === 'volume_up' ? 'volumeUp' : button === 'volume_down' ? 'volumeDown' : button;
        await driver.pressButton(name);
        return this.afterAction(driver, `pressed ${button}`);
    }

    async unlock(device?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.unlock();
        return this.afterAction(driver, 'unlock');
    }

    /** Open by bundle id or by (installed / system) app name. */
    async openApp(device: string | undefined, input: { app: string; relaunch?: boolean; arguments?: string[]; environment?: Record<string, string> }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        await driver.openApp(bundleId, {
            relaunch: input.relaunch ?? false,
            ...(input.arguments ? { args: input.arguments } : {}),
            ...(input.environment ? { environment: input.environment } : {}),
        });
        const pack = packForApp(this.plugins, bundleId);
        const result = await this.afterAction(driver, `opened ${bundleId}`, { bundleId });
        if (pack) result.text += `\napp pack "${pluginShortId(pack)}" applies — read phoneos://guide/${pluginShortId(pack)} first`;
        return result;
    }

    async closeApp(device: string | undefined, app: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, app);
        const closed = await driver.closeApp(bundleId);
        return this.afterAction(driver, `${closed ? 'closed' : 'was not running:'} ${bundleId}`);
    }

    private async resolveBundleId(driver: DeviceDriver, app: string): Promise<string> {
        const query = app.trim();
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(query) && query.includes('.')) return query;
        const needle = query.toLowerCase();
        const system = SYSTEM_APPS.find((entry) => entry.name.toLowerCase() === needle);
        if (system) return system.bundleId;
        const apps = await this.installedApps(driver);
        const exact = apps.find((entry) => entry.name.toLowerCase() === needle);
        if (exact) return exact.bundleId;
        const partial = apps.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.bundleId.toLowerCase().includes(needle));
        if (partial.length === 1) return partial[0]!.bundleId;
        if (partial.length > 1) throw new Error(`"${app}" matches several apps: ${partial.map((entry) => `${entry.name} (${entry.bundleId})`).join(', ')}`);
        throw new Error(`No installed app called "${app}" — use list_apps or a bundle id`);
    }

    async openUrl(device: string | undefined, url: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.openUrl(url);
        return this.afterAction(driver, `opened url ${url}`, { url });
    }

    async wait(device: string | undefined, ms: number): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.wait(Math.min(60_000, Math.max(0, ms)));
        return this.afterAction(driver, `waited ${ms}ms`);
    }

    async alert(device: string | undefined, action: 'accept' | 'dismiss', button?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const pressed = action === 'accept' ? await driver.acceptAlert(button) : await driver.dismissAlert(button);
        return this.afterAction(driver, `alert ${action}${pressed ? ` (pressed "${pressed}")` : ''}`);
    }

    async dismissKeyboard(device?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.dismissKeyboard();
        return this.afterAction(driver, 'dismissed keyboard');
    }

    /**
     * Set Settings → Display & Brightness → Auto-Lock. "Never" is what an unattended phone
     * wants: iOS refuses to launch a test runner on a locked device
     * (`deviceprep -3 "Unlock iPhone to Continue"`), so a phone that locks itself
     * needs a human every time WebDriverAgent restarts.
     */
    async setAutoLock(device: string | undefined, choice = 'Never'): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.unlock();
        await driver.openApp('com.apple.Preferences', { relaunch: true });
        await driver.wait(1_500);
        await this.backToSettingsRoot(driver);
        const tapByText = async (text: string, what: string) => {
            const found = await this.scrollTo(device, { text });
            if (/did not appear/.test(found.text)) throw new Error(`Could not find "${text}" in Settings (${what})`);
            await driver.tap({ text });
            await driver.wait(1_200);
        };
        await tapByText('Display & Brightness', 'Settings root');
        await tapByText('Auto-Lock', 'Display & Brightness');
        await tapByText(choice, 'Auto-Lock options');
        const snapshot = await driver.observe({ tree: true });
        const row = findElements(snapshot.elements, choice)[0];
        const selected = row?.value === '1';
        await driver.home();
        await this.record({ device: driver.udid, action: 'set_auto_lock', choice });
        const note = /never/i.test(choice)
            ? 'The phone will not lock itself, so WebDriverAgent can always restart — at the cost of leaving the screen on.'
            : 'The screen will sleep as usual; WebDriverAgent keeps running across the lock and unlocks the phone when a task needs it.';
        return { text: `Auto-Lock set to "${choice}"${selected ? ' (confirmed selected)' : ''}. ${note}` };
    }

    /** Settings reopens wherever it was left, so walk its back buttons up to the root list. */
    private async backToSettingsRoot(driver: DeviceDriver): Promise<void> {
        const screen = await driver.screen();
        for (let step = 0; step < 8; step++) {
            const snapshot = await driver.observe({ tree: true });
            const back = snapshot.elements.find((element) => element.type === 'Button'
                && /NavigationBar/.test(element.path)
                && (element.identifier === 'BackButton' || element.frame.x < screen.width / 3));
            if (!back) return;
            await driver.tap({ elementId: back.id });
            await driver.wait(700);
        }
    }

    // ---- files ------------------------------------------------------------------

    /** Metadata-only local video copy; deliberately does not resolve a phone. */
    async addVideoMetadata(input: AddVideoMetadataInput): Promise<ToolResult> {
        // An output path that is named must be inside the folder; left out, the copy goes next to the input.
        if (input.output_path) this.outputPath(input.output_path);
        const result = await addVideoMetadata(input);
        await this.record({ action: 'add_video_metadata', input: result.input_path, output: result.output_path, fields: Object.keys(result.written_tags) });
        return { text: JSON.stringify(result, null, 2) };
    }

    /** Local re-wrap for upload compatibility; deliberately does not resolve a phone. */
    async normalizeVideo(input: NormalizeVideoInput): Promise<ToolResult> {
        if (input.output_path) this.outputPath(input.output_path);
        const result = await normalizeVideo(input);
        await this.record({ action: 'normalize_video', input: result.input_path, output: result.output_path, changed: result.changed });
        return { text: JSON.stringify(result, null, 2) };
    }

    /** Images / videos from paths on this Mac into the phone's Photos library. */
    async addToPhotos(device: string | undefined, files: string[]): Promise<ToolResult> {
        const driver = await this.driver(device);
        const added = await driver.addToPhotos(files);
        await this.record({ device: driver.udid, action: 'add_to_photos', files: added.map((entry) => entry.name) });
        return { text: `Added to Photos: ${added.map((entry) => `${entry.name} (${entry.mimeType}, ${(entry.bytes / 1024).toFixed(0)} KB)`).join(', ')}. They are the newest items in Photos → Recents.` };
    }

    /** A file from this Mac into an app's Documents folder. */
    async addFile(device: string | undefined, input: { app: string; path: string; name?: string; subdirectory?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        const result = await driver.addDocument(bundleId, input.path, { ...(input.name ? { name: input.name } : {}), ...(input.subdirectory ? { subdirectory: input.subdirectory } : {}) });
        await this.record({ device: driver.udid, action: 'add_file', bundleId, destination: result.destination });
        return { text: `Copied ${path.basename(input.path)} (${(result.bytes / 1024).toFixed(0)} KB) to ${bundleId} → ${result.destination}. Open it from Files → On My iPhone → ${input.app}, or inside the app.` };
    }

    async listFiles(device: string | undefined, input: { app: string; subdirectory?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        const entries = await driver.listDocuments(bundleId, input.subdirectory ?? '');
        return { text: entries.length ? `${bundleId} Documents/${input.subdirectory ?? ''}:\n${entries.join('\n')}` : `${bundleId} Documents/${input.subdirectory ?? ''} is empty` };
    }

    async getPhotos(device: string | undefined, input: { count?: number; outDirectory?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const outDirectory = this.outputPath(input.outDirectory ?? path.join(this.stateRoot, 'pulled', driver.udid.slice(0, 8)));
        const pulled = await driver.getPhotos({ count: Math.min(100, Math.max(1, input.count ?? 10)), outDirectory });
        await this.record({ device: driver.udid, action: 'get_photos', count: pulled.length, outDirectory });
        if (!pulled.length) return { text: 'The camera roll is empty.' };
        return { text: `Pulled ${pulled.length} file${pulled.length === 1 ? '' : 's'} (newest first) into ${outDirectory}:\n${pulled.map((entry) => `${entry.path} (${(entry.bytes / 1024).toFixed(0)} KB${entry.modifiedAt ? `, ${entry.modifiedAt}` : ''})`).join('\n')}` };
    }

    async getFile(device: string | undefined, input: { app: string; path: string; outPath?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        const outPath = this.outputPath(input.outPath ?? freePath(path.join(this.stateRoot, 'pulled', driver.udid.slice(0, 8), path.basename(input.path))));
        const pulled = await driver.getDocument(bundleId, input.path, outPath);
        await this.record({ device: driver.udid, action: 'get_file', bundleId, remote: input.path, outPath });
        return { text: `Pulled ${bundleId}/Documents/${input.path.replace(/^\/+/, '')} → ${pulled.path} (${(pulled.bytes / 1024).toFixed(0)} KB)` };
    }

    // ---- location, push, permissions, status bar -------------------------------------

    /** The GPS position apps see (iOS 16.4+), or `clear` to give them the real one back. With neither, what is set now. */
    async setLocation(device: string | undefined, input: { latitude?: number; longitude?: number; clear?: boolean }): Promise<ToolResult> {
        const driver = await this.driver(device);
        if (input.clear) {
            await driver.client.clearSimulatedLocation();
            await this.record({ device: driver.udid, action: 'set_location', clear: true });
            return { text: 'The simulated location is cleared: apps see the real location again.' };
        }
        if (input.latitude === undefined && input.longitude === undefined) {
            const current = await driver.client.simulatedLocation();
            return { text: current ? `Apps see the simulated location ${current.latitude}, ${current.longitude}.` : 'No location is simulated: apps see the real one.' };
        }
        const { latitude, longitude } = input;
        if (latitude === undefined || longitude === undefined) throw new Error('Give both latitude and longitude, or clear=true');
        if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('latitude must be within ±90 and longitude within ±180');
        await driver.client.setSimulatedLocation(latitude, longitude);
        await this.record({ device: driver.udid, action: 'set_location' });
        return { text: `Apps now see ${latitude}, ${longitude}. It stays until set_location clear=true, or until the agent on the phone stops.` };
    }

    async sendPush(device: string | undefined, input: { app: string; title?: string; body?: string; payload?: Record<string, unknown> }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        await sendPush({ udid: driver.udid, kind: driver.identity.kind }, bundleId, pushPayload(input));
        await this.record({ device: driver.udid, action: 'send_push', bundleId });
        return { text: `Push sent to ${bundleId}. Observe to see the banner (or the app's reaction, when it is in front).` };
    }

    async setPermission(device: string | undefined, input: { app: string; service: PrivacyService; action: 'grant' | 'revoke' | 'reset' }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        await setPermission({ udid: driver.udid, kind: driver.identity.kind }, bundleId, input.service, input.action);
        await this.record({ device: driver.udid, action: 'set_permission', bundleId, service: input.service, change: input.action });
        const done = input.action === 'grant' ? 'granted' : input.action === 'revoke' ? 'revoked' : 'reset (the app will ask again)';
        return { text: `${input.service} ${done} for ${bundleId}. Some apps only notice after a relaunch.` };
    }

    async statusBar(device: string | undefined, clean: boolean): Promise<ToolResult> {
        const driver = await this.driver(device);
        await setCleanStatusBar({ udid: driver.udid, kind: driver.identity.kind }, clean);
        return { text: clean ? 'The status bar shows 9:41, full signal and a full battery.' : 'The status bar is back to normal.' };
    }

    // ---- logs and crashes ----------------------------------------------------------

    /**
     * Recent log lines of an app's process. A simulator's log is read back; a phone's is
     * captured from the first call on (it keeps none to read back), for as long as this
     * process runs, so on a phone the first call mostly starts the capture.
     */
    async appLogs(device: string | undefined, input: { app: string; sinceSeconds?: number; filter?: string; errorsOnly?: boolean; maxLines?: number; listenMs?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        const target = { udid: driver.udid, kind: driver.identity.kind };
        const processName = await executableName(target, bundleId);
        const sinceSeconds = Math.min(3_600, Math.max(1, input.sinceSeconds ?? 120));
        const maxLines = Math.min(1_000, Math.max(1, input.maxLines ?? 150));
        let lines: string[];
        let note = '';
        if (target.kind === 'simulator') {
            lines = await simulatorLog(target.udid, processName, sinceSeconds, { errorsOnly: Boolean(input.errorsOnly) });
        } else {
            const { since, startedNow } = await captureDeviceLog(target.udid);
            if (startedNow) await new Promise((resolve) => setTimeout(resolve, Math.min(120_000, input.listenMs ?? 3_000)));
            lines = linesOfProcess(capturedDeviceLog(target.udid, Math.max(since, Date.now() - sinceSeconds * 1_000)), processName);
            if (input.errorsOnly) lines = errorLines(lines);
            if (startedNow && input.listenMs === undefined) note = '\nA phone keeps no log to read back, so the capture started with this call and runs from now on. Do what shows the problem, then call app_logs again.';
        }
        if (input.filter) {
            const needle = input.filter.toLowerCase();
            lines = lines.filter((line) => line.toLowerCase().includes(needle));
        }
        const shown = lines.slice(-maxLines).map((line) => (line.length > 400 ? `${line.slice(0, 399)}…` : line));
        await this.record({ device: driver.udid, action: 'app_logs', bundleId, lines: lines.length });
        const head = `${lines.length} log line${lines.length === 1 ? '' : 's'} from ${processName} (${bundleId}) in the last ${sinceSeconds} s${input.errorsOnly ? ', errors and faults only' : ''}${input.filter ? ` containing "${input.filter}"` : ''}${shown.length < lines.length ? `; the last ${shown.length}` : ''}${shown.length ? ':' : '.'}`;
        return { text: `${head}${shown.length ? `\n${shown.join('\n')}` : ''}${note}` };
    }

    /** The newest crash reports of an app, each summarised (exception, termination, crashed thread). */
    async crashReports(device: string | undefined, input: { app: string; count?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        const target = { udid: driver.udid, kind: driver.identity.kind };
        const processName = await executableName(target, bundleId);
        const outDirectory = this.outputPath(path.join(this.stateRoot, 'crashes', driver.udid.slice(0, 8)));
        const { reports, total } = await crashReports(target, processName, { count: Math.min(20, Math.max(1, input.count ?? 3)), outDirectory });
        await this.record({ device: driver.udid, action: 'crash_reports', bundleId, total });
        if (!total) return { text: `No crash reports for ${processName} (${bundleId}) on this device.` };
        return { text: `${total} crash report${total === 1 ? '' : 's'} for ${processName}; the newest ${reports.length === 1 ? 'one' : reports.length}:\n\n${reports.map((report) => `${report.name} (${report.path})\n${report.summary}`).join('\n\n')}` };
    }

    // ---- waiting ---------------------------------------------------------------

    /** Poll observe until text appears (or disappears with `gone`). Returns matches or a plain "still not there" — never throws for a timeout. */
    async waitFor(device: string | undefined, input: { text: string; gone?: boolean; timeoutMs?: number; intervalMs?: number }): Promise<ToolResult> {
        return (await this.pollFor(device, input)).result;
    }

    /** `waitFor`, saying whether what it waited for happened (`run_steps` stops when it did not). */
    async pollFor(device: string | undefined, input: { text: string; gone?: boolean; timeoutMs?: number; intervalMs?: number }): Promise<{ met: boolean; result: ToolResult }> {
        const driver = await this.driver(device);
        const timeoutMs = Math.min(120_000, Math.max(500, input.timeoutMs ?? 20_000));
        const intervalMs = Math.min(10_000, Math.max(250, input.intervalMs ?? 1_000));
        const started = Date.now();
        let polls = 0;
        let matches: ReturnType<typeof findElements> = [];
        while (Date.now() - started <= timeoutMs) {
            const snapshot = await driver.observe({ tree: true });
            polls += 1;
            matches = findElements(snapshot.elements, input.text);
            const satisfied = input.gone ? matches.length === 0 : matches.length > 0;
            if (satisfied) {
                await this.persistSnapshot(driver);
                await this.record({ device: driver.udid, action: 'wait_for', text: input.text, gone: Boolean(input.gone), waitedMs: Date.now() - started });
                const waited = ((Date.now() - started) / 1000).toFixed(1);
                return { met: true, result: { text: input.gone
                    ? `"${input.text}" is gone (after ${waited}s, ${polls} check${polls === 1 ? '' : 's'}).\n${renderState(snapshot.state)}`
                    : `"${input.text}" appeared after ${waited}s:\n${matches.map(renderElement).join('\n')}\n${renderState(snapshot.state)}` } };
            }
            await driver.wait(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))));
        }
        await this.persistSnapshot(driver);
        return { met: false, result: { text: input.gone
            ? `"${input.text}" is still on screen after ${(timeoutMs / 1000).toFixed(0)}s:\n${matches.map(renderElement).join('\n')}`
            : `"${input.text}" did not appear within ${(timeoutMs / 1000).toFixed(0)}s (${polls} checks). Observe to see what is there instead.` } };
    }

    // ---- recording, clipboard, appearance, apps ------------------------------------

    async startRecording(device: string | undefined, input: { fps?: number } = {}): Promise<ToolResult> {
        const driver = await this.driver(device);
        // iOS cannot finish a recording of a locked screen, and the failure only shows at the stop.
        await driver.unlock();
        const existing = await driver.activeRecording();
        if (existing) return { text: `A recording is already running (started ${new Date(existing.startedAt * 1000).toISOString()}). Call stop_recording first.` };
        const info = await driver.startRecording({ ...(input.fps ? { fps: input.fps } : {}) });
        await this.record({ device: driver.udid, action: 'start_recording', uuid: info.uuid });
        return { text: `Recording started (${info.fps} fps, id ${info.uuid}). Call stop_recording to save the .mov.` };
    }

    async stopRecording(device: string | undefined, input: { outPath?: string } = {}): Promise<ToolResult> {
        const driver = await this.driver(device);
        const outPath = this.outputPath(input.outPath ?? path.join(this.stateRoot, 'recordings', `${driver.udid.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.mov`));
        const result = await driver.stopRecording(outPath);
        await this.record({ device: driver.udid, action: 'stop_recording', path: result.path, bytes: result.bytes });
        return { text: `Recording saved: ${result.path} (${(result.bytes / 1024).toFixed(0)} KB)` };
    }

    async setClipboard(device: string | undefined, input: { text?: string; url?: string; imagePath?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const value = input.text !== undefined ? { text: input.text } : input.url ? { url: input.url } : input.imagePath ? { imagePath: input.imagePath } : undefined;
        if (!value) throw new Error('Give text, a url, or an image path');
        const what = await driver.setClipboard(value);
        await this.record({ device: driver.udid, action: 'set_clipboard', what });
        return { text: `Clipboard now holds ${what}. Long-press a field and choose Paste to use it.` };
    }

    async getClipboard(device?: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const value = await driver.getClipboard();
        const parts = [];
        if (value.text !== undefined) parts.push(`text: ${JSON.stringify(value.text)}`);
        if (value.url) parts.push(`url: ${value.url}`);
        if (value.hasImage) parts.push('an image');
        return { text: parts.length ? `Clipboard: ${parts.join(' · ')}` : 'Clipboard is empty.' };
    }

    async setAppearance(device: string | undefined, name: 'light' | 'dark'): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.setAppearance(name);
        return this.afterAction(driver, `appearance set to ${name}`);
    }

    async rotate(device: string | undefined, orientation: 'portrait' | 'landscape'): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.rotate(orientation);
        return this.afterAction(driver, `rotated to ${orientation}`);
    }

    async pinch(device: string | undefined, input: { scale: number; velocity?: number }): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.pinch(input.scale, input.velocity);
        return this.afterAction(driver, `pinch scale ${input.scale}`);
    }

    async installApp(device: string | undefined, appPath: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        await driver.installApp(appPath);
        this.appsCache.delete(driver.udid);
        await this.record({ device: driver.udid, action: 'install_app', appPath });
        return { text: `Installed ${path.basename(appPath)}. list_apps shows its bundle id.` };
    }

    /** Back to a fresh install: no data, no granted permissions. A phone needs the .ipa/.app to reinstall. */
    async resetApp(device: string | undefined, input: { app: string; path?: string }): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, input.app);
        await driver.resetApp(bundleId, input.path);
        this.appsCache.delete(driver.udid);
        await this.record({ device: driver.udid, action: 'reset_app', bundleId });
        return { text: `${bundleId} is reinstalled, with no data and no permissions granted. open_app starts it as on first launch.` };
    }

    async uninstallApp(device: string | undefined, app: string): Promise<ToolResult> {
        const driver = await this.driver(device);
        const bundleId = await this.resolveBundleId(driver, app);
        await driver.uninstallApp(bundleId);
        this.appsCache.delete(driver.udid);
        await this.record({ device: driver.udid, action: 'uninstall_app', bundleId });
        return { text: `Uninstalled ${bundleId}.` };
    }

    // ---- packs -------------------------------------------------------------------

    async runMacro(plugin: PhoneosPlugin, macroName: string, device: string | undefined, input: unknown): Promise<ToolResult> {
        const macro = (plugin.macros ?? []).find((entry) => entry.name === macroName);
        if (!macro) throw new Error(`Unknown macro ${macroName} for ${plugin.id}`);
        const parsed = macro.input.parse(input ?? {});
        const registered = await this.fleet.resolve(device ?? '');
        const driver = await this.fleet.driver(registered.udid);
        const lines: string[] = [];
        const context: MacroContext = {
            driver, device: registered, pluginData: (registered.pluginData[plugin.id] ?? {}) as JsonObject,
            log: (line) => { lines.push(line); this.log(line); },
            outputPath: (requested) => this.outputPath(requested),
            point: async (name) => resolvePoint(plugin, name, await driver.screen(), registered.coordinates),
        };
        // A pack's own profile drives its macros, unless the session forces one on every device.
        const output = await driver.withHumanProfile(this.fleet.profileOverride ? undefined : plugin.humanProfile, () => macro.run(context, parsed as never));
        await this.record({ device: driver.udid, action: `macro:${macroToolName(plugin, macro)}`, input: parsed });
        const result = await this.afterAction(driver, `${macroToolName(plugin, macro)} finished`);
        const detail = output === undefined ? '' : typeof output === 'string' ? output : JSON.stringify(output);
        return { text: `${detail ? `${detail}\n` : ''}${lines.length ? `${lines.join('\n')}\n` : ''}${result.text}` };
    }

    guides(): Array<{ shortId: string; plugin: PhoneosPlugin }> {
        return this.plugins.filter((plugin) => plugin.guidePath).map((plugin) => ({ shortId: pluginShortId(plugin), plugin }));
    }
}
