import assert from 'node:assert/strict';
import test from 'node:test';

import { Humanizer } from '../src/humanize/humanizer.js';

const SCREEN = { width: 390, height: 844 };

test('a feed swipe starts off-centre and arcs inward, never straight down the middle', () => {
    const humanizer = new Humanizer({ seed: 'run-1', persona: 'udid-A' });
    const inward = humanizer.handedness === 'right' ? 1 : -1;
    let offCentre = 0;
    for (let i = 0; i < 40; i += 1) {
        const { from, to } = humanizer.feedSwipe(SCREEN);
        assert.ok(to.y < from.y, 'a feed swipe travels up');
        // The thumb sweeps back across the screen, so the path is never vertical.
        assert.notEqual(from.x, to.x);
        assert.ok((from.x - to.x) * inward > 0, 'drift follows the holding hand');
        if (Math.abs(from.x - SCREEN.width / 2) > SCREEN.width * 0.05) offCentre += 1;
    }
    assert.equal(offCentre, 40, 'every swipe should start away from dead centre');
});

test('endpoints stay clear of the edges iOS reserves for system gestures', () => {
    const humanizer = new Humanizer({ seed: 'run-2', persona: 'udid-B' });
    for (let i = 0; i < 60; i += 1) {
        const { from, to } = humanizer.feedSwipe(SCREEN);
        for (const point of [from, to]) {
            // Bounds are rounded to whole pixels, so compare against rounded limits.
            assert.ok(point.x >= Math.round(SCREEN.width * 0.10) && point.x <= Math.round(SCREEN.width * 0.90), `x ${point.x}`);
            assert.ok(point.y >= Math.round(SCREEN.height * 0.14) && point.y <= Math.round(SCREEN.height * 0.88), `y ${point.y}`);
        }
    }
});

test('handedness follows the persona, not the run seed', () => {
    const first = new Humanizer({ seed: 'monday', persona: 'udid-A' }).handedness;
    const second = new Humanizer({ seed: 'tuesday', persona: 'udid-A' }).handedness;
    assert.equal(first, second, 'the same phone keeps the same hand across runs');
    const personas = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']
        .map((persona) => new Humanizer({ persona }).handedness);
    assert.ok(personas.includes('right'), 'right-handed personas exist');
    assert.ok(new Set(personas).size <= 2);
});

test('successive swipes differ from one another', () => {
    const humanizer = new Humanizer({ seed: 'run-3', persona: 'udid-C' });
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
        const { from, to } = humanizer.feedSwipe(SCREEN);
        seen.add(`${from.x},${from.y}->${to.x},${to.y}`);
    }
    assert.ok(seen.size >= 24, `expected near-unique swipes, got ${seen.size}`);
});

test('a hesitant swipe travels too little to advance the feed', () => {
    const humanizer = new Humanizer({ profile: 'relaxed', seed: 'run-4', persona: 'udid-D' });
    const hesitant = humanizer.feedSwipe(SCREEN, { hesitate: true });
    const committed = humanizer.feedSwipe(SCREEN, { hesitate: false });
    assert.equal(hesitant.committed, false);
    assert.equal(committed.committed, true);
    assert.ok(hesitant.from.y - hesitant.to.y < SCREEN.height * 0.2, 'a half swipe barely moves');
    assert.ok(committed.from.y - committed.to.y > SCREEN.height * 0.35, 'a real swipe carries');
});

test('hesitation happens sometimes, but never on the precise profile', () => {
    const relaxed = new Humanizer({ profile: 'relaxed', seed: 'run-5', persona: 'udid-E' });
    const outcomes = Array.from({ length: 200 }, () => relaxed.feedSwipe(SCREEN).committed);
    assert.ok(outcomes.includes(false), 'relaxed scrolling should sometimes not commit');
    assert.ok(outcomes.filter((committed) => !committed).length < 80, 'but most swipes should land');

    const precise = new Humanizer({ profile: 'precise', seed: 'run-6', persona: 'udid-F' });
    assert.ok(Array.from({ length: 50 }, () => precise.feedSwipe(SCREEN).committed).every(Boolean));
});

test('a swipe by direction does not start on the same spot or travel the same distance twice', () => {
    // Without jitter every direction swipe would start on the same spot.
    const humanizer = new Humanizer({ seed: 'run-1', persona: 'udid-A' });
    const swipes = Array.from({ length: 40 }, () => humanizer.directionSwipe(SCREEN, 'left', 0.5));
    for (const { from, to } of swipes) {
        assert.ok(to.x < from.x, 'a left swipe travels left');
        const travel = from.x - to.x;
        assert.ok(travel >= SCREEN.width * 0.42 && travel <= SCREEN.width * 0.63, `travel ${travel}`);
        for (const point of [from, to]) assert.ok(point.x > 0 && point.x < SCREEN.width && point.y > SCREEN.height * 0.3 && point.y < SCREEN.height * 0.75);
    }
    const spanOf = (values: number[]) => Math.max(...values) - Math.min(...values);
    assert.ok(spanOf(swipes.map((swipe) => swipe.from.y)) > 120, 'starts are spread over the height of the picture');
    assert.ok(spanOf(swipes.map((swipe) => swipe.from.x)) > 40, 'and over its width');
    assert.ok(swipes.some((swipe) => Math.abs(swipe.from.y - swipe.to.y) > 8), 'some are off level');

    // A vertical one keeps to the thumb's side, like the feed swipe.
    const inward = humanizer.handedness === 'right' ? 1 : -1;
    for (let i = 0; i < 20; i += 1) {
        const { from, to } = humanizer.directionSwipe(SCREEN, 'up', 0.5);
        assert.ok(to.y < from.y && (from.x - SCREEN.width / 2) * inward > 0);
    }

    // The calibration profile keeps the exact geometry.
    const precise = new Humanizer({ profile: 'precise', seed: 'x' });
    const exact = precise.directionSwipe(SCREEN, 'left', 0.5);
    assert.deepEqual([exact.from.x, exact.to.x, exact.from.y === exact.to.y, Math.round(exact.from.y)], [292.5, 97.5, true, 464]);
});

test('a tap with a spread lands all over the button, and never outside it', () => {
    const humanizer = new Humanizer({ seed: 'run-1', persona: 'udid-A' });
    const heart = { x: 359, y: 421 };
    const narrow = Array.from({ length: 200 }, () => humanizer.tapAt(heart, SCREEN));
    const wide = Array.from({ length: 200 }, () => humanizer.tapAt(heart, SCREEN, 9));
    const farthest = (taps: Array<{ x: number; y: number }>) => Math.max(...taps.map((tap) => Math.max(Math.abs(tap.x - heart.x), Math.abs(tap.y - heart.y))));
    const distinct = (taps: Array<{ x: number; y: number }>) => new Set(taps.map((tap) => `${tap.x},${tap.y}`)).size;
    assert.ok(farthest(wide) <= 9, 'never further than the spread');
    assert.ok(farthest(wide) >= 7 && distinct(wide) > distinct(narrow) * 2, 'and it uses the room');
    assert.deepEqual(new Humanizer({ profile: 'precise', seed: 'x' }).tapAt(heart, SCREEN, 9), { x: 359, y: 421, holdMs: new Humanizer({ profile: 'precise', seed: 'x' }).tapAt(heart, SCREEN).holdMs });
});
