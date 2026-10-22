import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { addVideoMetadata, addVideoMetadataSchema, videoMetadataTags } from '../src/media/video-metadata.js';
import { tinyVideo } from './fixtures/tiny-video.js';

const execFileAsync = promisify(execFile);
const exiftool = createRequire(import.meta.url)('exiftool-vendored.pl') as string;

async function fixture(context: TestContext) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'phoneos-video-metadata-')));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'input video.mp4');
    await writeFile(input, tinyVideo);
    return { directory, input, output: path.join(directory, 'output video.mp4') };
}

async function inspect(file: string): Promise<Record<string, unknown>> {
    const { stdout } = await execFileAsync('perl', [exiftool, '-config', '', '-j', '-G1', '-s', '-n', file]);
    return (JSON.parse(stdout) as Array<Record<string, unknown>>)[0]!;
}

// Compare encoded media payload, not file hashes (container metadata changes).
function mediaPayload(file: Buffer): Buffer {
    const payloads: Buffer[] = [];
    for (let at = 0; at + 8 <= file.length;) {
        let length = file.readUInt32BE(at), header = 8;
        if (length === 1) { length = Number(file.readBigUInt64BE(at + 8)); header = 16; }
        if (length === 0) length = file.length - at;
        assert.ok(length >= header && at + length <= file.length);
        if (file.toString('ascii', at + 4, at + 8) === 'mdat') payloads.push(file.subarray(at + header, at + length));
        at += length;
    }
    assert.ok(payloads.length > 0);
    return Buffer.concat(payloads);
}

test('metadata schema rejects empty/unknown fields, invalid dates, coordinates and NULs', () => {
    const valid = { input_path: '/tmp/clip.mp4', metadata: { title: 'Clip' } };
    assert.equal(addVideoMetadataSchema.safeParse(valid).success, true);
    for (const metadata of [{}, { title: '' }, { title: ' ' }, { title: 'a\0b' }, { fps: 30 }, { make: 'Apple', preset: 'iphone' }, { creation_time: '2026-09-18T12:00:00' }, { creation_time: '2026-02-30T12:00:00Z' }, { creation_time: 'yesterday' }, { location: { latitude: 91, longitude: 0 } }, { location: { latitude: 0, longitude: -181 } }, { location: { latitude: 0 } }]) {
        assert.equal(addVideoMetadataSchema.safeParse({ ...valid, metadata }).success, false, JSON.stringify(metadata));
    }
    assert.equal(addVideoMetadataSchema.safeParse({ ...valid, overwrite: true }).success, false);
    assert.equal(addVideoMetadataSchema.safeParse({ ...valid, input_path: 'a\0b' }).success, false);
});

test('tag allowlist leaves shell-like strings literal and does not invent device, time or GPS', () => {
    const title = '$(touch /tmp/no) `id` -all= <file> "quotes"';
    assert.deepEqual(videoMetadataTags({ title }), { 'Keys:Title': title });
    assert.deepEqual(videoMetadataTags({ location: { latitude: 0, longitude: 0, altitude: 0 } }), { 'Keys:GPSCoordinates': '0.00000 0.00000 0.00' });
});

