import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { readyToFinish, type RegistrationCheck } from '../src/devices/registration.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { unavailableScheduler } from '../src/scheduler/unavailable.js';

// One devices.json path, shared by every test in this file.
const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'phoneos-dashboard-')), 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
await writeFile(configPath, JSON.stringify([
    { name: 'Lab $& iPhone', udid: 'udid-1', wdaLocalPort: 8100, mjpegLocalPort: 9100, humanProfile: 'relaxed', passcode: '1234', pluginData: {} },
]));

const idle = { async activeExecution() { return null; }, async listSchedules() { return []; } } as unknown as SchedulerRepository;
const busy = { async activeExecution() { return { id: 'run-1' }; } } as unknown as SchedulerRepository;

async function dashboard(context: { after(fn: () => unknown): void }, scheduler: SchedulerRepository = idle) {
    const { createApp } = await import('../src/api/app.js');
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme });
    context.after(() => app.close());
    return app;
}

test('the device page is filled in for its phone, with the mark and no app-pack panels', async (context) => {
    const app = await dashboard(context);
    const page = await inject(app, { method: 'GET', url: '/devices/udid-1' });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /__[A-Z_]+__/, 'every placeholder is replaced');
    // A `$&` in a name is literal text, not a replacement pattern.
    assert.match(page.body, /<h1>Lab \$&amp; iPhone<\/h1>/);
    assert.match(page.body, /data-profile="relaxed"/);
    assert.match(page.body, /id="passcode-state" class="tag">Set</);
    assert.doesNotMatch(page.body, /1234/, 'the passcode itself never reaches the page');
    assert.match(page.body, /bin\/phone\.js mcp/);
    assert.match(page.body, /class="logo-mark"/);
    assert.doesNotMatch(page.body, /tiktok|doomscroll/i);

    const icon = await inject(app, { method: 'GET', url: '/assets/logo.svg' });
    assert.equal(icon.statusCode, 200);
    assert.match(String(icon.headers['content-type']), /image\/svg\+xml/);
    assert.match(page.body, /href="\/assets\/logo\.svg\?v=[\w-]+"/);
});

test('the inspector refuses bad input before it reaches the phone', async (context) => {
    const app = await dashboard(context);
    const json = { 'content-type': 'application/json' };
    for (const bundleId of ['', 'com.example app', '-rf', 'a'.repeat(300), 42]) {
        const res = await inject(app, { method: 'POST', url: '/api/devices/udid-1/apps/open', headers: json, payload: { bundleId } });
        assert.equal(res.statusCode, 400, String(bundleId));
    }
    for (const text of ['', 'x'.repeat(2_001), 7]) {
        const res = await inject(app, { method: 'POST', url: '/api/devices/udid-1/type', headers: json, payload: { text } });
        assert.equal(res.statusCode, 400, String(text).slice(0, 10));
    }
});

test('the inspector leaves the phone alone while a task is driving it', async (context) => {
    const app = await dashboard(context, busy);
    const json = { 'content-type': 'application/json' };
    const calls = [
        { method: 'GET', url: '/api/devices/udid-1/elements' },
        { method: 'GET', url: '/api/devices/udid-1/accessibility' },
        { method: 'POST', url: '/api/devices/udid-1/apps/open', headers: json, payload: { bundleId: 'com.apple.Preferences' } },
        { method: 'POST', url: '/api/devices/udid-1/type', headers: json, payload: { text: 'hello' } },
        { method: 'POST', url: '/api/devices/udid-1/keyboard/dismiss', headers: json, payload: {} },
    ] as const;
    for (const call of calls) {
        const res = await inject(app, { ...call });
        assert.equal(res.statusCode, 409, call.url);
        assert.match(res.json().error, /task is driving this phone/);
    }
});

test('the dashboard says when scheduling is off, and why', async (context) => {
    const off = await dashboard(context, unavailableScheduler('DATABASE_URL is required'));
    assert.deepEqual((await inject(off, { method: 'GET', url: '/api/scheduler' })).json(), { available: false, reason: 'DATABASE_URL is required' });
    const on = await dashboard(context);
    assert.equal((await inject(on, { method: 'GET', url: '/api/scheduler' })).json().available, true);
});

test('a setup finishes on the built-in checks; an app pack\'s checks are advisory', () => {
    const passed: RegistrationCheck = { state: 'passed', message: '', updatedAt: '' };
    const blocked: RegistrationCheck = { state: 'blocked', message: 'Install the app', updatedAt: '' };
    const builtIn = { host: passed, connection: passed, signing: passed, developer: passed, wda: passed, video: passed, touch: passed };
    assert.equal(readyToFinish({ ...builtIn, 'myapp:installed': blocked }, 'Phone'), true);
    assert.equal(readyToFinish({ ...builtIn, touch: blocked }, 'Phone'), false);
    assert.equal(readyToFinish(builtIn, ''), false, 'a name is required');
});
