import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listInstalledApps } from '../src/device/apps.js';

test('a simulator udid reaches simctl as one argument and is never run by a shell', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'phoneos-apps-'));
    const originalPath = process.env.PATH;
    context.after(async () => {
        process.env.PATH = originalPath;
        await rm(directory, { recursive: true, force: true });
    });
    const marker = path.join(directory, 'ran');
    const argsFile = path.join(directory, 'args');
    // A stand-in for xcrun: records its last argument and prints what `simctl listapps` prints.
    await writeFile(path.join(directory, 'xcrun'), [
        '#!/bin/sh',
        `for last; do :; done; printf '%s' "$last" > '${argsFile}'`,
        `printf '%s' '{ "com.example.app" = { ApplicationType = User; CFBundleName = "Example"; }; "com.apple.Maps" = { ApplicationType = System; }; }'`,
    ].join('\n'));
    await chmod(path.join(directory, 'xcrun'), 0o755);
    process.env.PATH = `${directory}:${originalPath}`;

    const udid = `$(touch ${marker})`;
    const apps = await listInstalledApps(udid, 'simulator');

    assert.deepEqual(apps, [{ bundleId: 'com.example.app', name: 'Example' }]);
    assert.equal(await readFile(argsFile, 'utf8'), udid);
    assert.equal(existsSync(marker), false, 'the $(…) in the udid must not have run');
});
