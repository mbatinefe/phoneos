import assert from 'node:assert/strict';
import test from 'node:test';

import { findElements, flattenTree } from '../src/observe/tree.js';
import { renderElement, renderSnapshot } from '../src/observe/render.js';
import { keypadFromElements, geometricKeypad } from '../src/device/unlock.js';
import { lockScreenTree, node, settingsTree } from './fake-wda.js';

const screen = { width: 390, height: 844 };

test('flattenTree keeps visible, on-screen, meaningful nodes and collapses the keyboard', () => {
    const flat = flattenTree(settingsTree(), { screen });
    const labels = flat.elements.map((element) => `${element.type}:${element.label ?? element.name ?? ''}`);
    assert.ok(labels.includes('Cell:Airplane Mode'));
    assert.ok(labels.includes('Switch:Airplane Mode'));
    assert.ok(labels.includes('Cell:Wi-Fi'));
    assert.ok(labels.includes('TextField:Search'));
    assert.ok(labels.includes('NavigationBar:Settings'), 'labelled containers are kept');
    assert.ok(!labels.includes('Cell:Hidden'), 'off-screen nodes are dropped');
    assert.ok(!labels.includes('Cell:Invisible'), 'invisible nodes are dropped');
    assert.ok(!labels.some((label) => label.startsWith('Key:')), 'keyboard keys are not listed');
    assert.ok(!labels.includes('Other:'), 'unlabelled containers are dropped');
    assert.equal(flat.keyboardVisible, true);
    assert.equal(flat.alert, null);
    // the StaticText that repeats its Cell's label is deduplicated
    assert.equal(labels.filter((label) => label === 'StaticText:Airplane Mode').length, 0);
    const search = flat.elements.find((element) => element.type === 'TextField')!;
    assert.equal(search.focused, true);
    assert.equal(search.value, 'wifi');
    assert.equal(search.name, 'search');
    assert.equal(search.identifier, undefined, 'no identifier when WDA reports none');
    assert.deepEqual(flat.elements.map((element) => element.id).slice(0, 3), ['e1', 'e2', 'e3']);
});

test('flattenTree caps the list, keeping interactive elements first', () => {
    const flat = flattenTree(settingsTree(), { screen, maxElements: 3 });
    assert.equal(flat.elements.length, 3);
    assert.ok(flat.truncated > 0);
    assert.ok(flat.elements.every((element) => element.interactive));
});

test('a node exposed twice counts once, also when the list is capped', () => {
    const button = (label: string, y: number) => node({ type: 'Button', label, rect: { x: 20, y, width: 200, height: 44 } });
    const twice = button('Twice', 100);
    const root = node({ type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 }, children: [twice, twice, button('Other', 200), button('Third', 300)] });
    const flat = flattenTree(root, { screen, maxElements: 2 });
    assert.deepEqual(flat.elements.map((element) => element.label), ['Twice', 'Other']);
    assert.equal(flat.truncated, 1, 'three distinct buttons, two kept: one dropped, never a negative count');
});

test('findElements matches exactly first, then by substring, case-insensitively', () => {
    const { elements } = flattenTree(settingsTree(), { screen });
    assert.equal(findElements(elements, 'wi-fi')[0]!.type, 'Cell');
    assert.ok(findElements(elements, 'airplane').length >= 2);
    assert.deepEqual(findElements(elements, 'nope'), []);
});

test('render produces one line per element with centre coordinates in points', () => {
    const { elements } = flattenTree(settingsTree(), { screen });
    const line = renderElement(elements.find((element) => element.label === 'Wi-Fi')!);
    assert.match(line, /^\[e\d+\] Cell {8}"Wi-Fi" value="Home" @ 195,216 390×44 \(Table\)$/);
    const text = renderSnapshot({
        state: { locked: false, activeApp: { bundleId: 'com.apple.Preferences', name: 'Settings', pid: 1 }, screen: { ...screen, scale: 3, orientation: 'portrait' }, keyboardVisible: true, alert: null, takenAt: new Date().toISOString() },
        elements, treeStatus: 'ok',
    });
    assert.match(text, /^state: unlocked · app=com.apple.Preferences "Settings" · 390×844pt @3x portrait · keyboard=yes · alert=no/);
    assert.match(text, /\nelements \(\d+\):\n\[e1\]/);
});

test('lock-screen keypad is read from the tree, with a geometric fallback per screen size', () => {
    const { elements } = flattenTree(lockScreenTree(), { screen });
    const keypad = keypadFromElements(elements);
    assert.equal(keypad.size, 10);
    assert.equal(keypad.get('2')!.label, '2 ABC');
    assert.equal(keypad.get('0')!.frame.y, 620);
    const geometric = geometricKeypad(screen, 'iPhone16,1');
    assert.equal(geometric.size, 10);
    assert.deepEqual(geometric.get('5'), { x: 195, y: Math.round(0.53 * 844) });
    assert.ok(geometricKeypad({ width: 375, height: 667 }, 'iPhone10,1').get('1')!.y < geometric.get('1')!.y * 667 / 844 + 30);
});
