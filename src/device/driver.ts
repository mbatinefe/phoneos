import { Humanizer, type HumanProfile, type Point, type SwipeIntent } from '../humanize/humanizer.js';
import { stabilizeIds } from '../observe/diff.js';
import { scaleToPoints, type ScaledScreenshot } from '../observe/screenshot.js';
import { centerOf, exposedFrame, findElements, flattenTree } from '../observe/tree.js';
import type { DeviceState, ScreenGeometry, Snapshot, SnapshotElement, TreeStatus } from '../observe/types.js';
import { installApp, listInstalledApps, resetApp, uninstallApp, type InstalledApp } from './apps.js';
import { addDocument, addToPhotos, getDocument, getPhotos, listDocuments, mediaMimeType, type AddedMedia, type PulledFile } from './media.js';
import { activeRecording, startRecording, stopRecording, type RecordingInfo } from './recording.js';
import { longPressActions, swipeActions, tapActions } from './gestures.js';
import type { DeviceIdentity } from './identity.js';
import { keyPoints } from './keyboard.js';
import { lockScreenInTree, unlockDevice } from './unlock.js';
import { WdaClient, WdaError } from './wda-client.js';

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

/** What to tap: an element from the last observation, a point, or text to look up. */
export type TapTarget = { elementId: string } | { x: number; y: number; spread?: number } | { text: string };

export interface ObserveOptions {
    tree?: boolean;
    screenshot?: boolean;
    maxElements?: number;
    /** Per-call cap for the tree walk; busy apps may need less to answer at all. */
    treeTimeoutMs?: number;
}

export interface DeviceDriverOptions {
    identity: DeviceIdentity;
    wdaUrl: string;
    mjpegUrl?: string;
    passcode?: string;
    humanizer?: Humanizer;
    humanProfile?: HumanProfile;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
}

export class DeviceDriverError extends Error {}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SPRINGBOARD = 'com.apple.springboard';

/**
 * Apps whose accessibility tree is never asked for, neither directly nor through a call
 * that resolves the app: the front-app info, the orientation, the alert probe, `source`.
 * XCTest's snapshot of TikTok does not come back and takes the agent down with it.
 * `/wda/activeAppInfo` alone does it, because the agent reads the app's identifier for it.
 * With TikTok in front `/wda/apps/state`, `/wda/screen`, `/screenshot`, the battery and the
 * lock state all answer within half a second and leave the agent alone.
 */
const NO_TREE_APPS: Readonly<Record<string, string>> = { 'com.zhiliaoapp.musically': 'TikTok' };
const FOREGROUND = 4; // XCUIApplicationStateRunningForeground

