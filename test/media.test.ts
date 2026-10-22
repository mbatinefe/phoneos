import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { addToPhotos, documentsPath, freePath, mediaMimeType, refuseExisting } from '../src/device/media.js';
import { WdaClient } from '../src/device/wda-client.js';
import { startFakeWda } from './fake-wda.js';

test('mediaMimeType recognises images and videos only', () => {
    assert.equal(mediaMimeType('/x/a.JPG'), 'image/jpeg');
    assert.equal(mediaMimeType('clip.mov'), 'video/quicktime');
    assert.equal(mediaMimeType('report.pdf'), undefined);
});

test('addToPhotos refuses documents and missing files, and imports through the patched WDA route on devices', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const directory = await mkdtemp(path.join(os.tmpdir(), 'phoneos-media-'));
    const image = path.join(directory, 'shot.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = new WdaClient({ baseUrl: wda.url });
    const target = { udid: 'fake-1', kind: 'device' as const, client };

    await assert.rejects(addToPhotos(target, [path.join(directory, 'doc.pdf')]), /images and videos only/);
    await assert.rejects(addToPhotos(target, [path.join(directory, 'missing.png')]), /File not found/);
    await assert.rejects(addToPhotos(target, []), /at least one/);

    // Fake WDA has no /wda/import-media route → the error surfaces, proving the request was made with the right shape.
    await assert.rejects(addToPhotos(target, [image]), /import-media/);
    const request = wda.requests.find((entry) => entry.path === '/wda/import-media');
    assert.ok(request);
    assert.deepEqual(Object.keys(request!.body as object).sort(), ['data', 'mimeType', 'name']);
    assert.equal((request!.body as { mimeType: string }).mimeType, 'image/png');
    assert.equal((request!.body as { data: string }).data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
});

test('a path inside an app\'s Documents stays inside it', () => {
    assert.equal(documentsPath('reports/q3.pdf'), 'reports/q3.pdf');
    assert.equal(documentsPath('/Documents/reports/'), 'reports');
    assert.equal(documentsPath('a/../b.txt'), 'b.txt');
    assert.equal(documentsPath(''), '');
    for (const climbing of ['..', '../x', 'a/../../x', '..\\..\\Library']) {
        assert.throws(() => documentsPath(climbing), /leaves the app's Documents folder/, climbing);
    }
});

test('pulled files get a free name instead of replacing one', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'phoneos-free-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const first = path.join(directory, 'IMG_0001.JPG');
    assert.equal(freePath(first), first);
    await writeFile(first, 'a');
    assert.equal(freePath(first), path.join(directory, 'IMG_0001-2.JPG'));
    await writeFile(path.join(directory, 'IMG_0001-2.JPG'), 'b');
    assert.equal(freePath(first), path.join(directory, 'IMG_0001-3.JPG'));
    assert.throws(() => refuseExisting(first), /already exists/);
});
