import type { Humanizer } from '../humanize/humanizer.js';
import { flattenTree, type WdaTreeNode } from '../observe/tree.js';
import type { ElementFrame, SnapshotElement } from '../observe/types.js';
import { swipeActions, tapActions } from './gestures.js';
import { hasHomeButton } from './identity.js';
import { WdaError, type WdaClient } from './wda-client.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface UnlockOptions {
    client: WdaClient;
    humanizer: Humanizer;
    passcode: string | undefined;
    screen: { width: number; height: number };
    productType?: string;
    log?: (line: string) => void;
    /** Waits between steps; tests pass a virtual clock. */
    sleep?: (ms: number) => Promise<void>;
    /** The clock those waits are measured on. */
    now?: () => number;
}

/**
 * Lock-screen keypad buttons as SpringBoard exposes them to accessibility:
 * Buttons whose label starts with the digit ("2" or "2 ABC").
 */
export function keypadFromElements(elements: readonly SnapshotElement[]): Map<string, SnapshotElement> {
    const keypad = new Map<string, SnapshotElement>();
    for (const element of elements) {
        if (element.type !== 'Button' && element.type !== 'Key') continue;
        const match = /^\s*(\d)\b/.exec(element.label ?? element.name ?? '');
        if (match && !keypad.has(match[1]!)) keypad.set(match[1]!, element);
    }
    return keypad;
}

const LOCK_SCREEN_IDENTIFIERS = new Set(['SBCoverSheetWindow', 'lockscreen-date-view']);

/**
 * Whether SpringBoard's tree is the lock screen (or its passcode keypad), judged by the
 * identifiers iOS gives those views, so it does not depend on the phone's language.
 * On iOS 15 the lock screen is a window named SBCoverSheetWindow
 * holding `lockscreen-date-view`; the keypad is a secure "Passcode field" with digit keys.
 */
export function lockScreenInTree(tree: WdaTreeNode): boolean {
    let digitKeys = 0;
    let secureField = false;
    const visit = (node: WdaTreeNode): boolean => {
        if (LOCK_SCREEN_IDENTIFIERS.has(node.rawIdentifier ?? '') || LOCK_SCREEN_IDENTIFIERS.has(node.name ?? '')) return true;
        if (node.type === 'SecureTextField') secureField = true;
        if ((node.type === 'Key' || node.type === 'Button') && /^\s*\d\b/.test(node.label ?? node.name ?? '')) digitKeys += 1;
        return (node.children ?? []).some(visit);
    };
    return visit(tree) || (secureField && digitKeys >= 10);
}

/** The Today view, one page left of the lock screen, and the window iOS puts its "Touch ID / Use Passcode" prompt in. */
const TODAY_VIEW_IDENTIFIER = 'left-of-home-scroll-view';
const PROMPT_WINDOW_IDENTIFIER = 'SBTransientOverlayWindow';

/** What a locked phone is showing, as far as reaching the passcode keypad is concerned. */
export interface LockView {
    /** The keypad, when all ten digit keys are in the tree. */
    keypad?: Map<string, SnapshotElement>;
    /** "Use Passcode" on the Touch ID prompt. */
    usePasscode?: ElementFrame;
    /** A widget on the Today view. Tapping one makes iOS ask for the unlock. */
    widget?: ElementFrame;
    /** A passcode field is in the tree without its keys: the read stopped above them. */
    keysCutOff: boolean;
}

/**
 * Reads the lock screen's state from SpringBoard's tree by identifiers and positions, not
 * by label, so it does not depend on the phone's language. On iOS 15 the Today view is
 * a scroll view named `left-of-home-scroll-view` whose
 * widgets are Icons; the prompt is a window named SBTransientOverlayWindow with
 * "Use Passcode" in the middle and "Emergency" and "Cancel" at the bottom.
 */
