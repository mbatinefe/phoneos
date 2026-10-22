import assert from 'node:assert/strict';
import test from 'node:test';

import { lockViewFromTree, unlockDevice } from '../src/device/unlock.js';
import type { WdaClient } from '../src/device/wda-client.js';
import { Humanizer } from '../src/humanize/humanizer.js';
import type { WdaTreeNode } from '../src/observe/tree.js';
import { lockScreenTree, node } from './fake-wda.js';

type Rect = { x: number; y: number; width: number; height: number };
type Action = { type: string; x?: number; y?: number };

const screen = { width: 414, height: 736 };
const full = { x: 0, y: 0, ...screen };
const inside = (rect: Rect, point: { x: number; y: number }) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;

// The frames below are shaped like a 414×736 home-button phone's on iOS 15.
const WIDGET = { x: 31, y: 114, width: 352, height: 184 };
const USE_PASSCODE = { x: 155, y: 402, width: 104, height: 33 };
const KEYS: Array<[string, Rect]> = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((digit, index) => [digit, {
    x: index === 9 ? 149 : 34 + (index % 3) * 115, y: index === 9 ? 513 : 220 + Math.floor(index / 3) * 98, width: 116, height: 99,
}]);

const coverSheet = (children: WdaTreeNode[] = []) => node({
    type: 'Window', rawIdentifier: 'SBCoverSheetWindow', name: 'SBCoverSheetWindow', rect: full,
    children: [node({ type: 'Other', rawIdentifier: 'lockscreen-date-view', name: 'lockscreen-date-view', rect: { x: 8, y: 67, width: 398, height: 130 } }), ...children],
});
const todayView = () => node({
    type: 'ScrollView', rawIdentifier: 'left-of-home-scroll-view', name: 'left-of-home-scroll-view', rect: { x: 0, y: 0, width: 414, height: 707 },
    children: [node({ type: 'Icon', label: 'Photos', name: 'Photos', rect: WIDGET })],
});
const overlay = (children: WdaTreeNode[]) => node({ type: 'Window', rawIdentifier: 'SBTransientOverlayWindow', name: 'SBTransientOverlayWindow', rect: full, children });
const bottomButtons = () => [
    node({ type: 'Button', label: 'Emergency', name: 'Emergency', rect: { x: 51, y: 662, width: 82, height: 32 } }),
    node({ type: 'Button', label: 'Cancel', name: 'Cancel', rect: { x: 297, y: 662, width: 50, height: 32 } }),
];
const promptParts = () => [
    // iOS puts two unlabelled buttons in the prompt, one of them the size of the screen.
    node({ type: 'Button', rect: { x: 0, y: 0, width: 30, height: 30 } }),
    node({ type: 'Button', rect: { x: 0, y: 0, width: 414, height: 686 } }),
    node({ type: 'StaticText', label: 'Touch ID', rect: { x: 171, y: 346, width: 72, height: 22 }, isVisible: '0' }),
    node({ type: 'Button', label: 'Use Passcode', name: 'Use Passcode', rect: USE_PASSCODE }),
    ...bottomButtons(),
];
const keypadParts = () => [
    node({ type: 'SecureTextField', label: 'Passcode field', rect: { x: 0, y: 159, width: 414, height: 16 } }),
    ...KEYS.map(([digit, rect]) => node({ type: 'Key', label: digit, name: digit, rect })),
    ...bottomButtons(),
];
const application = (children: WdaTreeNode[]) => node({ type: 'Application', name: 'SpringBoard', rect: full, children });

