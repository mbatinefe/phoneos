import assert from 'node:assert/strict';
import test from 'node:test';

import { auditAccessibility, renderAudit } from '../src/observe/a11y.js';
import type { SnapshotElement } from '../src/observe/types.js';

function control(id: string, type: string, frame: SnapshotElement['frame'], overrides: Partial<SnapshotElement> = {}): SnapshotElement {
    return { id, type, frame, enabled: true, focused: false, path: '', interactive: true, ...overrides };
}

const issues = (elements: SnapshotElement[]) => auditAccessibility(elements).map((finding) => `${finding.element.id}:${finding.issue}`).sort();

test('a control without a spoken name, and a target under 44 points, are found', () => {
    assert.deepEqual(issues([
        control('e1', 'Button', { x: 10, y: 10, width: 24, height: 24 }, { identifier: 'closeButton' }),
        control('e2', 'Button', { x: 10, y: 100, width: 120, height: 44 }, { label: 'Continue' }),
    ]), ['e1:no-label', 'e1:small-target']);
});

test('a switch inside a labelled row is fine: the row is what VoiceOver reads and what is tapped', () => {
    // As Settings draws it on iOS 26: a labelled row-sized Switch around the bare one.
    assert.deepEqual(issues([
        control('e7', 'Switch', { x: 16, y: 367, width: 358, height: 52 }, { label: 'Airplane Mode', value: '0' }),
        control('e8', 'Switch', { x: 298, y: 379, width: 63, height: 28 }, { value: '0' }),
    ]), []);
});

test('a small button inside a text field is still its own target', () => {
    assert.deepEqual(issues([
        control('e23', 'SearchField', { x: 32, y: 773, width: 325, height: 38 }, { label: 'Search' }),
        control('e24', 'Button', { x: 323, y: 781, width: 18, height: 22 }, { label: 'Dictate' }),
    ]), ['e24:small-target']);
});

test('same-named controls, unlabelled fields and asset-name labels are flagged; keys and read text are not checked', () => {
    assert.deepEqual(issues([
        control('e1', 'Button', { x: 0, y: 0, width: 60, height: 60 }, { label: 'More' }),
        control('e2', 'Button', { x: 0, y: 100, width: 60, height: 60 }, { label: 'more' }),
        control('e3', 'TextField', { x: 0, y: 200, width: 300, height: 40 }, { value: '' }),
        control('e4', 'Button', { x: 0, y: 300, width: 60, height: 60 }, { label: 'icon_share@2x.png' }),
        control('e5', 'Key', { x: 0, y: 600, width: 30, height: 40 }),
        control('t1', 'Text', { x: 0, y: 700, width: 20, height: 10 }),
    ]), ['e1:duplicate-label', 'e2:duplicate-label', 'e3:unlabeled-field', 'e4:file-name-label']);
});

test('the report groups findings by problem and names each element', () => {
    const text = renderAudit(auditAccessibility([control('e9', 'Button', { x: 300, y: 780, width: 18, height: 22 }, { label: 'Dictate' })]), 1);
    assert.match(text, /1 finding among 1 controls/);
    assert.match(text, /Tap targets smaller than 44×44 points \(1\):\n {2}\[e9\] Button "Dictate" @ 309,791: tap target 18×22 pt/);
    assert.equal(renderAudit([], 12), 'No accessibility problems found among 12 controls on this screen.');
});
