import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBuildTargets, resolveTarget } from '../src/devices/wda/target-device.js';

const resolveTargetUdid = async (options: Parameters<typeof resolveTarget>[0]) => (await resolveTarget(options)).udid;

const none = async () => [];
const base = { env: {} as NodeJS.ProcessEnv, loadRegistered: none, loadConnected: none };

test('resolveTarget: an explicit --udid wins over everything', async () => {
    assert.equal(await resolveTargetUdid({
        ...base, argv: ['node', 's', '--udid', 'CLI'], env: { IOS_UDID: 'ENV' },
    }), 'CLI');
    assert.equal(await resolveTargetUdid({ ...base, argv: ['node', 's', '--udid=INLINE'] }), 'INLINE');
});

test('resolveTarget: env, then the sole registered, then the sole connected', async () => {
    assert.equal(await resolveTargetUdid({ ...base, argv: ['n', 's'], env: { IOS_UDID: 'ENV' } }), 'ENV');
    assert.equal(await resolveTargetUdid({
        ...base, argv: ['n', 's'], loadRegistered: async () => [{ udid: 'REG', name: 'Phone' }],
    }), 'REG');
    assert.equal(await resolveTargetUdid({
        ...base, argv: ['n', 's'], loadConnected: async () => [{ udid: 'CONN', kind: 'device' as const }],
    }), 'CONN');
});

test('resolveTarget: ambiguous or empty throws with guidance', async () => {
    await assert.rejects(resolveTargetUdid({
        ...base, argv: ['n', 's'], loadRegistered: async () => [{ udid: 'a', name: 'A' }, { udid: 'b', name: 'B' }],
    }), /pass --udid/);
    await assert.rejects(resolveTargetUdid({
        ...base, argv: ['n', 's'], loadConnected: async () => [{ udid: 'x', kind: 'device' as const }, { udid: 'y', kind: 'device' as const }],
    }), /pass --udid/);
    await assert.rejects(resolveTargetUdid({ ...base, argv: ['n', 's'] }), /No target device/);
    await assert.rejects(resolveTargetUdid({ ...base, argv: ['n', 's', '--udid'] }), /--udid needs a device UDID/);
});

test('resolveBuildTargets: --all lists devices.json, otherwise one target', async () => {
    assert.deepEqual(await resolveBuildTargets({
        ...base, argv: ['n', 's', '--all'],
        loadRegistered: async () => [{ udid: 'a', name: 'A' }, { udid: 'b', name: 'B', kind: 'simulator' as const }],
    }), [{ udid: 'a', kind: 'device' }, { udid: 'b', kind: 'simulator' }]);
    assert.deepEqual(await resolveBuildTargets({ ...base, argv: ['n', 's', '--udid', 'z'] }), [{ udid: 'z', kind: 'device' }]);
    assert.deepEqual(await resolveBuildTargets({ ...base, argv: ['n', 's', '--udid', 'z', '--sim'] }), [{ udid: 'z', kind: 'simulator' }]);
    await assert.rejects(resolveBuildTargets({ ...base, argv: ['n', 's', '--all'] }), /--all was given/);
});
