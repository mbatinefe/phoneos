import assert from 'node:assert/strict';
import test from 'node:test';

import { resetApp } from '../src/device/apps.js';

// Both refusals happen before anything is uninstalled.
test('Apple\'s own apps are never reinstalled', async () => {
    await assert.rejects(resetApp({ udid: 'phone-1', kind: 'device' }, 'com.apple.Preferences', '/tmp/x.ipa'), /part of iOS/);
});

test('a phone needs the build to reinstall, and nothing is touched without it', async () => {
    await assert.rejects(resetApp({ udid: 'phone-1', kind: 'device' }, 'com.example.app', undefined), /pass path= the \.ipa or \.app/);
});
