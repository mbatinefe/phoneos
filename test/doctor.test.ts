import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnose, renderDoctor, type DoctorDeviceFacts, type DoctorFacts } from '../src/devices/doctor.js';

function facts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
    return {
        node: '24.1.0',
        developerDir: '/Applications/Xcode.app/Contents/Developer',
        xcode: 'Xcode 27.1',
        wdaProjectPresent: true,
        envFile: true,
        devicesFile: { path: 'devices.json', mode: 0o600 },
        devices: [],
        signing: {},
        builds: { simulator: true, device: true },
        serviceRunning: true,
        database: { configured: false, reachable: false },
        ...overrides,
    };
}

function device(overrides: Partial<DoctorDeviceFacts> = {}): DoctorDeviceFacts {
    return { name: 'Phone A', udid: '00008101-0000000000000001', kind: 'device', wdaPort: 8100, hasPasscode: true, present: true, ready: true, ...overrides };
}

const failed = (checks: ReturnType<typeof diagnose>) => checks.filter((check) => check.status === 'fail');

test('a fresh clone with nothing registered is pointed at the demo', () => {
    const checks = diagnose(facts());
    assert.equal(failed(checks).length, 0);
    const registered = checks.find((check) => /No devices registered/.test(check.title));
    assert.equal(registered?.status, 'warn');
    assert.match(registered?.fix ?? '', /npm run demo/);
    assert.ok(!checks.some((check) => /service/.test(check.title)), 'the service is not judged before anything is registered');
});

test('the Command Line Tools in place of Xcode, and an old Node, are failures with their fixes', () => {
    const checks = diagnose(facts({ node: '20.11.0', developerDir: '/Library/Developer/CommandLineTools' }));
    assert.deepEqual(failed(checks).map((check) => check.fix), [
        'Install Node.js 22 or newer (https://nodejs.org)',
        'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
    ]);
});

test('a real iPhone needs signing and a device build; a simulator needs neither', () => {
    const phone = diagnose(facts({ devices: [device()], signing: { teamId: 'replace-me', bundleId: 'com.example.WebDriverAgentRunner' }, builds: { simulator: false, device: false } }));
    assert.match(failed(phone).map((check) => check.fix).join('\n'), /XCODE_ORG_ID .* and WDA_BUNDLE_ID/);
    assert.ok(failed(phone).some((check) => check.fix === 'npm run wda:prepare   (signs with your team; run it from Terminal.app, not SSH)'));
    assert.ok(!phone.some((check) => /for simulators/.test(check.title)), 'no simulator registered, so its build does not matter');

    const simulator = diagnose(facts({ devices: [device({ kind: 'simulator', name: 'Sim' })], builds: { simulator: false, device: false } }));
    assert.deepEqual(failed(simulator).map((check) => check.title), ['WebDriverAgent is not built for simulators']);
});

test('each phone gets the fix that matches why it is not ready', () => {
    const checks = diagnose(facts({
        signing: { teamId: 'ABCDE12345', bundleId: 'com.me.wda' },
        devices: [
            device({ name: 'Unplugged', present: false, ready: false }),
            device({ name: 'Locked', ready: false, supervisor: { wda: 'unlock-required', message: '' } }),
            device({ name: 'Starting', ready: false, supervisor: { wda: 'connecting', message: 'Building WebDriverAgent' } }),
            device({ name: 'Asleep', locked: true }),
            device({ name: 'No code', locked: true, hasPasscode: false }),
            device({ name: 'Sim', kind: 'simulator', udid: 'SIM-1', present: false, ready: false }),
        ],
    }));
    const about = (name: string) => checks.find((check) => check.title.startsWith(`${name} (`))!;
    assert.equal(about('Unplugged').status, 'fail');
    assert.match(about('Unplugged').fix!, /data cable/);
    assert.match(about('Locked').fix!, /Unlock the phone once by hand/);
    assert.equal(about('Starting').status, 'warn');
    assert.equal(about('Asleep').status, 'ok', 'a locked phone with a stored passcode is unlocked by the actions themselves');
    assert.match(about('No code').fix!, /passcode -d "No code"/);
    assert.equal(about('Sim').fix, 'xcrun simctl boot SIM-1 && open -a Simulator');
});

test('without the service every device is waiting on it, and the service failure comes first', () => {
    const checks = diagnose(facts({ serviceRunning: false, devices: [device({ kind: 'simulator', ready: false })] }));
    const titles = checks.map((check) => check.title);
    assert.ok(titles.indexOf('WebDriverAgent service is not running') < titles.findIndex((title) => title.startsWith('Phone A')));
    assert.match(renderDoctor(checks), /fix: npm run wda:service/);
});

test('a devices.json others can read is flagged, since it holds passcodes', () => {
    const checks = diagnose(facts({ devices: [device()], signing: { teamId: 'ABCDE12345', bundleId: 'com.me.wda' }, devicesFile: { path: 'devices.json', mode: 0o644 } }));
    assert.ok(checks.some((check) => check.status === 'warn' && check.fix === 'chmod 600 devices.json'));
});

test('the summary line says whether anything needs fixing', () => {
    assert.match(renderDoctor(diagnose(facts({ devices: [device({ kind: 'simulator' })] }))), /Everything is ready\.$/);
    assert.match(renderDoctor(diagnose(facts({ node: '18.0.0' }))), /1 problem and 1 warning\. Fix them from the top/);
});