const DISMISS_LABELS = /^(cancel|not now|don[’']?t allow|deny|close|later|maybe later|no|no thanks|dismiss|skip|ask app not to track|keep current)$/i;
const ACCEPT_LABELS = /^(allow|allow while using app|allow once|ok|okay|continue|yes|accept|open)$/i;

/**
 * The first whole JPEG in the bytes of a multipart MJPEG stream, if one has arrived: a part's
 * `Content-Length` when it has one, else from the JPEG's start marker to its end marker.
 */
export function firstMjpegFrame(buffered: Buffer): Buffer | undefined {
    const headerEnd = buffered.indexOf('\r\n\r\n');
    const length = headerEnd >= 0 ? /content-length:\s*(\d+)/i.exec(buffered.subarray(0, headerEnd).toString('latin1'))?.[1] : undefined;
    if (length !== undefined) {
        const start = headerEnd + 4;
        return buffered.length >= start + Number(length) ? buffered.subarray(start, start + Number(length)) : undefined;
    }
    const start = buffered.indexOf(Buffer.from([0xff, 0xd8]));
    const end = start >= 0 ? buffered.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1;
    return end >= 0 ? buffered.subarray(start, end + 2) : undefined;
}

/** The alert button whose label reads like the answer wanted, if one does. */
export function pickAlertButton(buttons: readonly string[], wanted: RegExp): string | undefined {
    return buttons.find((label) => wanted.test(label.trim()));
}

/**
 * Everything phoneos does to one phone goes through here: state, observation,
 * and every gesture (each routed through the humanizer). Model-agnostic — the
 * phone reports its own geometry and element positions.
 */
export class DeviceDriver {
    readonly identity: DeviceIdentity;
    readonly client: WdaClient;
    private currentHumanizer: Humanizer;
    readonly mjpegUrl: string;
    private readonly passcode: string | undefined;
    private readonly log: (line: string) => void;
    private screenCache: { value: ScreenGeometry; at: number } | undefined;
    private lastSnapshot: Snapshot | undefined;
    private lastTruncated = 0;

    constructor(options: DeviceDriverOptions) {
        this.identity = options.identity;
        this.client = new WdaClient({ baseUrl: options.wdaUrl, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        this.mjpegUrl = options.mjpegUrl ?? options.wdaUrl.replace(/:(\d+)$/, (_match, port: string) => `:${Number(port) + 1000}`);
        this.currentHumanizer = options.humanizer ?? new Humanizer({ profile: options.humanProfile ?? 'natural', seed: `${options.identity.udid}:${Date.now()}` });
        this.passcode = options.passcode;
        this.log = options.log ?? (() => {});
    }

    get udid(): string {
        return this.identity.udid;
    }

    /** Every gesture's plan comes from here: the device's profile, or a pack's while its own macros run. */
    get humanizer(): Humanizer {
        return this.currentHumanizer;
    }

    /** Run `work` with gestures humanised under `profile` (an app pack's own), then return to the device's. */
    async withHumanProfile<T>(profile: HumanProfile | undefined, work: () => Promise<T>): Promise<T> {
        if (!profile || profile === this.currentHumanizer.profile) return work();
        const own = this.currentHumanizer;
        this.currentHumanizer = own.withProfile(profile);
        try {
            return await work();
        } finally {
            this.currentHumanizer = own;
        }
    }

    /** The most recent observation, for resolving element ids. */
    get snapshot(): Snapshot | undefined {
        return this.lastSnapshot;
    }

    get truncatedElements(): number {
        return this.lastTruncated;
    }

    /** Adopt an observation taken earlier (e.g. by a previous CLI process) so its element ids resolve. */
    restoreSnapshot(snapshot: Snapshot): void {
        if (!this.lastSnapshot || Date.parse(snapshot.state.takenAt) > Date.parse(this.lastSnapshot.state.takenAt)) this.lastSnapshot = snapshot;
    }

    // ---- state -------------------------------------------------------------

    /**
     * The no-tree app that is in front, if one is. Asked through the app's process state,
     * which does not touch its tree.
     */
    private async noTreeAppInFront(): Promise<{ bundleId: string; name: string } | undefined> {
        for (const [bundleId, name] of Object.entries(NO_TREE_APPS)) {
            if ((await this.client.appState(bundleId).catch(() => 0)) >= FOREGROUND) return { bundleId, name };
        }
        return undefined;
    }

    async screen(force = false, noTree?: { bundleId: string } | null): Promise<ScreenGeometry> {
        if (!force && this.screenCache && Date.now() - this.screenCache.at < 30_000) return this.screenCache.value;
        // The orientation is read from the front app, so it is not asked while a no-tree app is in front.
        const skipOrientation = noTree === undefined ? Boolean(await this.noTreeAppInFront()) : Boolean(noTree);
        const [screen, orientation] = await Promise.all([
            this.client.screen(),
            skipOrientation ? Promise.resolve('PORTRAIT') : this.client.orientation().catch(() => 'PORTRAIT'),
        ]);
        const value: ScreenGeometry = {
            width: Math.round(screen.screenSize.width),
            height: Math.round(screen.screenSize.height),
            scale: screen.scale,
            orientation: /LANDSCAPE/i.test(String(orientation)) ? 'landscape' : 'portrait',
        };
        this.screenCache = { value, at: Date.now() };
        return value;
    }

    isReady(): Promise<boolean> {
        return this.client.isReady();
    }

    /**
     * Cheap state: lock, frontmost app, geometry, alert, battery. Keyboard
     * visibility needs the tree, so it is carried over from the last
     * observation when that is recent, else reported false.
     */
    async state(): Promise<DeviceState> {
        // WDA serves requests one at a time; keep this to the cheap calls and make every optional probe non-fatal.
        const noTree = (await this.noTreeAppInFront()) ?? null;
        const [locked, screen, app] = await Promise.all([
            this.client.locked(),
            this.screen(false, noTree).catch((error: unknown) => {
                if (this.screenCache) return this.screenCache.value;
                throw error;
            }),
            noTree ? Promise.resolve({ bundleId: noTree.bundleId, name: noTree.name, pid: 0 }) : this.client.activeAppInfo().catch(() => undefined),
        ]);
        const [alertText, battery] = await Promise.all([
            // Not probed over a no-tree app: `alert` then says nothing either way, and the screenshot is the judge.
            noTree ? Promise.resolve(null) : this.client.alertText(3_000),
            this.identity.kind === 'device' ? this.client.battery().catch(() => undefined) : Promise.resolve(undefined),
        ]);
        const recent = this.lastSnapshot && Date.now() - Date.parse(this.lastSnapshot.state.takenAt) < 4_000 ? this.lastSnapshot : undefined;
        const state: DeviceState = {
            locked,
            activeApp: app && app.bundleId && app.bundleId !== SPRINGBOARD
                ? { bundleId: app.bundleId, name: app.name || (app.bundleId.split('.').pop() ?? app.bundleId), pid: app.pid }
                : null,
            screen,
            keyboardVisible: recent?.state.keyboardVisible ?? false,
            // Without a fresh tree (the home screen is never read on a phone), ask the alert for its buttons.
            alert: recent?.state.alert ?? (alertText ? { text: alertText, buttons: await this.client.alertButtons() } : null),
            takenAt: new Date().toISOString(),
        };
        if (battery && battery.level >= 0) {
            state.battery = {
                level: battery.level,
                state: (['unknown', 'unplugged', 'charging', 'full'] as const)[battery.state] ?? 'unknown',
            };
        }
        return state;
    }

    // ---- observe -----------------------------------------------------------

    async observe({ tree = true, screenshot = false, maxElements = 120, treeTimeoutMs }: ObserveOptions = {}): Promise<Snapshot> {
        const previous = this.lastSnapshot;
        const state = await this.state();
        let elements: SnapshotElement[] = [];
        let treeStatus: TreeStatus = 'skipped';
        // SpringBoard's tree (every icon and label) takes ~20 s on a real phone; inside apps it is 1–3 s.
        // The agent goes on building it after we stop waiting, and every action queues behind it, so
        // on a phone's home screen it is not asked for at all unless the caller gives it a budget:
        // the agent gets the screenshot instead.
        const budget = treeTimeoutMs ?? 8_000;
        const springboard = state.activeApp === null && !state.locked && this.identity.kind === 'device' && treeTimeoutMs === undefined;
        const noTree = state.activeApp ? NO_TREE_APPS[state.activeApp.bundleId] : undefined;
        if (tree && springboard) {
            this.log('observe: the home screen\'s tree is not read on a phone (it takes ~20 s); screenshot only');
        } else if (tree && noTree) {
            treeStatus = 'unavailable';
            this.log(`observe: ${noTree}'s elements are never read (asking stalls the phone's agent); screenshot only`);
        } else if (tree) {
            try {
                // Session settings (snapshot depth / timeout caps) only apply once a session exists.
                await this.client.session().catch(() => undefined);
                const root = await this.client.source(budget);
                const flat = flattenTree(root, { screen: state.screen, maxElements });
                elements = flat.elements;
                state.keyboardVisible = flat.keyboardVisible;
                if (flat.alert) state.alert = flat.alert;
                this.lastTruncated = flat.truncated;
                treeStatus = 'ok';
            } catch (error) {
                const timedOut = error instanceof WdaError && (error.status === 0 || /timeout|timed out/i.test(error.message));
                treeStatus = timedOut ? 'timeout' : 'unavailable';
                this.log(`observe: tree ${treeStatus} after ${budget}ms — ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const snapshot: Snapshot = { state, elements, treeStatus };
        // With no elements to go on, the agent reads the screenshot itself.
        const blind = tree && (treeStatus !== 'ok' || !elements.length);
        if (screenshot || blind) {
            try {
                // After a timeout the agent is still walking the tree and a screenshot would wait
                // behind it (up to a minute on some apps), so the frame comes from the video
                // stream. Its frames are not turned for landscape, so in landscape it still waits.
                const stream = treeStatus === 'timeout' && state.screen.orientation === 'portrait';
                const image = stream
                    ? await this.mjpegFrame().catch(() => this.client.screenshot(45_000))
                    : await this.client.screenshot(treeStatus === 'timeout' ? 45_000 : undefined);
                snapshot.screenshot = await scaleToPoints(image, state.screen);
            } catch (error) {
                this.log(`observe: screenshot failed — ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // Elements still there keep the ids they had, so an id stays good across an observe that did not touch it.
        if (previous && previous.state.activeApp?.bundleId === state.activeApp?.bundleId) {
            snapshot.elements = stabilizeIds(snapshot.elements, previous.elements);
        }
        this.lastSnapshot = snapshot;
        return snapshot;
    }

    /** Screenshot scaled to points so its coordinates are tap coordinates. */
    async screenshot(format: 'jpeg' | 'png' = 'jpeg'): Promise<ScaledScreenshot> {
        // Within a minute of a tree timeout the agent may still be walking that tree, and a
        // screenshot would wait behind it; the video stream does not.
        const last = this.lastSnapshot;
        if (last?.treeStatus === 'timeout' && Date.now() - Date.parse(last.state.takenAt) < 60_000 && last.state.screen.orientation === 'portrait') {
            const frame = await this.mjpegFrame().catch(() => undefined);
            if (frame) return scaleToPoints(frame, last.state.screen, { format });
        }
        const [png, screen] = await Promise.all([this.client.screenshot(), this.screen()]);
        return scaleToPoints(png, screen, { format });
    }

    /** Full-resolution PNG (device pixels) — for recordings and pixel work. */
    rawScreenshot(): Promise<Buffer> {
        return this.client.screenshot();
    }

    mjpegStream(signal?: AbortSignal): Promise<Response> {
        return this.client.mjpeg(this.mjpegUrl, signal);
    }

    /**
     * One frame of the agent's video stream (device pixels, JPEG). The stream is served apart
     * from the agent's request queue, so a frame comes at once while a tree walk holds the queue.
     */
    async mjpegFrame(timeoutMs = 3_000): Promise<Buffer> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const reader = (await this.mjpegStream(controller.signal)).body!.getReader();
            let buffered = Buffer.alloc(0);
            for (;;) {
                const { value, done } = await reader.read();
                if (done) throw new WdaError('The video stream ended before a whole frame came', 0);
                buffered = Buffer.concat([buffered, value]);
                const frame = firstMjpegFrame(buffered);
                if (frame) return frame;
            }
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    }

    // ---- element resolution ---------------------------------------------

    /** The frame to land in for an element: its exposed part when a floating bar or sheet overlaps it. */
    private landingFrame(element: SnapshotElement): SnapshotElement['frame'] {
        const { frame, occludedBy } = exposedFrame(element, this.lastSnapshot?.elements ?? []);
        if (occludedBy) this.log(`tap: ${element.id} is partly covered by ${occludedBy.id} ${occludedBy.type} "${occludedBy.label ?? occludedBy.name ?? occludedBy.identifier ?? ''}" — landing in the exposed ${frame.width}×${frame.height} strip`);
        return frame;
    }

    /** Resolve a tap target to a frame (element) or a bare point. */
    async resolveTarget(target: TapTarget): Promise<{ element?: SnapshotElement; point: Point }> {
        if ('elementId' in target) {
            const element = this.lastSnapshot?.elements.find((entry) => entry.id === target.elementId);
            if (!element) {
                throw new DeviceDriverError(this.lastSnapshot
                    ? `Element ${target.elementId} is not in the last observation (${this.lastSnapshot.elements.length} elements, taken ${this.lastSnapshot.state.takenAt}). Observe again and use a fresh id.`
                    : 'No observation yet — call observe first, then tap by element id.');
            }
            return { element, point: centerOf(element.frame) };
        }
        if ('text' in target) {
            let matches = this.lastSnapshot ? findElements(this.lastSnapshot.elements, target.text) : [];
            if (!matches.length) {
                await this.observe({ tree: true });
                matches = this.lastSnapshot ? findElements(this.lastSnapshot.elements, target.text) : [];
            }
            const preferred = matches.find((entry) => entry.interactive) ?? matches[0];
            const last = this.lastSnapshot;
            const unreadable = last?.state.activeApp ? NO_TREE_APPS[last.state.activeApp.bundleId] : undefined;
            if (!preferred && unreadable) throw new DeviceDriverError(`${unreadable}'s elements cannot be read. Take a screenshot and tap the coordinates you read from it.`);
            if (!preferred && last?.treeStatus === 'skipped' && last.state.activeApp === null) {
                throw new DeviceDriverError(`The home screen's elements are not read on a phone, so "${target.text}" cannot be found by text. Use open_app, or tap the coordinates you read from the screenshot.`);
            }
            if (!preferred) throw new DeviceDriverError(`Nothing on screen matches "${target.text}". Observe and pick an element id.`);
            return { element: preferred, point: centerOf(preferred.frame) };
        }
        const screen = await this.screen();
        if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || target.x < 0 || target.y < 0 || target.x > screen.width || target.y > screen.height) {
            throw new DeviceDriverError(`Point (${target.x}, ${target.y}) is outside the ${screen.width}×${screen.height} point screen`);
        }
        return { point: { x: target.x, y: target.y } };
    }

    private async settle(): Promise<void> {
        const ms = this.humanizer.pause('afterAction');
        if (ms) await delay(ms);
    }

    /**
     * After a flick the content keeps decelerating; a tap on a moving list only
     * stops the scroll. Wait until two consecutive screenshots match (or 2.5 s).
     */
    private async settleScroll(): Promise<void> {
        const deadline = Date.now() + 2_500;
        let previous: Buffer | undefined;
        while (Date.now() < deadline) {
            const current = await this.client.screenshot().catch(() => undefined);
            if (!current) return;
            if (previous && previous.equals(current)) return;
            previous = current;
            await delay(150);
        }
    }

    // ---- actions -------------------------------------------------------------

    async tap(target: TapTarget): Promise<{ x: number; y: number; element?: SnapshotElement }> {
        const { element, point } = await this.resolveTarget(target);
        const spread = 'x' in target ? target.spread : undefined;
        const plan = element ? this.humanizer.tapInFrame(this.landingFrame(element)) : this.humanizer.tapAt(point, await this.screen(), spread);
        await this.client.absoluteActions(tapActions(plan));
        this.log(`tap ${element ? `${element.id} ${element.type} "${element.label ?? element.name ?? ''}"` : ''} at (${plan.x}, ${plan.y}) hold ${plan.holdMs}ms`);
        await this.settle();
        return { x: plan.x, y: plan.y, ...(element ? { element } : {}) };
    }

    /**
     * Write text by tapping the on-screen keyboard's keys one at a time, the way a thumb
     * does. `typeText` sends keys like a plugged-in keyboard: the on-screen one hides, and
     * a text tool that closes with it (some photo editors' text tools) loses what was typed.
     */
    async tapKeys(text: string): Promise<number> {
        const screen = await this.screen();
        const points = keyPoints(text, screen);
        for (const point of points) {
            await this.client.absoluteActions(tapActions(this.humanizer.tapAt(point, screen, 5)));
            await delay(90 + Math.round(this.humanizer.next() * 220));
        }
        // How much, never what: the text may be a password or a code.
        this.log(`tap-keys (${points.length} keys)`);
        await this.settle();
        return points.length;
    }

    async doubleTap(target: TapTarget): Promise<{ x: number; y: number }> {
        const { element, point } = await this.resolveTarget(target);
        const first = element ? this.humanizer.tapInFrame(this.landingFrame(element)) : this.humanizer.tapAt(point, await this.screen());
        await this.client.absoluteActions(tapActions({ ...first, holdMs: 50 }));
        await delay(120 + Math.round(this.humanizer.next() * 40));
        await this.client.absoluteActions(tapActions({ x: first.x, y: first.y, holdMs: 50 }));
        await this.settle();
        return { x: first.x, y: first.y };
    }

    async longPress(target: TapTarget, durationMs = 800): Promise<{ x: number; y: number }> {
        const { element, point } = await this.resolveTarget(target);
        const plan = element ? this.humanizer.tapInFrame(this.landingFrame(element)) : this.humanizer.tapAt(point, await this.screen());
        await this.client.absoluteActions(longPressActions(plan, durationMs));
        await this.settle();
        return { x: plan.x, y: plan.y };
    }

    /**
     * Swipe by direction (the finger moves that way; `amount` is the fraction
     * of the screen it travels, default 0.5) or between two explicit points.
     */
    async swipe(options: { direction: SwipeDirection; amount?: number; intent?: SwipeIntent; from?: Point } | { from: Point; to: Point; intent?: SwipeIntent; durationMs?: number }): Promise<{ from: Point; to: Point; durationMs: number }> {
        const screen = await this.screen();
        let from: Point;
        let to: Point;
        let intent: SwipeIntent = options.intent ?? 'flick';
        let durationMs: number | undefined;
        if ('direction' in options) {
            const amount = Math.min(0.9, Math.max(0.05, options.amount ?? 0.5));
            if (options.from) {
                // The caller named the middle of the swipe: keep it there.
                const dx = options.direction === 'left' ? -1 : options.direction === 'right' ? 1 : 0;
                const dy = options.direction === 'up' ? -1 : options.direction === 'down' ? 1 : 0;
                const travelX = dx * amount * screen.width;
                const travelY = dy * amount * screen.height;
                from = { x: options.from.x - travelX / 2, y: options.from.y - travelY / 2 };
                to = { x: options.from.x + travelX / 2, y: options.from.y + travelY / 2 };
            } else {
                ({ from, to } = this.humanizer.directionSwipe(screen, options.direction, amount));
            }
        } else {
            from = options.from;
            to = options.to;
            intent = options.intent ?? 'drag';
            durationMs = options.durationMs;
        }
        const clampPoint = (point: Point): Point => ({
            x: Math.min(screen.width - 1, Math.max(1, point.x)),
            y: Math.min(screen.height - 1, Math.max(1, point.y)),
        });
        const plan = this.humanizer.swipe(clampPoint(from), clampPoint(to), { intent, ...(durationMs ? { durationMs } : {}) });
        for (const segment of plan.segments) {
            segment.x = Math.min(screen.width - 1, Math.max(1, segment.x));
            segment.y = Math.min(screen.height - 1, Math.max(1, segment.y));
        }
        await this.client.absoluteActions(swipeActions(plan));
        this.log(`swipe ${intent} (${plan.start.x},${plan.start.y}) → (${plan.end.x},${plan.end.y}) ${plan.totalMs}ms ${plan.segments.length} segments`);
        if (intent === 'flick') await this.settleScroll();
        await this.settle();
        return { from: plan.start, to: plan.end, durationMs: plan.totalMs };
    }

    /**
     * Scroll the content in `direction` (content moves that way, so the finger moves the
     * opposite way). A `flick` carries inertia and can fly past whole screens of content;
     * pass `intent: 'drag'` when each step must move a predictable amount.
     */
    scroll(direction: SwipeDirection, amount = 0.5, { intent = 'flick' }: { intent?: SwipeIntent } = {}): Promise<{ from: Point; to: Point; durationMs: number }> {
        const opposite: Record<SwipeDirection, SwipeDirection> = { up: 'down', down: 'up', left: 'right', right: 'left' };
        return this.swipe({ direction: opposite[direction], amount, intent });
    }

    /**
     * One item on in a full-screen vertical feed (short videos, reels, stories): a thumb's
     * arc from one side, the way a person flicks, not a line up the middle. Now and then
     * the thumb hesitates and the item springs back; it then follows through, so the feed
     * still moves exactly one item.
     */
    async flickFeed(direction: 'next' | 'previous' = 'next'): Promise<void> {
        const screen = await this.screen();
        if (direction === 'previous') {
            const back = this.humanizer.feedSwipe(screen, { hesitate: false });
            await this.swipe({ from: back.to, to: back.from, intent: 'flick' });
            return;
        }
        const first = this.humanizer.feedSwipe(screen);
        await this.swipe({ from: first.from, to: first.to, intent: 'flick' });
        if (first.committed) return;
        await this.wait(this.humanizer.pause('betweenTaps'));
        const second = this.humanizer.feedSwipe(screen, { hesitate: false });
        await this.swipe({ from: second.from, to: second.to, intent: 'flick' });
    }

    /** Type into the focused field in human-paced bursts. `submit` presses return afterwards. */
    async typeText(text: string, { submit = false }: { submit?: boolean } = {}): Promise<void> {
        for (const chunk of this.humanizer.typing(text)) {
            await this.client.keys(chunk.text, chunk.charsPerSecond);
            if (chunk.pauseAfterMs) await delay(chunk.pauseAfterMs);
        }
        if (submit) await this.client.keys('\n', 10);
        this.log(`type ${text.length} character${text.length === 1 ? '' : 's'}${submit ? ' + return' : ''}`);
        await this.settle();
    }

    async pressButton(name: 'home' | 'volumeUp' | 'volumeDown' | 'lock'): Promise<void> {
        if (name === 'lock') {
            try {
                await this.client.lock();
            } catch (error) {
                // The agent waits for a system notification to confirm the lock and reports a
                // timeout when it misses it, although the phone did lock.
                // The lock screen in SpringBoard's tree is the better witness.
                const showing = await this.client.source(5_000).then(lockScreenInTree).catch(() => false);
                if (!showing) throw error;
                this.log('lock: the agent did not confirm the lock, but the lock screen is showing');
            }
        } else if (name === 'home') {
            // `/wda/homescreen` refuses on a locked phone ("the device was not, or could not be,
            // unlocked"). Pressing Home on a locked phone should wake it, like the real button.
            try {
                await this.client.homescreen();
            } catch (error) {
                if (!(await this.client.locked().catch(() => false))) throw error;
                await this.client.pressButton('home');
            }
        } else {
            await this.client.pressButton(name);
        }
        await this.settle();
    }

    home(): Promise<void> {
        return this.pressButton('home');
    }

    async unlock(): Promise<void> {
        const screen = await this.screen();
        await unlockDevice({
            client: this.client, humanizer: this.humanizer, passcode: this.passcode, screen,
            ...(this.identity.productType ? { productType: this.identity.productType } : {}), log: this.log,
        });
        await this.settle();
    }

    /** Bring an app to the front (launching it if needed). `relaunch` terminates it first for a clean start. */
    async openApp(bundleId: string, { relaunch = false, args, environment }: { relaunch?: boolean; args?: string[]; environment?: Record<string, string> } = {}): Promise<void> {
        // Arguments and environment only reach a process as it starts, so giving them relaunches the app.
        const options = { ...(args?.length ? { args } : {}), ...(environment && Object.keys(environment).length ? { environment } : {}) };
        if (relaunch || Object.keys(options).length) {
            await this.client.terminateApp(bundleId).catch(() => undefined);
            await this.client.launchApp(bundleId, options);
        } else {
            const state = await this.client.appState(bundleId).catch(() => 1);
            if (state >= 2) await this.client.activateApp(bundleId);
            else await this.client.launchApp(bundleId);
        }
        this.screenCache = undefined; // orientation may differ per app
        this.log(`open ${bundleId}${relaunch ? ' (relaunch)' : ''}${args?.length ? ` with ${args.length} argument${args.length === 1 ? '' : 's'}` : ''}${options.environment ? ` and ${Object.keys(options.environment).length} environment variable${Object.keys(options.environment).length === 1 ? '' : 's'}` : ''}`);
        await this.settle();
    }

    async closeApp(bundleId: string): Promise<boolean> {
        const result = await this.client.terminateApp(bundleId);
        await this.settle();
        return result;
    }

    async openUrl(url: string): Promise<void> {
        try {
            await this.client.openUrl(url);
        } catch (error) {
            // iOS before 16.4 cannot open a link from a test runner, and launching Safari with
            // the link as an argument leaves it loading for ever, so say what works instead.
            if (error instanceof Error && /does not have the capability to open/i.test(error.message)) {
                throw new DeviceDriverError('This phone\'s iOS cannot open a link directly. Open the browser (open_app "Safari"), tap its address field, type the address and submit');
            }
            throw error;
        }
        this.log(`open url ${url}`);
        await this.settle();
    }

    listApps(): Promise<InstalledApp[]> {
        return listInstalledApps(this.udid, this.identity.kind);
    }

    /** Images / videos from the Mac into the phone's Photos library. */
    addToPhotos(files: string[]): Promise<AddedMedia[]> {
        return addToPhotos({ udid: this.udid, kind: this.identity.kind, client: this.client }, files, this.log);
    }

    /** A file from the Mac into an app's Documents folder (Files → On My iPhone → app). */
    addDocument(bundleId: string, file: string, options: { name?: string; subdirectory?: string } = {}): Promise<{ bundleId: string; destination: string; bytes: number }> {
        return addDocument({ udid: this.udid, kind: this.identity.kind }, bundleId, file, options, this.log);
    }

    listDocuments(bundleId: string, subdirectory = ''): Promise<string[]> {
        return listDocuments({ udid: this.udid, kind: this.identity.kind }, bundleId, subdirectory);
    }

    /** Newest camera-roll photos / videos copied to a folder on the Mac. */
    getPhotos(options: { count?: number; outDirectory: string }): Promise<PulledFile[]> {
        return getPhotos({ udid: this.udid, kind: this.identity.kind }, options, this.log);
    }

    getDocument(bundleId: string, remotePath: string, outPath: string): Promise<PulledFile> {
        return getDocument({ udid: this.udid, kind: this.identity.kind }, bundleId, remotePath, outPath, this.log);
    }

    // ---- recording, clipboard, appearance, apps ---------------------------------

    startRecording(options?: { fps?: number; codec?: 0 | 1 }): Promise<RecordingInfo> {
        return startRecording({ udid: this.udid, kind: this.identity.kind, client: this.client }, options);
    }

    stopRecording(outPath: string): Promise<{ path: string; bytes: number; info: RecordingInfo }> {
        return stopRecording({ udid: this.udid, kind: this.identity.kind, client: this.client }, outPath, this.log);
    }

    activeRecording(): Promise<RecordingInfo | undefined> {
        return activeRecording(this.udid);
    }

    /** The WebDriverAgentRunner app's bundle id on this phone (what `wda:prepare` signed). */
    private runnerBundleId(): string {
        return `${process.env.WDA_BUNDLE_ID ?? 'com.facebook.WebDriverAgentRunner'}.xctrunner`;
    }

    /**
     * iOS only lets the *foreground* app touch the pasteboard. On a real phone,
     * bring the runner forward for the operation, then put the previous app back.
     */
    private async withRunnerInForeground<T>(run: () => Promise<T>): Promise<T> {
        if (this.identity.kind !== 'device') return run();
        const previous = (await this.noTreeAppInFront()) ?? await this.client.activeAppInfo().catch(() => undefined);
        await this.client.activateApp(this.runnerBundleId()).catch(() => undefined);
        await delay(400);
        try {
            return await run();
        } finally {
            if (previous?.bundleId && previous.bundleId !== SPRINGBOARD) await this.client.activateApp(previous.bundleId).catch(() => undefined);
            else await this.client.homescreen().catch(() => undefined);
            await delay(400);
        }
    }

    /** Put text, a URL, or an image file on the clipboard — paste it in any app with a long-press → Paste. */
    async setClipboard(value: { text: string } | { url: string } | { imagePath: string }): Promise<string> {
        return this.withRunnerInForeground(async () => {
            if ('text' in value) {
                await this.client.setPasteboard(value.text, 'plaintext');
                return `text (${value.text.length} chars)`;
            }
            if ('url' in value) {
                await this.client.setPasteboard(value.url, 'url');
                return `url ${value.url}`;
            }
            const mime = mediaMimeType(value.imagePath);
            if (!mime?.startsWith('image/')) throw new DeviceDriverError('Clipboard images must be jpg/png/gif/webp/heic files');
            const { readFile } = await import('node:fs/promises');
            await this.client.setPasteboard(await readFile(value.imagePath), 'image');
            return `image ${value.imagePath}`;
        });
    }

    async getClipboard(): Promise<{ text?: string; url?: string; hasImage: boolean }> {
        return this.withRunnerInForeground(async () => {
            const [text, url, image] = await Promise.all([
                this.client.getPasteboard('plaintext'), this.client.getPasteboard('url'), this.client.getPasteboard('image'),
            ]);
            return { ...(text.length ? { text: text.toString('utf8') } : {}), ...(url.length ? { url: url.toString('utf8') } : {}), hasImage: image.length > 0 };
        });
    }

    async setAppearance(name: 'light' | 'dark'): Promise<void> {
        await this.client.setAppearance(name);
        await this.settle();
    }

    async rotate(orientation: 'portrait' | 'landscape'): Promise<void> {
        await this.client.setOrientation(orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT');
        this.screenCache = undefined;
        await this.settle();
    }

    /** Zoom the frontmost app: scale > 1 zooms in, < 1 zooms out. */
    async pinch(scale: number, velocity = scale > 1 ? 1 : -1): Promise<void> {
        await this.client.pinch(scale, velocity);
        await this.settle();
    }

    installApp(appPath: string): Promise<void> {
        return installApp({ udid: this.udid, kind: this.identity.kind }, appPath, this.log);
    }

    uninstallApp(bundleId: string): Promise<void> {
        return uninstallApp({ udid: this.udid, kind: this.identity.kind }, bundleId, this.log);
    }

    resetApp(bundleId: string, appPath?: string): Promise<void> {
        return resetApp({ udid: this.udid, kind: this.identity.kind }, bundleId, appPath, this.log);
    }

    /** Accept the alert: the named button, else the one that says yes ("Allow", "OK"…), else WDA's pick. */
    async acceptAlert(button?: string): Promise<string | undefined> {
        await this.refuseAlertCallOverNoTreeApp();
        const pressed = button ?? pickAlertButton(await this.client.alertButtons(), ACCEPT_LABELS);
        await this.client.alertAccept(pressed);
        await this.settle();
        return pressed;
    }

    /**
     * Dismiss the alert: the named button, else the one that says no ("Cancel", "Not Now", "Don't
     * Allow"…). WDA's own pick is not safe: on "Turn On Location Services…" it presses "Settings"
     * on iOS 26, so it is only the last resort when no button reads like a no.
     */
    async dismissAlert(button?: string): Promise<string | undefined> {
        await this.refuseAlertCallOverNoTreeApp();
        const pressed = button ?? pickAlertButton(await this.client.alertButtons(), DISMISS_LABELS);
        await this.client.alertDismiss(pressed);
        await this.settle();
        return pressed;
    }

    /** The alert routes look for the alert in the front app's tree. */
    private async refuseAlertCallOverNoTreeApp(): Promise<void> {
        const noTree = await this.noTreeAppInFront();
        if (noTree) throw new DeviceDriverError(`${noTree.name} is in front and its elements cannot be read, so an alert cannot be answered this way. Take a screenshot and tap the alert's button by its coordinates.`);
    }

    async dismissKeyboard(): Promise<void> {
        await this.client.dismissKeyboard().catch(() => undefined);
        await this.settle();
    }

    /**
     * Wait, as a person would: the `relaxed` profile may nudge the screen a
     * little while waiting — never with a keyboard or alert up.
     */
    async wait(ms: number): Promise<void> {
        const gesture = this.humanizer.idleGesture(await this.screen());
        if (gesture && ms > 1_500 && !this.lastSnapshot?.state.keyboardVisible && !this.lastSnapshot?.state.alert) {
            const before = Math.round(ms * 0.4);
            await delay(before);
            await this.client.absoluteActions(swipeActions(gesture)).catch(() => undefined);
            await delay(Math.max(0, ms - before - gesture.totalMs));
            return;
        }
        await delay(ms);
    }
}
