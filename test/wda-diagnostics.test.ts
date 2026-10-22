import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnoseWdaLaunchFailure, unavailableLimitMs, wdaUnavailableTooLong } from '../src/devices/wda/diagnostics.js';

test('a phone waiting to be unlocked is not relaunched every two minutes', () => {
    // What xcodebuild prints for a locked phone on iOS 26.
    const output = 'Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock iPhone to Continue" UserInfo={NSLocalizedRecoverySuggestion=Xcode cannot launch WebDriverAgentRunner on iPhone because the device is locked.}';
    assert.equal(diagnoseWdaLaunchFailure(output), 'Unlock the phone to continue starting WDA');

    const launchedAt = 0;
    const tooLong = (minutes: number, waitingForUnlock: boolean) => wdaUnavailableTooLong({ now: minutes * 60_000, launchedAt, timeoutMs: unavailableLimitMs(waitingForUnlock) });
    assert.equal(tooLong(3, false), true, 'an unlocked phone whose agent is silent for 3 minutes is restarted');
    assert.equal(tooLong(3, true), false, 'a locked phone is left waiting');
    assert.equal(tooLong(20, true), false);
    assert.equal(tooLong(31, true), true, 'after half an hour the launcher is recycled once, in case it got stuck');
});