test('real ExifTool round trip verifies all options, preserves source and encoded video', async (context) => {
    const { input, output, directory } = await fixture(context);
    const metadata = {
        make: 'Apple', model: 'iPhone test fixture', software: 'phoneos test',
        title: 'Cherry 🍒 — $(not-a-command)', description: 'Synthetic test fixture, not camera provenance',
        author: 'Test author', copyright: 'Test copyright', comment: 'Two frames\nNo audio',
        creation_time: '2026-09-18T12:00:00+09:00',
        location: { latitude: -33.865143, longitude: 151.2099, altitude: -5.25 },
    };
    const result = await addVideoMetadata({ input_path: input, output_path: output, metadata });
    assert.equal(result.verified, true);
    assert.equal(result.output_path, output);
    assert.equal(result.readback['Keys:Make'], 'Apple');
    assert.equal(result.readback['Keys:Title'], metadata.title);
    assert.deepEqual(await readFile(input), tinyVideo);
    const edited = await readFile(output);
    assert.notDeepEqual(edited, tinyVideo);
    assert.deepEqual(mediaPayload(edited), mediaPayload(tinyVideo));
    const before = await inspect(input), after = await inspect(output);
    for (const key of ['QuickTime:Duration', 'Track1:ImageWidth', 'Track1:ImageHeight', 'Track1:VideoFrameRate', 'Track1:CompressorID']) assert.equal(after[key], before[key], key);
    assert.equal(after['Track1:ImageWidth'], 16);
    assert.equal(after['Track1:VideoFrameRate'], 24);
    assert.deepEqual((await readdir(directory)).sort(), ['input video.mp4', 'output video.mp4']);
});

test('default output is a new sibling; omitted tags remain and GPS zero is valid', async (context) => {
    const { input, directory } = await fixture(context);
    const first = await addVideoMetadata({ input_path: input, metadata: { author: 'Existing author', location: { latitude: 0, longitude: 0, altitude: 0 } } });
    assert.equal(first.output_path, path.join(directory, 'input video.metadata.mp4'));
    const second = await addVideoMetadata({ input_path: first.output_path, metadata: { title: 'Second edit' } });
    const saved = await inspect(second.output_path);
    assert.equal(saved['Keys:Author'], 'Existing author');
    assert.equal(saved['Keys:GPSCoordinates'], '0 0 0');
    assert.equal(saved['Keys:Title'], 'Second edit');
    assert.equal(saved['Keys:Make'], undefined);
});

test('refuses overwrite, same file, symlinks, invalid containers and format changes', async (context) => {
    const { input, output, directory } = await fixture(context);
    const metadata = { title: 'Test' };
    await assert.rejects(addVideoMetadata({ input_path: input, output_path: input, metadata }), /must differ/);
    await writeFile(output, 'do not replace');
    await assert.rejects(addVideoMetadata({ input_path: input, output_path: output, metadata }), /already exists/);
    assert.equal(await readFile(output, 'utf8'), 'do not replace');
    const alias = path.join(directory, 'alias.mp4');
    await symlink(input, alias);
    await assert.rejects(addVideoMetadata({ input_path: input, output_path: alias, metadata }), /already exists/);
    await assert.rejects(addVideoMetadata({ input_path: input, output_path: path.join(directory, 'converted.mov'), metadata }), /keep the input extension/);
    await assert.rejects(addVideoMetadata({ input_path: directory, metadata }), /regular video/);
    await assert.rejects(addVideoMetadata({ input_path: path.join(directory, 'missing.mp4'), metadata }), /ENOENT/);
    const fake = path.join(directory, 'fake.mp4');
    await writeFile(fake, 'This is not a video');
    await assert.rejects(addVideoMetadata({ input_path: fake, metadata }), /metadata|video track/);
    const unsupported = path.join(directory, 'unsupported.avi');
    await writeFile(unsupported, tinyVideo);
    await assert.rejects(addVideoMetadata({ input_path: unsupported, metadata }), /MP4, MOV and M4V only/);
    assert.deepEqual(await readFile(input), tinyVideo);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.phoneos-video-metadata-') || name === 'fake.metadata.mp4'));
});