test('the lock screen is read by identifiers and positions, not labels', () => {
    assert.deepEqual(lockViewFromTree(application([coverSheet()]), screen), { keysCutOff: false }, 'plain lock screen');
    assert.deepEqual(lockViewFromTree(application([todayView(), coverSheet()]), screen), { widget: WIDGET, keysCutOff: false }, 'Today view');
    const prompt = lockViewFromTree(application([todayView(), coverSheet(), overlay(promptParts())]), screen);
    assert.deepEqual(prompt.usePasscode, USE_PASSCODE, 'the one labelled button in the middle, not the screen-sized one');
    const keypad = lockViewFromTree(application([todayView(), coverSheet(), overlay(keypadParts())]), screen);
    assert.equal(keypad.keypad?.size, 10);
    assert.equal(keypad.usePasscode, undefined);
    // A read that stopped above the keys says so, so that the whole tree is read once.
    const cut = lockViewFromTree(application([coverSheet(), overlay(keypadParts().filter((part) => part.type !== 'Key'))]), screen);
    assert.deepEqual([cut.keypad, cut.usePasscode, cut.keysCutOff], [undefined, undefined, true]);
    // A widget page that is in the tree but off to the side is not "showing".
    const aside = node({ ...todayView(), type: 'ScrollView', children: [node({ type: 'Icon', label: 'Photos', rect: { ...WIDGET, x: -383 } })] });
    assert.equal(lockViewFromTree(application([aside, coverSheet()]), screen).widget, undefined);
});

/**
 * A stand-in for a home-button phone, behaving as one on iOS 15 does. The screen sleeps
 * 6.5 s after the last press or touch, and a touch on a dark
 * screen does nothing. A Home press on a dark screen only wakes it. On the lit lock screen
 * a Home press opens the keypad 1.2 s later, or (`homePressOpensKeypad: false`) nothing
 * happens, as it sometimes does. A swipe opens the Today view; a widget
 * there answers only 3 s after the swipe, with the Touch ID prompt, whose "Use Passcode"
 * opens the keypad. With the Today view on screen a tree read deeper than 16 never returns,
 * and the keys of the keypad a Home press opens are missing from a read of depth 12.
 */
function homeButtonPhone({ homePressOpensKeypad, widgetAnswers = true, startOn = 'lock' as 'lock' | 'today' }: { homePressOpensKeypad: boolean; widgetAnswers?: boolean; startOn?: 'lock' | 'today' }) {
    let now = 0;
    let litUntil = -Infinity;
    let base: 'lock' | 'today' = startOn;
    let over: 'none' | 'prompt' | 'keypad' = 'none';
    let todaySince = -Infinity;
    let keypadAt = Infinity;
    let typed = '';
    let front: 'lock-screen' | 'app' | 'home' = 'lock-screen';
    let depth = 40;
    const calls: string[] = [];
    const lit = () => now <= litUntil;
    const settle = () => {
        if (!lit()) { over = 'none'; keypadAt = Infinity; }
        if (now >= keypadAt) { over = 'keypad'; keypadAt = Infinity; }
    };
    const tree = (): WdaTreeNode => {
        const parts = over === 'prompt' ? promptParts() : over === 'keypad' ? keypadParts() : undefined;
        // The keypad a Home press opens keeps its keys deeper than a depth-12 read goes.
        if (base === 'lock') return application([coverSheet((parts ?? []).filter((part) => depth > 12 || part.type !== 'Key'))]);
        return application([todayView(), coverSheet(), ...(parts ? [overlay(parts)] : [])]);
    };
    const client = {
        locked: async () => front === 'lock-screen',
        activeAppInfo: async () => ({ bundleId: front === 'app' ? 'com.apple.mobileslideshow' : 'com.apple.springboard', name: '', pid: 1 }),
        updateSettings: async (settings: { snapshotMaxDepth?: number }) => { depth = settings.snapshotMaxDepth ?? depth; },
        restoreSettings: async () => { depth = 40; },
        unlock: async () => { calls.push('wda-unlock'); throw new Error('Timed out while waiting until the screen gets unlocked'); },
        pressButton: async () => { calls.push('synthetic-home'); if (front === 'app') front = 'home'; },
        performIoHidEvent: async () => {
            now += 100;
            settle();
            calls.push('hid-home');
            if (lit() && base === 'lock' && over === 'none' && homePressOpensKeypad) keypadAt = now + 1_200;
            litUntil = now + 6_500;
        },
        source: async () => {
            settle();
            const seen = tree();
            if (base === 'today' && depth > 16) { now += 25_000; throw new Error('The operation was aborted due to timeout'); }
            now += base === 'today' ? 3_600 : 2_500;
            return seen;
        },
        absoluteActions: async (sources: Array<{ actions: Action[] }>) => {
            settle();
            const moves = sources[0]!.actions.filter((action) => action.type === 'pointerMove');
            if (!lit()) { calls.push('touch-on-dark'); return; }
            litUntil = now + 6_500;
            const point = { x: moves[0]!.x!, y: moves[0]!.y! };
            if (moves.length > 1) {
                calls.push('swipe');
                if (base === 'lock' && over === 'none') { base = 'today'; todaySince = now; }
            } else if (over === 'keypad') {
                const key = KEYS.find(([, rect]) => inside(rect, point));
                calls.push(key ? 'digit' : 'tap-beside-keys');
                typed += key?.[0] ?? '';
                if (typed === '2580') front = base === 'today' ? 'app' : 'home';
            } else if (over === 'prompt') {
                calls.push(inside(USE_PASSCODE, point) ? 'use-passcode' : 'tap-beside-prompt');
                if (inside(USE_PASSCODE, point)) over = 'keypad';
            } else if (base === 'today' && inside(WIDGET, point)) {
                const ready = now - todaySince >= 3_000;
                calls.push(ready ? 'widget' : 'widget-too-early');
                if (ready && widgetAnswers) over = 'prompt';
            } else {
                calls.push('tap-on-lock-screen');
            }
        },
    } as unknown as WdaClient;
    const logs: string[] = [];
    const options = {
        client, humanizer: new Humanizer({ profile: 'precise' as const, seed: 'unlock-test' }), passcode: '2580', screen, productType: 'iPhone9,4',
        log: (line: string) => logs.push(line), sleep: async (ms: number) => { now += ms; }, now: () => now,
    };
    return { options, calls, logs, front: () => front, depth: () => depth, elapsed: () => now };
}

