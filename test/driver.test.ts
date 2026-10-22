import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import sharp from 'sharp';

import { DeviceDriver, DeviceDriverError, firstMjpegFrame, pickAlertButton } from '../src/device/driver.js';
import { Humanizer } from '../src/humanize/humanizer.js';
import { lockScreenTree, startFakeWda } from './fake-wda.js';

function driverFor(url: string, extra: Partial<ConstructorParameters<typeof DeviceDriver>[0]> = {}): DeviceDriver {
    return new DeviceDriver({
        identity: { udid: 'fake-1', kind: 'device', name: 'Fake', productType: 'iPhone16,1' },
        wdaUrl: url,
        humanizer: new Humanizer({ profile: 'natural', seed: 'driver-test' }),
        ...extra,
    });
}

test('state() reports lock, app, geometry, alert and battery', async (context) => {
    const wda = await startFakeWda({ alertText: 'Allow notifications?' });
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const state = await driver.state();
    assert.equal(state.locked, false);
    assert.deepEqual(state.activeApp, { bundleId: 'com.apple.Preferences', name: 'Settings', pid: 42 });
    assert.deepEqual(state.screen, { width: 390, height: 844, scale: 3, orientation: 'portrait' });
    assert.deepEqual(state.alert, { text: 'Allow notifications?', buttons: ['Settings', 'Cancel'] }, 'the buttons come from the alert itself');
    assert.deepEqual(state.battery, { level: 0.8, state: 'charging' });
    assert.equal(state.keyboardVisible, false, 'unknown without a tree');
});

test('observe() flattens the tree and scales the screenshot to points', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const snapshot = await driver.observe({ tree: true, screenshot: true });
    assert.equal(snapshot.treeStatus, 'ok');
    assert.ok(snapshot.elements.length >= 4);
    assert.equal(snapshot.state.keyboardVisible, true);
    assert.ok(snapshot.screenshot);
    assert.deepEqual([snapshot.screenshot!.width, snapshot.screenshot!.height, snapshot.screenshot!.mimeType], [390, 844, 'image/jpeg']);
    assert.equal(driver.snapshot, snapshot);
});

test('observe() falls back to a screenshot when the tree walk times out', async (context) => {
    const wda = await startFakeWda({ treeDelayMs: 1_500 });
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const snapshot = await driver.observe({ tree: true, treeTimeoutMs: 300 });
    assert.equal(snapshot.treeStatus, 'timeout');
    assert.deepEqual(snapshot.elements, []);
    assert.ok(snapshot.screenshot, 'a screenshot is attached automatically');
});

