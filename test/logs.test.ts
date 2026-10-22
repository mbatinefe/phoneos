import assert from 'node:assert/strict';
import test from 'node:test';

import { errorLines, linesOfProcess, summarizeCrash } from '../src/device/logs.js';

const SYSLOG = [
    'Oct 22 05:51:59 iPhone Preferences(UIKitCore)[14942] <Notice>: Sending UIEvent type: 0',
    'Oct 22 05:51:59 iPhone Preferences[14942] <Error>: Could not load the Wi-Fi list',
    'Oct 22 05:51:59 iPhone PreferencesExtra[311] <Fault>: another process with a longer name',
    'Oct 22 05:52:00 iPhone SpringBoard(FrontBoard)[60] <Fault>: not ours',
];

test('a process\'s lines are told apart from processes whose names start the same', () => {
    assert.deepEqual(linesOfProcess(SYSLOG, 'Preferences').map((line) => line.slice(-20)), [SYSLOG[0]!.slice(-20), SYSLOG[1]!.slice(-20)]);
    // `log show --style compact` writes `Name[pid:tid]`.
    assert.equal(linesOfProcess(['2026-10-22 12:00:00.000 E  MyApp[812:9a1] [Net] timeout'], 'MyApp').length, 1);
    assert.equal(linesOfProcess(['x My.App(Sub)[1] <Notice>: dots are literal'], 'My.App').length, 1);
    assert.equal(linesOfProcess(['x MyXApp(Sub)[1] <Notice>: not a regex wildcard'], 'My.App').length, 0);
});

test('errors only keeps the error and fault lines', () => {
    assert.deepEqual(errorLines(SYSLOG), SYSLOG.slice(1));
});

test('a crash report is summarised: what, why, and where', () => {
    const header = { app_name: 'MyApp', app_version: '2.1', timestamp: '2026-10-22 12:00:00.00 +0900', os_version: 'iPhone OS 26.1' };
    const body = {
        exception: { type: 'EXC_CRASH', signal: 'SIGABRT', codes: '0x0, 0x0' },
        termination: { namespace: 'SIGNAL', indicator: 'Abort trap: 6' },
        asi: { 'libswiftCore.dylib': ['Fatal error: Index out of range'] },
        faultingThread: 1,
        threads: [{ frames: [] }, { queue: 'com.apple.main-thread', frames: [{ imageIndex: 0, symbol: 'abort' }, { imageIndex: 1, imageOffset: 4096 }] }],
        usedImages: [{ name: 'libsystem_c.dylib' }, { name: 'MyApp' }],
    };
    const summary = summarizeCrash(`${JSON.stringify(header)}\n${JSON.stringify(body)}`);
    assert.equal(summary, [
        'MyApp 2.1 crashed 2026-10-22 12:00:00.00 +0900 (iPhone OS 26.1)',
        'exception: EXC_CRASH (SIGABRT) codes 0x0, 0x0',
        'termination: SIGNAL · Abort trap: 6',
        'libswiftCore.dylib: Fatal error: Index out of range',
        'crashed thread 1 (com.apple.main-thread):',
        '  0 libsystem_c.dylib abort',
        '  1 MyApp +0x1000',
    ].join('\n'));
});

test('a report that is not the two-part JSON is shown as its first lines', () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
    assert.equal(summarizeCrash(text).split('\n').length, 30);
});
