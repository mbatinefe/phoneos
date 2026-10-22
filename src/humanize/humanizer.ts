import { Random, seedFromString } from './random.js';

export type HumanProfile = 'precise' | 'natural' | 'relaxed';

export interface Point { x: number; y: number }
export interface Frame { x: number; y: number; width: number; height: number }

export interface TapPlan {
    /** Where the finger lands, in points. */
    x: number;
    y: number;
    /** Time between touch-down and lift. */
    holdMs: number;
}

export interface PathSegment { x: number; y: number; durationMs: number }

/** A feed swipe, and whether it travels far enough to actually advance the feed. */
export interface FeedSwipe {
    from: Point;
    to: Point;
    committed: boolean;
}

export interface SwipePlan {
    start: Point;
    /** Finger settles on the glass before it starts moving. */
    settleMs: number;
    /** Successive pointer-move targets; durations sum to `totalMs`. */
    segments: PathSegment[];
    totalMs: number;
    /** Where the finger finally lifts (last segment). */
    end: Point;
}

export type SwipeIntent = 'flick' | 'drag';

export interface TypingChunk { text: string; charsPerSecond: number; pauseAfterMs: number }

export type PauseKind = 'think' | 'betweenTaps' | 'afterAction';

interface Duration { median: number; sigma: number; min: number; max: number }

interface ProfileConfig {
    /** σ of the landing point as a fraction of the frame dimension (0 = dead centre). */
    tapSpread: number;
    /** Margin kept on every side of the frame, as a fraction (0.1 = inner 80 %). */
    tapInset: number;
    /** σ in points for taps given as bare coordinates. */
    coordinateJitter: number;
    hold: Duration;
    swipe: Duration;
    /** σ of the Bézier control-point offset, as a fraction of the swipe length. */
    curvature: number;
    /** σ in points of the endpoint jitter. */
    endpointJitter: number;
    /** Probability a flick overshoots its target by 5–10 %. */
    overshoot: number;
    /** Probability a feed swipe is half-hearted and springs back instead of advancing. */
    hesitation: number;
    segments: [number, number];
    pacing: Record<PauseKind, Duration>;
    typing: {
        charsPerSecond: [number, number]; chunk: [number, number]; pause: Duration };
    idleGestures: boolean;
}

const ZERO: Duration = { median: 0, sigma: 0, min: 0, max: 0 };

const PROFILES: Record<HumanProfile, ProfileConfig> = {
    precise: {
        tapSpread: 0, tapInset: 0, coordinateJitter: 0,
        hold: { median: 80, sigma: 0, min: 80, max: 80 },
        swipe: { median: 350, sigma: 0, min: 350, max: 350 },
        curvature: 0, endpointJitter: 0, overshoot: 0, hesitation: 0, segments: [6, 6],
        pacing: { think: ZERO, betweenTaps: ZERO, afterAction: ZERO },
        typing: {
        charsPerSecond: [20, 20], chunk: [10_000, 10_000], pause: ZERO },
        idleGestures: false,
    },
    natural: {
        tapSpread: 1 / 6, tapInset: 0.1, coordinateJitter: 1.5,
        hold: { median: 90, sigma: 0.25, min: 60, max: 140 },
        swipe: { median: 420, sigma: 0.25, min: 280, max: 650 },
        curvature: 0.05, endpointJitter: 2.5, overshoot: 0.15, hesitation: 0.10, segments: [10, 16],
        pacing: {
            think: { median: 700, sigma: 0.4, min: 400, max: 1500 },
            betweenTaps: { median: 260, sigma: 0.35, min: 150, max: 500 },
            afterAction: { median: 350, sigma: 0.35, min: 200, max: 700 },
        },
        typing: {
        charsPerSecond: [3, 5], chunk: [2, 5], pause: { median: 300, sigma: 0.4, min: 80, max: 300 } },
        idleGestures: false,
    },
    relaxed: {
        tapSpread: 1 / 4, tapInset: 0.05, coordinateJitter: 2.5,
        hold: { median: 110, sigma: 0.35, min: 60, max: 220 },
        swipe: { median: 500, sigma: 0.3, min: 300, max: 800 },
        curvature: 0.08, endpointJitter: 4, overshoot: 0.25, hesitation: 0.18, segments: [12, 18],
        pacing: {
            think: { median: 1000, sigma: 0.45, min: 500, max: 2500 },
            betweenTaps: { median: 400, sigma: 0.4, min: 200, max: 800 },
            afterAction: { median: 500, sigma: 0.4, min: 250, max: 1000 },
        },
        typing: {
        charsPerSecond: [2, 4], chunk: [1, 4], pause: { median: 400, sigma: 0.45, min: 100, max: 500 } },
        idleGestures: true,
    },
};

