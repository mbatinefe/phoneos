import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureWdaSource } from '../src/devices/wda/source.js';

/** A tarball laid out like the npm release: everything under `package/`. */
async function releaseTarball(dir: string): Promise<Buffer> {
    await mkdir(path.join(dir, 'package/WebDriverAgent.xcodeproj'), { recursive: true });
    await writeFile(path.join(dir, 'package/WebDriverAgent.xcodeproj/project.pbxproj'), '// fake project\n');
    execFileSync('tar', ['-czf', path.join(dir, 'release.tgz'), '-C', dir, 'package']);
    return readFile(path.join(dir, 'release.tgz'));
}

function integrityOf(bytes: Buffer): string {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function serving(bytes: Buffer, calls: string[] = []): typeof fetch {
    return (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
}

test('unpacks a release whose checksum matches the pin', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wda-source-'));
    const tarball = await releaseTarball(dir);
    const root = path.join(dir, '.wda/webdriveragent');
    await ensureWdaSource(root, { url: 'https://registry.example/wda.tgz', integrity: integrityOf(tarball), fetchImpl: serving(tarball) });
    assert.equal(await readFile(path.join(root, 'WebDriverAgent.xcodeproj/project.pbxproj'), 'utf8'), '// fake project\n');
});

test('refuses a download that does not match the pin and leaves nothing behind', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wda-source-'));
    const tarball = await releaseTarball(dir);
    const root = path.join(dir, '.wda/webdriveragent');
    await assert.rejects(
        ensureWdaSource(root, { integrity: integrityOf(Buffer.from('the real release')), fetchImpl: serving(tarball) }),
        /does not match its pinned checksum/,
    );
    assert.equal(existsSync(root), false);
});

test('does not download again when the project is already there', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wda-source-'));
    const root = path.join(dir, 'webdriveragent');
    await mkdir(path.join(root, 'WebDriverAgent.xcodeproj'), { recursive: true });
    const calls: string[] = [];
    await ensureWdaSource(root, { fetchImpl: serving(Buffer.alloc(0), calls) });
    assert.deepEqual(calls, []);
});
