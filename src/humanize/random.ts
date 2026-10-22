/**
 * Seeded pseudo-random source (mulberry32). Every humanized gesture draws from
 * one of these so a run can be replayed exactly from its seed.
 */
export class Random {
    private state: number;

    constructor(seed: number = Date.now()) {
        this.state = (seed >>> 0) || 0x9e3779b9;
    }

    /** Uniform in [0, 1). */
    next(): number {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    uniform(min: number, max: number): number {
        return min + (max - min) * this.next();
    }

    int(min: number, max: number): number {
        return Math.floor(this.uniform(min, max + 1));
    }

    chance(probability: number): boolean {
        return this.next() < probability;
    }

    pick<T>(values: readonly T[]): T {
        if (values.length === 0) throw new Error('Cannot pick from an empty list');
        return values[Math.min(values.length - 1, Math.floor(this.next() * values.length))]!;
    }

    /** Box–Muller normal deviate. */
    gaussian(mean = 0, standardDeviation = 1): number {
        let u = 0;
        let v = 0;
        while (u === 0) u = this.next();
        while (v === 0) v = this.next();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return mean + z * standardDeviation;
    }

    /** Log-normal deviate expressed by its median and spread (sigma of the log). */
    logNormal(median: number, sigma: number): number {
        return median * Math.exp(this.gaussian(0, sigma));
    }

    /** Log-normal clamped to a range — the workhorse for human-ish durations. */
    duration(median: number, sigma: number, min: number, max: number): number {
        return Math.round(Math.min(max, Math.max(min, this.logNormal(median, sigma))));
    }
}

/** Deterministic 32-bit seed from a string (FNV-1a). */
export function seedFromString(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
