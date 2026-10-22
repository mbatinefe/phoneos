import { renderElement, renderState } from './render.js';
import type { Snapshot, SnapshotElement } from './types.js';

/**
 * Observations that build on the one before. An element that is still there, the same
 * type, label and place, keeps its id, so `e7` stays valid across an observe that did
 * not touch it; and an observe can report only what is new, changed or gone, which on a
 * long session is most of the tokens saved.
 */

const SLACK = 2; // points: layout rounding moves frames by a point now and then

const keyOf = (element: SnapshotElement) => `${element.id.replace(/\d+$/, '')}|${element.type}|${element.label ?? element.name ?? ''}|${element.identifier ?? ''}`;

function samePlace(a: SnapshotElement['frame'], b: SnapshotElement['frame']): boolean {
    return Math.abs(a.x - b.x) <= SLACK && Math.abs(a.y - b.y) <= SLACK && Math.abs(a.width - b.width) <= SLACK && Math.abs(a.height - b.height) <= SLACK;
}

/**
 * Give each element still on screen its earlier id, and number the new ones after the highest
 * id used before. Same kind, label and place is the same element; one whose label is unique on
 * both screens is the same element moved (a scrolled list), and keeps its id too.
 */
export function stabilizeIds(current: readonly SnapshotElement[], previous: readonly SnapshotElement[]): SnapshotElement[] {
    const used = new Set<string>();
    const matched: Array<string | undefined> = current.map((element) => {
        const key = keyOf(element);
        const earlier = previous.find((candidate) => !used.has(candidate.id) && keyOf(candidate) === key && samePlace(candidate.frame, element.frame));
        if (earlier) used.add(earlier.id);
        return earlier?.id;
    });
    const count = (elements: readonly SnapshotElement[]) => elements.reduce((counts, element) => counts.set(keyOf(element), (counts.get(keyOf(element)) ?? 0) + 1), new Map<string, number>());
    const before = count(previous);
    const after = count(current);
    current.forEach((element, index) => {
        const key = keyOf(element);
        if (matched[index] || !(element.label ?? element.name ?? element.identifier) || before.get(key) !== 1 || after.get(key) !== 1) return;
        const earlier = previous.find((candidate) => !used.has(candidate.id) && keyOf(candidate) === key);
        if (!earlier) return;
        used.add(earlier.id);
        matched[index] = earlier.id;
    });
    const next = new Map<string, number>();
    for (const element of previous) {
        const [, prefix = '', number = '0'] = /^(\D+)(\d+)$/.exec(element.id) ?? [];
        next.set(prefix, Math.max(next.get(prefix) ?? 0, Number(number)));
    }
    return current.map((element, index) => {
        const id = matched[index];
        if (id) return { ...element, id };
        const prefix = /^\D+/.exec(element.id)?.[0] ?? 'e';
        const number = (next.get(prefix) ?? 0) + 1;
        next.set(prefix, number);
        return { ...element, id: `${prefix}${number}` };
    });
}

export interface ScreenChanges {
    added: SnapshotElement[];
    changed: Array<{ element: SnapshotElement; before: SnapshotElement }>;
    removed: SnapshotElement[];
    unchanged: number;
    /** Of the unchanged: how many are in a new place (their id still finds them there). */
    moved: number;
}

/** What differs between two observations whose ids were stabilised against each other. */
export function diffSnapshots(previous: Snapshot, current: Snapshot): ScreenChanges {
    const before = new Map(previous.elements.map((element) => [element.id, element]));
    const now = new Set(current.elements.map((element) => element.id));
    const changes: ScreenChanges = { added: [], changed: [], removed: previous.elements.filter((element) => !now.has(element.id)), unchanged: 0, moved: 0 };
    for (const element of current.elements) {
        const earlier = before.get(element.id);
        if (!earlier) changes.added.push(element);
        else if (earlier.value !== element.value || earlier.focused !== element.focused || earlier.enabled !== element.enabled) changes.changed.push({ element, before: earlier });
        else {
            changes.unchanged += 1;
            if (!samePlace(earlier.frame, element.frame)) changes.moved += 1;
        }
    }
    return changes;
}

/**
 * The observation as changes, or `undefined` when a full list says more: another app is in
 * front, the tree was not read either time, or most of the screen is new.
 */
export function renderChanges(previous: Snapshot | undefined, current: Snapshot): string | undefined {
    if (!previous || previous.state.activeApp?.bundleId !== current.state.activeApp?.bundleId) return undefined;
    if (!current.elements.length || !previous.elements.length) return undefined;
    const changes = diffSnapshots(previous, current);
    if (changes.unchanged < (changes.added.length + changes.changed.length) || changes.unchanged < current.elements.length / 3) return undefined;
    const seconds = Math.max(0, Math.round((Date.parse(current.state.takenAt) - Date.parse(previous.state.takenAt)) / 1000));
    const lines = [
        `state: ${renderState(current.state)}`,
        `changes since the observe ${seconds} s ago: ${changes.added.length} new, ${changes.changed.length} changed, ${changes.removed.length} gone, ${changes.unchanged} unchanged${changes.moved ? ` (${changes.moved} of them moved)` : ''}; their ids still work`,
    ];
    if (changes.added.length) lines.push('new:', ...changes.added.map(renderElement));
    if (changes.changed.length) {
        lines.push('changed:', ...changes.changed.map(({ element, before }) => {
            const was = [
                before.value !== element.value ? `value was ${JSON.stringify(before.value ?? '')}` : '',
                before.focused !== element.focused ? (element.focused ? 'now focused' : 'no longer focused') : '',
                before.enabled !== element.enabled ? (element.enabled ? 'now enabled' : 'now disabled') : '',
            ].filter(Boolean).join(', ');
            return `${renderElement(element)} (${was})`;
        }));
    }
    if (changes.removed.length) lines.push(`gone: ${changes.removed.map((element) => `${element.id} ${element.type}${element.label ? ` "${element.label}"` : ''}`).join(', ')}`);
    if (!changes.added.length && !changes.changed.length && !changes.removed.length) lines.push('nothing changed');
    return lines.join('\n');
}