export function isHumanProfile(value: unknown): value is HumanProfile {
    return value === 'precise' || value === 'natural' || value === 'relaxed';
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const easeIn = (t: number): number => t * t;

export interface HumanizerOptions {
    profile?: HumanProfile;
    /** Number or string; strings are hashed. Omit for a time-based seed. */
    seed?: number | string;
    /**
     * Stable identity behind the gestures — pass a device udid. Traits that
     * belong to a person rather than a run (handedness) derive from this, so
     * they survive a reseed. Defaults to `seed`.
     */
    persona?: string;
}

/**
 * Turns intents ("tap this frame", "swipe from A to B", "type this") into
 * gesture plans that don't look scripted: off-centre landings, curved
 * variable-speed swipes, natural pauses. Deterministic for a given seed.
 */
export class Humanizer {
    readonly profile: HumanProfile;
    readonly seed: number;
    /** Which hand holds the phone. Fixed for a persona — people do not swap between scrolls. */
    readonly handedness: 'left' | 'right';
    private readonly config: ProfileConfig;
    private readonly random: Random;
    private readonly persona: string;
    private lastTap: Point | undefined;

    constructor({ profile = 'natural', seed, persona }: HumanizerOptions = {}) {
        this.profile = profile;
        this.seed = typeof seed === 'string' ? seedFromString(seed) : (seed ?? (Date.now() >>> 0));
        this.config = PROFILES[profile];
        this.random = new Random(this.seed);
        this.persona = persona ?? String(this.seed);
        // Derived from the persona, not the run seed, and hashed separately so it
        // does not consume the gesture stream. ~88 % right-handed, as people are.
        this.handedness = seedFromString(`hand:${this.persona}`) % 100 < 88 ? 'right' : 'left';
    }

    /**
     * A number in [0, 1) from this humanizer's seeded stream. Anything else that has to look
     * human (a pause between keys, whether to like a video) draws from here rather than from
     * Math.random, so a seeded run replays exactly.
     */
    next(): number {
        return this.random.next();
    }

    /** The same person (seed stream continued, same hand) under another profile. */
    withProfile(profile: HumanProfile): Humanizer {
        return new Humanizer({ profile, seed: this.random.int(0, 0xffffffff), persona: this.persona });
    }

    describe(): { profile: HumanProfile; seed: number; handedness: 'left' | 'right' } {
        return { profile: this.profile, seed: this.seed, handedness: this.handedness };
    }

    /**
     * Where a thumb actually travels when someone scrolls a feed.
     *
     * A hand holds the phone on one side and pivots from the base of the thumb,
     * so the path is an arc: it starts in the thumb's resting zone, low and
     * toward the holding hand, and sweeps inward as the thumb extends. Driving
     * the swipe from a fixed centre fraction instead produces a straight
     * vertical line down the middle of the screen every time, which is the
     * single most obvious tell in a scripted feed session.
     *
     * Endpoints stay clear of the screen edges: iOS reads a gesture that starts
     * on the bezel as a system swipe (home indicator, back) rather than giving
     * it to the app.
     */
    feedSwipe(screen: { width: number; height: number }, { hesitate }: { hesitate?: boolean } = {}): FeedSwipe {
        const inward = this.handedness === 'right' ? 1 : -1;
        const anchor = 0.5 + inward * this.random.uniform(0.08, 0.20);
        const startFy = this.random.uniform(0.72, 0.86);
        // Sometimes a thumb starts a scroll and does not commit: the content lifts
        // a little and springs back. Too short to pass the app's advance
        // threshold, which is the point — the feed stays where it was.
        const committed = hesitate === undefined ? !this.random.chance(this.config.hesitation) : !hesitate;
        const travel = committed ? this.random.uniform(0.40, 0.64) : this.random.uniform(0.08, 0.16);
        const drift = inward * this.random.uniform(0.04, 0.15) * (committed ? 1 : 0.4);
        const px = (fx: number) => Math.round(clamp(fx, 0.10, 0.90) * screen.width);
        const py = (fy: number) => Math.round(clamp(fy, 0.14, 0.88) * screen.height);
        return {
            from: { x: px(anchor), y: py(startFy) },
            to: { x: px(anchor - drift), y: py(startFy - travel) },
            committed,
        };
    }

    /** A landing point inside `frame` — never dead centre (unless `precise`), never the same pixel twice in a row. */
    tapInFrame(frame: Frame): TapPlan {
        const { tapSpread, tapInset } = this.config;
        const centerX = frame.x + frame.width / 2;
        const centerY = frame.y + frame.height / 2;
        const insetX = frame.width * tapInset;
        const insetY = frame.height * tapInset;
        const minX = Math.ceil(frame.x + insetX);
        const maxX = Math.max(minX, Math.floor(frame.x + frame.width - insetX));
        const minY = Math.ceil(frame.y + insetY);
        const maxY = Math.max(minY, Math.floor(frame.y + frame.height - insetY));
        let x = clamp(Math.round(centerX + this.random.gaussian(0, frame.width * tapSpread)), minX, maxX);
        let y = clamp(Math.round(centerY + this.random.gaussian(0, frame.height * tapSpread)), minY, maxY);
        if (this.profile !== 'precise' && this.lastTap && this.lastTap.x === x && this.lastTap.y === y) {
            x = x > minX ? x - 1 : x + 1;
            x = clamp(x, minX, maxX);
            if (this.lastTap.x === x) y = clamp(y > minY ? y - 1 : y + 1, minY, maxY);
        }
        this.lastTap = { x, y };
        return { x, y, holdMs: this.hold() };
    }

    /**
     * A bare coordinate gets a little jitter so repeated taps don't stack on one pixel.
     * `spread` is for a caller who can see the button: the distance in points, from the
     * point given, within which the finger may land. Without it a model that reads the centre
     * of a button off every screenshot lands on the same few points all session.
     */
    tapAt(point: Point, screen?: { width: number; height: number }, spread?: number): TapPlan {
        const wide = spread !== undefined && spread > 0 && this.profile !== 'precise';
        const jitter = wide ? spread / 2 : this.config.coordinateJitter;
        const reach = wide ? spread : Infinity;
        const offset = () => (jitter ? clamp(this.random.gaussian(0, jitter), -reach, reach) : 0);
        let x = Math.round(point.x + offset());
        let y = Math.round(point.y + offset());
        if (screen) {
            x = clamp(x, 0, screen.width);
            y = clamp(y, 0, screen.height);
        }
        this.lastTap = { x, y };
        return { x, y, holdMs: this.hold() };
    }

    /**
     * Where a swipe "by direction" starts and ends when the caller names no point. A
     * person does not start every swipe on the same spot or drag it the same distance.
     * `precise` swipes through the centre, the same way every time.
     */
    directionSwipe(screen: { width: number; height: number }, direction: 'up' | 'down' | 'left' | 'right', amount: number): { from: Point; to: Point } {
        const horizontal = direction === 'left' || direction === 'right';
        const sign = direction === 'left' || direction === 'up' ? -1 : 1;
        if (this.profile === 'precise') {
            const center = { x: screen.width / 2, y: screen.height * 0.55 };
            const travel = sign * amount * (horizontal ? screen.width : screen.height);
            return horizontal
                ? { from: { x: center.x - travel / 2, y: center.y }, to: { x: center.x + travel / 2, y: center.y } }
                : { from: { x: center.x, y: center.y - travel / 2 }, to: { x: center.x, y: center.y + travel / 2 } };
        }
        const inward = this.handedness === 'right' ? 1 : -1;
        const length = clamp(amount * this.random.uniform(0.85, 1.25), 0.05, 0.9);
        if (horizontal) {
            // Anywhere across the middle band of the screen, a little off level, as a thumb arcs.
            const middle = { x: (0.5 + this.random.uniform(-0.06, 0.06)) * screen.width, y: this.random.uniform(0.38, 0.68) * screen.height };
            const travel = sign * length * screen.width;
            const tilt = this.random.uniform(-0.03, 0.03) * screen.height;
            return { from: { x: middle.x - travel / 2, y: middle.y - tilt / 2 }, to: { x: middle.x + travel / 2, y: middle.y + tilt / 2 } };
        }
        // On the thumb's side of the screen, drifting toward the hand as it travels.
        const middle = { x: (0.5 + inward * this.random.uniform(0.04, 0.2)) * screen.width, y: (0.55 + this.random.uniform(-0.05, 0.05)) * screen.height };
        const travel = sign * length * screen.height;
        const drift = inward * this.random.uniform(0, 0.06) * screen.width;
        return { from: { x: middle.x, y: middle.y - travel / 2 }, to: { x: middle.x + drift * (sign < 0 ? -1 : 1), y: middle.y + travel / 2 } };
    }

    private hold(): number {
        const { hold } = this.config;
        return this.random.duration(hold.median, hold.sigma, hold.min, hold.max);
    }

    /**
     * A curved, variable-speed path from `from` to `to`. `flick` accelerates
     * and lifts while moving (scrolling a feed); `drag` eases in and out
     * (moving a slider, reordering).
     */
    swipe(from: Point, to: Point, { intent = 'flick', durationMs }: { intent?: SwipeIntent; durationMs?: number } = {}): SwipePlan {
        const { curvature, endpointJitter, overshoot, segments, swipe } = this.config;
        const start = {
            x: from.x + this.random.gaussian(0, endpointJitter * 0.6),
            y: from.y + this.random.gaussian(0, endpointJitter * 0.6),
        };
        let end = {
            x: to.x + this.random.gaussian(0, endpointJitter),
            y: to.y + this.random.gaussian(0, endpointJitter),
        };
        if (intent === 'flick' && overshoot > 0 && this.random.chance(overshoot)) {
            const factor = this.random.uniform(1.05, 1.1);
            end = { x: start.x + (end.x - start.x) * factor, y: start.y + (end.y - start.y) * factor };
        }
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        const perpendicular = { x: -dy / length, y: dx / length };
        const control1 = {
            x: start.x + dx * 0.3 + perpendicular.x * this.random.gaussian(0, length * curvature),
            y: start.y + dy * 0.3 + perpendicular.y * this.random.gaussian(0, length * curvature),
        };
        const control2 = {
            x: start.x + dx * 0.7 + perpendicular.x * this.random.gaussian(0, length * curvature),
            y: start.y + dy * 0.7 + perpendicular.y * this.random.gaussian(0, length * curvature),
        };
        const totalMs = durationMs ?? this.random.duration(swipe.median, swipe.sigma, swipe.min, swipe.max);
        const count = this.random.int(segments[0], segments[1]);
        const timing = intent === 'flick' ? easeIn : easeInOut;
        const perSegment = totalMs / count;
        const path: PathSegment[] = [];
        for (let index = 1; index <= count; index++) {
            const point = cubicBezier(start, control1, control2, end, timing(index / count));
            path.push({ x: Math.round(point.x), y: Math.round(point.y), durationMs: Math.max(1, Math.round(perSegment)) });
        }
        const settleMs = this.profile === 'precise' ? 40 : this.random.duration(intent === 'flick' ? 45 : 90, 0.3, 30, 160);
        const last = path[path.length - 1]!;
        return {
            start: { x: Math.round(start.x), y: Math.round(start.y) },
            settleMs,
            segments: path,
            totalMs: path.reduce((sum, segment) => sum + segment.durationMs, 0),
            end: { x: last.x, y: last.y },
        };
    }

    /** A human-ish pause of the given kind, in milliseconds (0 for `precise`). */
    pause(kind: PauseKind): number {
        const spec = this.config.pacing[kind];
        if (spec.max === 0) return 0;
        return this.random.duration(spec.median, spec.sigma, spec.min, spec.max);
    }

    /** Time a person would spend reading `wordCount` words before acting (≈ 40 ms/word, capped). */
    readTime(wordCount: number): number {
        if (this.profile === 'precise' || wordCount <= 0) return 0;
        const base = Math.min(6_000, wordCount * 40);
        return this.random.duration(base, 0.3, base * 0.5, base * 1.6);
    }

    /** Text split into bursts with per-burst speed and pauses, as a person types. */
    typing(text: string): TypingChunk[] {
        const { typing } = this.config;
        const chunks: TypingChunk[] = [];
        let cursor = 0;
        while (cursor < text.length) {
            let size = this.random.int(typing.chunk[0], typing.chunk[1]);
            // Prefer to break after whitespace so bursts look like words.
            const window = text.slice(cursor, cursor + size + 3);
            const space = window.lastIndexOf(' ');
            if (space >= Math.floor(size * 0.6) && space < window.length - 1) size = space + 1;
            const piece = text.slice(cursor, cursor + size);
            cursor += size;
            chunks.push({
                text: piece,
                charsPerSecond: Math.round(this.random.uniform(typing.charsPerSecond[0], typing.charsPerSecond[1])),
                pauseAfterMs: cursor < text.length && typing.pause.max > 0
                    ? this.random.duration(typing.pause.median, typing.pause.sigma, typing.pause.min, typing.pause.max)
                    : 0,
            });
        }
        return chunks;
    }

    /**
     * A harmless gesture for idle moments — a tiny (6–12 pt) scroll nudge,
     * below what most screens treat as a real scroll. Only the `relaxed`
     * profile produces one, and the caller must skip it when a keyboard or
     * alert is up.
     */
    idleGesture(screen: { width: number; height: number }): SwipePlan | undefined {
        if (!this.config.idleGestures || !this.random.chance(0.35)) return undefined;
        const x = screen.width / 2 + this.random.gaussian(0, screen.width * 0.08);
        const y = screen.height * 0.55 + this.random.gaussian(0, screen.height * 0.05);
        const nudge = this.random.uniform(6, 12) * this.random.pick([-1, 1]);
        return this.swipe({ x, y }, { x, y: y + nudge }, { intent: 'drag', durationMs: this.random.int(180, 320) });
    }
}
