import assert from 'node:assert/strict';
import test from 'node:test';

import { aboutFacts, findRow, rowTitle, settingsPack } from '../apps/settings/pack.js';
import { PluginRegistry } from '../src/registry.js';
import type { SnapshotElement } from '../src/observe/types.js';

function row(id: string, type: string, label: string, identifier?: string): SnapshotElement {
    return {
        id, type, label, ...(identifier ? { identifier } : {}),
        frame: { x: 16, y: 100, width: 358, height: 54 }, enabled: true, focused: false, path: 'CollectionView > Cell', interactive: true,
    };
}

// iOS 26's first Settings page and General, as the tree gives them.
const firstPage = [
    row('e1', 'Button', 'Wi-Fi, Home Network', 'com.apple.settings.wifi'),
    row('e2', 'StaticText', 'Wi-Fi'),
    row('e3', 'Button', 'Battery', 'com.apple.settings.battery'),
    { ...row('e4', 'Button', 'Personal Hotspot, Off'), enabled: false },
];
const general = [
    { ...row('e5', 'StaticText', 'General'), path: 'Table > Cell' },
    { ...row('e6', 'Cell', 'About'), path: 'Table' },
    { ...row('e7', 'Button', 'About'), path: 'Table > Cell' },
];

test('a row is found by its title, its button first, never a greyed-out one', () => {
    assert.equal(rowTitle('Wi-Fi, Home Network'), 'Wi-Fi');
    assert.equal(findRow(firstPage, 'wi-fi')?.id, 'e1');
    assert.equal(findRow(firstPage, 'Battery')?.id, 'e3');
    assert.equal(findRow(firstPage, 'Personal Hotspot'), undefined);
    assert.equal(findRow(general, 'About')?.id, 'e7');
    assert.equal(findRow(general, 'General'), undefined, 'a page heading is not a row');
});

test('on iOS 15 a row is its cell, straight in the table', () => {
    const ios15 = [
        { ...row('e2', 'Cell', 'Control Center'), path: 'Table' },
        { ...row('e3', 'Button', 'chevron'), path: 'Table > Cell', enabled: false },
        { ...row('e4', 'Cell', 'Display & Brightness'), path: 'Table' },
    ];
    assert.equal(findRow(ios15, 'Display & Brightness')?.id, 'e4');
    assert.equal(findRow(ios15, 'chevron'), undefined, 'the greyed-out chevron is not a row');
});

test('About is read by row id, and what identifies the phone is left out', () => {
    const about = [
        row('e1', 'Cell', 'Name, Lab iPhone', 'NAME_CELL_ID'),
        row('e2', 'Cell', 'iOS Version, 26.6', 'SW_VERSION_SPECIFIER'),
        row('e3', 'Button', 'iOS Version, 26.6', 'SW_VERSION_SPECIFIER'),
        row('e4', 'Cell', 'Model Name, iPhone 12 Pro', 'ProductModelName'),
        row('e5', 'Cell', 'Serial Number, F2LXXXXXXXXX', 'SerialNumber'),
        row('e6', 'Cell', 'Capacity, 256 GB', 'User Data Capacity'),
        row('e7', 'Cell', 'Available, 211.9 GB', 'User Data Available'),
        row('e8', 'Cell', 'Wi-Fi Address, 00:00:5E:00:53:01', 'MACAddress'),
        row('e9', 'Cell', 'IMEI, 00 000000 000000 0', 'ModemIMEI.1'),
    ];
    assert.deepEqual(aboutFacts(about), { name: 'Lab iPhone', iosVersion: '26.6', model: 'iPhone 12 Pro', capacity: '256 GB', available: '211.9 GB' });
});

test('the Settings pack is a valid app pack with a schedulable task', () => {
    const registry = new PluginRegistry([settingsPack]);
    const task = registry.validate({
        deviceUdid: 'device-12345678',
        task: { pluginId: settingsPack.id, taskType: 'about', taskVersion: 1, payload: {} },
        timing: { kind: 'daily', localTime: '09:00', timezone: 'America/New_York' },
    });
    assert.deepEqual(task.task.payload, {});
    assert.deepEqual(settingsPack.macros?.map((macro) => macro.name), ['open', 'about']);
});
