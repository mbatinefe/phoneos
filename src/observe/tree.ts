import type { AlertSummary, ElementFrame, SnapshotElement } from './types.js';

/** One node of `GET /source?format=json` (XCUIApplication+FBHelpers dictionaryForElement). */
export interface WdaTreeNode {
    type?: string;
    rawIdentifier?: string | null;
    name?: string | null;
    value?: string | number | null;
    label?: string | null;
    rect?: { x?: number; y?: number; width?: number; height?: number };
    isEnabled?: string | boolean;
    isVisible?: string | boolean;
    isAccessible?: string | boolean;
    isFocused?: string | boolean;
    children?: WdaTreeNode[];
}

export interface FlattenOptions {
    screen: { width: number; height: number };
    /** Hard cap on elements kept; interactive ones win over decorative ones. */
    maxElements?: number;
}

export interface FlattenedTree {
    elements: SnapshotElement[];
    keyboardVisible: boolean;
    alert: AlertSummary | null;
    /** How many elements the cap dropped, so the reader knows the list is not the whole screen. */
    truncated: number;
}

const INTERACTIVE = new Set([
    'Button', 'TextField', 'SecureTextField', 'SearchField', 'TextView', 'Switch', 'Slider', 'Cell', 'Link',
    'MenuItem', 'SegmentedControl', 'Picker', 'PickerWheel', 'Stepper', 'Tab', 'Toggle', 'DatePicker', 'CheckBox',
    'RadioButton', 'MenuButton', 'PopUpButton', 'ComboBox', 'Incrementor', 'Key', 'PageIndicator', 'RatingIndicator', 'Icon',
]);

/** Pure layout containers: kept only when they carry a label of their own. */
const CONTAINERS = new Set([
    'Application', 'Window', 'Other', 'Group', 'ScrollView', 'Table', 'CollectionView', 'NavigationBar', 'TabBar',
    'Toolbar', 'WebView', 'LayoutArea', 'LayoutItem', 'Any', 'Outline', 'OutlineRow', 'Sheet', 'Popover', 'Dialog',
    'Drawer', 'SplitGroup', 'SplitView', 'Matte', 'ScrollBar', 'Ruler', 'Grid', 'List', 'Browser', 'DockItem',
]);

/** Ancestors whose name is worth carrying into an element's `path`. */
const PATH_TYPES = new Set(['NavigationBar', 'TabBar', 'Toolbar', 'Cell', 'Alert', 'Sheet', 'Table', 'CollectionView', 'Popover', 'Dialog']);

function truthy(value: string | boolean | undefined): boolean {
    return value === true || value === '1' || value === 'true';
}

function text(value: string | number | null | undefined): string | undefined {
    if (value === null || value === undefined) return undefined;
    const trimmed = String(value).trim();
    return trimmed.length ? trimmed : undefined;
}

function frameOf(node: WdaTreeNode): ElementFrame {
    return {
        x: Math.round(node.rect?.x ?? 0),
        y: Math.round(node.rect?.y ?? 0),
        width: Math.round(node.rect?.width ?? 0),
        height: Math.round(node.rect?.height ?? 0),
    };
}

function onScreen(frame: ElementFrame, screen: { width: number; height: number }): boolean {
    if (frame.width <= 0 || frame.height <= 0) return false;
    return frame.x < screen.width && frame.y < screen.height && frame.x + frame.width > 0 && frame.y + frame.height > 0;
}

interface Candidate extends Omit<SnapshotElement, 'id'> { order: number; priority: number }

/**
 * Flattens WDA's element tree into the short list an agent reads: visible,
 * on-screen, meaningful nodes only, with the keyboard collapsed into a flag
 * and any alert summarised.
 */
