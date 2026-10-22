import type { Point } from '../humanize/humanizer.js';
import { pluginShortId, type PhoneosPlugin } from '../plugin.js';

/**
 * Named points: where an app's controls sit when the app does not expose them as
 * elements (custom-drawn screens, video feeds). A pack gives each one as fractions of
 * the screen, so it fits any iPhone; a device can override any of them in
 * `devices.json` → `coordinates`, under `<pack short id>.<point name>`.
 */

/** The `devices.json` → `coordinates` key that overrides a pack's point. */
export function pointKey(plugin: Pick<PhoneosPlugin, 'id' | 'shortId'>, name: string): string {
    return `${pluginShortId(plugin)}.${name}`;
}

/** Where a pack's named point is on this screen: the device's override, else the pack's fraction. */
export function resolvePoint(
    plugin: Pick<PhoneosPlugin, 'id' | 'shortId' | 'points'>,
    name: string,
    screen: { width: number; height: number },
    overrides?: Readonly<Record<string, Point>>,
): Point {
    const point = plugin.points?.[name];
    if (!point) throw new Error(`${pluginShortId(plugin)} has no point named "${name}"`);
    const override = overrides?.[pointKey(plugin, name)];
    if (override) return { x: override.x, y: override.y };
    return { x: Math.round(point.fx * screen.width), y: Math.round(point.fy * screen.height) };
}

export interface ListedPoint {
    key: string;
    pack: string;
    name: string;
    label: string;
    default: Point;
    current: Point;
    overridden: boolean;
}

/** Every point the packs declare, with where it falls by default and where it is now. */
export function listPoints(
    plugins: readonly PhoneosPlugin[],
    screen: { width: number; height: number },
    overrides?: Readonly<Record<string, Point>>,
): ListedPoint[] {
    return plugins.flatMap((plugin) => Object.entries(plugin.points ?? {}).map(([name, point]) => {
        const key = pointKey(plugin, name);
        return {
            key, pack: plugin.displayName, name, label: point.label,
            default: resolvePoint(plugin, name, screen),
            current: resolvePoint(plugin, name, screen, overrides),
            overridden: Boolean(overrides?.[key]),
        };
    }));
}