export function lockViewFromTree(tree: WdaTreeNode, screen: { width: number; height: number }): LockView {
    const keypad = keypadFromElements(flattenTree(tree, { screen, maxElements: 250 }).elements);
    if (keypad.size >= 10) return { keypad, keysCutOff: false };
    let secureField = false;
    let widget: ElementFrame | undefined;
    const promptButtons: ElementFrame[] = [];
    const visit = (node: WdaTreeNode, inToday: boolean, inPrompt: boolean): void => {
        const identifier = node.rawIdentifier ?? node.name ?? '';
        const today = inToday || identifier === TODAY_VIEW_IDENTIFIER;
        const prompt = inPrompt || identifier === PROMPT_WINDOW_IDENTIFIER;
        if (node.type === 'SecureTextField') secureField = true;
        const { x, y, width, height } = node.rect ?? {};
        if (typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number') {
            const centreX = x + width / 2;
            const centreY = y + height / 2;
            const onScreen = centreX > 0 && centreX < screen.width && centreY > 0 && centreY < screen.height;
            // The Today view stays in the tree while the lock screen itself is showing, off to the side.
            if (today && !widget && node.type === 'Icon' && onScreen && width >= 60 && height >= 60
                && centreY > screen.height * 0.12 && centreY < screen.height * 0.9) widget = { x, y, width, height };
            // The prompt also holds unlabelled buttons, one of them the size of the screen.
            if (prompt && node.type === 'Button' && onScreen && (node.label ?? node.name)
                && width <= screen.width * 0.6 && height <= screen.height * 0.12) promptButtons.push({ x, y, width, height });
        }
        for (const child of node.children ?? []) visit(child, today, prompt);
    };
    visit(tree, false, false);
    const middle = promptButtons.filter((frame) => {
        const centreY = frame.y + frame.height / 2;
        return centreY > screen.height * 0.3 && centreY < screen.height * 0.8;
    });
    const usePasscode = promptButtons.length >= 2 && middle.length === 1 ? middle[0] : undefined;
    return { ...(usePasscode ? { usePasscode } : {}), ...(widget ? { widget } : {}), keysCutOff: secureField };
}

/** How deep SpringBoard's tree is read on a locked home-button phone; see the measurements below. */
const LOCK_SCREEN_TREE_DEPTH = 12;

type TreeReader = Pick<WdaClient, 'source' | 'updateSettings' | 'restoreSettings'>;

async function shallowTree(client: TreeReader, timeoutMs: number): Promise<WdaTreeNode> {
    await client.updateSettings({ snapshotMaxDepth: LOCK_SCREEN_TREE_DEPTH }).catch(() => undefined);
    try {
        return await client.source(timeoutMs);
    } finally {
        await client.restoreSettings().catch(() => undefined);
    }
}

/**
 * One look at the lock screen of a home-button phone. The tree is read shallow, because
 * with the Today view on screen a full read does not come back. The keypad that a Home
 * press opens keeps its keys below that depth (the one behind "Use Passcode" does not),
 * so when the passcode field turns up without keys the whole tree is read once.
 */
export async function readLockView(client: TreeReader, screen: { width: number; height: number }): Promise<LockView> {
    const view = lockViewFromTree(await shallowTree(client, 8_000), screen);
    if (view.keypad || !view.keysCutOff) return view;
    return lockViewFromTree(await client.source(8_000), screen);
}

/**
 * Where the numeric keypad sits when the tree can't be read, as fractions of the screen.
 * Home-button layout: the key centres read from the tree of a 414×736 pt home-button phone
 * on iOS 15. The other layout was only checked by eye. Used once, never in
 * a loop (wrong digits count as failed attempts and iOS escalates the lock-out), and only
 * when no tree could be read at all.
 */
