import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DeviceDriver } from '../src/device/driver.js';
import { DeviceFleet } from '../src/device/fleet.js';
import { AgentTools } from '../src/agent-interface/tools.js';
import { Humanizer } from '../src/humanize/humanizer.js';
import { startFakeWda } from './fake-wda.js';

async function fleetFor(url: string): Promise<{ tools: AgentTools; udid: string }> {
    const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-cap-')), 'devices.json');
    const port = Number(new URL(url).port);
    await writeFile(configPath, JSON.stringify([{ name: 'Fake', udid: 'fake-cap', wdaLocalPort: port, mjpegLocalPort: port + 1000, pluginData: {} }]));
    const fleet = new DeviceFleet({ loadDevices: async () => JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8')), discover: async () => [] });
    return { tools: new AgentTools({ fleet, plugins: [], recordDirectory: null }), udid: 'fake-cap' };
}

test('clipboard round-trips text, urls and images through WDA', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const { tools, udid } = await fleetFor(wda.url);
    assert.match((await tools.getClipboard(udid)).text, /empty/);
    await tools.setClipboard(udid, { text: 'hello 🚀' });
    assert.match((await tools.getClipboard(udid)).text, /text: "hello 🚀"/);
    await tools.setClipboard(udid, { url: 'https://example.com/a' });
    assert.match((await tools.getClipboard(udid)).text, /url: https:\/\/example.com\/a/);
    const image = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-clip-')), 'pic.png');
    await writeFile(image, Buffer.from([1, 2, 3]));
    await tools.setClipboard(udid, { imagePath: image });
    assert.match((await tools.getClipboard(udid)).text, /an image/);
    assert.equal(wda.state.pasteboard.image, Buffer.from([1, 2, 3]).toString('base64'));
    await assert.rejects(tools.setClipboard(udid, { imagePath: '/x/doc.pdf' }), /jpg\/png/);
});

test('appearance, rotation and pinch reach the right WDA routes and refresh geometry', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const { tools, udid } = await fleetFor(wda.url);
    await tools.setAppearance(udid, 'dark');
    assert.equal(wda.state.appearance, 'dark');
    const rotated = await tools.rotate(udid, 'landscape');
    assert.match(rotated.text, /844×390pt @3x landscape/);
    await tools.rotate(udid, 'portrait');
    await tools.pinch(udid, { scale: 2 });
    const pinch = wda.requests.find((entry) => entry.path.endsWith('/wda/pinch'));
    assert.deepEqual(pinch?.body, { scale: 2, velocity: 1 });
});

test('wait_for polls until text appears or disappears and never throws on timeout', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const { tools, udid } = await fleetFor(wda.url);
    const found = await tools.waitFor(udid, { text: 'Wi-Fi', timeoutMs: 3_000 });
    assert.match(found.text, /"Wi-Fi" appeared after/);
    const missing = await tools.waitFor(udid, { text: 'Nope', timeoutMs: 1_200, intervalMs: 300 });
    assert.match(missing.text, /did not appear within 1s/);
    setTimeout(() => { wda.state.tree = { type: 'Application', children: [] }; }, 600);
    const gone = await tools.waitFor(udid, { text: 'Wi-Fi', gone: true, timeoutMs: 5_000, intervalMs: 300 });
    assert.match(gone.text, /"Wi-Fi" is gone/);
});

test('recording start/stop uses the XCTest routes and remembers the active id on disk', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    process.env.PHONEOS_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'phoneos-rec-'));
    const driver = new DeviceDriver({ identity: { udid: 'fake-rec', kind: 'device', name: 'Fake' }, wdaUrl: wda.url, humanizer: new Humanizer({ profile: 'precise' }) });
    const info = await driver.startRecording({ fps: 12 });
    assert.equal(info.uuid, 'REC-1');
    assert.equal(wda.state.recording?.fps, 12);
    assert.equal((await driver.activeRecording())?.uuid, 'REC-1');
    // Stopping on a "device" runs devicectl, which cannot succeed here — the stop route must still have been called and the state cleared.
    await assert.rejects(driver.stopRecording(path.join(process.env.PHONEOS_STATE_DIR, 'out.mov')), /Could not pull recording REC-1/);
    assert.equal(wda.state.recording, null);
    assert.equal(await driver.activeRecording(), undefined);
});

test('fleet health reports battery, thermal, lock and warnings per device', async (context) => {
    const wda = await startFakeWda({ locked: true });
    context.after(() => wda.close());
    const { deviceHealth, renderHealth } = await import('../src/device/health.js');
    const port = Number(new URL(wda.url).port);
    const registered = { name: 'Fake', udid: 'fake-health', wdaLocalPort: port, mjpegLocalPort: port + 1000, pluginData: {} };
    const fleet = new DeviceFleet({ loadDevices: async () => [registered], discover: async () => [{ udid: 'fake-health', kind: 'device', name: 'Fake', osVersion: '17.0' }] });
    const [entry] = await fleet.list();
    const health = await deviceHealth(fleet, entry!, { udid: 'fake-health', physical: 'connected', wda: 'ready', managed: true, message: 'WDA is ready', retryCount: 4, updatedAt: '' });
    assert.equal(health.wda, 'ready');
    assert.equal(health.thermal, 'serious');
    assert.equal(health.locked, true);
    assert.deepEqual(health.battery, { level: 0.8, state: 'charging' });
    assert.ok(health.warnings.includes('thermal state serious'));
    // A sleeping phone we hold the passcode for is healthy; without one it cannot wake itself.
    assert.ok(health.warnings.some((warning) => /cannot unlock itself/.test(warning)), health.warnings.join('; '));
    assert.ok(health.warnings.includes('WDA restarted 4 times'));

    const withPasscode = await deviceHealth(
        new DeviceFleet({ loadDevices: async () => [{ ...registered, passcode: '0000' }], discover: async () => [{ udid: 'fake-health', kind: 'device', name: 'Fake', osVersion: '17.0' }] }),
        { ...entry!, registered: { ...registered, passcode: '0000' } },
    );
    assert.ok(!withPasscode.warnings.some((warning) => /unlock itself/.test(warning)), 'no lock warning when the passcode is known');
    assert.match(renderHealth(health), /battery=80% charging · thermal=serious/);

    const offline = await deviceHealth(fleet, { ...entry!, present: false, ready: false });
    assert.deepEqual(offline.warnings, ['not connected over USB']);
});
