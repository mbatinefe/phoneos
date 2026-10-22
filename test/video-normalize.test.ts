import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { normalizeVideo, normalizeVideoSchema, probeTags } from '../src/media/video-normalize.js';
import { readTags } from '../src/media/local-video.js';
import { tinyVideo } from './fixtures/tiny-video.js';

async function fixture(context: TestContext) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'phoneos-video-normalize-')));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'input video.mp4');
    await writeFile(input, tinyVideo);
    return { directory, input, output: path.join(directory, 'output video.mp4') };
}

test('schema fills defaults and rejects out-of-range or unknown options', () => {
    const parsed = normalizeVideoSchema.parse({ input_path: '/tmp/clip.mp4' });
    assert.equal(parsed.fps, 30);
    assert.equal(parsed.ensure_audio, true);
    assert.equal(parsed.quality, 18);
    for (const input of [{ fps: 0 }, { fps: 121 }, { fps: 29.97 }, { quality: 52 }, { quality: -1 }, { preset: 'slow' }, { ensure_audio: 'yes' }]) {
        assert.equal(normalizeVideoSchema.safeParse({ input_path: '/tmp/clip.mp4', ...input }).success, false, JSON.stringify(input));
    }
    assert.equal(normalizeVideoSchema.safeParse({ input_path: 'a\0b' }).success, false);
});

test('adds a silent audio track, retimes to the target rate and keeps the picture size', async (context) => {
    const { input, output } = await fixture(context);
    const before = probeTags((await readTags(input)).tags);
    assert.equal(before.hasAudio, false);

    const result = await normalizeVideo({ input_path: input, output_path: output, fps: 30 });
    assert.equal(result.verified, true);
    assert.equal(result.after.hasAudio, true);
    assert.ok(Math.abs(result.after.fps! - 30) < 0.05, `fps was ${result.after.fps}`);
    assert.equal(result.after.width, before.width);
    assert.equal(result.after.height, before.height);
    assert.equal(result.changed.length, 2, result.changed.join(' | '));
    assert.ok(result.changed.some((line) => line.includes('silent stereo AAC')));
    assert.ok(result.changed.some((line) => line.includes('30 fps')));
    // The source is never touched.
    assert.deepEqual(await readFile(input), tinyVideo);
});

test('copies streams without re-encoding when the input already conforms', async (context) => {
    const { directory, input, output } = await fixture(context);
    await normalizeVideo({ input_path: input, output_path: output, fps: 30 });
    const again = path.join(directory, 'again.mp4');
    const result = await normalizeVideo({ input_path: output, output_path: again, fps: 30 });
    assert.equal(result.verified, true);
    assert.deepEqual(result.changed, []);
    assert.ok(result.warnings.some((line) => line.includes('already conformed')));
    assert.equal(result.after.hasAudio, true);
});

test('leaves an existing audio track alone rather than replacing it', async (context) => {
    const { directory, input, output } = await fixture(context);
    await normalizeVideo({ input_path: input, output_path: output, fps: 30 });
    const kept = path.join(directory, 'kept.mp4');
    // Re-running at a new rate re-encodes the video but must not touch the audio.
    const result = await normalizeVideo({ input_path: output, output_path: kept, fps: 60 });
    assert.equal(result.changed.length, 1, result.changed.join(' | '));
    assert.ok(result.changed[0]!.includes('60 fps'));
    assert.equal(result.after.hasAudio, true);
});

test('inherits the never-overwrite safety model', async (context) => {
    const { directory, input, output } = await fixture(context);
    await assert.rejects(normalizeVideo({ input_path: input, output_path: input }), /must differ/);
    await writeFile(output, 'do not replace');
    await assert.rejects(normalizeVideo({ input_path: input, output_path: output }), /already exists/);
    assert.equal(await readFile(output, 'utf8'), 'do not replace');
    await assert.rejects(normalizeVideo({ input_path: input, output_path: path.join(directory, 'converted.mov') }), /keep the input extension/);
    await assert.rejects(normalizeVideo({ input_path: directory }), /regular video/);
    await assert.rejects(normalizeVideo({ input_path: path.join(directory, 'missing.mp4') }), /ENOENT/);
    const unsupported = path.join(directory, 'unsupported.avi');
    await writeFile(unsupported, tinyVideo);
    await assert.rejects(normalizeVideo({ input_path: unsupported }), /MP4, MOV and M4V only/);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.phoneos-video-normalize-')));
});

test('MCP exposes and executes normalize_video without resolving a phone', async (context) => {
    const { input, output } = await fixture(context);
    const { createPhoneosMcpServer } = await import('../src/agent-interface/mcp-server.js');
    const { server, tools } = await createPhoneosMcpServer({ plugins: [], recordDirectory: null, outputRoot: path.dirname(output) });
    tools.driver = async () => { throw new Error('Normalization must not use a phone driver'); };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'normalize-test', version: '0' });
    await client.connect(clientTransport);
    context.after(async () => { await client.close(); await server.close(); });
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'normalize_video');
    assert.ok(listed);
    assert.equal(listed.inputSchema.properties?.device, undefined);
    const result = await client.callTool({ name: 'normalize_video', arguments: { input_path: input, output_path: output } });
    assert.equal(result.isError, undefined);
    const blocks = result.content as Array<{ type: string; text: string }>;
    assert.equal(JSON.parse(blocks[0]!.text).after.hasAudio, true);
});
