import assert from 'node:assert/strict';
import test from 'node:test';

import { DeviceFleet } from '../src/device/fleet.js';
import { runSteps, stepSchema } from '../src/agent-interface/steps.js';
import { AgentTools } from '../src/agent-interface/tools.js';
import { startFakeWda } from './fake-wda.js';

async function toolsFor(context: { after(fn: () => unknown): void }) {
    const wda = await startFakeWda();
    context.after(() => wda.close());
    const port = Number(new URL(wda.url).port);
    const fleet = new DeviceFleet({
        loadDevices: async () => [{ name: 'Fake', udid: 'fake-1', wdaLocalPort: port, mjpegLocalPort: port + 1000, pluginData: {} }],
        discover: async () => [{ udid: 'fake-1', kind: 'device', name: 'Fake', osVersion: '17.0' }],
    });
    return { wda, tools: new AgentTools({ fleet, recordDirectory: null }) };
}

test('steps run in order through the same tools, and the run ends with an observation', async (context) => {
    const { wda, tools } = await toolsFor(context);
    const steps = [
        { action: 'tap', text: 'Wi-Fi' },
        { action: 'wait_for', text: 'Airplane Mode', timeout_ms: 2000 },
        { action: 'tap', text: 'Airplane Mode' },
        { action: 'press_button', button: 'home' },
    ].map((step) => stepSchema.parse(step));
    const result = await runSteps(tools, 'fake-1', steps);
    assert.match(result.text, /^All 4 steps done:/);
    assert.match(result.text, /1\. ✓ tap text="Wi-Fi"/);
    assert.match(result.text, /4\. ✓ press_button button="home"/);
    assert.match(result.text, /\nNow:\nstate: /, 'a fresh observation closes the run');
    assert.equal(wda.requests.filter((entry) => entry.path === '/wda/absolute-actions').length, 2, 'two taps reached the phone');
});

test('the first failure stops the run, and a wait that never comes counts as one', async (context) => {
    const { wda, tools } = await toolsFor(context);
    const steps = [
        { action: 'wait_for', text: 'Nothing like this', timeout_ms: 600 },
        { action: 'tap', text: 'Wi-Fi' },
    ].map((step) => stepSchema.parse(step));
    const result = await runSteps(tools, 'fake-1', steps, { observeAfter: false });
    assert.match(result.text, /^0 of 2 steps done, then one failed:/);
    assert.match(result.text, /1\. ✗ wait_for text="Nothing like this" timeout_ms=600 — "Nothing like this" did not appear/);
    assert.match(result.text, /Stopped: steps 2–2 did not run\./);
    assert.equal(wda.requests.filter((entry) => entry.path === '/wda/absolute-actions').length, 0, 'nothing after the failure was tapped');
});

test('a step the schema does not know is refused before anything runs', () => {
    assert.throws(() => stepSchema.parse({ action: 'delete_everything' }));
    assert.throws(() => stepSchema.parse({ action: 'wait', ms: 120_000 }));
});
