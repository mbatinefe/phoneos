import assert from 'node:assert/strict';
import test from 'node:test';

import { Humanizer } from '../src/humanize/humanizer.js';
import { Random, seedFromString } from '../src/humanize/random.js';
import { swipeActions, tapActions } from '../src/device/gestures.js';

test('Random is deterministic for a seed and produces sane distributions', () => {
    const a = new Random(42);
    const b = new Random(42);
    assert.deepEqual([a.next(), a.next(), a.int(1, 6)], [b.next(), b.next(), b.int(1, 6)]);
    const samples = Array.from({ length: 2_000 }, () => new Random(7).duration(300, 0.25, 100, 900));
    assert.ok(samples.every((value) => value >= 100 && value <= 900));
    assert.equal(seedFromString('phone-a'), seedFromString('phone-a'));
    assert.notEqual(seedFromString('phone-a'), seedFromString('phone-b'));
});

test('natural taps land inside the frame, off-centre, never on the same pixel twice in a row', () => {
    const humanizer = new Humanizer({ profile: 'natural', seed: 'test' });
    const frame = { x: 100, y: 200, width: 120, height: 44 };
    let previous: { x: number; y: number } | undefined;
    let offCentre = 0;
    for (let index = 0; index < 200; index++) {
        const tap = humanizer.tapInFrame(frame);
        assert.ok(tap.x >= frame.x + frame.width * 0.1 && tap.x <= frame.x + frame.width * 0.9, `x ${tap.x} inside inner 80%`);
        assert.ok(tap.y >= frame.y + frame.height * 0.1 && tap.y <= frame.y + frame.height * 0.9, `y ${tap.y} inside inner 80%`);
        assert.ok(tap.holdMs >= 60 && tap.holdMs <= 140, `hold ${tap.holdMs}`);
        if (previous) assert.ok(previous.x !== tap.x || previous.y !== tap.y, 'never the exact same pixel twice');
        if (tap.x !== 160 || tap.y !== 222) offCentre += 1;
        previous = tap;
    }
    assert.ok(offCentre > 180, 'the vast majority of taps are off dead-centre');
});

test('precise taps hit the exact centre with a fixed hold', () => {
    const humanizer = new Humanizer({ profile: 'precise' });
    const tap = humanizer.tapInFrame({ x: 100, y: 200, width: 120, height: 44 });
    assert.deepEqual(tap, { x: 160, y: 222, holdMs: 80 });
    assert.equal(humanizer.pause('think'), 0);
    assert.equal(humanizer.readTime(100), 0);
});

test('swipes are curved, multi-segment, variable-speed paths that end near the target', () => {
    const humanizer = new Humanizer({ profile: 'natural', seed: 1 });
    const plan = humanizer.swipe({ x: 195, y: 700 }, { x: 195, y: 200 }, { intent: 'flick' });
    assert.ok(plan.segments.length >= 10 && plan.segments.length <= 16);
    assert.ok(plan.totalMs >= 280 && plan.totalMs <= 660, `duration ${plan.totalMs}`);
    assert.ok(Math.abs(plan.end.x - 195) < 40, 'ends roughly on the target column');
    assert.ok(plan.end.y < 260, 'ends near the target row (allowing overshoot)');
    const xs = plan.segments.map((segment) => segment.x);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 0, 'the path bends sideways rather than being a straight line');
    // ease-in flick: later segments cover more distance than earlier ones
    const first = Math.abs(plan.segments[1]!.y - plan.segments[0]!.y);
    const last = Math.abs(plan.segments[plan.segments.length - 1]!.y - plan.segments[plan.segments.length - 2]!.y);
    assert.ok(last > first, 'accelerates towards the lift');
});

test('the same seed replays the same gestures', () => {
    const a = new Humanizer({ profile: 'relaxed', seed: 'replay' });
    const b = new Humanizer({ profile: 'relaxed', seed: 'replay' });
    assert.deepEqual(a.swipe({ x: 10, y: 10 }, { x: 300, y: 600 }), b.swipe({ x: 10, y: 10 }, { x: 300, y: 600 }));
    assert.deepEqual(a.typing('hello there world'), b.typing('hello there world'));
});

test('typing is split into word-ish bursts with pauses, and joins back to the text', () => {
    const humanizer = new Humanizer({ profile: 'natural', seed: 3 });
    const text = 'Meet me at the corner cafe at nine tomorrow morning';
    const chunks = humanizer.typing(text);
    assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
    assert.ok(chunks.length > 4);
    assert.ok(chunks.every((chunk) => chunk.charsPerSecond >= 3 && chunk.charsPerSecond <= 5));
    assert.equal(chunks[chunks.length - 1]!.pauseAfterMs, 0);
});

test('gesture plans convert to the W3C shape the absolute-actions patch accepts', () => {
    const humanizer = new Humanizer({ profile: 'precise' });
    const tap = tapActions(humanizer.tapInFrame({ x: 0, y: 0, width: 10, height: 10 }));
    assert.equal(tap[0]!.parameters.pointerType, 'touch');
    assert.deepEqual(tap[0]!.actions.map((action) => action.type), ['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
    const swipe = swipeActions(humanizer.swipe({ x: 0, y: 500 }, { x: 0, y: 100 }));
    const types = swipe[0]!.actions.map((action) => action.type);
    assert.equal(types[0], 'pointerMove');
    assert.equal(types[1], 'pointerDown');
    assert.equal(types[2], 'pause');
    assert.equal(types[types.length - 1], 'pointerUp');
    assert.ok(types.filter((type) => type === 'pointerMove').length >= 7);
    assert.ok(swipe[0]!.actions.every((action) => !('origin' in action) || action.origin === 'viewport'));
});

test('idle gestures only exist for the relaxed profile and stay tiny', () => {
    assert.equal(new Humanizer({ profile: 'natural', seed: 1 }).idleGesture({ width: 390, height: 844 }), undefined);
    const relaxed = new Humanizer({ profile: 'relaxed', seed: 5 });
    let found: ReturnType<typeof relaxed.idleGesture>;
    for (let index = 0; index < 50 && !found; index++) found = relaxed.idleGesture({ width: 390, height: 844 });
    assert.ok(found, 'relaxed eventually nudges');
    assert.ok(Math.abs(found!.end.y - found!.start.y) < 30, 'a nudge, not a scroll');
});
