import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { settingsPack } from '../apps/settings/pack.js';
import { startFakeWda } from './fake-wda.js';

type ToolText = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

test('MCP server exposes the phone tools, pack macros, guides, and drives the fake WDA', async (context) => {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-mcp-')), 'devices.json');
    process.env.DEVICES_CONFIG_PATH = configPath;
    const port = Number(new URL(wda.url).port);
    await writeFile(configPath, JSON.stringify([{ name: 'Fake', udid: 'fake-1', wdaLocalPort: port, mjpegLocalPort: port + 1000, pluginData: {} }]));

    const { createPhoneosMcpServer } = await import('../src/agent-interface/mcp-server.js');
    const { server } = await createPhoneosMcpServer({ plugins: [settingsPack], recordDirectory: null });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
    context.after(() => client.close());

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const expected of ['list_devices', 'fleet_status', 'observe', 'tap', 'tap_keys', 'swipe', 'scroll', 'type_text', 'open_app', 'press_button', 'unlock', 'add_to_photos', 'add_file', 'list_files', 'get_photos', 'get_file', 'wait_for', 'start_recording', 'stop_recording', 'set_clipboard', 'get_clipboard', 'set_appearance', 'rotate', 'pinch', 'install_app', 'uninstall_app', 'flick_feed', 'settings_open', 'settings_about']) {
        assert.ok(names.includes(expected), `tool ${expected} registered (have ${names.join(', ')})`);
    }
    const tapSchema = tools.tools.find((tool) => tool.name === 'tap')!.inputSchema as { properties: Record<string, unknown> };
    assert.ok('element_id' in tapSchema.properties && 'x' in tapSchema.properties && 'text' in tapSchema.properties);

    for (const tool of tools.tools.filter((entry) => entry.name.startsWith('settings_'))) {
        assert.ok('device' in (tool.inputSchema as { properties: Record<string, unknown> }).properties, `${tool.name} takes a device`);
    }

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === 'phoneos://agents-md'));
    const guide = await client.readResource({ uri: 'phoneos://guide/settings' });
    assert.match(String((guide.contents[0] as { text: string }).text), /^# Settings/);

    const observed = await client.callTool({ name: 'observe', arguments: { device: 'fake-1' } }) as ToolText;
    assert.equal(observed.isError, undefined);
    const text = observed.content[0]!.text!;
    assert.match(text, /^state: unlocked · app=com.apple.Preferences "Settings"/);
    assert.match(text, /\[e\d+\] Cell {8}"Wi-Fi"/);

    const id = /\[(e\d+)\] Cell {8}"Wi-Fi"/.exec(text)![1]!;
    const tapped = await client.callTool({ name: 'tap', arguments: { device: 'fake-1', element_id: id } }) as ToolText;
    assert.equal(tapped.isError, undefined);
    assert.match(tapped.content[0]!.text!, /^tap at \(\d+, \d+\) on Cell "Wi-Fi" done\./);
    assert.ok(wda.requests.some((entry) => entry.path === '/wda/absolute-actions'));

    const shot = await client.callTool({ name: 'observe', arguments: { device: 'fake-1', screenshot: true } }) as ToolText;
    const image = shot.content.find((block) => block.type === 'image');
    assert.ok(image && image.mimeType === 'image/jpeg' && image.data!.length > 100, 'screenshot attached');

    const opened = await client.callTool({ name: 'open_app', arguments: { device: 'fake-1', app: 'Notes' } }) as ToolText;
    assert.match(opened.content[0]!.text!, /opened com.apple.mobilenotes/);

    const failed = await client.callTool({ name: 'tap', arguments: { device: 'fake-1', element_id: 'e999' } }) as ToolText;
    assert.equal(failed.isError, true);
    assert.match(failed.content[0]!.text!, /not in the last observation/);

    // What was typed is not repeated back or logged: it may be a password.
    const typed = await client.callTool({ name: 'type_text', arguments: { device: 'fake-1', text: 'hello', submit: true } }) as ToolText;
    assert.match(typed.content[0]!.text!, /typed 5 characters \+ return done/);
    assert.doesNotMatch(typed.content[0]!.text!, /hello/);

    // An agent writes files on the Mac only inside the folder the server runs in.
    const outside = await client.callTool({ name: 'get_file', arguments: { device: 'fake-1', app: 'Notes', path: 'a.txt', out_path: '/tmp/phoneos-outside.txt' } }) as ToolText;
    assert.equal(outside.isError, true);
    assert.match(outside.content[0]!.text!, /can only be written inside/);
    const climbing = await client.callTool({ name: 'list_files', arguments: { device: 'fake-1', app: 'Notes', subdirectory: '../../Library' } }) as ToolText;
    assert.equal(climbing.isError, true);
    assert.match(climbing.content[0]!.text!, /leaves the app's Documents folder/);
});