test('firstMjpegFrame cuts the first JPEG out of a multipart stream', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const part = Buffer.concat([Buffer.from(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n--BoundaryString')]);
    assert.deepEqual(firstMjpegFrame(part), jpeg, 'by its Content-Length');
    assert.equal(firstMjpegFrame(part.subarray(0, part.length - 20)), undefined, 'not until the whole frame is there');
    assert.deepEqual(firstMjpegFrame(Buffer.concat([Buffer.from('--b\r\nContent-type: image/jpg\r\n'), jpeg])), jpeg, 'by its markers without a length');
});

/** A video stream like the agent's: one multipart JPEG part, then the connection stays open. */
async function startMjpeg(context: { after(fn: () => void): void }): Promise<string> {
    const frame = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#203040' } }).jpeg().toBuffer();
    const stream = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=BoundaryString' });
        response.write(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        response.write(frame);
    });
    await new Promise<void>((resolve) => stream.listen(0, '127.0.0.1', resolve));
    context.after(() => { stream.closeAllConnections(); stream.close(); });
    return `http://127.0.0.1:${(stream.address() as AddressInfo).port}`;
}

test('after a tree timeout the screenshot comes from the video stream, not from behind the tree walk', async (context) => {
    const wda = await startFakeWda({ treeDelayMs: 1_500 });
    context.after(() => wda.close());
    const driver = driverFor(wda.url, { mjpegUrl: await startMjpeg(context) });
    const snapshot = await driver.observe({ tree: true, treeTimeoutMs: 300 });
    assert.equal(snapshot.treeStatus, 'timeout');
    assert.deepEqual([snapshot.screenshot?.width, snapshot.screenshot?.height], [390, 844], 'scaled to points');
    const shot = await driver.screenshot();
    assert.deepEqual([shot.width, shot.height], [390, 844], 'a screenshot right after comes from the stream too');
    assert.ok(!wda.requests.some((entry) => entry.path === '/screenshot'), 'the agent was not asked for one');
});

test('tap resolves element ids, text and points, and posts a humanised absolute-actions tap inside the frame', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    await assert.rejects(driver.tap({ elementId: 'e2' }), DeviceDriverError);
    await driver.observe();
    const wifi = driver.snapshot!.elements.find((element) => element.label === 'Wi-Fi')!;
    const result = await driver.tap({ elementId: wifi.id });
    assert.ok(result.x >= wifi.frame.x && result.x <= wifi.frame.x + wifi.frame.width);
    assert.ok(result.y >= wifi.frame.y && result.y <= wifi.frame.y + wifi.frame.height);
    assert.notDeepEqual([result.x, result.y], [195, 216], 'not dead centre');
    const posted = wda.requests.filter((entry) => entry.path === '/wda/absolute-actions');
    assert.equal(posted.length, 1);
    const actions = (posted[0]!.body as { actions: Array<{ actions: Array<{ type: string; x?: number; y?: number; duration?: number }> }> }).actions[0]!.actions;
    assert.deepEqual(actions.map((action) => action.type), ['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
    assert.deepEqual([actions[0]!.x, actions[0]!.y], [result.x, result.y]);
    assert.ok(actions[2]!.duration! >= 60 && actions[2]!.duration! <= 140);

    const byText = await driver.tap({ text: 'airplane mode' });
    assert.ok(byText.element?.interactive, 'prefers an interactive match');
    await driver.tap({ x: 10, y: 10 });
    await assert.rejects(driver.tap({ x: 9999, y: 10 }), /outside/);
    await assert.rejects(driver.tap({ text: 'does not exist' }), /Nothing on screen/);
});

test('on the home screen a tap by text points the agent to open_app or the screenshot', async (context) => {
    const wda = await startFakeWda({ activeApp: { bundleId: 'com.apple.springboard', name: 'SpringBoard', pid: 1 } });
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    await driver.observe();
    await assert.rejects(driver.tap({ text: 'Files' }), /Use open_app, or tap the coordinates you read from the screenshot/);
});

test('swipe by direction produces a curved multi-segment path within the screen', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const result = await driver.scroll('down', 0.6);
    assert.ok(result.from.y > result.to.y, 'content scrolls down ⇒ finger moves up');
    const posted = wda.requests.filter((entry) => entry.path === '/wda/absolute-actions');
    const actions = (posted[0]!.body as { actions: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }> }).actions[0]!.actions;
    const moves = actions.filter((action) => action.type === 'pointerMove');
    assert.ok(moves.length >= 11);
    assert.ok(moves.every((move) => move.x! >= 1 && move.x! <= 389 && move.y! >= 1 && move.y! <= 843));
});

test('typeText goes through the session keys route in bursts; openApp/openUrl/home use the right routes', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    await driver.typeText('hello there friend', { submit: true });
    const keys = wda.requests.filter((entry) => entry.path.endsWith('/wda/keys'));
    assert.ok(keys.length >= 3, `bursts: ${keys.length}`);
    assert.ok(keys[0]!.path.startsWith('/session/s1/'), 'a bare session was created lazily');
    const typed = keys.map((entry) => (entry.body as { value: string[] }).value.join('')).join('');
    assert.equal(typed, 'hello there friend\n');
    assert.equal(wda.requests.filter((entry) => entry.path === '/session').length, 1, 'one session for the whole run');

    await driver.openApp('com.apple.mobilenotes');
    assert.equal(wda.state.activeApp.bundleId, 'com.apple.mobilenotes');
    assert.ok(wda.requests.some((entry) => entry.path.endsWith('/wda/apps/launch')));
    await driver.openApp('com.apple.mobilenotes');
    assert.ok(wda.requests.some((entry) => entry.path.endsWith('/wda/apps/activate')), 'a running app is activated, not relaunched');
    await driver.openApp('com.apple.mobilenotes', { args: ['-UITestMode', 'YES'], environment: { API_URL: 'http://127.0.0.1:9000' } });
    const launches = wda.requests.filter((entry) => entry.path.endsWith('/wda/apps/launch'));
    assert.deepEqual(launches.at(-1)!.body, {
        bundleId: 'com.apple.mobilenotes', shouldWaitForQuiescence: false,
        arguments: ['-UITestMode', 'YES'], environment: { API_URL: 'http://127.0.0.1:9000' },
    }, 'launch options reach the app, which is relaunched even though it was running');
    assert.ok(wda.requests.some((entry) => entry.path.endsWith('/wda/apps/terminate')));
    await driver.openUrl('https://example.com');
    assert.ok(wda.requests.some((entry) => entry.path.endsWith('/url')));
    await driver.home();
    assert.equal(wda.state.activeApp.bundleId, 'com.apple.springboard');
    assert.equal((await driver.state()).activeApp, null, 'SpringBoard reads as no app');
});