export function geometricKeypad(screen: { width: number; height: number }, productType?: string): Map<string, { x: number; y: number }> {
    const homeButton = hasHomeButton(productType);
    const columns = homeButton ? [0.222, 0.5, 0.778] : [0.275, 0.5, 0.725];
    const rows = homeButton ? [0.367, 0.5, 0.632, 0.765] : [0.435, 0.53, 0.625, 0.72];
    const keypad = new Map<string, { x: number; y: number }>();
    for (let digit = 1; digit <= 9; digit++) {
        keypad.set(String(digit), {
            x: Math.round(columns[(digit - 1) % 3]! * screen.width),
            y: Math.round(rows[Math.floor((digit - 1) / 3)]! * screen.height),
        });
    }
    keypad.set('0', { x: Math.round(columns[1]! * screen.width), y: Math.round(rows[3]! * screen.height) });
    return keypad;
}

/**
 * Home-button phones (measured on iOS 15 with a passcode and Touch ID on):
 * - From a dark screen a Home press only wakes the phone. The lock screen then stays lit
 *   for 6 to 7 seconds.
 * - A Home press on the lit lock screen asks iOS to unlock. Usually the keypad opens 0.3
 *   to 3.4 seconds later, but for stretches of time it does not open at all, for the HID
 *   event and the synthetic press alike, although iOS logs an accepted unlock request.
 *   The keypad comes back once it has been opened by the route below.
 * - The route that does not depend on the button: swipe right on the lock screen to the
 *   Today view and tap a widget. iOS asks for the unlock with a "Touch ID" prompt, whose
 *   "Use Passcode" button opens the keypad. A widget tapped sooner than about 3 seconds
 *   after the swipe is ignored, and a touch on a screen that has gone dark does nothing,
 *   so each step is confirmed in the tree before the next.
 * - While the Today view is on screen a full-depth tree read does not come back (25 s and
 *   more). At depth 12 it takes 3 to 4 seconds and still holds the widgets, the prompt's
 *   buttons and the keys of the keypad behind "Use Passcode"; depth 22 already hangs. The
 *   keys of the keypad a Home press opens lie deeper than 12 and need the full read.
 * So: two presses first (14 to 16 s to unlocked when they work), then the Today view (23
 * to 26 s). Between them they unlock the phone reliably.
 */
const HOME_BUTTON = { betweenPressesMs: 2_500, afterPressesMs: 1_500, awakeMs: 6_000, maxSteps: 12 } as const;

/**
 * Phones without a home button (measured on iOS 26): a synthetic Home press wakes the dark
 * screen and a swipe up from the bottom edge then leaves the lock screen. `/wda/unlock` does
 * neither: it gives up after 8 seconds with the phone still locked and dark. With a passcode
 * set, the same swipe brings the keypad once Face ID has given up; that path is less tested.
 */
const SWIPE_UP_STEPS = [
    { act: 'home', waitMs: 800, look: false },
    { act: 'swipe-up', waitMs: 1_200, look: true },
    { act: 'wait', waitMs: 1_500, look: true },
    { act: 'unlock', waitMs: 800, look: true },
    { act: 'hid-home', waitMs: 800, look: false },
    { act: 'swipe-up', waitMs: 1_200, look: true },
    { act: 'wait', waitMs: 1_500, look: true },
] as const;