test('a home-button phone whose Home press opens the keypad is unlocked with two presses', async () => {
    const phone = homeButtonPhone({ homePressOpensKeypad: true });
    await unlockDevice(phone.options);
    assert.equal(phone.front(), 'home', phone.logs.join('\n'));
    assert.deepEqual(phone.calls, ['hid-home', 'hid-home', 'digit', 'digit', 'digit', 'digit']);
    assert.ok(phone.logs.some((line) => line.includes('after two home presses')), phone.logs.join('\n'));
    assert.equal(phone.depth(), 40, 'the tree depth is put back');
});

test('when the Home press brings no keypad, the Today view and "Use Passcode" do', async () => {
    const phone = homeButtonPhone({ homePressOpensKeypad: false });
    await unlockDevice(phone.options);
    assert.equal(phone.front(), 'home', `the widget's app is left again\n${phone.logs.join('\n')}`);
    assert.deepEqual(phone.calls, ['hid-home', 'hid-home', 'hid-home', 'swipe', 'widget', 'use-passcode', 'digit', 'digit', 'digit', 'digit', 'synthetic-home']);
    assert.ok(phone.logs.some((line) => line.includes('through a Today view widget')), phone.logs.join('\n'));
    assert.equal(phone.depth(), 40, 'the tree depth is put back');
});

test('a phone that fell asleep on the Today view is woken before it is touched', async () => {
    const phone = homeButtonPhone({ homePressOpensKeypad: false, startOn: 'today' });
    await unlockDevice(phone.options);
    assert.equal(phone.front(), 'home', phone.logs.join('\n'));
    assert.ok(!phone.calls.includes('touch-on-dark') && !phone.calls.includes('widget-too-early'), phone.calls.join(' '));
});