test('concurrent writes never replace an existing output and clean staging files', async (context) => {
    const { input, output, directory } = await fixture(context);
    const results = await Promise.allSettled(['First', 'Second'].map((title) => addVideoMetadata({ input_path: input, output_path: output, metadata: { title } })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.ok(['First', 'Second'].includes(String((await inspect(output))['Keys:Title'])));
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.phoneos-video-metadata-')));
});

test('CLI writes metadata without a device and rejects bad JSON', async (context) => {
    const { input, output, directory } = await fixture(context);
    const options = { cwd: path.resolve('.'), env: { ...process.env, DEVICES_CONFIG_PATH: path.join(directory, 'absent-devices.json') } };
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/agent-interface/cli.ts', 'video-metadata', input, '--metadata', '{"title":"CLI test"}', '-o', output], options);
    assert.equal(JSON.parse(stdout).readback['Keys:Title'], 'CLI test');
    await assert.rejects(execFileAsync(process.execPath, ['--import', 'tsx', 'src/agent-interface/cli.ts', 'video-metadata', input, '--metadata', '{invalid}'], options), /must be valid JSON/);
});

test('MCP exposes and executes add_video_metadata without resolving a phone', async (context) => {
    const { input, output } = await fixture(context);
    const { createPhoneosMcpServer } = await import('../src/agent-interface/mcp-server.js');
    // The agent may write only inside the server's folder: here, the test's own.
    const { server, tools } = await createPhoneosMcpServer({ plugins: [], recordDirectory: null, outputRoot: path.dirname(output) });
    tools.driver = async () => { throw new Error('Metadata must not use a phone driver'); };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'metadata-test', version: '0' });
    await client.connect(clientTransport);
    context.after(async () => { await client.close(); await server.close(); });
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'add_video_metadata');
    assert.ok(listed);
    assert.ok(listed.inputSchema.properties?.metadata);
    assert.equal(listed.inputSchema.properties?.device, undefined);
    const result = await client.callTool({ name: 'add_video_metadata', arguments: { input_path: input, output_path: output, metadata: { title: 'MCP test' } } });
    assert.equal(result.isError, undefined);
    const blocks = result.content as Array<{ type: string; text: string }>;
    assert.equal(JSON.parse(blocks[0]!.text).readback['Keys:Title'], 'MCP test');
    const bad = await client.callTool({ name: 'add_video_metadata', arguments: { input_path: input, metadata: { fps: 60 } } });
    assert.equal(bad.isError, true);
    const outside = await client.callTool({ name: 'add_video_metadata', arguments: { input_path: input, output_path: path.join(os.tmpdir(), 'phoneos-elsewhere.mp4'), metadata: { title: 'x' } } });
    assert.equal(outside.isError, true);
    assert.match((outside.content as Array<{ text: string }>)[0]!.text, /can only be written inside/);
});

test('an XMP date left by an editor does not fail an otherwise good write', async (context) => {
    const { input, output } = await fixture(context);
    // Editors routinely leave XMP-xmp:CreateDate behind. It is not a tag this tool
    // writes, so verification must ignore it rather than compare against it.
    await execFileAsync('perl', [exiftool, '-config', '', '-overwrite_original', '-XMP:CreateDate=2020:01:01 00:00:00', input]);
    const result = await addVideoMetadata({ input_path: input, output_path: output, metadata: { creation_time: '2026-09-18T12:00:00+09:00' } });
    assert.equal(result.verified, true);
    assert.equal(result.readback['XMP-xmp:CreateDate'], undefined);
    const tags = await inspect(output);
    assert.equal(tags['Keys:CreationDate'], '2026:09:18 12:00:00+09:00');
    assert.equal(tags['XMP-xmp:CreateDate'], '2020:01:01 00:00:00'); // untouched
});

test('a millisecond timestamp is accepted and stored to the whole second', async (context) => {
    const { input, output } = await fixture(context);
    assert.equal(videoMetadataTags({ creation_time: '2026-09-18T09:00:00.500+09:00' })['Keys:CreationDate'], '2026-09-18T09:00:00+09:00');
    // Exactly what `new Date().toISOString()` produces, which a caller reaches for first.
    const result = await addVideoMetadata({ input_path: input, output_path: output, metadata: { creation_time: '2026-09-18T07:27:24.338Z' } });
    assert.equal(result.verified, true);
    assert.equal(result.written_tags['Keys:CreationDate'], '2026-09-18T07:27:24Z');
    const stored = String(result.readback['Keys:CreationDate']).replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T');
    assert.equal(Date.parse(stored), Date.parse('2026-09-18T07:27:24Z'));
});
