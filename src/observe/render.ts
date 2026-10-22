import type { DeviceState, Snapshot, SnapshotElement } from './types.js';

function quote(value: string): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    return `"${compact.length > 80 ? `${compact.slice(0, 77)}…` : compact}"`;
}

/** One line per element — the format an agent reads and taps by id. */
export function renderElement(element: SnapshotElement): string {
    const center = { x: Math.round(element.frame.x + element.frame.width / 2), y: Math.round(element.frame.y + element.frame.height / 2) };
    const parts = [`[${element.id}]`, element.type.padEnd(11)];
    if (element.label) parts.push(quote(element.label));
    else if (element.name) parts.push(quote(element.name));
    if (element.value !== undefined) parts.push(`value=${quote(element.value)}`);
    if (element.identifier) parts.push(`#${element.identifier}`);
    parts.push(`@ ${center.x},${center.y}`, `${element.frame.width}×${element.frame.height}`);
    if (element.focused) parts.push('focused');
    if (!element.enabled) parts.push('disabled');
    if (element.path) parts.push(`(${element.path})`);
    return parts.join(' ');
}

export function renderState(state: DeviceState): string {
    const app = state.activeApp ? `${state.activeApp.bundleId} "${state.activeApp.name}"` : 'home screen';
    const bits = [
        state.locked ? 'LOCKED' : 'unlocked',
        `app=${app}`,
        `${state.screen.width}×${state.screen.height}pt @${state.screen.scale}x ${state.screen.orientation}`,
        `keyboard=${state.keyboardVisible ? 'yes' : 'no'}`,
        state.alert ? `ALERT=${JSON.stringify(state.alert)}` : 'alert=no',
    ];
    if (state.battery) bits.push(`battery=${Math.round(state.battery.level * 100)}% ${state.battery.state}`);
    return bits.join(' · ');
}

export function renderSnapshot(snapshot: Snapshot, { truncated = 0 }: { truncated?: number } = {}): string {
    const lines = [`state: ${renderState(snapshot.state)}`];
    const home = snapshot.state.activeApp === null
        ? ' — this is the home screen; use open_app to launch apps, or tap by coordinates from the screenshot (its element tree is slow to read: pass tree_timeout_ms=30000 if you really need it)'
        : '';
    const why = snapshot.treeStatus === 'skipped' ? 'not read' : `unavailable (${snapshot.treeStatus})`;
    if (snapshot.treeStatus !== 'ok') {
        lines.push(`elements: ${why}${home || ' — use the screenshot and tap by coordinates'}`);
    } else {
        lines.push(`elements (${snapshot.elements.length}${truncated ? `, ${truncated} more hidden` : ''}):`);
        for (const element of snapshot.elements) lines.push(renderElement(element));
    }
    return lines.join('\n');
}
