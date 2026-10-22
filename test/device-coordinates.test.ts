import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolvePoint } from '../src/device/points.js';
import type { PhoneosPlugin } from '../src/plugin.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-coords-')), 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
const seed = () => writeFile(configPath, JSON.stringify([{ name: 'Phone', udid: 'u1', wdaLocalPort: 65001, mjpegLocalPort: 65002, pluginData: {} }]));
const onDisk = async () => JSON.parse(await readFile(configPath, 'utf8')) as Array<{ coordinates?: Record<string, unknown> }>;

const scheduler = { async activeExecution() { return null; }, async listSchedules() { return []; } } as unknown as SchedulerRepository;

// A pack for an app whose like button is drawn, not an element.
const videoPack: PhoneosPlugin = {
    id: 'com.example.video', version: '1.0.0', displayName: 'Video', shortId: 'video', tasks: [],
    points: { like: { fx: 0.92, fy: 0.469, label: 'Like button' } },
};

test('a pack\'s named point scales to the screen, and a device override wins', () => {
    assert.deepEqual(resolvePoint(videoPack, 'like', { width: 390, height: 844 }), { x: 359, y: 396 });
    assert.deepEqual(resolvePoint(videoPack, 'like', { width: 390, height: 844 }, { 'video.like': { x: 350, y: 320 } }), { x: 350, y: 320 });
    assert.deepEqual(resolvePoint(videoPack, 'like', { width: 390, height: 844 }, { like: { x: 1, y: 1 } }), { x: 359, y: 396 }, 'only the pack-qualified name overrides');
    assert.throws(() => resolvePoint(videoPack, 'share', { width: 390, height: 844 }), /no point named "share"/);
});

test('named points: GET lists every pack\'s points, PATCH stores and clears overrides', async (context) => {
    await seed();
    const { createApp } = await import('../src/api/app.js');
    const app = await createApp({ plugins: new PluginRegistry([videoPack]), scheduler });
    context.after(() => app.close());

    const list = await inject(app, { method: 'GET', url: '/api/devices/u1/coordinates' });
    assert.equal(list.statusCode, 200);
    // No WDA on that port → a 390×844 screen, and the fractions scale to it.
    assert.deepEqual(list.json().screenSize, { width: 390, height: 844 });
    const like = list.json().points.find((p: { key: string }) => p.key === 'video.like');
    assert.equal(like.pack, 'Video');
    assert.equal(like.overridden, false);
    assert.deepEqual(like.current, like.default);
    assert.deepEqual(like.default, { x: Math.round(0.92 * 390), y: Math.round(0.469 * 844) });

    const set = await inject(app, {
        method: 'PATCH', url: '/api/devices/u1',
        payload: { coordinates: { 'video.like': { x: 350, y: 320 } } }, headers: { 'content-type': 'application/json' },
    });
    assert.equal(set.statusCode, 200);
    assert.deepEqual((await onDisk())[0]!.coordinates, { 'video.like': { x: 350, y: 320 } });

    const after = await inject(app, { method: 'GET', url: '/api/devices/u1/coordinates' });
    const like2 = after.json().points.find((p: { key: string }) => p.key === 'video.like');
    assert.equal(like2.overridden, true);
    assert.deepEqual(like2.current, { x: 350, y: 320 });

    const bad = await inject(app, {
        method: 'PATCH', url: '/api/devices/u1',
        payload: { coordinates: { 'video.like': { x: -1, y: 20 } } }, headers: { 'content-type': 'application/json' },
    });
    assert.equal(bad.statusCode, 400);
    const badName = await inject(app, {
        method: 'PATCH', url: '/api/devices/u1',
        payload: { coordinates: { '../x': { x: 1, y: 2 } } }, headers: { 'content-type': 'application/json' },
    });
    assert.equal(badName.statusCode, 400);

    const clear = await inject(app, {
        method: 'PATCH', url: '/api/devices/u1',
        payload: { coordinates: {} }, headers: { 'content-type': 'application/json' },
    });
    assert.equal(clear.statusCode, 200);
    assert.equal((await onDisk())[0]!.coordinates, undefined);
});
