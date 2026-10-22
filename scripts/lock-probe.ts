// Measures how a phone's lock screen behaves, so `unlock` can be made right for it
// instead of guessed. It never types a passcode digit.
//
//   npm run lock:probe -- -d "My iPhone"
//
// It reports:
//   1. what iOS itself says about the passcode (asked over USB, not through the agent)
//   2. whether the agent can lock the phone
//   3. how long the lock screen stays lit after a wake press
//   4. home button: whether two Home presses open the keypad, and whether the Today view
//      does (swipe right, tap a widget, "Use Passcode")
//      no home button: what a wake press and a swipe up from the bottom edge lead to
// These are the facts `src/device/unlock.ts` is built on. Run it again whenever unlock
// stops working on a phone, after an iOS update, or on a new model. On a phone with no
// passcode step 4 leaves the phone unlocked.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { DeviceFleet } from '../src/device/fleet.js';
import { swipeActions, tapActions } from '../src/device/gestures.js';
import { hasHomeButton } from '../src/device/identity.js';
import { readLockView, type LockView } from '../src/device/unlock.js';
import { Humanizer } from '../src/humanize/humanizer.js';

const { values } = parseArgs({ options: { device: { type: 'string', short: 'd' } } });
const fleet = new DeviceFleet();
const registered = await fleet.resolve(values.device ?? '');
const driver = await fleet.driver(registered.udid);
const client = driver.client;
const screen = await driver.screen();
const productType = registered.productType;
const homeButton = hasHomeButton(productType);
const humanizer = new Humanizer({ profile: 'natural' });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
const say = (line: string) => process.stdout.write(`${line}\n`);

/** iOS's own answer, from lockdown over USB: true while a passcode stands between the Mac and the phone. */
async function passcodeRequired(): Promise<string> {
    try {
        const { utilities } = createRequire(import.meta.url)('appium-ios-device') as { utilities: { startLockdownSession(udid: string): Promise<{ getValue(query: { Key: string }): Promise<unknown>; close(): void }> } };
        const lockdown = await utilities.startLockdownSession(registered.udid);
        try { return String(await lockdown.getValue({ Key: 'PasswordProtected' })); } finally { lockdown.close(); }
    } catch {
        return 'unknown';
    }
}
// The same look `unlock` takes: shallow, and once more at full depth when the keys were cut off.
const view = (): Promise<LockView | undefined> => readLockView(client, screen).catch(() => undefined);
const describe = (seen: LockView | undefined): string => (!seen ? 'the tree could not be read'
    : seen.keypad ? 'the passcode keypad' : seen.usePasscode ? 'the Touch ID prompt with "Use Passcode"' : seen.widget ? 'the Today view' : 'no keypad, prompt or Today view');
const lit = async (): Promise<boolean> => (await driver.rawScreenshot()).length > 200_000; // a dark screen compresses to a few kB
const waitForDark = async (): Promise<void> => { for (let waited = 0; waited < 15 && (await lit()); waited += 1) await sleep(1_000); };
const hidHome = () => client.performIoHidEvent(0x0c, 0x40).catch(() => undefined);
const swipe = (from: { x: number; y: number }, to: { x: number; y: number }) => client.absoluteActions(swipeActions(humanizer.swipe(from, to))).catch(() => undefined);

async function probe(): Promise<void> {
    say(`\n1. iOS says a passcode is required right now: ${await passcodeRequired()} (true = locked with a passcode; false = unlocked, or no passcode set)`);
    say(`   the agent says locked: ${await client.locked()}`);

    if (!(await client.locked())) {
        say('\n2. Can the agent lock the phone?');
        try {
            await client.lock();
            say('   yes: the lock call returned normally');
        } catch (error) {
            say(`   the lock call failed: ${(error as Error).message.slice(0, 110)}`);
        }
        await sleep(2_000);
        const nowLit = await lit();
        say(`   afterwards: agent says locked: ${await client.locked()} · screen lit: ${nowLit} · iOS says passcode required: ${await passcodeRequired()}`);
        if (nowLit && !(await client.locked())) {
            say('   The phone did not lock. Let it lock by itself (Auto-Lock) or lock it by hand, then run this again.');
            return;
        }
    } else {
        say('\n2. Can the agent lock the phone? Not asked: it is locked already.');
    }

    say('\n3. How long does the lock screen stay lit after one press?');
    await waitForDark();
    const wokenAt = Date.now();
    await (homeButton ? hidHome() : client.pressButton('home').catch(() => undefined));
    let wentDark: string | undefined;
    for (let poll = 0; poll < 16; poll += 1) {
        await sleep(700);
        if (!(await lit())) { wentDark = seconds(wokenAt); break; }
    }
    say(wentDark ? `   dark again ${wentDark} after the press` : '   still lit after 12 seconds');

    if (homeButton) {
        say('\n4a. Two Home presses 2.5 seconds apart: does the keypad open?');
        await waitForDark();
        await hidHome();
        await sleep(2_500);
        await hidHome();
        const pressedAt = Date.now();
        await sleep(1_500);
        let afterPresses = await view();
        say(`   1.5 seconds after the second press the screen shows ${describe(afterPresses)}`);
        if (!afterPresses?.keypad) {
            // The keypad has taken up to 3.4 seconds to appear; one early look can miss it.
            await sleep(500);
            const lookedAt = seconds(pressedAt);
            afterPresses = await view();
            say(`   ${lookedAt} after it: ${describe(afterPresses)}`);
        }
        say(afterPresses?.keypad ? '   The Home button opens the keypad.' : '   The Home button did not open the keypad this time.');

        say('\n4b. Through the Today view: wake, swipe right, tap a widget, "Use Passcode"');
        await waitForDark();
        await hidHome();
        await sleep(1_000);
        await swipe({ x: screen.width * 0.12, y: screen.height * 0.57 }, { x: screen.width * 0.9, y: screen.height * 0.57 });
        await sleep(600);
        let seen = await view();
        say(`   after the swipe: ${describe(seen)}`);
        if (seen?.widget) {
            await client.absoluteActions(tapActions(humanizer.tapInFrame(seen.widget)));
            await sleep(800);
            seen = await view();
            say(`   after the widget tap: ${describe(seen)}`);
        }
        if (seen?.usePasscode) {
            await client.absoluteActions(tapActions(humanizer.tapInFrame(seen.usePasscode)));
            await sleep(700);
            seen = await view();
            say(`   after "Use Passcode": ${describe(seen)}`);
        }
        say(seen?.keypad ? '   The keypad can be reached this way.' : '   The keypad was not reached this way.');
        say('\nNothing was typed. An open keypad closes by itself when the screen sleeps.');
    } else {
        say('\n4. A wake press, then a swipe up from the bottom edge');
        await waitForDark();
        await client.pressButton('home').catch(() => undefined);
        await sleep(800);
        await swipe({ x: screen.width / 2, y: screen.height - 6 }, { x: screen.width / 2, y: screen.height * 0.35 });
        await sleep(1_200);
        if (!(await client.locked())) {
            say('   the phone is unlocked: it has no passcode, and it has been left unlocked');
        } else {
            let seen = await view();
            if (!seen?.keypad) { await sleep(1_500); seen = await view(); }
            say(`   still locked; the screen shows ${describe(seen)}`);
            say('\nNothing was typed. An open keypad closes by itself when the screen sleeps.');
        }
    }
}

say(`${registered.name} · ${productType ?? 'unknown model'} · ${homeButton ? 'home button' : 'no home button'} · ${screen.width}×${screen.height}pt`);
await probe();
process.exit(0);
