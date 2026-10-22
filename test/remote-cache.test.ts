import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('DeviceFleet caches a driver per device and forget() rebuilds it from devices.json', async () => {
    const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-remote-')), 'devices.json');
    process.env.DEVICES_CONFIG_PATH = configPath;
    const write = (name: string, passcode: string) => writeFile(configPath, JSON.stringify([
        { name, udid: 'u1', passcode, wdaLocalPort: 8100, mjpegLocalPort: 9100, pluginData: {} },
    ]));

    await write('Phone', '1111');
    const { RegistryWdaRemoteControl } = await import('../src/devices/registry-remote.js');
    const remote = new RegistryWdaRemoteControl();

    const first = await remote.fleet.driver('u1');
    assert.equal(await remote.fleet.driver('u1'), first, 'same instance while cached');
    assert.equal(first.identity.name, 'Phone');
    assert.equal(first.client.baseUrl, 'http://127.0.0.1:8100');

    await write('Phone renamed', '2222');
    assert.equal(await remote.fleet.driver('u1'), first, 'still the stale instance until forgotten');

    remote.forget('u1');
    const rebuilt = await remote.fleet.driver('u1');
    assert.notEqual(rebuilt, first, 'rebuilt after forget()');
    assert.equal(rebuilt.identity.name, 'Phone renamed', 'picks up the new devices.json entry');
});

test('DeviceFleet.resolve accepts a udid, a unique prefix, or a name', async () => {
    const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-resolve-')), 'devices.json');
    process.env.DEVICES_CONFIG_PATH = configPath;
    await writeFile(configPath, JSON.stringify([
        { name: 'Alpha', udid: '00008030-AAAA', pluginData: {} },
        { name: 'Beta', udid: '00008030-BBBB', pluginData: {} },
    ]));
    const { DeviceFleet } = await import('../src/device/fleet.js');
    const fleet = new DeviceFleet();
    assert.equal((await fleet.resolve('00008030-BBBB')).name, 'Beta');
    assert.equal((await fleet.resolve('00008030-a')).name, 'Alpha');
    assert.equal((await fleet.resolve('beta')).name, 'Beta');
    await assert.rejects(fleet.resolve('00008030'), /matches several/);
    await assert.rejects(fleet.resolve('nope'), /No registered device/);
});
