import type { Point, SwipePlan, TapPlan } from '../humanize/humanizer.js';

/**
 * W3C pointer actions in the exact shape the patched WebDriverAgent route
 * `POST /wda/absolute-actions` accepts (see Patches/…-absolute-touch.patch):
 * a single touch pointer whose items are only pointerMove / pointerDown /
 * pointerUp / pause. Multiple pointerMoves after the down draw a path.
 */
export interface W3cPointerAction {
    type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pause';
    duration?: number;
    x?: number;
    y?: number;
    origin?: 'viewport';
    button?: number;
}

export interface W3cPointerSource {
    type: 'pointer';
    id: string;
    parameters: { pointerType: 'touch' };
    actions: W3cPointerAction[];
}

function source(actions: W3cPointerAction[]): W3cPointerSource[] {
    return [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }];
}

export function tapActions(plan: TapPlan): W3cPointerSource[] {
    return source([
        { type: 'pointerMove', duration: 0, x: plan.x, y: plan.y, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: plan.holdMs },
        { type: 'pointerUp', button: 0 },
    ]);
}

export function longPressActions(point: Point, holdMs: number): W3cPointerSource[] {
    return tapActions({ x: point.x, y: point.y, holdMs });
}

export function swipeActions(plan: SwipePlan): W3cPointerSource[] {
    return source([
        { type: 'pointerMove', duration: 0, x: plan.start.x, y: plan.start.y, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: plan.settleMs },
        ...plan.segments.map((segment): W3cPointerAction => ({
            type: 'pointerMove', duration: segment.durationMs, x: segment.x, y: segment.y, origin: 'viewport',
        })),
        { type: 'pointerUp', button: 0 },
    ]);
}