test('with TikTok in front nothing asks the agent for the app or its tree', async (context) => {
    // With TikTok in front, the front-app call alone hangs the agent.
    const wda = await startFakeWda({ activeApp: { bundleId: 'com.zhiliaoapp.musically', name: '', pid: 7 } });
    context.after(() => wda.close());
    const logs: string[] = [];
    const driver = driverFor(wda.url, { log: (line) => logs.push(line) });
    const state = await driver.state();
    assert.deepEqual([state.activeApp?.bundleId, state.activeApp?.name, state.alert], ['com.zhiliaoapp.musically', 'TikTok', null]);
    const snapshot = await driver.observe();
    assert.equal(snapshot.treeStatus, 'unavailable');
    assert.ok(snapshot.screenshot, 'a screenshot comes instead');
    await assert.rejects(driver.tap({ text: 'Profile' }), /cannot be read.*Take a screenshot/);
    await assert.rejects(driver.acceptAlert(), /TikTok is in front/);
    await driver.tap({ x: 372, y: 708 });
    const asked = wda.requests.map((entry) => entry.path.replace(/^\/session\/[^/]+/, ''));
    for (const forbidden of ['/wda/activeAppInfo', '/orientation', '/alert/text', '/source', '/alert/accept']) {
        assert.ok(!asked.includes(forbidden), `${forbidden} was asked`);
    }
    assert.ok(asked.includes('/wda/apps/state') && asked.includes('/wda/absolute-actions'));

    // Any other app is asked as before.
    wda.state.activeApp = { bundleId: 'com.apple.Preferences', name: 'Settings', pid: 42 };
    wda.requests.length = 0;
    assert.equal((await driverFor(wda.url).state()).activeApp?.name, 'Settings');
    assert.ok(wda.requests.some((entry) => entry.path === '/wda/activeAppInfo'));
});

test('a tap by coordinates takes a spread, and a feed flick runs from the thumb side', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const pointsOf = () => wda.requests.filter((entry) => entry.path === '/wda/absolute-actions')
        .map((entry) => (entry.body as { actions: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }> }).actions[0]!.actions.filter((action) => action.type === 'pointerMove'));
    for (let i = 0; i < 25; i += 1) await driver.tap({ x: 200, y: 400, spread: 10 });
    const taps = pointsOf().map((moves) => moves[0]!);
    assert.ok(taps.every((tap) => Math.abs(tap.x! - 200) <= 10 && Math.abs(tap.y! - 400) <= 10));
    assert.ok(new Set(taps.map((tap) => `${tap.x},${tap.y}`)).size > 12, 'they do not pile up on one point');

    wda.requests.length = 0;
    await driver.flickFeed('previous');
    const back = pointsOf()[0]!;
    assert.ok(back.at(-1)!.y! > back[0]!.y! + 250, 'back: the finger travels down the screen');
    assert.ok(Math.abs(back[0]!.x! - 195) > 15, 'on the thumb side, not down the middle');

    wda.requests.length = 0;
    await driver.flickFeed('next');
    const swipes = pointsOf();
    const last = swipes.at(-1)!;
    assert.ok(last.at(-1)!.y! < last[0]!.y! - 250, 'next: the finger travels up the screen');
    // A hesitant first flick springs back and is followed through: never more than two swipes.
    assert.ok(swipes.length >= 1 && swipes.length <= 2);
});

test('text is written by tapping one key per character, and what has no key is refused before any tap', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const taps = () => wda.requests.filter((entry) => entry.path === '/wda/absolute-actions')
        .map((entry) => (entry.body as { actions: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }> }).actions[0]!.actions.find((action) => action.type === 'pointerMove')!);
    assert.equal(await driver.tapKeys('navy blues'), 10);
    const landed = taps();
    assert.equal(landed.length, 10);
    // n sits in the bottom letter row, a in the middle one, the space bar under both.
    assert.ok(Math.abs(landed[0]!.x! - 271) <= 5 && Math.abs(landed[0]!.y! - 690) <= 5);
    assert.ok(Math.abs(landed[1]!.x! - 43) <= 5 && Math.abs(landed[1]!.y! - 635) <= 5);
    assert.ok(Math.abs(landed[4]!.x! - 195) <= 5 && Math.abs(landed[4]!.y! - 743) <= 5);

    wda.requests.length = 0;
    await assert.rejects(driver.tapKeys('Notes #1'), /No key for "N", "#", "1"/);
    assert.equal(taps().length, 0);

    const { keyPoints } = await import('../src/device/keyboard.js');
    assert.throws(() => keyPoints('a', { width: 375, height: 667 }), /has not been measured on a 375×667 screen/);
});

