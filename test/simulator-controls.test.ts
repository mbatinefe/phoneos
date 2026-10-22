import assert from 'node:assert/strict';
import test from 'node:test';

import { pushPayload, sendPush, setCleanStatusBar, setPermission } from '../src/device/simulator-controls.js';
import { DeviceDriver } from '../src/device/driver.js';
import { Humanizer } from '../src/humanize/humanizer.js';
import { startFakeWda } from './fake-wda.js';

test('a title and body become an alert payload; a payload of your own must carry "aps"', () => {
    assert.deepEqual(pushPayload({ title: 'Order shipped', body: 'Arrives Friday' }), { aps: { alert: { title: 'Order shipped', body: 'Arrives Friday' }, sound: 'default' } });
    assert.deepEqual(pushPayload({ payload: { aps: { badge: 3 }, orderId: 7 } }), { aps: { badge: 3 }, orderId: 7 });
    assert.throws(() => pushPayload({ payload: { orderId: 7 } }), /needs an "aps" object/);
    assert.throws(() => pushPayload({}), /title and\/or body/);
});

test('push, permissions and the status bar refuse a phone and say what works there', async () => {
    const phone = { udid: 'phone-1', kind: 'device' as const };
    await assert.rejects(sendPush(phone, 'com.example.app', { aps: { alert: 'x' } }), /only be sent to a simulator/);
    await assert.rejects(setPermission(phone, 'com.example.app', 'photos', 'grant'), /alert action=accept/);
    await assert.rejects(setCleanStatusBar(phone, true), /only be changed on a simulator/);
});

test('a simulated location is set, read back and cleared through the agent on the phone', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const driver = new DeviceDriver({ identity: { udid: 'fake-1', kind: 'device', name: 'Fake' }, wdaUrl: wda.url, humanizer: new Humanizer({ profile: 'precise', seed: 'loc' }) });
    assert.equal(await driver.client.simulatedLocation(), null);
    await driver.client.setSimulatedLocation(37.3349, -122.009);
    assert.deepEqual(await driver.client.simulatedLocation(), { latitude: 37.3349, longitude: -122.009 });
    await driver.client.clearSimulatedLocation();
    assert.equal(await driver.client.simulatedLocation(), null);
});
