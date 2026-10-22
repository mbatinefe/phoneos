import { z } from 'zod';

import type { AgentTools, ToolResult } from './tools.js';

/**
 * `run_steps`: a short, known sequence in one call (open an app, tap, type, wait for the
 * result) instead of one round trip per action. Steps run in order through the same tools,
 * humanised and logged as if called one by one; the first failure stops the run.
 */

const target = {
    element_id: z.string().optional().describe('An id from the observe before this call; an element a step changes gets a new id, so prefer text in later steps'),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
};

export const stepSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('tap'), ...target, spread: z.number().min(0).max(40).optional() }),
    z.object({ action: z.literal('double_tap'), ...target }),
    z.object({ action: z.literal('long_press'), ...target, duration_ms: z.number().int().min(200).max(10_000).optional() }),
    z.object({ action: z.literal('type_text'), text: z.string(), submit: z.boolean().optional() }),
    z.object({ action: z.literal('tap_keys'), text: z.string().min(1) }),
    z.object({ action: z.literal('swipe'), direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().min(0.05).max(0.9).optional(), from: z.object({ x: z.number(), y: z.number() }).optional(), to: z.object({ x: z.number(), y: z.number() }).optional() }),
    z.object({ action: z.literal('flick_feed'), direction: z.enum(['next', 'previous']).optional() }),
    z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().min(0.05).max(0.9).optional() }),
    z.object({ action: z.literal('scroll_to'), text: z.string(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), max_swipes: z.number().int().min(1).max(20).optional() }),
    z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(60_000) }),
    z.object({ action: z.literal('wait_for'), text: z.string(), gone: z.boolean().optional(), timeout_ms: z.number().int().min(500).max(120_000).optional() }),
    z.object({ action: z.literal('press_button'), button: z.enum(['home', 'volume_up', 'volume_down', 'lock']) }),
    z.object({ action: z.literal('open_app'), app: z.string(), relaunch: z.boolean().optional() }),
    z.object({ action: z.literal('close_app'), app: z.string() }),
    z.object({ action: z.literal('open_url'), url: z.string() }),
    z.object({ action: z.literal('dismiss_keyboard') }),
    z.object({ action: z.literal('alert'), choice: z.enum(['accept', 'dismiss']), button: z.string().optional() }),
]);

export type Step = z.infer<typeof stepSchema>;

export const MAX_STEPS = 30;

/** A wait or search that ran out without finding what it looked for: in a sequence, that is a failure. */
export class StepNotMet extends Error {}

/** The step as one line. What is typed stays out of it, as it does everywhere: it may be a password. */
function describe(step: Step): string {
    const { action, ...rest } = step;
    const typed = action === 'type_text' || action === 'tap_keys';
    const args = Object.entries(rest).map(([key, value]) => (typed && key === 'text' ? `text=(${String(value).length} characters)` : `${key}=${JSON.stringify(value)}`));
    return [action, ...args].join(' ');
}

function targetOf(step: { element_id?: string; text?: string; x?: number; y?: number }) {
    return {
        ...(step.element_id ? { elementId: step.element_id } : {}), ...(step.text ? { text: step.text } : {}),
        ...(step.x !== undefined ? { x: step.x } : {}), ...(step.y !== undefined ? { y: step.y } : {}),
    };
}