/** Wake the phone and enter the passcode. Resolves when the phone is unlocked. */
export async function unlockDevice({ client, humanizer, passcode, screen, productType, log = () => {}, sleep = delay, now = Date.now }: UnlockOptions): Promise<void> {
    const homeButton = hasHomeButton(productType);
    // The agent learns about the lock from a system notification and can miss it: a freshly
    // started agent can answer "unlocked" while the passcode keypad is on screen. So
    // "unlocked" is only believed when the lock screen is
    // not what SpringBoard is showing. Another app's tree is never read for this.
    const lockScreenShowing = async (): Promise<boolean> => {
        try {
            if ((await client.activeAppInfo()).bundleId !== 'com.apple.springboard') return false;
            return lockScreenInTree(await (homeButton ? shallowTree(client, 5_000) : client.source(5_000)));
        } catch {
            return false;
        }
    };
    let agentIsRight = true;
    if (!(await client.locked())) {
        if (!(await lockScreenShowing())) return;
        agentIsRight = false;
        log('unlock: the agent reports unlocked, but the lock screen is showing; unlocking anyway');
    }
    const stillLocked = (): Promise<boolean> => (agentIsRight ? client.locked() : lockScreenShowing());
    if (passcode && !/^\d{4,}$/.test(passcode)) throw new WdaError('Device passcode must be digits only', 400);

    const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
        const plan = humanizer.swipe(from, to);
        plan.start.y = Math.min(plan.start.y, screen.height - 2);
        await client.absoluteActions(swipeActions(plan)).catch(() => undefined);
    };
    const swipeUpFromBottomEdge = () => swipe({ x: screen.width / 2, y: screen.height - 6 }, { x: screen.width / 2, y: screen.height * 0.35 });

    if (!passcode) {
        // No passcode registered, so the phone should not have one: waking it and leaving
        // the lock screen is all there is to do.
        if (homeButton) {
            try { await client.unlock(); } catch { /* it reports an error when a passcode is required */ }
        } else {
            await client.pressButton('home').catch(() => undefined);
            await sleep(800);
            await swipeUpFromBottomEdge();
        }
        await sleep(1_200);
        if (!(await stillLocked())) return;
        throw new WdaError('The device is locked and no passcode is registered for it — add one with `phone passcode -d <device>` (it is stored only in devices.json)', 423, 'locked');
    }

    const tap = (frame: ElementFrame) => client.absoluteActions(tapActions(humanizer.tapInFrame(frame)));
    const pressHidHome = () => client.performIoHidEvent(0x0c, 0x40).catch(() => undefined);
    let keypad: Map<string, SnapshotElement> | undefined;
    let treeRead = false; // whether any look at the lock screen came back
    const seen: string[] = []; // what each look found, for the error when the keypad never comes
    let throughWidget = false;

    if (homeButton) {
        const readView = (): Promise<LockView | undefined> => readLockView(client, screen).catch(() => undefined); // undefined: tree unavailable this time
        // The screen sleeps 6 to 7 seconds after the last press or touch, and a touch on a
        // dark screen does nothing while the tree still shows what was there. So a touch is
        // only made within `awakeMs` of the last one; otherwise the phone is woken again first.
        let lastInputAt = -Infinity;
        const awake = (): boolean => now() - lastInputAt < HOME_BUTTON.awakeMs;
        let pressedTwice = false;
        let widgetTaps = 0;
        let unreadable = 0;
        for (let step = 1; step <= HOME_BUTTON.maxSteps && unreadable < 3; step += 1) {
            if (agentIsRight && !(await client.locked())) {
                if (throughWidget) await client.pressButton('home').catch(() => undefined);
                return;
            }
            const view = await readView();
            if (view) { treeRead = true; unreadable = 0; } else unreadable += 1;
            seen.push(!view ? 'unreadable' : view.keypad ? 'keypad' : view.usePasscode ? 'Touch ID prompt' : view.widget ? 'Today view' : 'lock screen');
            if (view?.keypad) {
                keypad = view.keypad;
                log(`unlock: keypad located via accessibility tree (${throughWidget ? 'through a Today view widget' : pressedTwice ? 'after two home presses' : 'already showing'})`);
                break;
            }
            if (!pressedTwice) {
                pressedTwice = true;
                await pressHidHome();
                await sleep(HOME_BUTTON.betweenPressesMs);
                await pressHidHome();
                lastInputAt = now();
                await sleep(HOME_BUTTON.afterPressesMs);
            } else if (view?.usePasscode && awake()) {
                log('unlock: Touch ID prompt showing; choosing Use Passcode');
                await tap(view.usePasscode);
                lastInputAt = now();
                await sleep(700);
            } else if (view?.widget && awake() && widgetTaps < 3) {
                // The look that found the widget took 3 seconds or more, which is the wait the Today view needs.
                log('unlock: Today view showing; tapping a widget so that iOS asks for the unlock');
                throughWidget = true;
                widgetTaps += 1;
                await tap(view.widget);
                lastInputAt = now();
                await sleep(800);
            } else if (!view) {
                await sleep(700); // look again before touching anything
            } else {
                log('unlock: no keypad from the home button; going through the Today view');
                await pressHidHome(); // wakes a screen that has gone dark meanwhile
                await sleep(1_000);
                await swipe({ x: screen.width * 0.12, y: screen.height * 0.57 }, { x: screen.width * 0.9, y: screen.height * 0.57 });
                lastInputAt = now();
                await sleep(600);
            }
        }
    } else {
        const readKeypad = async (): Promise<Map<string, SnapshotElement> | undefined> => {
            try {
                // The lock screen's tree is tiny, so keep this short: the screen may dim while we look.
                const tree = await client.source(5_000);
                treeRead = true;
                const found = keypadFromElements(flattenTree(tree, { screen, maxElements: 250 }).elements);
                return found.size >= 10 ? found : undefined;
            } catch {
                return undefined; // tree unavailable this time
            }
        };
        keypad = await readKeypad(); // it may already be on screen
        if (keypad) log('unlock: keypad located via accessibility tree (already showing)');
        for (const step of SWIPE_UP_STEPS) {
            if (keypad) break;
            try {
                if (step.act === 'home') await client.pressButton('home');
                else if (step.act === 'swipe-up') await swipeUpFromBottomEdge();
                else if (step.act === 'unlock') await client.unlock();
                else if (step.act === 'hid-home') await client.performIoHidEvent(0x0c, 0x40);
            } catch { /* expected while a passcode is still required */ }
            await sleep(step.waitMs);
            // Asked before any look: once unlocked, the home screen's tree takes 20 seconds to read.
            if (agentIsRight && !(await client.locked())) return;
            if (!step.look) continue;
            keypad = await readKeypad();
            if (keypad) log(`unlock: keypad located via accessibility tree (after ${step.act})`);
        }
    }

    if (!keypad && treeRead) {
        // The screen could be read and the keypad is not on it. Tapping where its keys would be
        // only presses whatever is there instead.
        throw new WdaError(`The passcode keypad did not open, so nothing was typed${seen.length ? ` (the looks found: ${seen.join(', ')})` : ''}. Unlock the phone by hand once, then run \`npm run lock:probe -- -d <device>\` to see which step fails`, 423, 'locked');
    }

    const targets: Array<{ digit: string; point?: { x: number; y: number }; frame?: SnapshotElement['frame'] }> = [];
    if (keypad && [...passcode].every((digit) => keypad!.has(digit))) {
        for (const digit of passcode) targets.push({ digit, frame: keypad.get(digit)!.frame });
    } else {
        log('unlock: keypad not readable; using the geometric layout for this screen size');
        const geometric = geometricKeypad(screen, productType);
        for (const digit of passcode) targets.push({ digit, point: geometric.get(digit)! });
    }

    for (const target of targets) {
        const plan = target.frame ? humanizer.tapInFrame(target.frame) : humanizer.tapAt(target.point!, screen);
        await client.absoluteActions(tapActions(plan));
        await sleep(humanizer.pause('betweenTaps') || 180);
    }
    await sleep(1_500);
    if (await stillLocked()) {
        throw new WdaError('Device is still locked after entering the passcode — check the passcode in devices.json and unlock it by hand once', 423, 'locked');
    }
    // The unlock that a widget asked for ends in that widget's app. Leave the phone on its home screen.
    if (throughWidget) {
        await client.pressButton('home').catch(() => undefined);
        await sleep(600);
    }
}