export function flattenTree(root: WdaTreeNode, options: FlattenOptions): FlattenedTree {
    const maxElements = options.maxElements ?? 120;
    const candidates: Candidate[] = [];
    let keyboardVisible = false;
    let alert: AlertSummary | null = null;
    let order = 0;

    const visit = (node: WdaTreeNode, ancestors: string[], parentLabel: string | undefined, insideAlert: boolean): void => {
        const type = node.type ?? 'Other';
        const frame = frameOf(node);
        const visible = truthy(node.isVisible);
        const label = text(node.label);
        const name = text(node.name);
        const value = text(node.value);
        const rawIdentifier = text(node.rawIdentifier);
        // An accessibilityIdentifier that merely repeats the label adds nothing; WDA also mirrors it into `name`, which we then drop.
        const identifier = rawIdentifier && rawIdentifier !== label ? rawIdentifier : undefined;

        if (type === 'Keyboard') {
            if (visible || onScreen(frame, options.screen)) keyboardVisible = true;
            return; // its ~40 keys are not listed: type_text types, and tap_keys knows where each key is
        }

        const isAlert = type === 'Alert' || (type === 'Sheet' && (label || name));
        if (isAlert && !alert) {
            alert = { buttons: [] };
            const title = label ?? name;
            if (title) alert.title = title;
        }

        const nextAncestors = PATH_TYPES.has(type) ? [...ancestors, label && type !== 'Cell' ? `${type}(${label})` : type] : ancestors;
        const children = node.children ?? [];

        const named = Boolean(label || name || value || identifier);
        // Decorative system glyphs ("chevron.forward", "checkmark") say nothing a person would act on — whether
        // iOS reports the symbol name as the label or only as the identifier — nor do full-screen dimming overlays.
        const decorativeImage = type === 'Image' && !label && (
            /^[a-z0-9]+(\.[a-z0-9]+)+$/i.test(name ?? rawIdentifier ?? '')
            || /overlay|dimming/i.test(rawIdentifier ?? '')
            || (frame.width > options.screen.width && frame.height > options.screen.height)
        );
        const scrollBar = /scroll bar/i.test(label ?? name ?? '');
        const keep = visible && onScreen(frame, options.screen) && !decorativeImage && !scrollBar && (
            // Interactive controls are always listed — except bare Cell wrappers, whose labelled child carries the meaning.
            (INTERACTIVE.has(type) && (type !== 'Cell' || named))
            || (type === 'StaticText' && (label || value))
            || (type === 'Image' && (label || identifier))
            || (CONTAINERS.has(type) && Boolean(label || identifier) && type !== 'Application' && type !== 'Window')
            || (!INTERACTIVE.has(type) && !CONTAINERS.has(type) && type !== 'StaticText' && type !== 'Image' && Boolean(label || name || value))
        );
        // A StaticText that merely repeats its container's label is noise.
        const duplicate = type === 'StaticText' && parentLabel !== undefined && (label ?? value) === parentLabel;

        if (keep && !duplicate) {
            const interactive = INTERACTIVE.has(type);
            const element: Candidate = {
                order: order++,
                priority: interactive ? 0 : type === 'StaticText' ? 1 : 2,
                type,
                frame,
                enabled: node.isEnabled === undefined ? true : truthy(node.isEnabled),
                focused: truthy(node.isFocused),
                path: ancestors.slice(-2).join(' > '),
                interactive,
                ...(label ? { label } : {}),
                ...(name && name !== label && name !== identifier ? { name } : {}),
                ...(value && value !== label ? { value } : {}),
                ...(identifier ? { identifier } : {}),
            };
            candidates.push(element);
            if (insideAlert || isAlert) {
                if (type === 'Button' && alert && (label ?? name)) alert.buttons.push((label ?? name)!);
                else if (type === 'StaticText' && alert && !alert.text && (label ?? value) && (label ?? value) !== alert.title) alert.text = (label ?? value)!;
            }
        }

        const childParentLabel = keep ? (label ?? name) : parentLabel;
        for (const child of children) visit(child, nextAncestors, childParentLabel, insideAlert || Boolean(isAlert));
    };

    visit(root, [], undefined, false);

    // Some views expose the same node twice (scroll indicators, mirrored layers); keep the first.
    const seen = new Set<string>();
    const unique = candidates.filter((candidate) => {
        const key = `${candidate.type}|${candidate.label ?? ''}|${candidate.name ?? ''}|${candidate.value ?? ''}|${candidate.frame.x},${candidate.frame.y},${candidate.frame.width},${candidate.frame.height}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    let kept = unique;
    if (unique.length > maxElements) {
        kept = [...unique].sort((a, b) => a.priority - b.priority || a.order - b.order).slice(0, maxElements)
            .sort((a, b) => a.order - b.order);
    }
    const elements: SnapshotElement[] = kept.map(({ order: _order, priority: _priority, ...rest }, index) => ({ id: `e${index + 1}`, ...rest }));
    return { elements, keyboardVisible, alert, truncated: unique.length - kept.length };
}

/** Centre of a frame, in points. */
export function centerOf(frame: ElementFrame): { x: number; y: number } {
    return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

/** Case-insensitive search over label / name / value / identifier. */
export function findElements(elements: readonly SnapshotElement[], query: string): SnapshotElement[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const haystack = (element: SnapshotElement) => [element.label, element.name, element.value, element.identifier]
        .filter((entry): entry is string => Boolean(entry)).map((entry) => entry.toLowerCase());
    const exact = elements.filter((element) => haystack(element).some((entry) => entry === needle));
    if (exact.length) return exact;
    return elements.filter((element) => haystack(element).some((entry) => entry.includes(needle)));
}

function intersects(a: ElementFrame, b: ElementFrame): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: ElementFrame, inner: ElementFrame): boolean {
    return inner.x >= outer.x - 1 && inner.y >= outer.y - 1
        && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
}

/**
 * The part of `target`'s frame that is not covered by something drawn on top
 * of it — floating search pills, tab bars, toolbars, keyboards. The tree does
 * not know about z-order, so: a later element whose frame overlaps the target
 * without being inside it (a descendant) or enclosing it (an ancestor/container)
 * is treated as an overlay, and the target is shrunk vertically to the largest
 * strip that remains. Returns the full frame when nothing overlaps.
 */
export function exposedFrame(target: SnapshotElement, elements: readonly SnapshotElement[]): { frame: ElementFrame; occludedBy?: SnapshotElement } {
    const index = elements.findIndex((element) => element.id === target.id);
    let frame = { ...target.frame };
    let occludedBy: SnapshotElement | undefined;
    for (const other of elements.slice(index + 1)) {
        if (!intersects(frame, other.frame) || contains(target.frame, other.frame) || contains(other.frame, target.frame)) continue;
        if (!other.interactive && !/Bar|Sheet|Popover|Alert|SearchField|Dialog/.test(other.type)) continue;
        const top = frame.y;
        const bottom = frame.y + frame.height;
        const otherTop = other.frame.y;
        const otherBottom = other.frame.y + other.frame.height;
        // Neighbouring rows share a border; only a real overlap (> 6 pt) counts as something drawn on top.
        if (Math.min(bottom, otherBottom) - Math.max(top, otherTop) <= 6) continue;
        const above = Math.max(0, Math.min(bottom, otherTop) - top);      // exposed strip above the overlay
        const below = Math.max(0, bottom - Math.max(top, otherBottom));   // exposed strip below the overlay
        if (above < 8 && below < 8) continue;                             // nothing usable left; leave the frame
        occludedBy = other;
        frame = above >= below
            ? { ...frame, height: Math.min(frame.height, above) }
            : { ...frame, y: Math.max(top, otherBottom), height: Math.min(frame.height, below) };
    }
    return occludedBy ? { frame, occludedBy } : { frame };
}