async function runStep(tools: AgentTools, device: string | undefined, step: Step, fresh: boolean): Promise<ToolResult> {
    // By text, a tap looks the element up in the last observation: after an earlier step changed
    // the screen that is stale, so look again first.
    if ('text' in step && step.text && !fresh && (step.action === 'tap' || step.action === 'double_tap' || step.action === 'long_press')) {
        await tools.observe(device);
    }
    switch (step.action) {
        case 'tap': return tools.tap(device, { ...targetOf(step), ...(step.spread !== undefined ? { spread: step.spread } : {}) });
        case 'double_tap': return tools.doubleTap(device, targetOf(step));
        case 'long_press': return tools.longPress(device, { ...targetOf(step), ...(step.duration_ms ? { durationMs: step.duration_ms } : {}) });
        case 'type_text': return tools.typeText(device, { text: step.text, ...(step.submit !== undefined ? { submit: step.submit } : {}) });
        case 'tap_keys': return tools.tapKeys(device, step.text);
        case 'swipe': return tools.swipe(device, { ...(step.direction ? { direction: step.direction } : {}), ...(step.amount !== undefined ? { amount: step.amount } : {}), ...(step.from ? { from: step.from } : {}), ...(step.to ? { to: step.to } : {}) });
        case 'flick_feed': return tools.flickFeed(device, step.direction ?? 'next');
        case 'scroll': return tools.scroll(device, { direction: step.direction, ...(step.amount !== undefined ? { amount: step.amount } : {}) });
        case 'scroll_to': {
            const result = await tools.scrollTo(device, { text: step.text, ...(step.direction ? { direction: step.direction } : {}), ...(step.max_swipes ? { maxSwipes: step.max_swipes } : {}) });
            if (!/^Found after/.test(result.text)) throw new StepNotMet(result.text);
            return result;
        }
        case 'wait': return tools.wait(device, step.ms);
        case 'wait_for': {
            const { met, result } = await tools.pollFor(device, { text: step.text, ...(step.gone !== undefined ? { gone: step.gone } : {}), ...(step.timeout_ms ? { timeoutMs: step.timeout_ms } : {}) });
            if (!met) throw new StepNotMet(result.text);
            return result;
        }
        case 'press_button': return tools.pressButton(device, step.button);
        case 'open_app': return tools.openApp(device, { app: step.app, ...(step.relaunch !== undefined ? { relaunch: step.relaunch } : {}) });
        case 'close_app': return tools.closeApp(device, step.app);
        case 'open_url': return tools.openUrl(device, step.url);
        case 'dismiss_keyboard': return tools.dismissKeyboard(device);
        case 'alert': return tools.alert(device, step.choice, step.button);
    }
}

/** Run the steps in order; stop at the first failure; finish with a fresh observation unless told not to. */
export async function runSteps(tools: AgentTools, device: string | undefined, steps: readonly Step[], { observeAfter = true }: { observeAfter?: boolean } = {}): Promise<ToolResult> {
    if (!steps.length) throw new Error('Give at least one step');
    if (steps.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps in one call`);
    const lines: string[] = [];
    let failed = false;
    for (const [index, step] of steps.entries()) {
        const started = Date.now();
        try {
            // scroll_to and wait_for end on a fresh observation of their own.
            const fresh = index === 0 || steps[index - 1]!.action === 'scroll_to' || steps[index - 1]!.action === 'wait_for';
            const result = await runStep(tools, device, step, fresh);
            lines.push(`${index + 1}. ✓ ${describe(step)} (${((Date.now() - started) / 1000).toFixed(1)} s) — ${result.text.split('\n')[0]}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lines.push(`${index + 1}. ✗ ${describe(step)} — ${message.split('\n')[0]}`);
            if (index + 1 < steps.length) lines.push(`Stopped: steps ${index + 2}–${steps.length} did not run.`);
            if (!(error instanceof StepNotMet)) await tools.noteFailure(device, `run_steps step ${index + 1} (${step.action})`, message);
            failed = true;
            break;
        }
    }
    const summary = failed ? `${lines.filter((line) => /^\d+\. ✓/.test(line)).length} of ${steps.length} steps done, then one failed:` : `All ${steps.length} steps done:`;
    if (!observeAfter) return { text: `${summary}\n${lines.join('\n')}` };
    const observed = await tools.observe(device);
    return { text: `${summary}\n${lines.join('\n')}\n\nNow:\n${observed.text}`, ...(observed.image ? { image: observed.image } : {}) };
}
