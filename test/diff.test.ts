import assert from 'node:assert/strict';
import test from 'node:test';

import { diffSnapshots, renderChanges, stabilizeIds } from '../src/observe/diff.js';
import type { Snapshot, SnapshotElement } from '../src/observe/types.js';

function element(id: string, label: string, y: number, overrides: Partial<SnapshotElement> = {}): SnapshotElement {
    return { id, type: 'Button', label, frame: { x: 16, y, width: 358, height: 52 }, enabled: true, focused: false, path: '', interactive: true, ...overrides };
}

function snapshot(elements: SnapshotElement[], app = 'com.example.app', takenAt = '2026-10-22T10:00:00.000Z'): Snapshot {
    return {
        state: { locked: false, activeApp: { bundleId: app, name: 'App', pid: 1 }, screen: { width: 390, height: 844, scale: 3, orientation: 'portrait' }, keyboardVisible: false, alert: null, takenAt },
        elements, treeStatus: 'ok',
    };
}

test('an element still in its place keeps its id; new ones are numbered after the highest id seen', () => {
    const before = [element('e1', 'Wi-Fi', 100), element('e2', 'Bluetooth', 152), element('e3', 'Cellular', 204)];
    // A fresh flatten numbers from e1 again; Bluetooth is gone and Battery is new.
    const after = stabilizeIds([element('e1', 'Wi-Fi', 100), element('e2', 'Cellular', 204), element('e3', 'Battery', 256)], before);
    assert.deepEqual(after.map((entry) => `${entry.id} ${entry.label}`), ['e1 Wi-Fi', 'e3 Cellular', 'e4 Battery']);
});

test('a uniquely labelled element that moved keeps its id; look-alikes that moved do not', () => {
    const switchAt = (id: string, y: number) => element(id, '', y, { type: 'Switch', label: undefined });
    const before = [element('e1', 'General', 500), switchAt('e2', 400), switchAt('e3', 600)];
    const after = stabilizeIds([element('e1', 'General', 300), switchAt('e2', 200), switchAt('e3', 400)], before);
    assert.equal(after[0]!.id, 'e1', 'General scrolled up and is still e1');
    assert.equal(after[2]!.id, 'e2', 'the switch now at 400 sits where e2 was: same kind and place');
    assert.equal(after[1]!.id, 'e4', 'an unlabelled switch that moved cannot be told apart, so it is new');
});

test('changes list what is new, changed and gone, and say how much stayed', () => {
    const before = snapshot([element('e1', 'Wi-Fi', 100), element('e2', 'Airplane Mode', 152, { type: 'Switch', value: '0' }), element('e3', 'Cancel', 204), element('e4', 'Battery', 256)]);
    const now = snapshot(stabilizeIds([
        element('e1', 'Wi-Fi', 100), element('e2', 'Airplane Mode', 152, { type: 'Switch', value: '1' }), element('e3', 'Battery', 256), element('e4', 'Done', 308),
    ], before.elements), 'com.example.app', '2026-10-22T10:00:07.000Z');
    const changes = diffSnapshots(before, now);
    assert.deepEqual(changes.added.map((entry) => entry.label), ['Done']);
    assert.deepEqual(changes.changed.map(({ element: entry }) => entry.label), ['Airplane Mode']);
    assert.deepEqual(changes.removed.map((entry) => entry.label), ['Cancel']);
    assert.equal(changes.unchanged, 2);
    const text = renderChanges(before, now)!;
    assert.match(text, /changes since the observe 7 s ago: 1 new, 1 changed, 1 gone, 2 unchanged; their ids still work/);
    assert.match(text, /\[e2\] Switch\s+"Airplane Mode" value="1" .*\(value was "0"\)/);
    assert.match(text, /gone: e3 Button "Cancel"/);
});

test('another app, or a screen that is mostly new, gets the full list instead', () => {
    const before = snapshot([element('e1', 'Wi-Fi', 100), element('e2', 'Bluetooth', 152)]);
    assert.equal(renderChanges(before, snapshot(before.elements, 'com.other.app')), undefined);
    const mostlyNew = snapshot(stabilizeIds([element('e1', 'Wi-Fi', 100), element('e2', 'A', 200), element('e3', 'B', 250), element('e4', 'C', 300)], before.elements));
    assert.equal(renderChanges(before, mostlyNew), undefined);
    assert.equal(renderChanges(undefined, before), undefined);
});
