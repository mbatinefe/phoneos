import type { SnapshotElement } from './types.js';

/**
 * An accessibility check of one screen, from the element tree: what VoiceOver users and
 * people with less precise hands run into first. Apple's guidance is the yardstick (a
 * control has a spoken name; a tap target is at least 44×44 points).
 */

export type A11yIssue = 'no-label' | 'small-target' | 'duplicate-label' | 'unlabeled-field' | 'file-name-label';

export interface A11yFinding {
    issue: A11yIssue;
    element: SnapshotElement;
    detail: string;
}

/** Controls VoiceOver announces by their label alone. */
const NAMED_CONTROLS = new Set(['Button', 'Link', 'Switch', 'Toggle', 'Slider', 'Stepper', 'SegmentedControl', 'Tab', 'CheckBox', 'RadioButton', 'MenuButton', 'PopUpButton', 'Icon']);
const FIELDS = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);
const MIN_TARGET = 44;
const FILE_NAME = /^(?:[a-z0-9]+[_-])+[a-z0-9]+(?:@[23]x)?(?:\.(?:png|jpe?g|pdf|svg))?$|\.(?:png|jpe?g|pdf|svg)$/i;

const spoken = (element: SnapshotElement) => element.label?.trim() ?? '';
// The keyboard's keys never reach the element list (tree.ts); a passcode keypad's do.
const inKeyboard = (element: SnapshotElement) => element.type === 'Key';

/** `outer` encloses `inner` (a point of slack for rounding). */
function encloses(outer: SnapshotElement['frame'], inner: SnapshotElement['frame']): boolean {
    return outer.x <= inner.x + 1 && outer.y <= inner.y + 1
        && outer.x + outer.width >= inner.x + inner.width - 1 && outer.y + outer.height >= inner.y + inner.height - 1;
}

export function auditAccessibility(elements: readonly SnapshotElement[]): A11yFinding[] {
    const findings: A11yFinding[] = [];
    const controls = elements.filter((element) => element.interactive && !inKeyboard(element) && !/^t\d+$/.test(element.id));
    // A switch drawn inside a labelled row is reached and tapped through the row (Settings does
    // this everywhere): VoiceOver reads the row's label, and the whole row is the target. A text
    // field is no such row: a button inside it (Dictate, Clear) is a separate thing to hit.
    const coveredByLabelledControl = (element: SnapshotElement) => controls.some((other) => other !== element && Boolean(spoken(other)) && !FIELDS.has(other.type)
        && other.frame.width * other.frame.height > element.frame.width * element.frame.height && encloses(other.frame, element.frame));
    for (const element of controls) {
        const label = spoken(element);
        const covered = coveredByLabelledControl(element);
        if (NAMED_CONTROLS.has(element.type) && !label && !covered) {
            findings.push({ issue: 'no-label', element, detail: `${element.type} has no accessibility label: VoiceOver says ${element.identifier ? `"${element.identifier}"` : 'only its type'}` });
        }
        if (FIELDS.has(element.type) && !label && !element.value?.trim()) {
            findings.push({ issue: 'unlabeled-field', element, detail: `${element.type} has neither a label nor placeholder text` });
        }
        if (label && FILE_NAME.test(label)) {
            findings.push({ issue: 'file-name-label', element, detail: `label "${label}" reads like an image or asset name` });
        }
        const { width, height } = element.frame;
        if (element.type !== 'Cell' && !FIELDS.has(element.type) && !covered && (width < MIN_TARGET || height < MIN_TARGET)) {
            findings.push({ issue: 'small-target', element, detail: `tap target ${width}×${height} pt, under ${MIN_TARGET}×${MIN_TARGET}` });
        }
    }
    const byLabel = new Map<string, SnapshotElement[]>();
    for (const element of controls) {
        const label = spoken(element).toLowerCase();
        if (!label || element.type === 'Cell') continue;
        byLabel.set(label, [...(byLabel.get(label) ?? []), element]);
    }
    for (const group of byLabel.values()) {
        if (group.length < 2) continue;
        for (const element of group) {
            findings.push({ issue: 'duplicate-label', element, detail: `${group.length} controls are all called "${spoken(element)}": ${group.map((other) => other.id).join(', ')}` });
        }
    }
    return findings;
}

const HEADINGS: Record<A11yIssue, string> = {
    'no-label': 'Controls VoiceOver cannot name',
    'unlabeled-field': 'Text fields with no label or placeholder',
    'file-name-label': 'Labels that read like file names',
    'duplicate-label': 'Controls with the same label (VoiceOver users cannot tell them apart)',
    'small-target': 'Tap targets smaller than 44×44 points',
};

export function renderAudit(findings: readonly A11yFinding[], checked: number): string {
    if (!findings.length) return `No accessibility problems found among ${checked} controls on this screen.`;
    const lines = [`${findings.length} finding${findings.length === 1 ? '' : 's'} among ${checked} controls on this screen:`];
    for (const issue of Object.keys(HEADINGS) as A11yIssue[]) {
        const group = findings.filter((finding) => finding.issue === issue);
        if (!group.length) continue;
        lines.push('', `${HEADINGS[issue]} (${group.length}):`);
        for (const finding of group) {
            const element = finding.element;
            const centre = `${Math.round(element.frame.x + element.frame.width / 2)},${Math.round(element.frame.y + element.frame.height / 2)}`;
            lines.push(`  [${element.id}] ${element.type}${spoken(element) ? ` "${spoken(element)}"` : ''} @ ${centre}: ${finding.detail}`);
        }
    }
    return lines.join('\n');
}
