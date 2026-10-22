import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunReports } from '../src/agent-interface/report.js';

test('a report collects steps with their screenshots and renders one self-contained file', async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'phoneos-report-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const reports = new RunReports(root);

    await reports.step('phone-1', { action: 'ignored: no report is open' });
    await reports.start('phone-1', 'Phone A', 'Checkout <with> a saved card');
    await assert.rejects(reports.start('phone-1', 'Phone A', 'again'), /already open/);
    await reports.step('phone-1', { action: 'tap on Button "Pay"', state: 'unlocked · app=com.example.shop', image: Buffer.from('jpeg-bytes') });
    await reports.step('phone-1', { action: 'wait_for failed: "Thank you" did not appear', failed: true });
    const finished = await reports.finish('phone-1', { notes: 'The confirmation never showed.' });

    assert.deepEqual([finished.steps, finished.failures], [2, 1]);
    const html = await readFile(finished.path, 'utf8');
    assert.match(html, /<title>Checkout &lt;with&gt; a saved card<\/title>/, 'the title is escaped');
    assert.match(html, /<span class="badge failed">failed/, 'a failed step makes the run failed when no outcome is given');
    assert.equal(html.split(Buffer.from('jpeg-bytes').toString('base64')).length - 1, 1, 'each screenshot is embedded once');
    assert.match(html, /The confirmation never showed\./);
    assert.equal(await reports.active('phone-1'), undefined, 'finishing closes the report');
    await assert.rejects(reports.finish('phone-1'), /No report is open/);
});