test('a phone that cannot open links says what to do instead', async (context) => {
    const wda = await startFakeWda({ cannotOpenLinks: true });
    context.after(() => wda.close());
    await assert.rejects(driverFor(wda.url).openUrl('https://ipinfo.io/json'), /cannot open a link directly\. Open the browser/);
    // Nothing is launched behind the caller's back: relaunching Safari with the link left it loading for ever.
    assert.ok(!wda.requests.some((entry) => entry.path.endsWith('/wda/apps/launch')));
});

test('unlock reads the keypad from the SpringBoard tree and taps the passcode', async (context) => {
    const wda = await startFakeWda({ locked: true, tree: lockScreenTree() });
    context.after(() => wda.close());
    const noPasscode = driverFor(wda.url);
    await assert.rejects(noPasscode.unlock(), /no passcode is registered/);
    const logs: string[] = [];
    const driver = driverFor(wda.url, { passcode: '2580', log: (line) => logs.push(line) });
    await driver.unlock();
    assert.equal(wda.state.locked, false);
    assert.ok(logs.some((line) => line.includes('keypad located via accessibility tree')), logs.join('\n'));
    // The attempt without a passcode wakes the phone and swipes up; only the single-point touches are digits.
    const taps = wda.requests.filter((entry) => entry.path === '/wda/absolute-actions'
        && (entry.body as { actions: Array<{ actions: Array<{ type: string }> }> }).actions[0]!.actions.filter((action) => action.type === 'pointerMove').length === 1);
    assert.equal(taps.length, 4);
    const tapped = taps.map((entry) => (entry.body as { actions: Array<{ actions: Array<{ x?: number; y?: number }> }> }).actions[0]!.actions[0]!);
    // '2' is the top-middle key (x≈160..230, y≈320..390), '0' the bottom key (x≈160..230, y≈620..690)
    assert.ok(tapped[0]!.x! >= 160 && tapped[0]!.x! <= 230 && tapped[0]!.y! >= 320 && tapped[0]!.y! <= 390, JSON.stringify(tapped[0]));
    assert.ok(tapped[3]!.y! >= 620 && tapped[3]!.y! <= 690, JSON.stringify(tapped[3]));
});

test('a second process joins the agent\'s running session instead of starting one, which would end a recording', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const first = driverFor(wda.url);
    await first.typeText('a');
    const second = driverFor(wda.url);
    await second.typeText('b');
    assert.equal(wda.requests.filter((entry) => entry.path === '/session').length, 1);
    assert.ok(wda.requests.filter((entry) => entry.path.endsWith('/wda/keys')).every((entry) => entry.path.startsWith('/session/s1/')));
});

test('dismiss presses the button that says no, never the one that leads somewhere', async (context) => {
    const wda = await startFakeWda({ alertText: 'Turn On Location Services to Allow “Weather” to Determine Your Location' });
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    // WDA's own dismiss presses "Settings" on this alert (iOS 26).
    assert.equal(await driver.dismissAlert(), 'Cancel');
    assert.deepEqual(wda.requests.filter((entry) => entry.path === '/alert/dismiss').at(-1)!.body, { name: 'Cancel' });
    assert.equal(await driver.acceptAlert('Settings'), 'Settings', 'a named button is pressed as asked');
    assert.equal(pickAlertButton(['Don’t Allow', 'Allow'], /^allow$/i), 'Allow');
    assert.equal(pickAlertButton(['Settings'], /^(cancel|not now)$/i), undefined);
});

test('on a phone\'s home screen the tree is not asked for: the screenshot comes instead', async (context) => {
    const wda = await startFakeWda({ activeApp: { bundleId: 'com.apple.springboard', name: 'SpringBoard', pid: 1 } });
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    const snapshot = await driver.observe();
    assert.equal(snapshot.state.activeApp, null);
    assert.equal(snapshot.treeStatus, 'skipped');
    assert.ok(snapshot.screenshot, 'the screenshot comes instead');
    assert.ok(!wda.requests.some((entry) => entry.path.startsWith('/source')), 'SpringBoard\'s slow tree was never requested');
    // Asked for with a budget, it is read.
    await driver.observe({ treeTimeoutMs: 5_000 });
    assert.ok(wda.requests.some((entry) => entry.path.startsWith('/source')));
});

test('the keyboard is dismissed and the phone locked through their own routes', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = driverFor(wda.url);
    await driver.dismissKeyboard();
    assert.ok(wda.requests.some((entry) => entry.path.endsWith('/wda/keyboard/dismiss')));
    await driver.pressButton('lock');
    assert.ok(wda.requests.some((entry) => entry.path === '/wda/lock'));
    assert.equal(wda.state.locked, true);
});