test('with no keypad on a readable lock screen nothing is typed', async () => {
    const phone = homeButtonPhone({ homePressOpensKeypad: false, widgetAnswers: false });
    await assert.rejects(unlockDevice(phone.options), /keypad did not open, so nothing was typed \(the looks found: lock screen, lock screen, Today view/);
    assert.equal(phone.front(), 'lock-screen');
    assert.equal(phone.calls.filter((call) => call === 'widget').length, 3, 'a widget that does not answer is not tapped for ever');
    assert.ok(!phone.calls.some((call) => call === 'digit' || call.startsWith('tap-')), phone.calls.join(' '));
    assert.equal(phone.depth(), 40);
});

test('a phone without a home button is woken and swiped up; one with no passcode is then unlocked', async () => {
    // A passcode still registered here, none on the phone.
    let locked = true;
    let awake = false;
    const calls: string[] = [];
    const client = {
        locked: async () => locked,
        source: async () => application([coverSheet()]),
        pressButton: async () => { calls.push('synthetic-home'); awake = true; },
        performIoHidEvent: async () => { calls.push('hid-home'); },
        unlock: async () => { calls.push('wda-unlock'); throw new Error('Timed out while waiting until the screen gets unlocked'); },
        absoluteActions: async (sources: Array<{ actions: Action[] }>) => {
            const moves = sources[0]!.actions.filter((action) => action.type === 'pointerMove');
            const swipeUp = moves.length > 1 && moves[0]!.y! > 830 && moves.at(-1)!.y! < 400;
            calls.push(swipeUp ? 'swipe-up' : moves.length > 1 ? 'swipe' : 'tap');
            if (swipeUp && awake && !stuck) locked = false;
        },
    } as unknown as WdaClient;
    let stuck = false;
    const options = { client, humanizer: new Humanizer({ profile: 'precise' as const, seed: 'unlock-test' }), passcode: '2580', screen: { width: 390, height: 844 }, productType: 'iPhone13,3', sleep: async () => {} };
    await unlockDevice(options);
    assert.deepEqual(calls, ['synthetic-home', 'swipe-up']);

    // The lock screen can be read and never shows a keypad: the digits are not tapped onto it.
    locked = true; stuck = true; calls.length = 0;
    await assert.rejects(unlockDevice(options), /keypad did not open, so nothing was typed/);
    assert.ok(!calls.includes('tap'), calls.join(' '));
    assert.ok(calls.includes('wda-unlock') && calls.filter((call) => call === 'swipe-up').length === 2, calls.join(' '));
});

test('unlock does not believe an agent that says unlocked while the lock screen is showing', async () => {
    let taps = 0;
    const calls: string[] = [];
    const keypad = lockScreenTree();
    const lockScreen = { type: 'Application', children: [{ type: 'Window', rawIdentifier: 'SBCoverSheetWindow', name: 'SBCoverSheetWindow', children: keypad.children ?? [] }] };
    const homeScreen = { type: 'Application', children: [{ type: 'Window', children: [{ type: 'Icon', label: 'Safari' }] }] };
    let frontApp = 'com.apple.springboard';
    const client = {
        locked: async () => false, // wrong the whole time
        activeAppInfo: async () => ({ bundleId: frontApp, name: '', pid: 1 }),
        source: async () => (taps >= 4 ? homeScreen : lockScreen),
        performIoHidEvent: async () => { calls.push('hid-home'); },
        pressButton: async () => { calls.push('synthetic-home'); },
        unlock: async () => { calls.push('wda-unlock'); },
        absoluteActions: async () => { taps += 1; },
        updateSettings: async () => {},
        restoreSettings: async () => {},
    } as unknown as WdaClient;
    const logs: string[] = [];
    const options = { client, humanizer: new Humanizer({ profile: 'precise' as const, seed: 'unlock-test' }), passcode: '2580', screen: { width: 390, height: 844 }, productType: 'iPhone9,4', log: (line: string) => logs.push(line), sleep: async () => {} };
    await unlockDevice(options);
    assert.equal(taps, 4, logs.join('\n'));
    assert.ok(logs.some((line) => line.includes('the agent reports unlocked, but the lock screen is showing')), logs.join('\n'));

    // Really unlocked, home screen in front: nothing is pressed or tapped.
    taps = 4; calls.length = 0;
    await unlockDevice(options);
    assert.deepEqual([taps, calls], [4, []]);

    // Another app in front: its tree is not read to find out.
    frontApp = 'com.zhiliaoapp.musically';
    let treeReads = 0;
    (client as unknown as { source: () => Promise<unknown> }).source = async () => { treeReads += 1; return lockScreen; };
    await unlockDevice(options);
    assert.equal(treeReads, 0);
});
